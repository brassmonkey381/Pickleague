import React, { useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { Tournament, RootStackParamList } from '../types';
import { FORMAT_META } from '../lib/tournament';
import { isAvailableAt, TOTAL_CELLS } from '../lib/availability';
import { checkGodmode, countActiveOwnedTournaments } from '../lib/godmode';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import EmptyState from '../components/EmptyState';
import ConfirmModal from '../components/ConfirmModal';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Tournaments'>;
  route: RouteProp<RootStackParamList, 'Tournaments'>;
};

const STATUS_META: Record<Tournament['status'], { label: string; color: string }> = {
  registration: { label: 'Registration Open', color: '#2e7d32' },
  active:       { label: 'In Progress',        color: '#1565c0' },
  completed:    { label: 'Ended',               color: '#888'   },
  cancelled:    { label: 'Cancelled',           color: '#c62828' },
};

export default function TournamentsScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const { leagueId, leagueName } = route.params ?? {};
  const [tournaments, setTournaments] = React.useState<Tournament[]>([]);
  const [playerCounts, setPlayerCounts] = React.useState<Record<string, number>>({});
  // approved-only counts drive the full/waitlist CTA (invites don't hold a slot)
  const [approvedCounts, setApprovedCounts] = React.useState<Record<string, number>>({});
  // tournamentId → my registration metadata for the role pill
  const [myRegs, setMyRegs] = React.useState<
    Record<string, { status: 'pending' | 'approved' | 'rejected' | 'waitlisted'; role: string | null; invited_by: string | null }>
  >({});
  const [myAvailability, setMyAvailability] = React.useState<boolean[]>([]);
  const [filterByAvail, setFilterByAvail] = React.useState(false);
  const [showEnded, setShowEnded]         = React.useState(false);
  const [searchQuery, setSearchQuery]     = React.useState('');
  const [godmode, setGodmode]                             = React.useState(false);
  const [activeOwnedTournamentCount, setActiveOwnedTournamentCount] = React.useState(0);
  const [showLimitModal, setShowLimitModal] = React.useState(false);
  const atTournamentLimit = !godmode && activeOwnedTournamentCount >= 1;

  useFocusEffect(useCallback(() => { load(); }, []));

  const refresh = useRefresh(load);

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();

    let q = supabase.from('tournaments').select('*').order('created_at', { ascending: false });
    if (leagueId) q = q.eq('league_id', leagueId);

    const [{ data: tData }, profileRes, godmodeResult] = await Promise.all([
      q,
      user
        ? supabase.from('profiles').select('availability').eq('id', user.id).single()
        : Promise.resolve({ data: null }),
      checkGodmode(),
    ]);
    setGodmode(godmodeResult);
    if (user?.id) setActiveOwnedTournamentCount(await countActiveOwnedTournaments(user.id));

    const t = (tData ?? []) as Tournament[];
    setTournaments(t);

    const av = (profileRes as any)?.data?.availability;
    setMyAvailability(Array.isArray(av) && av.length === TOTAL_CELLS ? av : []);

    if (t.length > 0) {
      const ids = t.map(x => x.id);
      // Count approved members AND outstanding invites (status='pending' with
      // an inviter set) — both occupy a slot on the public roster.
      // Also pull THIS user's own row per tournament so the card can show
      // their role pill.
      const [{ data: regs }, mineRes] = await Promise.all([
        supabase
          .from('tournament_registrations')
          .select('tournament_id, status, invited_by')
          .in('tournament_id', ids)
          .in('status', ['approved', 'pending']),
        user
          ? supabase
              .from('tournament_registrations')
              .select('tournament_id, status, role, invited_by')
              .in('tournament_id', ids)
              .eq('user_id', user.id)
          : Promise.resolve({ data: null } as any),
      ]);
      const counts: Record<string, number> = {};
      const approvedOnly: Record<string, number> = {};
      (regs ?? []).forEach(r => {
        if (r.status === 'approved' || (r.status === 'pending' && r.invited_by != null)) {
          counts[r.tournament_id] = (counts[r.tournament_id] ?? 0) + 1;
        }
        // Capacity (full → waitlist) is decided on APPROVED players only —
        // same rule as the DB waitlist trigger.
        if (r.status === 'approved') {
          approvedOnly[r.tournament_id] = (approvedOnly[r.tournament_id] ?? 0) + 1;
        }
      });
      setPlayerCounts(counts);
      setApprovedCounts(approvedOnly);

      const mine: typeof myRegs = {};
      (mineRes?.data ?? []).forEach((r: any) => {
        mine[r.tournament_id] = { status: r.status, role: r.role ?? null, invited_by: r.invited_by ?? null };
      });
      setMyRegs(mine);
    }
  }

  function rolePillFor(tournamentId: string): { label: string; color: string } {
    const reg = myRegs[tournamentId];
    if (!reg) return { label: 'Not joined', color: '#888' };
    if (reg.status === 'rejected') return { label: '✗ Declined', color: '#c62828' };
    if (reg.status === 'waitlisted') return { label: '⏳ Waitlisted', color: '#b8860b' };
    if (reg.status === 'pending') {
      return reg.invited_by
        ? { label: '📨 Invited', color: '#b8860b' }
        : { label: '⏳ Request pending', color: '#b8860b' };
    }
    // approved
    if (reg.role === 'admin')    return { label: '👑 Admin',    color: '#6d28d9' };
    if (reg.role === 'co-admin') return { label: '🛡 Co-admin', color: '#2563eb' };
    return { label: '✓ Member', color: '#2e7d32' };
  }

  // Registration deadline passed (tournament may still be in 'registration'
  // status until the bracket is locked) — the RLS policy rejects new
  // self-requests after this, so the card must not offer "Register".
  function regClosed(item: Tournament): boolean {
    return item.registration_closes_at != null
      && Date.now() >= new Date(item.registration_closes_at).getTime();
  }
  function isFull(item: Tournament): boolean {
    return item.max_players != null && (approvedCounts[item.id] ?? 0) >= item.max_players;
  }

  // Prominent join CTA shown on registration-open, request-mode cards. The label
  // reflects the viewer's per-tournament registration state (loaded into myRegs)
  // plus the tournament's live state (deadline passed, at capacity).
  // `null` means no CTA (e.g. invite-only, or not in registration).
  function joinCtaFor(item: Tournament): { label: string; disabled: boolean } | null {
    if (item.status !== 'registration' || item.registration_mode !== 'request') return null;
    const reg = myRegs[item.id];
    if (!reg || reg.status === 'rejected') {
      if (regClosed(item)) return { label: '⏳ Registration closed', disabled: true };
      if (isFull(item))    return { label: 'Full — join waitlist →', disabled: false };
      return { label: reg ? 'View & Register →' : 'Register →', disabled: false };
    }
    if (reg.status === 'waitlisted') return { label: '⏳ On the waitlist', disabled: true };
    if (reg.status === 'pending') {
      return reg.invited_by
        ? { label: '📨 Respond to invite →', disabled: false }
        : { label: '⏳ Request pending', disabled: true };
    }
    return { label: '✓ Joined — View →', disabled: false }; // approved
  }

  const hasAvailability = myAvailability.some(Boolean);

  const endedCount = tournaments.filter(t => t.status === 'completed').length;
  const trimmedQuery = searchQuery.trim().toLowerCase();

  const visibleTournaments = tournaments.filter(t => {
    if (!showEnded && t.status === 'completed') return false;
    if (showEnded && trimmedQuery && !t.name.toLowerCase().includes(trimmedQuery)) return false;
    if (filterByAvail) {
      if (!t.start_time) return false;
      if (!isAvailableAt(myAvailability, new Date(t.start_time))) return false;
    }
    return true;
  });

  function renderCard({ item }: { item: Tournament }) {
    const fmt    = FORMAT_META[item.format];
    // "Registration Open" would be stale once the deadline has passed or the
    // roster is at capacity — reflect the live state on the badge.
    const status = item.status === 'registration' && regClosed(item)
      ? { label: 'Registration Closed', color: '#b8860b' }
      : item.status === 'registration' && isFull(item)
      ? { label: 'Full — Waitlist Open', color: '#b8860b' }
      : STATUS_META[item.status];
    const count  = playerCounts[item.id] ?? 0;
    const matchesAvail = hasAvailability && item.start_time
      ? isAvailableAt(myAvailability, new Date(item.start_time))
      : null;

    return (
      <TouchableOpacity
        style={S.card}
        onPress={() => navigation.navigate('TournamentDetail', { tournamentId: item.id, tournamentName: item.name })}
        activeOpacity={0.75}
      >
        <View style={S.cardTop}>
          <Text style={S.fmtIcon}>{fmt.icon}</Text>
          <View style={S.cardInfo}>
            <Text style={S.name} numberOfLines={1}>{item.name}</Text>
            <Text style={S.fmt}>{fmt.label} · {item.match_type === 'doubles' ? 'Doubles' : 'Singles'}</Text>
          </View>
          <View style={S.cardBadges}>
            <View style={[S.statusBadge, { backgroundColor: status.color + '22' }]}>
              <Text style={[S.statusText, { color: status.color }]}>{status.label}</Text>
            </View>
            {(() => {
              const r = rolePillFor(item.id);
              return (
                <View style={[S.roleBadge, { backgroundColor: r.color + '1a', borderColor: r.color }]}>
                  <Text style={[S.roleBadgeText, { color: r.color }]}>{r.label}</Text>
                </View>
              );
            })()}
            {matchesAvail === true && (
              <View style={S.availBadge}>
                <Text style={S.availBadgeText}>✓ Fits schedule</Text>
              </View>
            )}
            {matchesAvail === false && (
              <View style={S.unavailBadge}>
                <Text style={S.unavailBadgeText}>⚠ Schedule conflict</Text>
              </View>
            )}
          </View>
        </View>

        <View style={S.meta}>
          <Text style={S.metaItem}>👥 {count}{item.max_players ? ` / ${item.max_players}` : ''} players</Text>
          {item.start_time && (
            <Text style={S.metaItem}>
              📅 {new Date(item.start_time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </Text>
          )}
          {item.location_name && (
            <Text style={S.metaItem} numberOfLines={1}>📍 {item.location_name}</Text>
          )}
        </View>

        {/* TODO: smoke-test in browser — prominent join CTA on Tournaments list cards */}
        {(() => {
          const cta = joinCtaFor(item);
          if (cta) {
            return (
              <TouchableOpacity
                style={[S.joinBtn, cta.disabled && S.joinBtnDisabled]}
                disabled={cta.disabled}
                onPress={() => navigation.navigate('TournamentDetail', { tournamentId: item.id, tournamentName: item.name })}
                activeOpacity={0.85}
              >
                <Text style={[S.joinBtnText, cta.disabled && S.joinBtnTextDisabled]}>{cta.label}</Text>
              </TouchableOpacity>
            );
          }
          return (
            <Text style={S.regMode}>
              {item.registration_mode === 'invite_only' ? '🔒 Invite only' : '📝 Request to join'}
            </Text>
          );
        })()}
      </TouchableOpacity>
    );
  }

  return (
    <View style={S.container}>
      {/* Filter bar */}
      <View style={S.filterBar}>
        <View style={S.filterChips}>
          <TouchableOpacity
            style={[S.filterChip, filterByAvail && S.filterChipActive]}
            onPress={() => {
              if (!hasAvailability) return;
              setFilterByAvail(v => !v);
            }}
            activeOpacity={0.8}
          >
            <Text style={[S.filterChipText, filterByAvail && S.filterChipTextActive]}>
              📅 Matches my schedule
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[S.filterChip, showEnded && S.filterChipActive]}
            onPress={() => {
              setShowEnded(v => {
                const next = !v;
                if (!next) setSearchQuery('');
                return next;
              });
            }}
            activeOpacity={0.8}
          >
            <Text style={[S.filterChipText, showEnded && S.filterChipTextActive]}>
              🏁 Show ended{endedCount > 0 ? ` (${endedCount})` : ''}
            </Text>
          </TouchableOpacity>
        </View>
        {!hasAvailability && (
          <Text style={S.filterHint}>Set availability on your profile to use that filter</Text>
        )}
        {showEnded && (
          <TextInput
            style={S.searchInput}
            placeholder="Search by name…"
            placeholderTextColor={c.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCorrect={false}
            autoCapitalize="none"
          />
        )}
      </View>

      <FlatList
        data={visibleTournaments}
        keyExtractor={i => i.id}
        renderItem={renderCard}
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
        refreshControl={<AppRefreshControl {...refresh} />}
        ListEmptyComponent={
          showEnded && trimmedQuery
            ? <EmptyState icon="🔍" title="No matches" subtitle={`No tournaments match "${searchQuery.trim()}".`} />
            : filterByAvail
            ? <EmptyState icon="📅" title="No matching tournaments" subtitle="No tournaments match your availability. Try removing the filter." />
            : !showEnded && endedCount > 0
            ? <EmptyState icon="🏆" title="No active tournaments" subtitle='Toggle "Show ended" to see past tournaments.' />
            : <EmptyState icon="🏆" title="No tournaments yet" subtitle="Create one to get started!" />
        }
      />
      <TouchableOpacity
        style={[S.fab, atTournamentLimit && S.fabDisabled]}
        onPress={() => {
          if (atTournamentLimit) {
            setShowLimitModal(true);
            return;
          }
          navigation.navigate('CreateTournament', { leagueId });
        }}
        activeOpacity={0.8}
      >
        <Text style={[S.fabText, atTournamentLimit && S.fabTextDisabled]}>
          {atTournamentLimit ? '+ New Tournament (limit reached)' : '+ New Tournament'}
        </Text>
      </TouchableOpacity>

      <ConfirmModal
        visible={showLimitModal}
        title="Active tournament limit reached"
        body="You're already running an active tournament. Wait for it to end (or cancel it) before starting another."
        primaryLabel="OK"
        cancelLabel="Close"
        onConfirm={() => setShowLimitModal(false)}
        onClose={() => setShowLimitModal(false)}
      />
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container:           { flex: 1, backgroundColor: c.bg },

    filterBar:           { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border, gap: 8 },
    filterChips:         { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
    filterChip:          { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.bg },
    filterChipActive:    { borderColor: c.primary, backgroundColor: c.primaryLight },
    filterChipText:      { fontSize: 13, color: c.textMuted, fontWeight: '600' },
    filterChipTextActive:{ color: c.primary },
    filterHint:          { fontSize: 11, color: c.textMuted },
    searchInput:         { backgroundColor: c.bg, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: c.text },

    card:                { backgroundColor: c.surface, borderRadius: 14, padding: 16, marginBottom: 12, elevation: 3, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
    cardTop:             { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10, gap: 10 },
    fmtIcon:             { fontSize: 28 },
    cardInfo:            { flex: 1 },
    cardBadges:          { gap: 4, alignItems: 'flex-end' },
    name:                { fontSize: 16, fontWeight: '800', color: c.text },
    fmt:                 { fontSize: 12, color: c.textMuted, marginTop: 2 },
    statusBadge:         { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
    statusText:          { fontSize: 11, fontWeight: '700' },
    roleBadge:           { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
    roleBadgeText:       { fontSize: 10, fontWeight: '700' },
    availBadge:          { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: c.primaryLight },
    availBadgeText:      { fontSize: 10, fontWeight: '700', color: c.primary },
    unavailBadge:        { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: '#fff8e1' },
    unavailBadgeText:    { fontSize: 10, fontWeight: '700', color: '#e65100' },
    meta:                { gap: 3, marginBottom: 8 },
    metaItem:            { fontSize: 12, color: c.textSub },
    regMode:             { fontSize: 12, color: c.textMuted },
    joinBtn:             { marginTop: 4, backgroundColor: c.primary, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
    joinBtnDisabled:     { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    joinBtnText:         { color: '#fff', fontWeight: '700', fontSize: 15 },
    joinBtnTextDisabled: { color: c.textMuted },
    empty:               { textAlign: 'center', color: c.textMuted, marginTop: 60, fontSize: 15, lineHeight: 22 },
    fab:                 { position: 'absolute', bottom: 24, right: 24, backgroundColor: c.primary, paddingHorizontal: 20, paddingVertical: 14, borderRadius: 30, elevation: 4 },
    fabDisabled:         { backgroundColor: c.border, elevation: 0 },
    fabText:             { color: '#fff', fontWeight: '700', fontSize: 15 },
    fabTextDisabled:     { color: c.textMuted },
  });
}
