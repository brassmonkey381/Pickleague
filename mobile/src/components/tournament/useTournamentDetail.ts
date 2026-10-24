import React, { useState, useCallback, useMemo, useRef } from 'react';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../../lib/supabase';
import { Tournament, TournamentRegistration, RootStackParamList } from '../../types';
import { getTournamentRole, TournamentRole } from '../../lib/tournamentRole';
import {
  FORMAT_META, seedPlayers, seedTeams,
  generateRoundRobin, generatePoolPlay, generateSingleElim, generateDoubleElim,
  generateRotatingPartners, generateMLPSchedule,
  generateDoublesRoundRobin, generateDoublesSingleElim, generateDoublesDoubleElim, generateDoublesPoolPlay,
  MatchPairing, validateDoublesTeams, validateMlpTeams, validatePools, MlpTeamShape,
} from '../../lib/tournament';
import { checkGodmode } from '../../lib/godmode';
import type { WagerSubject } from '../../lib/wager';
import { useStatusMessage } from '../../lib/useStatusMessage';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { useRefresh } from '../../lib/useRefresh';
import { fetchFinalRanks, type FinalRankRow } from '../../lib/tournamentStandings';
import type { MlpTeamSlots } from './tournamentModel';

export type TournamentDetailNavigation = NativeStackNavigationProp<RootStackParamList, 'TournamentDetail'>;

/** One row of the mlp_team_standings RPC. */
export type MlpStandingRow = {
  team_id: string; team_name: string; seed: number | null;
  pool_letter: string | null; sub_matches_won: number; sub_matches_lost: number;
};

/**
 * All of TournamentDetail's state, loading and actions, moved verbatim out of
 * screens/TournamentDetailScreen.tsx (UI compaction P5a). The screen calls
 * this once, first thing after useTheme, so React sees the exact hook
 * sequence the monolithic screen had (minus the dead partner-request state),
 * and every function below closes over the same per-render values it did
 * before. The extracted sections under components/tournament/ are
 * presentational: they get this state as props and call these actions.
 *
 * Removed in the move (verified dead, not just unused-looking): the
 * partner-request modal's state, its tournament_partner_requests query and
 * its send/respond/cancel actions. Nothing ever set showPartnerModal to true,
 * so the modal could not open, and the query's rows fed only that modal.
 * Partners are formed through DoublesPairSection (doubles_pairs) instead.
 */
