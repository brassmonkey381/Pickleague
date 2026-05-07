import React, { useState, useCallback } from 'react';
import {
  ScrollView, View, Text, TouchableOpacity, Modal, Pressable,
  StyleSheet, Alert, ActivityIndicator, FlatList,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { Tournament, TournamentRegistration, Profile, RootStackParamList } from '../types';
import {
  getTournamentRole, isTournamentPrivileged, requiresPartner,
  bracketReleaseLabel, tournamentRoleLabel, tournamentRoleBadgeColor,
  TournamentRole,
} from '../lib/tournamentRole';
import {
  FORMAT_META, seedPlayers, generateRoundRobin, generatePoolPlay,
  generateSingleElim, generateRotatingPartners, generateMLPSchedule, MatchPairing,
} from '../lib/tournament';
import AppDateTimePicker from '../components/AppDateTimePicker';
import TournamentBracket, { BracketSlot } from '../components/TournamentBracket';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TournamentDetail'>;
  route: RouteProp<RootStackParamList, 'TournamentDetail'>;
};

type PartnerRequest = {
  id: string;
  requester_id: string;
  requested_id: string;
  status: 'pending' | 'accepted' | 'rejected';
  requesterProfile?: Profile;
  requestedProfile?: Profile;
};

export default function TournamentDetailScreen({ navigation, route }: Props) {
  const { tournamentId } = route.params;

  const [tournament, setTournament]       = useState<Tournament | null>(null);
  const [registrations, setRegistrations] = useState<TournamentRegistration[]>([]);
  const [myRole, setMyRole]               = useState<TournamentRole>(null);
  const [myUserId, setMyUserId]           = useState<string | null>(null);
  const [partnerRequests, setPartnerRequests] = useState<PartnerRequest[]>([]);
  const [generatedMatches, setGeneratedMatches] = useState<MatchPairing[] | null>(null);
  const [pools, setPools]                 = useState<string[][] | null>(null);
  const [locking, setLocking]             = useState(false);
  const [savedMatches, setSavedMatches]   = useState<any[]>([]);
  const [savedRounds, setSavedRounds]     = useState<any[]>([]);
  const [myMatchesOnly, setMyMatchesOnly] = useState(false);
  const [profileNames, setProfileNames]   = useState<Record<string, string>>({});
  const [profileRatings, setProfileRatings] = useState<Record<string, number>>({});
  const [loading, setLoading]             = useState(true);

  // Bracket release time picker
  const [showReleasePicker, setShowReleasePicker] = useState(false);

  // Partner selection modal
  const [showPartnerModal, setShowPartnerModal] = useState(false);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id ?? null;
    setMyUserId(uid);

    const [tRes, regRes, role] = await Promise.all([
      supabase.from('tournaments').select('*').eq('id', tournamentId).single(),
      supabase.from('tournament_registrations')
        .select('*, profile:profiles(id, full_name, rating)')
        .eq('tournament_id', tournamentId)
        .order('role'),
      getTournamentRole(tournamentId),
    ]);

    const t = tRes.data as Tournament;
    setTournament(t);
    setMyRole(role);

    const regs = (regRes.data ?? []) as TournamentRegistration[];
    setRegistrations(regs);

    const names: Record<string, string> = {};
    const ratings: Record<string, number> = {};
    regs.forEach(r => {
      if (r.profile) { names[r.user_id] = r.profile.full_name; ratings[r.user_id] = (r.profile as any).rating ?? 1000; }
    });
    setProfileNames(names);
    setProfileRatings(ratings);

    // Load saved matches + rounds if tournament is active
    if (t?.status === 'active') {
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
      setSavedMatches(smRes.data ?? []);
      setSavedRounds(srRes.data ?? []);
    }

    // Load partner requests if format requires it
    if (requiresPartner(t?.format ?? '') && uid) {
      const { data: pr } = await supabase
        .from('tournament_partner_requests')
        .select('*, requesterProfile:profiles!tournament_partner_requests_requester_id_fkey(id, full_name), requestedProfile:profiles!tournament_partner_requests_requested_id_fkey(id, full_name)')
        .eq('tournament_id', tournamentId)
        .or(`requester_id.eq.${uid},requested_id.eq.${uid}`);
      setPartnerRequests((pr ?? []) as PartnerRequest[]);
    }

    setLoading(false);
  }

  // ── Registration ────────────────────────────────────────────
  async function register() {
    const { error } = await supabase.from('tournament_registrations').insert({
      tournament_id: tournamentId, user_id: myUserId,
    });
    if (error) Alert.alert('Error', error.message);
    else load();
  }

  async function approveReg(regId: string) {
    await supabase.from('tournament_registrations').update({ status: 'approved' }).eq('id', regId);
    load();
  }
  async function rejectReg(regId: string) {
    await supabase.from('tournament_registrations').update({ status: 'rejected' }).eq('id', regId);
    load();
  }

  // ── Bracket release time ────────────────────────────────────
  async function saveBracketReleaseTime(date: Date) {
    setShowReleasePicker(false);
    await supabase.from('tournaments').update({ bracket_release_time: date.toISOString() }).eq('id', tournamentId);
    load();
  }

  // ── Bracket generation (admin only) ────────────────────────
  function generateBracket() {
    if (!tournament) return;
    const approved = registrations.filter(r => r.status === 'approved').map(r => r.user_id);
    if (approved.length < 2) { Alert.alert('Need at least 2 approved players.'); return; }

    const seeded = seedPlayers(approved, profileRatings, tournament.seeding);

    switch (tournament.format) {
      case 'round_robin':
        setGeneratedMatches(generateRoundRobin(seeded)); break;
      case 'single_elimination':
      case 'double_elimination':
        setGeneratedMatches(generateSingleElim(seeded)); break;
      case 'pool_play': {
        const { pools: p, matches: m } = generatePoolPlay(seeded, tournament.pool_count);
        setPools(p); setGeneratedMatches(m); break;
      }
      case 'rotating_partners':
        setGeneratedMatches(generateRotatingPartners(seeded, Math.ceil(seeded.length / 4) * 3)); break;
      case 'mlp': {
        const teams: [string, string][] = [];
        for (let i = 0; i + 1 < seeded.length; i += 2) teams.push([seeded[i], seeded[i+1]]);
        setGeneratedMatches(generateMLPSchedule(teams)); break;
      }
    }
  }

  // ── Lock in bracket + notify ────────────────────────────────
  async function lockInBracket() {
    if (!generatedMatches || !tournament) return;

    Alert.alert(
      'Lock in bracket?',
      `This will finalize the schedule and notify all ${approved.length} members. You won't be able to regenerate after this.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Lock In & Notify', style: 'default', onPress: doLockIn },
      ]
    );
  }

  async function doLockIn() {
    if (!generatedMatches || !tournament) return;
    setLocking(true);

    try {
      // 1. Create a round record
      const roundType = tournament.format === 'pool_play' ? 'pool' : 'winners';
      const { data: round, error: rErr } = await supabase
        .from('tournament_rounds')
        .insert({
          tournament_id: tournament.id,
          round_number: 1,
          label: FORMAT_META[tournament.format].label + ' Schedule',
          round_type: roundType,
        })
        .select().single();
      if (rErr) throw new Error('Could not create round: ' + rErr.message);

      // 2. Save all matches — rotating_partners is always doubles regardless of setting
      const isRotating = tournament.format === 'rotating_partners' || tournament.format === 'mlp';
      const matchRows = generatedMatches.map((m, i) => ({
        tournament_id: tournament.id,
        round_id:      round.id,
        match_order:   i,
        match_type:    isRotating ? 'doubles' : tournament.match_type,
        team1_player1: m.team1[0] !== 'BYE' ? m.team1[0] : null,
        team1_player2: m.team1[1] && m.team1[1] !== 'BYE' ? m.team1[1] : null,
        team2_player1: m.team2[0] !== 'BYE' ? m.team2[0] : null,
        team2_player2: m.team2[1] && m.team2[1] !== 'BYE' ? m.team2[1] : null,
      }));

      // Insert in batches of 20 to avoid request size issues
      for (let i = 0; i < matchRows.length; i += 20) {
        const { error: mErr } = await supabase.from('tournament_matches').insert(matchRows.slice(i, i + 20));
        if (mErr) throw new Error('Could not save matches: ' + mErr.message);
      }

      // 3. Update tournament status
      const { error: sErr } = await supabase.from('tournaments').update({ status: 'active' }).eq('id', tournament.id);
      if (sErr) throw new Error('Could not update status: ' + sErr.message);

      // 4. Notify each member individually to avoid RLS batch-check timeouts
      const memberIds = approved.map(r => r.user_id);
      let notifsFailed = 0;
      for (const uid of memberIds) {
        const { error: nErr } = await supabase.from('notifications').insert({
          user_id:     uid,
          title:       `🏆 Bracket Set — ${tournament.name}`,
          body:        `The draw has been finalized! ${generatedMatches.length} matches scheduled. Open the tournament to see your matches.`,
          type:        'tournament',
          entity_id:   tournament.id,
          entity_type: 'tournament',
        });
        if (nErr) notifsFailed++;
      }

      setGeneratedMatches(null);
      setPools(null);
      load();

      const notified = memberIds.length - notifsFailed;
      Alert.alert(
        '✓ Bracket locked!',
        `Schedule saved — ${notified}/${memberIds.length} members notified.` +
          (notifsFailed > 0 ? ` (${notifsFailed} notifications failed)` : '')
      );
    } catch (err: any) {
      Alert.alert('Lock-in failed', err.message ?? 'Unknown error. Please try again.');
    } finally {
      setLocking(false);
    }
  }

  // ── Partner requests ────────────────────────────────────────
  async function sendPartnerRequest(targetId: string) {
    setShowPartnerModal(false);
    const { error } = await supabase.from('tournament_partner_requests').upsert({
      tournament_id: tournamentId, requester_id: myUserId!, requested_id: targetId, status: 'pending',
    });
    if (error) Alert.alert('Error', error.message);
    else { Alert.alert('Request sent!', 'They\'ll be notified to accept or decline.'); load(); }
  }

  async function respondToPartnerRequest(reqId: string, accept: boolean) {
    await supabase.from('tournament_partner_requests')
      .update({ status: accept ? 'accepted' : 'rejected' }).eq('id', reqId);
    load();
  }

  async function cancelPartnerRequest(reqId: string) {
    await supabase.from('tournament_partner_requests').delete().eq('id', reqId);
    load();
  }

  // ── Helpers ─────────────────────────────────────────────────
  function playerName(id: string | undefined): string {
    if (!id || id === 'BYE') return 'BYE';
    return profileNames[id] ?? '…';
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;
  if (!tournament) return <Text style={styles.empty}>Tournament not found.</Text>;

  const fmt        = FORMAT_META[tournament.format];
  const approved   = registrations.filter(r => r.status === 'approved');
  const pending    = registrations.filter(r => r.status === 'pending');
  const myReg      = registrations.find(r => r.user_id === myUserId);
  const isPriv     = isTournamentPrivileged(myRole);
  const isAdmin    = myRole === 'admin';
  const canRegister = !myReg && tournament.status === 'registration'
                       && tournament.registration_mode === 'request';
  const bracketLabel = bracketReleaseLabel(tournament.bracket_release_time);

  // Partner state for current user
  const myPartnerReqSent     = partnerRequests.find(r => r.requester_id === myUserId && r.status === 'pending');
  const myPartnerReqReceived = partnerRequests.find(r => r.requested_id === myUserId && r.status === 'pending');
  const myConfirmedPartner   = partnerRequests.find(r =>
    (r.requester_id === myUserId || r.requested_id === myUserId) && r.status === 'accepted'
  );
  const myPartnerUserId = myConfirmedPartner
    ? (myConfirmedPartner.requester_id === myUserId ? myConfirmedPartner.requested_id : myConfirmedPartner.requester_id)
    : null;

  // Available partners = approved members without a confirmed partner and not myself
  const takenPartnerIds = new Set(
    partnerRequests.filter(r => r.status === 'accepted').flatMap(r => [r.requester_id, r.requested_id])
  );
  const availablePartners = approved.filter(r =>
    r.user_id !== myUserId && !takenPartnerIds.has(r.user_id)
  );

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 48 }}>

        {/* ── Header ── */}
        <View style={styles.headerCard}>
          <View style={styles.headerTop}>
            <Text style={styles.fmtIcon}>{fmt.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.fmtLabel}>{fmt.label}</Text>
              <Text style={styles.fmtDesc}>{fmt.description}</Text>
            </View>
            {myRole && (
              <View style={[styles.myRoleBadge, { backgroundColor: tournamentRoleBadgeColor(myRole) + '22', borderColor: tournamentRoleBadgeColor(myRole) + '55' }]}>
                <Text style={[styles.myRoleText, { color: tournamentRoleBadgeColor(myRole) }]}>
                  {tournamentRoleLabel(myRole)}
                </Text>
              </View>
            )}
          </View>

          {/* Settings chips */}
          <View style={styles.chipsRow}>
            <Text style={styles.chip}>{tournament.match_type === 'doubles' ? '2v2' : '1v1'}</Text>
            <Text style={styles.chip}>{tournament.seeding === 'elo' ? '📊 ELO seeded' : '🎲 Random'}</Text>
            {tournament.format === 'pool_play' && <Text style={styles.chip}>{tournament.pool_count} pools</Text>}
            {tournament.partner_rotation && <Text style={styles.chip}>Rotate {tournament.partner_rotation.replace('_', ' ')}</Text>}
            <Text style={styles.chip}>{tournament.registration_mode === 'invite_only' ? '🔒 Invite only' : '📝 Requests'}</Text>
          </View>

          {tournament.start_time && (
            <Text style={styles.metaLine}>📅 {new Date(tournament.start_time).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text>
          )}
          {tournament.location_name && <Text style={styles.metaLine}>📍 {tournament.location_name}</Text>}
          {tournament.description && <Text style={styles.desc}>{tournament.description}</Text>}
        </View>

        {/* ── Member: bracket release countdown ── */}
        {myReg?.status === 'approved' && !generatedMatches && (
          <View style={styles.infoBox}>
            {bracketLabel ? (
              <>
                <Text style={styles.infoIcon}>⏰</Text>
                <Text style={styles.infoText}>{bracketLabel}</Text>
              </>
            ) : (
              <>
                <Text style={styles.infoIcon}>🗓️</Text>
                <Text style={styles.infoText}>Bracket release date hasn't been set yet. Check back soon!</Text>
              </>
            )}
          </View>
        )}

        {/* ── Admin: set bracket release time ── */}
        {isPriv && !generatedMatches && (
          <TouchableOpacity style={styles.setReleaseBtn} onPress={() => setShowReleasePicker(true)}>
            <Text style={styles.setReleaseBtnText}>
              {tournament.bracket_release_time
                ? `⏰ Bracket release: ${new Date(tournament.bracket_release_time).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}  (tap to change)`
                : '⏰ Set expected bracket release time'}
            </Text>
          </TouchableOpacity>
        )}

        {/* ── Registration ── */}
        {canRegister && (
          <TouchableOpacity style={styles.registerBtn} onPress={register}>
            <Text style={styles.registerBtnText}>📝 Request to Join</Text>
          </TouchableOpacity>
        )}
        {tournament.registration_mode === 'invite_only' && !myReg && (
          <View style={styles.inviteNote}>
            <Text style={styles.inviteNoteText}>🔒 This tournament is invite only. Contact an organizer to be added.</Text>
          </View>
        )}
        {myReg && (
          <View style={[styles.myRegBadge,
            myReg.status === 'approved' ? styles.regApproved :
            myReg.status === 'rejected' ? styles.regRejected : styles.regPending]}>
            <Text style={styles.myRegText}>
              {myReg.status === 'approved' ? '✓ You\'re in the tournament!'
               : myReg.status === 'rejected' ? '✗ Request not approved'
               : '⏳ Registration pending — an admin will review your request shortly.'}
            </Text>
          </View>
        )}

        {/* ── Partner section (MLP / fixed format + approved member) ── */}
        {requiresPartner(tournament.format) && myReg?.status === 'approved' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Your Partner</Text>

            {myConfirmedPartner ? (
              <View style={styles.partnerConfirmed}>
                <Text style={styles.partnerConfirmedIcon}>🤝</Text>
                <Text style={styles.partnerConfirmedName}>{playerName(myPartnerUserId ?? undefined)}</Text>
                <Text style={styles.partnerConfirmedNote}>Partner confirmed</Text>
              </View>
            ) : myPartnerReqSent ? (
              <View style={styles.partnerPending}>
                <Text style={styles.partnerPendingText}>
                  ⏳ Waiting for {playerName(myPartnerReqSent.requested_id)} to accept your request.
                </Text>
                <TouchableOpacity onPress={() => cancelPartnerRequest(myPartnerReqSent.id)}>
                  <Text style={styles.cancelReqText}>Cancel request</Text>
                </TouchableOpacity>
              </View>
            ) : myPartnerReqReceived ? (
              <View style={styles.partnerRequest}>
                <Text style={styles.partnerReqText}>
                  {playerName(myPartnerReqReceived.requester_id)} wants to be your partner!
                </Text>
                <View style={styles.partnerReqActions}>
                  <TouchableOpacity style={styles.acceptBtn} onPress={() => respondToPartnerRequest(myPartnerReqReceived.id, true)}>
                    <Text style={styles.acceptBtnText}>Accept</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.declineBtn} onPress={() => respondToPartnerRequest(myPartnerReqReceived.id, false)}>
                    <Text style={styles.declineBtnText}>Decline</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <>
                <Text style={styles.noPartnerText}>You don't have a partner yet.</Text>
                <TouchableOpacity style={styles.findPartnerBtn} onPress={() => setShowPartnerModal(true)}>
                  <Text style={styles.findPartnerBtnText}>🔍 Find a Partner</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {/* ── Approved players ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>
              Players ({approved.length}{tournament.max_players ? `/${tournament.max_players}` : ''})
            </Text>
            {isPriv && (
              <TouchableOpacity onPress={() => navigation.navigate('TournamentMembers', { tournamentId, tournamentName: tournament.name })}>
                <Text style={styles.manageLinkText}>Manage Roles →</Text>
              </TouchableOpacity>
            )}
          </View>
          {approved.map((r, i) => {
            const role = r.role as TournamentRole;
            const bc = tournamentRoleBadgeColor(role);
            return (
              <View key={r.id} style={styles.playerRow}>
                <Text style={styles.playerSeed}>#{i + 1}</Text>
                <Text style={styles.playerName}>{r.profile?.full_name ?? '—'}</Text>
                <Text style={styles.playerRating}>{(r.profile as any)?.rating ?? 1000}</Text>
                {role !== 'member' && (
                  <View style={[styles.rolePill, { backgroundColor: bc + '22', borderColor: bc }]}>
                    <Text style={[styles.rolePillText, { color: bc }]}>{tournamentRoleLabel(role)}</Text>
                  </View>
                )}
              </View>
            );
          })}
          {approved.length === 0 && <Text style={styles.emptySection}>No approved players yet.</Text>}
        </View>

        {/* ── Pending requests (admin/co-admin only) ── */}
        {isPriv && pending.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Pending Requests ({pending.length})</Text>
            {pending.map(r => (
              <View key={r.id} style={styles.pendingRow}>
                <Text style={styles.playerName} numberOfLines={1}>{r.profile?.full_name ?? '—'}</Text>
                <Text style={styles.playerRating}>{(r.profile as any)?.rating ?? 1000} ELO</Text>
                <View style={styles.pendingActions}>
                  <TouchableOpacity style={styles.approveBtn} onPress={() => approveReg(r.id)}>
                    <Text style={styles.approveBtnText}>✓</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.rejectBtn} onPress={() => rejectReg(r.id)}>
                    <Text style={styles.rejectBtnText}>✕</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* ── Generate / Lock bracket ── */}
        {tournament.status !== 'active' && isAdmin && approved.length >= 2 && (
          <>
            <TouchableOpacity style={styles.generateBtn} onPress={generateBracket}>
              <Text style={styles.generateBtnText}>⚡ {generatedMatches ? 'Re-generate Preview' : `Generate ${fmt.label} Schedule`}</Text>
            </TouchableOpacity>
            {generatedMatches && (
              <TouchableOpacity
                style={[styles.lockBtn, locking && styles.lockBtnDisabled]}
                onPress={lockInBracket}
                disabled={locking}
              >
                <Text style={styles.lockBtnText}>
                  {locking ? 'Locking in…' : `🔒 Lock In & Notify ${approved.length} Members`}
                </Text>
              </TouchableOpacity>
            )}
          </>
        )}
        {tournament.status === 'active' && (
          <View style={styles.activeBanner}>
            <Text style={styles.activeBannerText}>✓ Bracket finalized — all members notified</Text>
          </View>
        )}
        {!isAdmin && isPriv && tournament.status !== 'active' && (
          <View style={styles.coAdminNote}>
            <Text style={styles.coAdminNoteText}>Only the tournament admin can generate the bracket.</Text>
          </View>
        )}

        {/* ── Pools ── */}
        {pools && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Pool Assignments ({tournament.seeding === 'elo' ? 'ELO snake-draft' : 'random'})</Text>
            {pools.map((pool, pi) => (
              <View key={pi} style={styles.poolCard}>
                <Text style={styles.poolLabel}>Pool {String.fromCharCode(65 + pi)}</Text>
                {pool.map(uid => <Text key={uid} style={styles.poolPlayer}>• {playerName(uid)}</Text>)}
              </View>
            ))}
          </View>
        )}

        {/* ── Pool-play bracket view ── */}
        {tournament.status === 'active' && tournament.format === 'pool_play' && savedRounds.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Tournament Bracket</Text>

            {/* Advancement criteria */}
            <View style={styles.advancementCard}>
              <Text style={styles.advancementTitle}>How teams advance</Text>
              <Text style={styles.advancementRule}>
                {'🏆  '}The <Text style={styles.bold}>top 2 teams</Text> from each pool advance to the semi-finals, determined by:
              </Text>
              <Text style={styles.advancementPoint}>1.  Best win/loss record</Text>
              <Text style={styles.advancementPoint}>2.  Point differential (if tied on record)</Text>
            </View>

            <View style={styles.bracketDivider} />

            {/* Visual bracket — positional labels only, no team names yet */}
            <TournamentBracket
              slotA1={{ label: 'Pool A · 1st Place' }}
              slotB2={{ label: 'Pool B · 2nd Place' }}
              slotB1={{ label: 'Pool B · 1st Place' }}
              slotA2={{ label: 'Pool A · 2nd Place' }}
              semi1={{ label: 'Semi-Final 1' }}
              semi2={{ label: 'Semi-Final 2' }}
              final={{ label: 'Grand Final' }}
            />
          </View>
        )}

        {/* ── Saved schedule (tournament is active) ── */}
        {tournament.status === 'active' && savedMatches.length > 0 && (() => {
          const myCount = savedMatches.filter(m =>
            myUserId && [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].includes(myUserId)
          ).length;
          const displayed = myMatchesOnly
            ? savedMatches.filter(m => myUserId && [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].includes(myUserId))
            : savedMatches;

          return (
            <View style={styles.section}>
              {/* Filter toggle */}
              <View style={styles.scheduleHeader}>
                <Text style={styles.sectionTitle}>
                  Match Schedule ({displayed.length}{myMatchesOnly ? '' : ` of ${savedMatches.length}`})
                </Text>
                <TouchableOpacity
                  style={[styles.myMatchesToggle, myMatchesOnly && styles.myMatchesToggleOn]}
                  onPress={() => setMyMatchesOnly(v => !v)}
                >
                  <Text style={[styles.myMatchesToggleText, myMatchesOnly && styles.myMatchesToggleTextOn]}>
                    {myMatchesOnly ? '👤 My matches' : '👥 All matches'}
                  </Text>
                </TouchableOpacity>
              </View>

              {myMatchesOnly && myCount === 0 && (
                <Text style={styles.noMyMatches}>You have no scheduled matches in this tournament.</Text>
              )}

              {displayed.map((m, i) => {
                const t1 = [m.team1_player1, m.team1_player2].filter(Boolean).map(playerName).join(' & ');
                const t2 = [m.team2_player1, m.team2_player2].filter(Boolean).map(playerName).join(' & ');
                const isMyMatch = myUserId && [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].includes(myUserId);
                return (
                  <View key={m.id} style={[styles.matchRow, isMyMatch && styles.matchRowHighlight]}>
                    <Text style={styles.matchNum}>{i + 1}</Text>
                    <Text style={[styles.matchup, isMyMatch && styles.matchupHighlight]} numberOfLines={1}>{t1}</Text>
                    <Text style={styles.vs}>vs</Text>
                    <Text style={[styles.matchup, isMyMatch && styles.matchupHighlight]} numberOfLines={1}>{t2}</Text>
                    {isMyMatch && <Text style={styles.myMatchTag}>YOU</Text>}
                  </View>
                );
              })}
            </View>
          );
        })()}

        {/* ── Generated preview schedule (before lock-in) ── */}
        {generatedMatches && generatedMatches.length > 0 && (() => {
          const previewFiltered = myMatchesOnly
            ? generatedMatches.filter(m => myUserId && (m.team1.includes(myUserId) || m.team2.includes(myUserId)))
            : generatedMatches;
          const rounds = [...new Set(previewFiltered.map(m => m.round))].sort((a,b) => a-b);

          return (
            <View style={styles.section}>
              <View style={styles.previewBanner}>
                <Text style={styles.previewBannerText}>👁 Preview — tap "Lock In" above to save and notify members</Text>
              </View>

              {/* Filter toggle */}
              <View style={styles.scheduleHeader}>
                <Text style={styles.sectionTitle}>
                  Preview ({previewFiltered.length}{myMatchesOnly ? '' : ` of ${generatedMatches.length}`} matches)
                </Text>
                <TouchableOpacity
                  style={[styles.myMatchesToggle, myMatchesOnly && styles.myMatchesToggleOn]}
                  onPress={() => setMyMatchesOnly(v => !v)}
                >
                  <Text style={[styles.myMatchesToggleText, myMatchesOnly && styles.myMatchesToggleTextOn]}>
                    {myMatchesOnly ? '👤 My matches' : '👥 All matches'}
                  </Text>
                </TouchableOpacity>
              </View>

              {rounds.map(r => (
                <View key={r} style={styles.roundBlock}>
                  <Text style={styles.roundLabel}>
                    {generatedMatches.find(m => m.round === r)?.label?.split('·')[0]?.trim() ?? `Round ${r}`}
                  </Text>
                  {previewFiltered.filter(m => m.round === r).map((m, mi) => {
                    const t1 = m.team1.map(playerName).join(' & ');
                    const t2 = m.team2.map(playerName).join(' & ');
                    const isMyMatch = myUserId && (m.team1.includes(myUserId) || m.team2.includes(myUserId));
                    return (
                      <View key={mi} style={[styles.matchRow, isMyMatch && styles.matchRowHighlight]}>
                        <Text style={styles.matchNum}>{mi+1}</Text>
                        <Text style={[styles.matchup, isMyMatch && styles.matchupHighlight]} numberOfLines={1}>{t1}</Text>
                        <Text style={styles.vs}>vs</Text>
                        <Text style={[styles.matchup, isMyMatch && styles.matchupHighlight]} numberOfLines={1}>{t2}</Text>
                        {isMyMatch && <Text style={styles.myMatchTag}>YOU</Text>}
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          );
        })()}

      </ScrollView>

      {/* ── Bracket release time picker ── */}
      <AppDateTimePicker
        visible={showReleasePicker}
        value={tournament.bracket_release_time ? new Date(tournament.bracket_release_time) : new Date(Date.now() + 86400000)}
        minimumDate={new Date()}
        onChange={saveBracketReleaseTime}
        onClose={() => setShowReleasePicker(false)}
      />

      {/* ── Partner selection modal ── */}
      <Modal visible={showPartnerModal} transparent animationType="slide" onRequestClose={() => setShowPartnerModal(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowPartnerModal(false)}>
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <Text style={styles.modalTitle}>Request a Partner</Text>
            <Text style={styles.modalSubtitle}>{availablePartners.length} player{availablePartners.length !== 1 ? 's' : ''} available</Text>
            <FlatList
              data={availablePartners}
              keyExtractor={i => i.id}
              scrollEnabled={availablePartners.length > 6}
              style={{ maxHeight: 320 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.partnerOption} onPress={() => sendPartnerRequest(item.user_id)}>
                  <View style={styles.partnerOptionAvatar}>
                    <Text style={styles.partnerOptionInitial}>{(item.profile?.full_name ?? '?')[0].toUpperCase()}</Text>
                  </View>
                  <Text style={styles.partnerOptionName}>{item.profile?.full_name}</Text>
                  <Text style={styles.partnerOptionRating}>{(item.profile as any)?.rating ?? 1000} ELO</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text style={styles.modalEmpty}>All players are already partnered.</Text>}
            />
            <TouchableOpacity style={styles.modalClose} onPress={() => setShowPartnerModal(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  empty: { textAlign: 'center', marginTop: 60, color: '#999' },

  headerCard: { backgroundColor: '#fff', padding: 16, marginBottom: 8 },
  headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  fmtIcon: { fontSize: 30, marginTop: 2 },
  fmtLabel: { fontSize: 16, fontWeight: '800', color: '#1a1a1a' },
  fmtDesc: { fontSize: 12, color: '#888', marginTop: 2 },
  myRoleBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1 },
  myRoleText: { fontSize: 11, fontWeight: '700' },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chip: { backgroundColor: '#f5f5f5', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, fontSize: 12, color: '#555', fontWeight: '500' },
  metaLine: { fontSize: 13, color: '#666', marginBottom: 3 },
  desc: { fontSize: 13, color: '#777', marginTop: 6 },

  infoBox: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff8e1', margin: 12, marginBottom: 4, borderRadius: 10, padding: 14, borderWidth: 1, borderColor: '#ffe082' },
  infoIcon: { fontSize: 22 },
  infoText: { flex: 1, fontSize: 14, color: '#b8860b', fontWeight: '500' },

  setReleaseBtn: { margin: 12, marginBottom: 4, backgroundColor: '#f0f0f0', borderRadius: 10, padding: 12 },
  setReleaseBtnText: { fontSize: 13, color: '#555', fontWeight: '500' },

  registerBtn: { margin: 12, backgroundColor: GREEN, borderRadius: 10, padding: 16, alignItems: 'center' },
  registerBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  inviteNote: { margin: 12, backgroundColor: '#f9f9f9', borderRadius: 10, padding: 14 },
  inviteNoteText: { fontSize: 13, color: '#888' },
  myRegBadge: { margin: 12, borderRadius: 10, padding: 14 },
  regApproved: { backgroundColor: '#e8f5e9' },
  regPending:  { backgroundColor: '#fff8e1' },
  regRejected: { backgroundColor: '#ffebee' },
  myRegText: { fontSize: 14, fontWeight: '600', color: '#333' },

  section: { backgroundColor: '#fff', margin: 12, marginTop: 0, marginBottom: 8, borderRadius: 12, padding: 14 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 },
  manageLinkText: { fontSize: 12, color: GREEN, fontWeight: '600' },
  emptySection: { fontSize: 13, color: '#ccc', textAlign: 'center', paddingVertical: 8 },

  playerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  playerSeed: { width: 28, fontSize: 12, color: '#bbb', fontWeight: '600' },
  playerName: { flex: 1, fontSize: 14, fontWeight: '600', color: '#1a1a1a' },
  playerRating: { fontSize: 13, fontWeight: '700', color: GREEN, marginRight: 6 },
  rolePill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, borderWidth: 1 },
  rolePillText: { fontSize: 10, fontWeight: '700' },

  pendingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  pendingActions: { flexDirection: 'row', gap: 6 },
  approveBtn: { backgroundColor: GREEN, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  approveBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  rejectBtn: { backgroundColor: '#f5f5f5', width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  rejectBtnText: { color: '#888', fontSize: 14, fontWeight: '800' },

  generateBtn: { margin: 12, marginBottom: 6, backgroundColor: '#1565c0', borderRadius: 10, padding: 16, alignItems: 'center' },
  generateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  lockBtn: { margin: 12, marginTop: 0, backgroundColor: GREEN, borderRadius: 10, padding: 16, alignItems: 'center' },
  lockBtnDisabled: { backgroundColor: '#a5d6a7' },
  lockBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  activeBanner: { margin: 12, backgroundColor: '#e8f5e9', borderRadius: 10, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: '#c8e6c9' },
  activeBannerText: { fontSize: 14, color: GREEN, fontWeight: '700' },
  coAdminNote: { margin: 12, marginTop: 0, backgroundColor: '#f5f5f5', borderRadius: 10, padding: 12 },
  coAdminNoteText: { fontSize: 13, color: '#aaa', textAlign: 'center' },
  bracketDivider: { height: 1, backgroundColor: '#eee', marginVertical: 14 },
  advancementCard: { backgroundColor: '#f0f4ff', borderRadius: 10, padding: 13, borderWidth: 1, borderColor: '#c5cff5' },
  advancementTitle: { fontSize: 13, fontWeight: '700', color: '#1565c0', marginBottom: 7 },
  advancementRule: { fontSize: 13, color: '#333', lineHeight: 19, marginBottom: 6 },
  advancementPoint: { fontSize: 13, color: '#444', lineHeight: 18, paddingLeft: 8 },
  bold: { fontWeight: '700' },
  scheduleHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  myMatchesToggle: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, borderWidth: 1.5, borderColor: '#ddd', backgroundColor: '#fafafa' },
  myMatchesToggleOn: { borderColor: '#2e7d32', backgroundColor: '#e8f5e9' },
  myMatchesToggleText: { fontSize: 12, color: '#888', fontWeight: '600' },
  myMatchesToggleTextOn: { color: '#2e7d32' },
  noMyMatches: { fontSize: 13, color: '#aaa', textAlign: 'center', paddingVertical: 12 },
  previewBanner: { backgroundColor: '#fff3e0', borderRadius: 8, padding: 10, marginBottom: 10 },
  previewBannerText: { fontSize: 12, color: '#e65100', fontWeight: '500' },
  matchRowHighlight: { backgroundColor: '#f0faf0' },
  matchupHighlight: { color: GREEN, fontWeight: '800' },
  myMatchTag: { fontSize: 9, color: GREEN, fontWeight: '800', backgroundColor: '#e8f5e9', paddingHorizontal: 5, paddingVertical: 2, borderRadius: 6 },

  // Partner section
  partnerConfirmed: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#e8f5e9', borderRadius: 10, padding: 12 },
  partnerConfirmedIcon: { fontSize: 24 },
  partnerConfirmedName: { flex: 1, fontSize: 15, fontWeight: '700', color: '#1a1a1a' },
  partnerConfirmedNote: { fontSize: 12, color: GREEN },
  partnerPending: { backgroundColor: '#fff8e1', borderRadius: 10, padding: 12 },
  partnerPendingText: { fontSize: 13, color: '#b8860b', marginBottom: 6 },
  cancelReqText: { fontSize: 12, color: '#c62828', fontWeight: '600' },
  partnerRequest: { backgroundColor: '#e8f5e9', borderRadius: 10, padding: 12 },
  partnerReqText: { fontSize: 14, fontWeight: '600', color: '#1a1a1a', marginBottom: 10 },
  partnerReqActions: { flexDirection: 'row', gap: 10 },
  acceptBtn: { flex: 1, backgroundColor: GREEN, borderRadius: 8, padding: 10, alignItems: 'center' },
  acceptBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  declineBtn: { flex: 1, backgroundColor: '#f5f5f5', borderRadius: 8, padding: 10, alignItems: 'center' },
  declineBtnText: { color: '#888', fontWeight: '600', fontSize: 14 },
  noPartnerText: { fontSize: 13, color: '#aaa', marginBottom: 10 },
  findPartnerBtn: { backgroundColor: '#e8f5e9', borderRadius: 10, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: GREEN },
  findPartnerBtnText: { color: GREEN, fontWeight: '700', fontSize: 14 },

  // Pools & schedule
  poolCard: { backgroundColor: '#f9f9f9', borderRadius: 8, padding: 10, marginBottom: 8 },
  poolLabel: { fontSize: 13, fontWeight: '700', color: '#1565c0', marginBottom: 4 },
  poolPlayer: { fontSize: 13, color: '#444', paddingVertical: 2 },
  roundBlock: { marginBottom: 12 },
  roundLabel: { fontSize: 12, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  matchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  matchNum: { width: 20, fontSize: 11, color: '#bbb', fontWeight: '600' },
  matchup: { flex: 1, fontSize: 13, fontWeight: '600', color: '#1a1a1a' },
  vs: { fontSize: 11, color: '#bbb', fontWeight: '700' },

  // Partner modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 36 },
  modalTitle: { fontSize: 20, fontWeight: '800', color: '#1a1a1a', marginBottom: 4 },
  modalSubtitle: { fontSize: 13, color: '#888', marginBottom: 14 },
  partnerOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  partnerOptionAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#e8f5e9', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  partnerOptionInitial: { fontSize: 16, fontWeight: '700', color: GREEN },
  partnerOptionName: { flex: 1, fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  partnerOptionRating: { fontSize: 13, fontWeight: '700', color: GREEN },
  modalEmpty: { textAlign: 'center', color: '#aaa', paddingVertical: 20 },
  modalClose: { marginTop: 16, padding: 14, alignItems: 'center' },
  modalCloseText: { fontSize: 15, color: '#aaa' },
});