export function useTournamentDetail({ navigation, tournamentId }: {
  navigation: TournamentDetailNavigation;
  tournamentId: string;
}) {
  // Page-level banner for info/error feedback (replaces Alert.alert, which
  // collapses multi-button alerts and uses window.confirm on web). Modal
  // scope keeps its own error so the user sees it without scrolling.
  const status = useStatusMessage();
  const [editError, setEditError] = useState<string | null>(null);

  const [tournament, setTournament]       = useState<Tournament | null>(null);
  const [registrations, setRegistrations] = useState<TournamentRegistration[]>([]);
  const [myRole, setMyRole]               = useState<TournamentRole>(null);
  const [myUserId, setMyUserId]           = useState<string | null>(null);
  const [generatedMatches, setGeneratedMatches] = useState<MatchPairing[] | null>(null);
  // Draw order captured at generation time (a ref so godmode's generate→lock
  // in one tick sees it without a state flush). Persisted to
  // tournament_registrations.seed at lock-in — the DB advancement triggers
  // reconstruct round-1 bracket slots by ordering registrations on seed, so
  // without this a random draw advanced the WRONG players.
  const seededOrderRef = useRef<string[] | null>(null);
  const [pools, setPools]                 = useState<string[][] | null>(null);
  // Fixed doubles pairs (non-MLP doubles formats). Loaded alongside regs.
  const [doublesPairs, setDoublesPairs]   = useState<{ partner_1_id: string | null; partner_2_id: string | null }[]>([]);
  const [locking, setLocking]             = useState(false);
  // Lock-in writes six things in a row with no transaction behind it. Two
  // concurrent runs (confirm modal + godmode shortcut, or a double tap) would
  // interleave those writes, so the guard is a ref checked at the top.
  const lockingRef                        = useRef(false);
  const [generatingPlayoff, setGeneratingPlayoff] = useState(false);
  // Same reason as lockingRef: this RPC writes playoff rounds + matches and
  // nothing dedupes them, so the guard can't be a state read.
  const playoffGenRef = useRef(false);
  const [showLockInConfirm, setShowLockInConfirm] = useState(false);
  const [lockInError, setLockInError]     = useState<string | null>(null);
  const [savedMatches, setSavedMatches]   = useState<any[]>([]);
  const [savedRounds, setSavedRounds]     = useState<any[]>([]);
  const [mlpStandings, setMlpStandings]   = useState<MlpStandingRow[] | null>(null);
  const [myMatchesOnly, setMyMatchesOnly] = useState(false);
  const [profileNames, setProfileNames]   = useState<Record<string, string>>({});
  const [profileRatings, setProfileRatings] = useState<Record<string, number>>({});
  const [loading, setLoading]             = useState(true);
  // Last failed tournament read (null after a good one). The screen tells a
  // real "not found" from a network failure with classifySbError.
  const [loadError, setLoadError]         = useState<unknown>(null);
  // Settled finishing order (completed tournaments only; [] until it exists).
  // The You card's finish + podium and the final standings read it (P5b).
  const [finalRanks, setFinalRanks]       = useState<FinalRankRow[]>([]);
  // MLP teams' slots (MLP formats only): the Teams summary, the setup
  // checklist's "Pair teams" step and the viewer's row in the MLP table.
  const [mlpTeams, setMlpTeams]           = useState<(MlpTeamSlots & { name: string })[]>([]);

  // Bracket release time picker
  const [showReleasePicker, setShowReleasePicker] = useState(false);

  // Godmode (Brian Stockman superuser bypass)
  const [godmode, setGodmode] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelling, setCancelling]               = useState(false);
  const [cancelError, setCancelError]             = useState<string | null>(null);
  const [deleting, setDeleting]                   = useState(false);
  const [simulating, setSimulating]               = useState(false);
  const [deleteError, setDeleteError]             = useState<string | null>(null);
  const [showPayoutModal, setShowPayoutModal]     = useState(false);
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
  const [completing, setCompleting]               = useState(false);
  const [completeError, setCompleteError]         = useState<string | null>(null);

  // Wagering — match outcome / exact-score / champion. wagerMatchPick must
  // outlive the action sheet so the exact-score sub-flow can still read it.
  const [wagerSubject, setWagerSubject] = useState<WagerSubject | null>(null);
  const [wagerOpen, setWagerOpen]       = useState(false);
  const [wagerMatchPick, setWagerMatchPick] = useState<{
    tournamentMatchId: string;
    team1Label: string;
    team2Label: string;
  } | null>(null);
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  const [exactScoreOpen, setExactScoreOpen] = useState(false);
  const [exactScoreT1, setExactScoreT1]     = useState('');
  const [exactScoreT2, setExactScoreT2]     = useState('');
  const [exactScoreError, setExactScoreError] = useState<string | null>(null);
  const [wagerMarketOpen, setWagerMarketOpen]       = useState(false);
  const [wagerMarketShowAll, setWagerMarketShowAll] = useState(false);

  // Edit-tournament modal (admin only)
  const [showEditModal, setShowEditModal]     = useState(false);
  const [editName, setEditName]               = useState('');
  const [editDesc, setEditDesc]               = useState('');
  const [editLocation, setEditLocation]       = useState('');
  const [editMinPlayers, setEditMinPlayers]   = useState('');
  const [editMaxPlayers, setEditMaxPlayers]   = useState('');
  const [editStartTime, setEditStartTime]     = useState<Date | null>(null);
  const [editLengthHours, setEditLengthHours] = useState('');
  const [editAnte, setEditAnte]               = useState('');
  const [editPayout, setEditPayout]           = useState('');
  const [editPrizePool, setEditPrizePool]     = useState('');
  const [editSeeding, setEditSeeding]         = useState<'random' | 'elo'>('random');
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [savingEdit, setSavingEdit]           = useState(false);

  // Approved registrations sorted by PLUPR desc — used by the Wager Market panel.
  // "Not Rated" / null rating sinks to the bottom so unrated players don't outrank real ones.
  const wagerMarketSorted = useMemo(() => {
    const approvedRegs = registrations.filter(r => r.status === 'approved');
    return approvedRegs.slice().sort((a, b) => {
      const ap = a.profile as any;
      const bp = b.profile as any;
      const aVal = ap?.total_matches_played === 0 || ap?.rating == null ? -Infinity : Number(ap.rating);
      const bVal = bp?.total_matches_played === 0 || bp?.rating == null ? -Infinity : Number(bp.rating);
      return bVal - aVal;
    });
  }, [registrations]);

  useFocusEffect(useCallback(() => { load(); }, []));

  const refresh = useRefresh(load);

  // Refresh MLP standings whenever the tournament loads or new matches land —
  // the RPC reads completed sub-match counts, so it updates as games finish.
  // Fetched for any MLP variant with a group stage (round_robin, pool_play,
  // round_robin_playoff, pool_play_playoff). For the *_playoff variants the
  // render block hides itself once a playoff round exists in savedRounds.
  React.useEffect(() => {
    const isMlp = tournament?.format === 'mlp' || tournament?.format === 'mlp_random';
    const hasGroupStage =
      tournament?.mlp_play_format === 'round_robin' ||
      tournament?.mlp_play_format === 'pool_play' ||
      tournament?.mlp_play_format === 'round_robin_playoff' ||
      tournament?.mlp_play_format === 'pool_play_playoff';
    if (!isMlp || !hasGroupStage) { setMlpStandings(null); return; }
    if (tournament?.status !== 'active' && tournament?.status !== 'completed') return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc('mlp_team_standings', { p_tournament_id: tournamentId });
      if (cancelled) return;
      setMlpStandings((data ?? []) as any);
    })();
    return () => { cancelled = true; };
  }, [tournamentId, tournament?.format, tournament?.mlp_play_format, tournament?.status, savedMatches.length]);

  async function load() {
    // Local session read: the old getUser() was a network round trip that
    // resolves to null offline, which made the viewer look like a stranger to
    // their own tournament (no admin controls, no "you're registered" state).
    const uid = await currentUserId(supabase);
    setMyUserId(uid);

    const [tRes, regRes, role, godmodeResult] = await Promise.all([
      supabase.from('tournaments').select('*').eq('id', tournamentId).single(),
      supabase.from('tournament_registrations')
        .select('*, profile:profiles!tournament_registrations_user_id_fkey(id, full_name, rating, total_matches_played, name_color, list_name_style_id, avatar_emoji, avatar_bg_color)')
        .eq('tournament_id', tournamentId)
        .order('role'),
      getTournamentRole(tournamentId),
      checkGodmode(),
    ]);
    setGodmode(godmodeResult);

    // A failed read (offline, flaky refocus) keeps the last loaded tournament
    // and everything derived from it instead of wiping the screen to
    // "not found". A missing row (.single() -> PGRST116) also lands here and
    // classifies as notFound.
    if (tRes.error) {
      setLoadError(tRes.error);
      setLoading(false);
      return;
    }
    setLoadError(null);

    const t = tRes.data as Tournament;
    setTournament(t);
    // The header is the tournament's own name, never the push that opened it.
    if (t?.name) navigation.setOptions({ title: t.name });
    // 'unknown' means the role read failed — keep the last known role rather
    // than stripping an organizer's controls over a network blip.
    if (role !== 'unknown') setMyRole(role);

    // Same for registrations: a failed read keeps the last list (and the
    // names/ratings built from it) so the viewer doesn't look unregistered.
    if (!regRes.error) {
      const regs = (regRes.data ?? []) as TournamentRegistration[];
      setRegistrations(regs);

      const names: Record<string, string> = {};
      const ratings: Record<string, number> = {};
      regs.forEach(r => {
        if (r.profile) { names[r.user_id] = r.profile.full_name; ratings[r.user_id] = (r.profile as any).rating ?? 3.25; }
      });
      setProfileNames(names);
      setProfileRatings(ratings);
    }

    // Doubles pair list (only relevant for non-MLP doubles formats — harmless
    // to load for others, returns empty).
    const { data: pairs } = await supabase
      .from('doubles_pairs')
      .select('partner_1_id, partner_2_id')
      .eq('tournament_id', tournamentId);
    setDoublesPairs((pairs ?? []) as any);

    // Load saved matches + rounds if tournament is active OR completed
    if (t?.status === 'active' || t?.status === 'completed') {
      const [smRes, srRes] = await Promise.all([
        supabase.from('tournament_matches')
          .select('*, round:tournament_rounds(id, label, round_type, round_number)')
          .eq('tournament_id', tournamentId)
          .order('match_order'),
        supabase.from('tournament_rounds')
          .select('*')
          .eq('tournament_id', tournamentId)
          .order('round_number'),
      ]);
      // Keep the last schedule on a failed read rather than blanking it.
      if (!smRes.error) setSavedMatches(smRes.data ?? []);
      if (!srRes.error) setSavedRounds(srRes.data ?? []);
    }

    // Settled ranks: everyone can read tournament_final_ranks (RLS). A read
    // error comes back as [] and the screen falls back to live standings.
    setFinalRanks(t?.status === 'completed' ? await fetchFinalRanks(supabase, tournamentId) : []);

    // MLP teams (readable by everyone). Only the slots: MlpTeamSection
    // loads its own full rows and profiles for the team builder.
    if (t?.format === 'mlp' || t?.format === 'mlp_random') {
      const { data: teamRows } = await supabase
        .from('mlp_teams')
        .select('id, name, male_1_id, male_2_id, female_1_id, female_2_id')
        .eq('tournament_id', tournamentId);
      setMlpTeams((teamRows ?? []) as any);
    } else {
      setMlpTeams([]);
    }

    setLoading(false);
  }

  // ── Registration ────────────────────────────────────────────
  async function register() {
    // When the tournament is at max_players, a DB trigger flips this insert
    // to 'waitlisted' — same call either way.
    const wasFull = tournament?.max_players != null
      && registrations.filter(r => r.status === 'approved').length >= tournament.max_players;
    const { error } = await supabase.from('tournament_registrations').insert({
      tournament_id: tournamentId, user_id: myUserId,
    });
    if (error) status.error(error.message);
    else { status.success(wasFull ? 'Tournament is full — you\'ve been added to the waitlist.' : 'Request to join submitted.'); load(); }
  }

  async function approveReg(regId: string) {
    // Can fail on the DB capacity guard when the tournament is full.
    const { error } = await supabase.from('tournament_registrations').update({ status: 'approved' }).eq('id', regId);
    if (error) status.error(error.message);
    load();
  }
  async function rejectReg(regId: string) {
    await supabase.from('tournament_registrations').update({ status: 'rejected' }).eq('id', regId);
    load();
  }

  // Invitee responds to a tournament invite (admin-sent). Notifies the inviter.
  async function respondToTournamentInvite(regId: string, accept: boolean) {
    const { error } = await supabase.rpc('tournament_respond_to_invite', {
      p_registration_id: regId,
      p_accept: accept,
    });
    if (error) {
      status.error(`${accept ? 'Accept' : 'Decline'} failed: ${error.message}`);
      return;
    }
    status.success(accept ? 'Invite accepted.' : 'Invite declined.');
    load();
  }

  // ── Bracket release time ────────────────────────────────────
  // ── Godmode simulate (Brian only) — fills pending matches randomly ──
  async function simulateFillMatches() {
    if (!tournament) return;
    setSimulating(true);
    const { data, error } = await supabase.rpc('godmode_simulate_fill_matches', {
      p_tournament_id: tournament.id,
    });
    setSimulating(false);
    if (error) {
      status.error(`Simulate failed: ${error.message}`);
      return;
    }
    status.success(`Filled! ${data} pending match${data === 1 ? '' : 'es'} got random scores. Reloading…`);
    load();
  }

  // ── Godmode tournament-setup shortcuts (Brian only) ─────────
  // Helper: call an RPC and return { ok, message, missing }. `missing` is true
  // when Postgres reports the function doesn't exist (typical when the
  // migration hasn't been applied yet) so callers can decide to soft-skip.
  async function tryRpc(name: string, params: Record<string, unknown>) {
    console.warn('[godmode rpc]', name, params);
    const { data, error } = await supabase.rpc(name, params);
    if (error) {
      const msg = error.message ?? '';
      const missing = /function .* does not exist|Could not find the function|404|PGRST202/i.test(msg);
      console.warn('[godmode rpc error]', name, msg, { missing });
      return { ok: false, message: msg || 'Unknown error', missing };
    }
    const row = Array.isArray(data) ? data[0] : data;
    const message = row?.message ?? (typeof row === 'string' ? row : 'OK');
    console.warn('[godmode rpc ok]', name, message);
    return { ok: true, message, missing: false };
  }

  async function godmodeApproveAllInvitees() {
    if (!tournament) { status.error('Godmode: tournament not loaded.'); return; }
    const r = await tryRpc('godmode_approve_all_invitees', { p_tournament_id: tournament.id });
    const text = r.missing ? 'RPC not deployed — run migration_godmode_approve_all_invitees.sql.' : r.message;
    if (r.ok) { status.success(`Approved — ${text}`); load(); }
    else      { status.error(`Approve failed — ${text}`); }
  }

  async function godmodeForceCreateTeams() {
    if (!tournament) { status.error('Godmode: tournament not loaded.'); return; }
    const rpcName =
      tournament.format === 'mlp_random' ? 'generate_random_mlp_teams' :
      tournament.format === 'mlp'        ? 'godmode_force_fill_mlp_teams' :
                                           'godmode_auto_pair_doubles_for_tournament';
    const params: Record<string, unknown> = { p_tournament_id: tournament.id };
    if (tournament.format === 'mlp_random') params.p_mode = 'snake';
    const r = await tryRpc(rpcName, params);
    const text = r.missing ? `RPC ${rpcName} not deployed — run the corresponding migration.` : r.message;
    if (r.ok) { status.success(`Teams created — ${text}`); load(); }
    else      { status.error(`Team-create failed — ${text}`); }
  }

  // Full-pipeline auto-setup: approve all → create teams (if applicable) →
  // generate bracket → lock in. Each step soft-skips if the underlying RPC
  // isn't deployed so partially-deployed environments still make progress.
  // Godmode: approve everyone, form teams, and generate the bracket PREVIEW.
  // Deliberately does NOT lock in — locking is a separate explicit button so
  // the draw can be reviewed first. (The old combined version also locked
  // from a stale `registrations` closure, so the min-players guard could
  // silently bail while the toast claimed success.)
  async function godmodeAutoGeneratePreview() {
    if (!tournament) { status.error('Godmode: tournament not loaded.'); return; }
    const steps: string[] = [];
    try {
      // 1. Approve everyone.
      const approve = await tryRpc('godmode_approve_all_invitees', { p_tournament_id: tournament.id });
      steps.push(approve.ok ? `Done: ${approve.message}` : `Skipped: approve (${approve.missing ? 'RPC missing' : approve.message})`);

      // 2. Create teams when relevant.
      const needsTeams = tournament.match_type === 'doubles'
        || tournament.format === 'mlp' || tournament.format === 'mlp_random';
      if (needsTeams) {
        const rpcName =
          tournament.format === 'mlp_random' ? 'generate_random_mlp_teams' :
          tournament.format === 'mlp'        ? 'godmode_force_fill_mlp_teams' :
                                               'godmode_auto_pair_doubles_for_tournament';
        const params: Record<string, unknown> = { p_tournament_id: tournament.id };
        if (tournament.format === 'mlp_random') params.p_mode = 'snake';
        const teams = await tryRpc(rpcName, params);
        steps.push(teams.ok ? `Done: ${teams.message}` : `Skipped: teams (${teams.missing ? 'RPC missing' : teams.message})`);
      }

      // 3. Reload so generateBracket sees the newly approved/paired rows.
      await load();

      // 4. Generate the bracket preview.
      //    MLP formats need the server-side generate_mlp_bracket RPC because
      //    each round expands into 4 sub-matches (Men's / Women's / Mixed 1 /
      //    Mixed 2) that the local generateBracket() pure helpers don't
      //    produce — there is no client preview step for MLP, so that path
      //    goes live immediately.
      if (tournament.format === 'mlp' || tournament.format === 'mlp_random') {
        const mlpBracket = await tryRpc('generate_mlp_bracket', { p_tournament_id: tournament.id });
        steps.push(mlpBracket.ok
          ? `Done: Generated MLP schedule — live immediately (MLP has no preview step)`
          : `Failed: MLP bracket (${mlpBracket.missing ? 'RPC missing' : mlpBracket.message})`);
        const summary = steps.join('\n');
        if (mlpBracket.ok) { status.success(`Auto-setup complete\n${summary}`); load(); }
        else               { status.error(`Auto-setup partial\n${summary}`); }
        return;
      }

      const matches = await generateBracket();
      if (!matches || matches.length === 0) {
        steps.push('Skipped: bracket not generated (see prior alert)');
        status.error(`Auto-setup partial\n${steps.join('\n')}`);
        return;
      }
      steps.push(`Done: Generated ${matches.length}-match preview`);
      status.success(`Preview ready\n${steps.join('\n')}\nReview the draw below, then tap Lock in bracket.`);
    } catch (e: any) {
      steps.push(`Failed: ${e?.message ?? String(e)}`);
      status.error(`Auto-setup failed\n${steps.join('\n')}`);
    }
  }

  // ── Godmode delete (Brian only) ────────────────────────────
  function deleteTournament() {
    if (!tournament) return;
    setDeleteError(null);
    setShowDeleteConfirm(true);
  }

  async function confirmDeleteTournament() {
    if (!tournament) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      // Try the SECURITY DEFINER RPC first (bypasses RLS entirely). Falls
      // back to a direct DELETE if the RPC hasn't been deployed yet.
      const rpcRes = await supabase.rpc('godmode_delete_tournament', {
        p_tournament_id: tournament.id,
      });
      console.warn('[delete tournament rpc]', rpcRes);

      if (rpcRes.error) {
        const msg = rpcRes.error.message ?? '';
        const looksMissing =
          /function .* does not exist|Could not find the function|404|PGRST202/i.test(msg);
        if (!looksMissing) {
          setDeleteError(msg || 'Delete failed.');
          return;
        }
        // RPC missing — fall back to direct delete via RLS policy.
        const fallback = await supabase
          .from('tournaments')
          .delete()
          .eq('id', tournament.id)
          .select();
        console.warn('[delete tournament fallback]', fallback);
        if (fallback.error) {
          setDeleteError(fallback.error.message ?? 'Delete failed.');
          return;
        }
        if (!fallback.data || fallback.data.length === 0) {
          setDeleteError(
            'No rows were deleted. Run supabase/migration_add_godmode_delete_rpc.sql ' +
            '(or migration_add_godmode_delete.sql) in Supabase SQL Editor.'
          );
          return;
        }
      }

      setShowDeleteConfirm(false);
      navigation.goBack();
    } catch (e: any) {
      console.warn('[delete tournament] exception', e);
      setDeleteError(e?.message ?? String(e));
    } finally {
      setDeleting(false);
    }
  }

  // ── Complete tournament (admin) ────────────────────────────
  async function confirmCompleteTournament() {
    if (!tournament) return;
    setCompleting(true);
    setCompleteError(null);
    try {
      const { error } = await supabase.rpc('admin_complete_tournament', {
        p_tournament_id: tournament.id,
      });
      if (error) {
        setCompleteError(error.message ?? 'Complete failed.');
        return;
      }
      setShowCompleteConfirm(false);
      load();
    } catch (e: any) {
      setCompleteError(e?.message ?? String(e));
    } finally {
      setCompleting(false);
    }
  }

  // ── Cancel tournament (creator) ─────────────────────────────
  // Server-side RPC refunds every ante/contribution and open wager, then
  // flips status to cancelled and notifies participants.
  async function confirmCancelTournament() {
    if (!tournament) return;
    setCancelError(null);
    setCancelling(true);
    try {
      const { data, error } = await supabase.rpc('cancel_tournament', { p_tournament_id: tournament.id });
      if (error) { setCancelError(error.message ?? 'Cancel failed.'); return; }
      setShowCancelConfirm(false);
      status.success(typeof data === 'string' ? data : 'Tournament cancelled — everything refunded.');
      load();
    } catch (e: any) {
      setCancelError(e?.message ?? String(e));
    } finally {
      setCancelling(false);
    }
  }

  // ── Edit tournament (admin) ────────────────────────────────
  function openEditModal() {
    if (!tournament) return;
    setEditName(tournament.name);
    setEditDesc(tournament.description ?? '');
    setEditLocation(tournament.location_name ?? '');
    setEditMinPlayers(tournament.min_players != null ? String(tournament.min_players) : '');
    setEditMaxPlayers(tournament.max_players != null ? String(tournament.max_players) : '');
    setEditStartTime(tournament.start_time ? new Date(tournament.start_time) : null);
    setEditLengthHours(tournament.expected_length_hours != null ? String(tournament.expected_length_hours) : '');
    setEditAnte(tournament.pickle_ante != null ? String(tournament.pickle_ante) : '0');
    setEditPayout(Array.isArray(tournament.payout_structure) ? tournament.payout_structure.join(',') : '60,25,15');
    setEditPrizePool(tournament.prize_pool != null ? String(tournament.prize_pool) : '');
    setEditSeeding((tournament.seeding === 'elo' ? 'elo' : 'random'));
    setEditError(null);
    setShowEditModal(true);
  }

  async function saveTournamentEdits() {
    if (!tournament) return;
    setEditError(null);
    const name = editName.trim();
    if (!name) { setEditError('Tournament name is required.'); return; }
    const maxPlayersN = editMaxPlayers.trim() ? parseInt(editMaxPlayers.trim(), 10) : null;
    if (editMaxPlayers.trim() && (Number.isNaN(maxPlayersN!) || maxPlayersN! < 2)) {
      setEditError('Max players must be a number ≥ 2.'); return;
    }
    const minPlayersN = editMinPlayers.trim() ? parseInt(editMinPlayers.trim(), 10) : null;
    if (editMinPlayers.trim() && (Number.isNaN(minPlayersN!) || minPlayersN! < 2)) {
      setEditError('Min players must be a number ≥ 2.'); return;
    }
    if (minPlayersN != null && maxPlayersN != null && minPlayersN > maxPlayersN) {
      setEditError('Min players can\'t be greater than max players.'); return;
    }
    let lengthN: number | null = null;
    if (editLengthHours.trim()) {
      lengthN = parseFloat(editLengthHours.trim());
      if (Number.isNaN(lengthN) || lengthN < 0.5 || lengthN > 168) {
        setEditError('Expected length must be between 0.5 and 168 hours.'); return;
      }
    }

    // Ante (entry fee in pickles, ≥ 0)
    const anteN = editAnte.trim() ? parseInt(editAnte.trim(), 10) : 0;
    if (!Number.isFinite(anteN) || anteN < 0) {
      setEditError('Entry ante must be 0 or a positive integer.'); return;
    }

    // Payout structure (comma-separated %, sum to 100)
    const payoutParts = editPayout.split(',').map(s => parseInt(s.trim(), 10));
    if (payoutParts.some(n => !Number.isFinite(n) || n < 0)) {
      setEditError('Payout structure must be comma-separated non-negative integers.'); return;
    }
    if (payoutParts.reduce((a, b) => a + b, 0) !== 100) {
      setEditError('Payout structure must sum to 100 (e.g. 60,25,15).'); return;
    }

    // Prize pool override — leave null to let the existing accounting drive it
    let prizePoolN: number | null = null;
    if (editPrizePool.trim()) {
      prizePoolN = parseInt(editPrizePool.trim(), 10);
      if (!Number.isFinite(prizePoolN) || prizePoolN < 0) {
        setEditError('Prize pool must be 0 or a positive integer.'); return;
      }
    }

    setSavingEdit(true);
    const updatePayload: Record<string, any> = {
      name,
      description:           editDesc.trim() || null,
      location_name:         editLocation.trim() || null,
      min_players:           minPlayersN,
      max_players:           maxPlayersN,
      start_time:            editStartTime ? editStartTime.toISOString() : null,
      expected_length_hours: lengthN,
      pickle_ante:           anteN,
      payout_structure:      payoutParts,
      seeding:               editSeeding,
    };
    // Only override the pool when the admin explicitly typed a value.
    if (prizePoolN != null) updatePayload.prize_pool = prizePoolN;

    const { error } = await supabase.from('tournaments').update(updatePayload).eq('id', tournament.id);
    setSavingEdit(false);

    if (error) { setEditError(error.message); return; }
    setShowEditModal(false);
    setEditError(null);
    load();
  }

  async function saveBracketReleaseTime(date: Date) {
    setShowReleasePicker(false);
    await supabase.from('tournaments').update({ bracket_release_time: date.toISOString() }).eq('id', tournamentId);
    load();
  }

  // ── Bracket generation (admin only) ────────────────────────
  // Returns the generated MatchPairing[] (also written to state) so callers
  // that need to chain into doLockIn() can pass them directly instead of
  // waiting for a React state flush.
  async function generateBracket(): Promise<MatchPairing[] | null> {
    if (!tournament) return null;
    status.clear();
    const approved = registrations.filter(r => r.status === 'approved').map(r => r.user_id);
    if (approved.length < 2) { status.error('Need at least 2 approved players.'); return null; }

    // Wrap throws from the pure generators so an unexpected violation surfaces
    // as a user-facing banner instead of a silent crash.
    function bailFromError(label: string, e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      status.error(`Couldn't generate ${label}: ${msg}`);
    }

    function commit(matches: MatchPairing[]): MatchPairing[] {
      setGeneratedMatches(matches);
      return matches;
    }

    // ── MLP (Fixed Teams / Random Teams) ──
    // Validate that every mlp_teams row has all four slots filled before
    // attempting to generate a schedule. mlp_random tournaments still write
    // to mlp_teams once Generate Random Teams has been clicked, so the same
    // check applies.
    if (tournament.format === 'mlp' || tournament.format === 'mlp_random') {
      const { data: mlpRows, error: mlpErr } = await supabase
        .from('mlp_teams')
        .select('id, name, male_1_id, male_2_id, female_1_id, female_2_id')
        .eq('tournament_id', tournament.id);
      if (mlpErr) { status.error(`Could not load MLP teams: ${mlpErr.message}`); return null; }
      const teamRows = (mlpRows ?? []) as MlpTeamShape[];
      const teamError = validateMlpTeams(teamRows);
      if (teamError) { status.error(`MLP teams incomplete: ${teamError.message}`); return null; }

      // Build [string, string][] pairs from the validated teams for the
      // existing schedule generator (it treats each team as a 2-token pair).
      // We pass [male_1, male_2] as the token pair and rely on the live MLP
      // backend tables (mlp_team_standings, etc.) to track the actual 4-player
      // roster. The preview here is just round-by-round team matchups.
      const teams: [string, string][] = teamRows
        .map(t => [t.male_1_id!, t.male_2_id!] as [string, string]);

      try { return commit(generateMLPSchedule(teams)); }
      catch (e) { bailFromError('MLP bracket', e); return null; }
    }

    // ── Doubles tournaments with fixed pairs (round-robin / elim / pool play) ──
    const usesFixedPairs = tournament.match_type === 'doubles'
      && tournament.format !== 'rotating_partners';

    if (usesFixedPairs) {
      const approvedSet = new Set(approved);
      const teams: [string, string][] = [];
      const paired = new Set<string>();
      for (const p of doublesPairs) {
        if (p.partner_1_id && p.partner_2_id
            && approvedSet.has(p.partner_1_id) && approvedSet.has(p.partner_2_id)) {
          teams.push([p.partner_1_id, p.partner_2_id]);
          paired.add(p.partner_1_id);
          paired.add(p.partner_2_id);
        }
      }
      // REQUIRE every approved player to be locked into a pair of 2 before the
      // draw is generated. The old behavior silently random-paired leftovers
      // (never persisted — so the roster views disagreed with the draw) and
      // silently DROPPED an odd player, which surfaced as 1v1 "doubles"
      // matches. Now it's a hard stop naming the unpaired players.
      const leftovers = approved.filter(uid => !paired.has(uid));
      if (leftovers.length > 0) {
        const names = leftovers.map(uid => playerName(uid)).join(', ');
        const hint = tournament.team_creation === 'random'
          ? 'Use "Generate Random Pairs" in the Teams section to pair everyone.'
          : 'Everyone must pair up in the Teams section first.';
        status.error(`All players must be in a doubles pair of 2 before generating the draw. Unpaired (${leftovers.length}): ${names}. ${hint}`);
        return null;
      }
      if (teams.length < 2) {
        status.error('Not enough teams — need at least 2 doubles pairs to generate a bracket.');
        return null;
      }
      // Doubles elimination advancement can't (yet) reconstruct BYE slots the
      // way singles can — a non-power-of-2 team count strands the bracket
      // after round 1. Require 2/4/8/16 teams for elim formats.
      if ((tournament.format === 'single_elimination' || tournament.format === 'double_elimination')
          && (teams.length & (teams.length - 1)) !== 0) {
        status.error(`Doubles ${FORMAT_META[tournament.format].label} needs a power-of-2 team count (2, 4, 8, 16). You have ${teams.length} teams — add or remove a pair, or switch to Round Robin / Pool Play.`);
        return null;
      }
      // Validate every team has two distinct partners and no player is on
      // multiple teams.
      const teamErr = validateDoublesTeams(teams);
      if (teamErr) { status.error(`Doubles teams invalid: ${teamErr.message}`); return null; }

      const seededTeams = seedTeams(teams, profileRatings, tournament.seeding);
      seededOrderRef.current = seededTeams.flat();

      try {
        switch (tournament.format) {
          case 'round_robin':
            return commit(generateDoublesRoundRobin(seededTeams));
          case 'single_elimination':
            return commit(generateDoublesSingleElim(seededTeams));
          case 'double_elimination':
            return commit(generateDoublesDoubleElim(seededTeams));
          case 'pool_play': {
            const { pools: p, matches: m } = generateDoublesPoolPlay(seededTeams, tournament.pool_count);
            const poolErr = validatePools(p, tournament.pool_count, m);
            if (poolErr) { status.error(`Pool setup invalid: ${poolErr.message}`); return null; }
            setPools(p.map(pool => pool.flat()));
            return commit(m);
          }
        }
      } catch (e) { bailFromError('doubles bracket', e); }
      return null;
    }

    // ── Singles + Rotating-partners: existing per-player logic ──
    const seeded = seedPlayers(approved, profileRatings, tournament.seeding);
    seededOrderRef.current = seeded;

    // Singles DOUBLE elim also requires a power-of-2 field: the single-elim
    // advancement trigger reconstructs BYE slots from seeds, but the
    // double-elim one doesn't — a non-power-of-2 draw strands the bracket
    // after round 1 (found by the sweep: 5 players produced ONE match and a
    // garbage podium). Single elim singles handles byes fine.
    if (tournament.format === 'double_elimination' && tournament.match_type === 'singles'
        && (approved.length & (approved.length - 1)) !== 0) {
      status.error(`Double Elimination needs a power-of-2 player count (2, 4, 8, 16). You have ${approved.length} players — adjust the roster, or switch to Single Elim / Round Robin.`);
      return null;
    }

    try {
      switch (tournament.format) {
        case 'round_robin':
          return commit(generateRoundRobin(seeded));
        case 'single_elimination':
          return commit(generateSingleElim(seeded));
        case 'double_elimination':
          return commit(generateDoubleElim(seeded));
        case 'pool_play': {
          const { pools: p, matches: m } = generatePoolPlay(seeded, tournament.pool_count);
          const poolErr = validatePools(p, tournament.pool_count, m);
          if (poolErr) { status.error(`Pool setup invalid: ${poolErr.message}`); return null; }
          setPools(p);
          return commit(m);
        }
        case 'rotating_partners':
          return commit(generateRotatingPartners(seeded, Math.ceil(seeded.length / 4) * 3));
      }
    } catch (e) { bailFromError('bracket', e); }
    return null;
  }

  // ── Lock in bracket + notify ────────────────────────────────
  // Alert.alert with multiple buttons collapses to a single OK on web, which
  // killed this flow. Use a Modal instead — same pattern as Disband Team,
  // Delete Tournament confirm, etc.
  function lockInBracket() {
    if (!generatedMatches || !tournament) return;
    setLockInError(null);
    setShowLockInConfirm(true);
  }

  async function doLockIn(matchesArg?: MatchPairing[]) {
    if (lockingRef.current) return;
    // matchesArg lets callers (e.g. the godmode setup shortcut) pass freshly
    // generated matches directly, bypassing React state-flush timing.
    // Defensive: ignore non-array values — e.g., a TouchableOpacity
    // GestureResponderEvent if a button passes onConfirm={doLockIn} directly.
    const passed = Array.isArray(matchesArg) ? matchesArg : undefined;
    const matches = passed ?? generatedMatches;
    if (!matches || !tournament) return;
    // Min-roster gate (covers the godmode shortcut path too, which skips
    // the confirm modal and calls doLockIn directly).
    const approvedCount = registrations.filter(r => r.status === 'approved').length;
    if (tournament.min_players != null && approvedCount < tournament.min_players) {
      status.error(`This tournament needs at least ${tournament.min_players} approved players to lock in (currently ${approvedCount}).`);
      setShowLockInConfirm(false);
      return;
    }
    lockingRef.current = true;
    setLocking(true);

    try {
      // Lock-in is six sequential writes with no transaction behind it, and
      // neither tournament_rounds nor tournament_matches has a unique
      // constraint — so a connection that dropped halfway used to leave a
      // partial bracket that a retry then DUPLICATED. Everything below reads
      // what is already there and writes only what is missing, which makes
      // "just try again" the correct recovery instead of a second bug.
      const existingRounds = await sbCall(() => supabase
        .from('tournament_rounds')
        .select('id, round_number')
        .eq('tournament_id', tournament.id)) as { id: string; round_number: number }[] | null;

      // 0. Persist any novel doubles pairs used in the bracket preview.
      //    Non-MLP doubles tournaments may have included random pairings of
      //    previously-unpaired approved players — those rows weren't written
      //    to doubles_pairs yet. Insert them now so the pair section UI
      //    reflects every team that actually got locked in.
      const usesFixedPairs = tournament.match_type === 'doubles'
        && tournament.format !== 'mlp'
        && tournament.format !== 'mlp_random'
        && tournament.format !== 'rotating_partners';

      if (usesFixedPairs) {
        const alreadyPaired = new Set<string>();
        for (const p of doublesPairs) {
          if (p.partner_1_id) alreadyPaired.add(p.partner_1_id);
          if (p.partner_2_id) alreadyPaired.add(p.partner_2_id);
        }
        // Collect distinct teams from the generated matches.
        const novelPairs: { p1: string; p2: string }[] = [];
        const seenKey = new Set<string>();
        for (const m of matches) {
          for (const team of [m.team1, m.team2]) {
            const [a, b] = team;
            if (!a || !b || a === 'BYE' || b === 'BYE') continue;
            if (alreadyPaired.has(a) || alreadyPaired.has(b)) continue;
            const key = [a, b].sort().join('|');
            if (seenKey.has(key)) continue;
            seenKey.add(key);
            novelPairs.push({ p1: a, p2: b });
          }
        }
        if (novelPairs.length > 0) {
          try {
            await sbCall(() => supabase.rpc('persist_random_doubles_pairs', {
              p_tournament_id: tournament.id,
              p_pairs: novelPairs,
            }), { retries: 0 });
          } catch (pairErr) {
            // Non-fatal — bracket lock-in can still proceed.
            // eslint-disable-next-line no-console
            console.warn('[lock-in] failed to persist novel doubles pairs', pairErr);
          }
        }
      }

      // 1. Create round record(s). Pool play needs ONE round per pool so the
      // downstream renderer can group matches by pool (otherwise every match
      // collapses into "Pool A" because pool identity is lost).
      //
      // Derive the pool count from the matches themselves rather than the
      // `pools` React state — callers can pass freshly generated matches
      // before setPools has flushed, so reading `pools` would give us
      // stale/empty data and we'd fall through to the single-round branch.
      const isPoolPlay = tournament.format === 'pool_play';
      const roundType  = isPoolPlay ? 'pool' : 'winners';
      const poolCountFromMatches = isPoolPlay
        ? matches.reduce((max, m) => Math.max(max, (m.poolIndex ?? -1)), -1) + 1
        : 0;

      // poolIndex (0-based) → round.id. For non-pool-play, all matches share one round.
      const roundIdByPool = new Map<number, string>();
      let defaultRoundId: string | null = null;

      // round_number is what identifies a round within a tournament here, so a
      // round left behind by a failed attempt is reused rather than re-created.
      const roundByNumber = new Map((existingRounds ?? []).map(r => [r.round_number, r.id]));

      if (isPoolPlay && poolCountFromMatches > 0) {
        for (let pi = 0; pi < poolCountFromMatches; pi++) {
          const letter = String.fromCharCode(65 + pi);
          const already = roundByNumber.get(pi + 1);
          if (already) { roundIdByPool.set(pi, already); continue; }
          try {
            const poolRound = await sbCall(() => supabase
              .from('tournament_rounds')
              .insert({
                tournament_id: tournament.id,
                round_number: pi + 1,
                label:        `Pool ${letter}`,
                round_type:   'pool',
              })
              .select().single(), { retries: 0 }) as { id: string };
            roundIdByPool.set(pi, poolRound.id);
          } catch (prErr) {
            throw new Error(`Could not create Pool ${letter} round: ${friendlySbMessage(prErr, 'unknown error')}`);
          }
        }
      } else {
        const already = roundByNumber.get(1);
        if (already) {
          defaultRoundId = already;
        } else {
          try {
            const round = await sbCall(() => supabase
              .from('tournament_rounds')
              .insert({
                tournament_id: tournament.id,
                round_number: 1,
                label:        FORMAT_META[tournament.format].label + ' Schedule',
                round_type:   roundType,
              })
              .select().single(), { retries: 0 }) as { id: string };
            defaultRoundId = round.id;
          } catch (rErr) {
            throw new Error('Could not create round: ' + friendlySbMessage(rErr, 'unknown error'));
          }
        }
      }

      // 2. Save all matches — rotating_partners is always doubles regardless of setting
      const isRotating = tournament.format === 'rotating_partners' || tournament.format === 'mlp';
      const matchRows = matches.map((m, i) => {
        // Pool-play matches carry poolIndex (set in generatePoolPlay); fall back
        // to pool 0 if absent so we never write a null round_id.
        const roundId = isPoolPlay
          ? (roundIdByPool.get(m.poolIndex ?? 0) ?? roundIdByPool.get(0)!)
          : defaultRoundId!;
        return {
          tournament_id: tournament.id,
          round_id:      roundId,
          match_order:   i,
          match_type:    isRotating ? 'doubles' : tournament.match_type,
          team1_player1: m.team1[0] !== 'BYE' ? m.team1[0] : null,
          team1_player2: m.team1[1] && m.team1[1] !== 'BYE' ? m.team1[1] : null,
          team2_player1: m.team2[0] !== 'BYE' ? m.team2[0] : null,
          team2_player2: m.team2[1] && m.team2[1] !== 'BYE' ? m.team2[1] : null,
        };
      });

      // (round_id, match_order) identifies a match within the draw, so rows a
      // previous attempt already wrote are skipped rather than duplicated.
      //
      // But skipping is only correct when this is a RESUME of the same draw. If
      // the admin regenerated a different draw after a failed attempt, those
      // slots already hold different players, and silently keeping them would
      // splice two draws into one bracket — worse than either failure. So the
      // existing rows are compared against what we just generated, and a
      // mismatch stops with an explanation instead of half-applying.
      const existingMatches = await sbCall(() => supabase
        .from('tournament_matches')
        .select('round_id, match_order, team1_player1, team1_player2, team2_player1, team2_player2')
        .eq('tournament_id', tournament.id)) as {
          round_id: string; match_order: number;
          team1_player1: string | null; team1_player2: string | null;
          team2_player1: string | null; team2_player2: string | null;
        }[] | null;

      const slotKey = (r: { round_id: string; match_order: number }) => `${r.round_id}|${r.match_order}`;
      const lineup = (r: {
        team1_player1: string | null; team1_player2: string | null;
        team2_player1: string | null; team2_player2: string | null;
      }) => [r.team1_player1, r.team1_player2, r.team2_player1, r.team2_player2].join(',');

      const existingBySlot = new Map((existingMatches ?? []).map(m => [slotKey(m), m]));
      const conflicts = matchRows.filter(r => {
        const prior = existingBySlot.get(slotKey(r));
        return prior && lineup(prior) !== lineup(r);
      });
      if (conflicts.length > 0) {
        throw new Error(
          `This tournament already has ${existingBySlot.size} matches saved from an earlier Lock In, `
          + `and ${conflicts.length} of them don't match the draw you're locking in now. `
          + 'Locking in would mix the two draws. Delete the existing matches first if you meant to '
          + 'replace them, or re-run Lock In without regenerating to finish the original draw.',
        );
      }
      const pendingRows = matchRows.filter(r => !existingBySlot.has(slotKey(r)));

      // Insert in batches of 20 to avoid request size issues. Not retried: a
      // retry that lands after a lost reply would duplicate the batch, and the
      // re-read above is the safe way to resume instead.
      for (let i = 0; i < pendingRows.length; i += 20) {
        try {
          await sbCall(() => supabase.from('tournament_matches').insert(pendingRows.slice(i, i + 20)), { retries: 0 });
        } catch (mErr) {
          throw new Error(
            `Could not save matches (${i} of ${pendingRows.length} written): ${friendlySbMessage(mErr, 'unknown error')}. `
            + 'Run Lock In again once you have a connection — it resumes where it stopped.',
          );
        }
      }

      // 3. Update tournament status
      try {
        await sbCall(() => supabase.from('tournaments').update({ status: 'active' }).eq('id', tournament.id));
      } catch (sErr) {
        throw new Error('Could not update status: ' + friendlySbMessage(sErr, 'unknown error'));
      }

      // 3b. Persist the draw order as registration seeds — the advancement
      // triggers order registrations by seed to reconstruct round-1 slots.
      // This is the one step that must never fail quietly: a half-written seed
      // order still looks like a valid order to those triggers, so they advance
      // the WRONG players and nothing about the bracket looks broken.
      const seedOrder = seededOrderRef.current;
      if (seedOrder) {
        let seedFailures = 0;
        for (let i = 0; i < seedOrder.length; i++) {
          try {
            // Idempotent: a fixed seed keyed by (tournament, user).
            await sbCall(() => supabase.from('tournament_registrations')
              .update({ seed: i + 1 })
              .eq('tournament_id', tournament.id)
              .eq('user_id', seedOrder[i]));
          } catch {
            seedFailures++;
          }
        }
        if (seedFailures > 0) {
          throw new Error(
            `Seeds only partially saved (${seedFailures} of ${seedOrder.length} failed). `
            + 'Advancement rebuilds round 1 from seed order, so leaving it like this would advance the wrong players. '
            + 'Run Lock In again once you have a connection — it is safe to repeat and nothing will be duplicated.',
          );
        }
      }

      // 4. Notify each member individually to avoid RLS batch-check timeouts
      const approvedRegs = registrations.filter(r => r.status === 'approved');
      const memberIds = approvedRegs.map(r => r.user_id);
      // Announcements are the only step left that is safe to repeat but not
      // idempotent — a re-run re-announces. That's noise, never corruption, so
      // it stays unconditional rather than gating the bracket on it.
      let notifsFailed = 0;
      for (const uid of memberIds) {
        try {
          await sbCall(() => supabase.from('notifications').insert({
            user_id:     uid,
            title:       `🏆 Bracket Set — ${tournament.name}`,
            body:        `The draw has been finalized! ${matches.length} matches scheduled. Open the tournament to see your matches.`,
            type:        'tournament',
            entity_id:   tournament.id,
            entity_type: 'tournament',
          }), { retries: 0 });
        } catch {
          notifsFailed++;
        }
      }

      setGeneratedMatches(null);
      setPools(null);
      setShowLockInConfirm(false);
      load();

      const notified = memberIds.length - notifsFailed;
      const resumed = pendingRows.length < matchRows.length;
      status.success(
        `Bracket locked! Schedule saved — ${notified}/${memberIds.length} members notified.` +
          (notifsFailed > 0 ? ` (${notifsFailed} notifications failed)` : '') +
          // Say so plainly when this run only finished someone else's half-write.
          (resumed ? ` (resumed a previous attempt: ${matchRows.length - pendingRows.length} matches were already saved)` : '')
      );
    } catch (err: any) {
      const msg = friendlySbMessage(err, 'Unknown error. Please try again.');
      setLockInError(msg);
      // Also toast it — callers outside the confirm modal (godmode lock
      // button) never render lockInError.
      status.error(`Lock-in failed: ${msg}`);
    } finally {
      lockingRef.current = false;
      setLocking(false);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────
  function playerName(id: string | undefined): string {
    if (!id || id === 'BYE') return 'BYE';
    return profileNames[id] ?? '…';
  }

  // ── Wagering helpers ────────────────────────────────────────
  function openMatchWager(
    pickedTeam: 'team1' | 'team2',
    pick: { tournamentMatchId: string; team1Label: string; team2Label: string },
  ) {
    setWagerSubject({
      type: 'tournament_match',
      tournamentMatchId: pick.tournamentMatchId,
      teamLabels: { team1: pick.team1Label, team2: pick.team2Label },
      pickedTeam,
    });
    setWagerOpen(true);
  }

  function submitExactScore() {
    setExactScoreError(null);
    const t1 = parseInt(exactScoreT1.trim(), 10);
    const t2 = parseInt(exactScoreT2.trim(), 10);
    if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 < 0 || t2 < 0) {
      setExactScoreError('Both scores must be non-negative integers.');
      return;
    }
    const pick = wagerMatchPick;
    if (!pick) { setExactScoreError('Lost track of which match — try again.'); return; }
    setWagerSubject({
      type: 'tournament_match_score',
      tournamentMatchId: pick.tournamentMatchId,
      teamLabels: { team1: pick.team1Label, team2: pick.team2Label },
      team1Score: t1,
      team2Score: t2,
    });
    setExactScoreOpen(false);
    setExactScoreT1('');
    setExactScoreT2('');
    setWagerOpen(true);
  }

  function openMatchActionSheet(m: {
    id: string;
    team1_player1: string | null; team1_player2: string | null;
    team2_player1: string | null; team2_player2: string | null;
  }) {
    const team1Label = ([m.team1_player1, m.team1_player2].filter(Boolean) as string[]).map(playerName).join(' & ') || 'Team 1';
    const team2Label = ([m.team2_player1, m.team2_player2].filter(Boolean) as string[]).map(playerName).join(' & ') || 'Team 2';
    setWagerMatchPick({ tournamentMatchId: m.id, team1Label, team2Label });
    setActionSheetOpen(true);
  }

  function openMatchActionSheetById(matchId: string) {
    const m = savedMatches.find((sm: any) => sm.id === matchId);
    if (!m) return;
    openMatchActionSheet(m);
  }

  // ── Generate playoff (admin) ────────────────────────────────
  // Moved verbatim from the render-time closure in the Playoff Bracket
  // section; `ready` is the value that closure captured (every group-play
  // match complete), now passed in by the section.
  async function generatePlayoff(ready: boolean) {
    if (playoffGenRef.current) return;
    if (!ready) return;
    playoffGenRef.current = true;
    status.clear();
    setGeneratingPlayoff(true);
    try {
      // Not retried: a second run would write a second playoff bracket.
      await sbCall(() => supabase.rpc('generate_playoff_bracket', {
        p_tournament_id: tournamentId,
      }), { retries: 0 });
      await load();
      status.success('Playoff bracket generated.');
    } catch (e) {
      // Alert.alert renders nothing on react-native-web, so this
      // failure was completely invisible on the web build.
      status.error(`Playoff generation failed: ${friendlySbMessage(e, 'unknown error')}`);
    } finally {
      playoffGenRef.current = false;
      setGeneratingPlayoff(false);
    }
  }

  return {
    status, refresh, load, loading, loadError,
    // Data
    tournament, registrations, myRole, myUserId, godmode,
    doublesPairs, savedMatches, savedRounds, mlpStandings,
    profileNames, profileRatings, wagerMarketSorted, finalRanks, mlpTeams,
    // Schedule filter
    myMatchesOnly, setMyMatchesOnly,
    // Registration
    register, approveReg, rejectReg, respondToTournamentInvite,
    // Bracket release time
    showReleasePicker, setShowReleasePicker, saveBracketReleaseTime,
    // Bracket preview + lock-in
    generatedMatches, pools, locking, generateBracket, lockInBracket, doLockIn,
    showLockInConfirm, setShowLockInConfirm, lockInError,
    // Playoff
    generatingPlayoff, generatePlayoff,
    // Lifecycle (complete / cancel / delete / payout)
    showCompleteConfirm, setShowCompleteConfirm, completing, completeError, confirmCompleteTournament,
    showCancelConfirm, setShowCancelConfirm, cancelling, cancelError, setCancelError, confirmCancelTournament,
    showDeleteConfirm, setShowDeleteConfirm, deleting, deleteError, deleteTournament, confirmDeleteTournament,
    showPayoutModal, setShowPayoutModal,
    // Godmode
    simulating, simulateFillMatches,
    godmodeApproveAllInvitees, godmodeForceCreateTeams, godmodeAutoGeneratePreview,
    // Edit modal
    showEditModal, setShowEditModal, openEditModal, saveTournamentEdits, editError, savingEdit,
    editName, setEditName, editDesc, setEditDesc, editLocation, setEditLocation,
    editMinPlayers, setEditMinPlayers, editMaxPlayers, setEditMaxPlayers,
    editStartTime, setEditStartTime, editLengthHours, setEditLengthHours,
    editAnte, setEditAnte, editPayout, setEditPayout, editPrizePool, setEditPrizePool,
    editSeeding, setEditSeeding, showStartPicker, setShowStartPicker,
    // Wagers
    wagerSubject, setWagerSubject, wagerOpen, setWagerOpen,
    wagerMatchPick, setWagerMatchPick, actionSheetOpen, setActionSheetOpen,
    exactScoreOpen, setExactScoreOpen, exactScoreT1, setExactScoreT1,
    exactScoreT2, setExactScoreT2, exactScoreError, setExactScoreError,
    wagerMarketOpen, setWagerMarketOpen, wagerMarketShowAll, setWagerMarketShowAll,
    openMatchWager, submitExactScore, openMatchActionSheet, openMatchActionSheetById,
    // Helpers
    playerName,
  };
}

export type TournamentDetailState = ReturnType<typeof useTournamentDetail>;
