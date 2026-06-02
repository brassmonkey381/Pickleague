import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, Platform,
} from 'react-native';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { getLeagueRole, isPrivileged } from '../lib/leagueRole';
import { LeagueEvent, EventSlot, Profile, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { gs } from '../lib/globalStyles';
import ConfirmModal from '../components/ConfirmModal';
import ContactPickerModal from '../components/ContactPickerModal';
import { sendSmsInvite } from '../lib/sms';
import { shareInvite } from '../lib/share';
import { DeviceContact } from '../lib/contacts';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'EventDetail'>;
  route: RouteProp<RootStackParamList, 'EventDetail'>;
};

function useCountdown(endsAt: string) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    function tick() {
      const diff = new Date(endsAt).getTime() - Date.now();
      if (diff <= 0) { setLabel('Voting closed'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      if (h >= 24) setLabel(`${Math.floor(h / 24)}d ${h % 24}h remaining`);
      else setLabel(`${h}h ${m}m remaining`);
    }
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [endsAt]);
  return label;
}

export default function EventDetailScreen({ navigation, route }: Props) {
  const { eventId } = route.params;
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  const [event, setEvent] = useState<LeagueEvent | null>(null);
  const [leagueName, setLeagueName] = useState<string>('');
  const [isMember, setIsMember] = useState(false);
  const [showGuestPicker, setShowGuestPicker] = useState(false);
  const [invitingGuests, setInvitingGuests] = useState(false);
  const [closeWinner, setCloseWinner] = useState<EventSlot | null>(null);
  const [closing, setClosing]         = useState(false);
  const [slots, setSlots] = useState<EventSlot[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [creatorProfile, setCreatorProfile] = useState<Profile | null>(null);
  const [confirmedAttendees, setConfirmedAttendees] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState<string | null>(null); // slot id being toggled
  type EventMatchRow = {
    id: string;
    match_type: 'singles' | 'doubles';
    player1_score: number | null;
    player2_score: number | null;
    winner_team: 'team1' | 'team2' | null;
    status: string;
    played_at: string | null;
    p1?: { full_name: string | null } | null;
    p2?: { full_name: string | null } | null;
    pn1?: { full_name: string | null } | null;
    pn2?: { full_name: string | null } | null;
  };
  const [eventMatches, setEventMatches] = useState<EventMatchRow[]>([]);

  useFocusEffect(useCallback(() => { load(); }, []));

  async function load() {
    const { data: { user } } = await supabase.auth.getUser();
    setCurrentUserId(user?.id ?? null);

    const { data: ev } = await supabase.from('league_events').select('*').eq('id', eventId).single();
    if (!ev) return;
    setEvent(ev);

    const { count } = await supabase
      .from('league_members')
      .select('*', { count: 'exact', head: true })
      .eq('league_id', ev.league_id);
    setMemberCount(count ?? 0);

    const { data: lg } = await supabase.from('leagues').select('name').eq('id', ev.league_id).single();
    setLeagueName(lg?.name ?? '');

    const { data: slotRows } = await supabase
      .from('event_slots')
      .select('*')
      .eq('event_id', eventId)
      .order('starts_at');

    const { data: voteRows } = await supabase
      .from('event_slot_votes')
      .select('slot_id, user_id, profile:profiles(id, full_name, avatar_emoji, avatar_bg_color)')
      .in('slot_id', (slotRows ?? []).map((s) => s.id));

    const enriched: EventSlot[] = (slotRows ?? []).map((s) => {
      const slotVotes = (voteRows ?? []).filter((v) => v.slot_id === s.id);
      return {
        ...s,
        vote_count: slotVotes.length,
        my_vote: slotVotes.some((v) => v.user_id === user?.id),
        voters: slotVotes.map((v: any) => v.profile).filter(Boolean),
      };
    });
    setSlots(enriched);

    // Confirmed attendees (if voting is closed)
    if (ev.confirmed_slot_id) {
      const { data: winnerVotes } = await supabase
        .from('event_slot_votes')
        .select('user_id, profile:profiles(id, full_name, username)')
        .eq('slot_id', ev.confirmed_slot_id);
      setConfirmedAttendees((winnerVotes ?? []).map((v: any) => v.profile).filter(Boolean));
    }

    // Matches recorded against this event.
    const { data: mRows } = await supabase
      .from('matches')
      .select(
        'id, match_type, player1_score, player2_score, winner_team, status, played_at,'
        + ' p1:profiles!matches_player1_id_fkey(full_name),'
        + ' p2:profiles!matches_player2_id_fkey(full_name),'
        + ' pn1:profiles!matches_partner1_id_fkey(full_name),'
        + ' pn2:profiles!matches_partner2_id_fkey(full_name)'
      )
      .eq('event_id', eventId)
      .order('played_at', { ascending: false });
    setEventMatches((mRows ?? []) as unknown as EventMatchRow[]);

    setLoading(false);
  }

  async function toggleVote(slot: EventSlot) {
    if (!currentUserId) return;
    const votingOpen = event && event.status === 'voting' && new Date(event.vote_ends_at) > new Date();
    if (!votingOpen) return;

    setVoting(slot.id);
    if (slot.my_vote) {
      await supabase
        .from('event_slot_votes')
        .delete()
        .eq('slot_id', slot.id)
        .eq('user_id', currentUserId);
    } else {
      await supabase
        .from('event_slot_votes')
        .insert({ slot_id: slot.id, user_id: currentUserId });
    }
    setVoting(null);
    await load();
  }

  function closeVoting() {
    if (!event) return;
    const winner = [...slots].sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))[0];
    if (!winner) return;
    setCloseWinner(winner);
  }
  async function confirmCloseVoting() {
    if (!event || !closeWinner) return;
    setClosing(true);
    await supabase
      .from('league_events')
      .update({ status: 'scheduled', confirmed_slot_id: closeWinner.id })
      .eq('id', event.id);
    setClosing(false);
    setCloseWinner(null);
    await load();
  }

  const countdown = useCountdown(event?.vote_ends_at ?? new Date().toISOString());
  const votingIsOpen = event?.status === 'voting' && new Date(event.vote_ends_at) > new Date();
  const [canClose, setCanClose] = React.useState(false);
  React.useEffect(() => {
    if (event?.league_id) getLeagueRole(event.league_id).then(r => {
      setCanClose(isPrivileged(r));
      setIsMember(r != null);
    });
  }, [event?.league_id]);

  // Entry point for "Invite guests". Native has device contacts, so we open the
  // in-app picker and group-text the chosen numbers. Mobile web can't read
  // contacts, so we skip the picker and hand the invite to the OS share sheet
  // (Web Share API) — the user picks the recipients / creates the group there.
  function onInviteGuests() {
    if (Platform.OS === 'web') void shareGuestInviteWeb();
    else setShowGuestPicker(true);
  }

  function buildGuestMessage(token: string): string {
    const link = `https://pickleague.club/g/${token}`;
    const where = leagueName ? ` in ${leagueName}` : '';
    return (
      `You're invited to vote on a time for "${event!.title}"${where} on Pickleague! 🥒\n` +
      `Tap to join the vote — no account needed (7-day guest pass): ${link}`
    );
  }

  // Mints a shared guest invite and returns its token, or null (after alerting).
  // Catches a rejected rpc (network failure) too, so callers never throw.
  async function createGuestInvite(invitedNames: string[]): Promise<string | null> {
    if (!event) return null;
    try {
      const { data, error } = await supabase.rpc('create_guest_invite', {
        p_league_id:     event.league_id,
        p_event_id:      eventId,
        p_invited_names: invitedNames,
      });
      const token = typeof data === 'string' ? data : (Array.isArray(data) ? data[0] : null);
      if (error || !token) {
        Alert.alert('Could not create invite', error?.message ?? 'Please try again.');
        return null;
      }
      return token;
    } catch (e: any) {
      Alert.alert('Could not create invite', e?.message ?? 'Please try again.');
      return null;
    }
  }

  // Native: pick phone contacts → mint invite → group-text the link.
  async function sendGuestInvites(contacts: DeviceContact[]) {
    if (!event || contacts.length === 0) return;
    setInvitingGuests(true);
    try {
      const token = await createGuestInvite(contacts.map(c => c.name));
      if (token) {
        await sendSmsInvite({ message: buildGuestMessage(token), recipients: contacts.map(c => c.phone) });
      }
    } finally {
      // Always clear busy state so the button/modal never lock up on an error.
      setInvitingGuests(false);
      setShowGuestPicker(false);
    }
  }

  // Web: no contacts access — mint invite (empty roster; the landing page lets
  // each guest type their name) → share via the OS share sheet, falling back to
  // an sms: composer then clipboard.
  async function shareGuestInviteWeb() {
    if (!event || invitingGuests) return;
    setInvitingGuests(true);
    try {
      const token = await createGuestInvite([]);
      if (!token) return;
      const result = await shareInvite({
        title:   `Vote on "${event.title}"`,
        message: buildGuestMessage(token),
      });
      if (result.copied) {
        Alert.alert('Invite copied', 'The invite link was copied — paste it into a group text to your guests.');
      }
    } finally {
      setInvitingGuests(false);
    }
  }

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color={c.primary} />;
  if (!event) return <Text style={{ padding: 24, color: c.text }}>Event not found.</Text>;

  const confirmedSlot = event.confirmed_slot_id ? slots.find((s) => s.id === event.confirmed_slot_id) : null;

  return (
    <ScrollView style={S.container} contentContainerStyle={{ paddingBottom: 40 }}>
      {/* Header */}
      <View style={S.header}>
        {event.description ? <Text style={S.desc}>{event.description}</Text> : null}
        <View style={S.statusRow}>
          {votingIsOpen ? (
            <>
              <View style={S.dotOpen} />
              <Text style={S.statusOpen}>Voting open · {countdown}</Text>
            </>
          ) : event.status === 'scheduled' ? (
            <>
              <View style={S.dotScheduled} />
              <Text style={S.statusScheduled}>Confirmed</Text>
            </>
          ) : (
            <>
              <View style={S.dotClosed} />
              <Text style={S.statusClosed}>Voting closed · {countdown}</Text>
            </>
          )}
        </View>
        {votingIsOpen && (
          <Text style={S.voteDeadline}>
            Deadline: {new Date(event.vote_ends_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}
      </View>

      {/* Confirmed slot banner */}
      {confirmedSlot && (
        <View style={S.confirmedBanner}>
          <Text style={S.confirmedLabel}>Confirmed Time</Text>
          <Text style={S.confirmedDate}>
            {new Date(confirmedSlot.starts_at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </Text>
          <Text style={S.confirmedTime}>
            {new Date(confirmedSlot.starts_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            {' – '}
            {new Date(confirmedSlot.ends_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </Text>
          <Text style={S.confirmedAttendeeCount}>{confirmedAttendees.length} player{confirmedAttendees.length !== 1 ? 's' : ''} confirmed</Text>
          <TouchableOpacity
            style={S.recordBtn}
            activeOpacity={0.85}
            onPress={() => navigation.navigate('MatchEntry', { leagueId: event.league_id, eventId })}
          >
            <Text style={S.recordBtnText}>📝 Record a match for this event</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Matches recorded for this event */}
      {eventMatches.length > 0 && (
        <View style={S.matchesSection}>
          <Text style={S.matchesSectionTitle}>Matches recorded ({eventMatches.length})</Text>
          {eventMatches.map(m => {
            const teamA = [m.p1?.full_name, m.pn1?.full_name].filter(Boolean).join(' & ') || '?';
            const teamB = [m.p2?.full_name, m.pn2?.full_name].filter(Boolean).join(' & ') || '?';
            const scoreLabel = m.player1_score != null && m.player2_score != null
              ? `${m.player1_score}–${m.player2_score}`
              : '—';
            const winSuffix = m.winner_team === 'team1' ? ' ✓ Team A' : m.winner_team === 'team2' ? ' ✓ Team B' : '';
            return (
              <View key={m.id} style={S.matchRow}>
                <Text style={S.matchRowTeams} numberOfLines={2}>{teamA} vs {teamB}</Text>
                <Text style={S.matchRowMeta}>
                  {scoreLabel}{winSuffix} · {m.status === 'completed' ? 'final' : m.status}
                </Text>
              </View>
            );
          })}
        </View>
      )}

      {/* Voting instruction */}
      {votingIsOpen && (
        <Text style={S.voteInstruction}>
          Tap the slots you're available for. You can select multiple.
        </Text>
      )}

      {/* Invite guests (members only, while voting is open) */}
      {votingIsOpen && isMember && (
        <TouchableOpacity style={S.inviteGuestsBtn} onPress={onInviteGuests} disabled={invitingGuests}>
          <Text style={S.inviteGuestsText}>📲  Invite guests to vote</Text>
        </TouchableOpacity>
      )}

      {/* Slot cards */}
      {slots.map((slot) => {
        const isWinner = slot.id === event.confirmed_slot_id;
        const pct = memberCount > 0 ? Math.min((slot.vote_count ?? 0) / memberCount, 1) : 0;
        const isMyVote = slot.my_vote ?? false;
        const isTogglingThis = voting === slot.id;

        return (
          <TouchableOpacity
            key={slot.id}
            style={[S.slotCard, isWinner && S.slotCardWinner, isMyVote && S.slotCardVoted]}
            onPress={() => toggleVote(slot)}
            disabled={!votingIsOpen || isTogglingThis}
            activeOpacity={votingIsOpen ? 0.7 : 1}
          >
            <View style={S.slotTop}>
              <View style={S.slotDateBlock}>
                <Text style={S.slotDay}>
                  {new Date(slot.starts_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                </Text>
                <Text style={S.slotTime}>
                  {new Date(slot.starts_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  {' – '}
                  {new Date(slot.ends_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
              <View style={S.slotRight}>
                {isWinner && <Text style={S.winnerStar}>★</Text>}
                {isMyVote && !isWinner && (
                  <View style={S.myVoteBadge}>
                    <Text style={S.myVoteText}>✓ Available</Text>
                  </View>
                )}
              </View>
            </View>

            {/* Progress bar */}
            <View style={S.progressBg}>
              <View style={[S.progressFill, { width: `${pct * 100}%` as any }, isWinner && S.progressFillWinner]} />
            </View>
            <Text style={S.voteCount}>
              {slot.vote_count} / {memberCount} {memberCount === 1 ? 'player' : 'players'} available
            </Text>

            {/* Who voted for this slot */}
            {(slot.voters?.length ?? 0) > 0 && (
              <View style={S.voterWrap}>
                {slot.voters!.map((vp) => {
                  const first = (vp.full_name ?? '?').trim().split(' ')[0] || '?';
                  return (
                    <View key={vp.id} style={S.voterChip}>
                      <View style={[S.voterAvatar, vp.avatar_bg_color ? { backgroundColor: vp.avatar_bg_color } : null]}>
                        <Text style={S.voterAvatarText}>{vp.avatar_emoji ?? (first[0]?.toUpperCase() ?? '?')}</Text>
                      </View>
                      <Text style={S.voterName} numberOfLines={1}>{first}</Text>
                    </View>
                  );
                })}
              </View>
            )}
          </TouchableOpacity>
        );
      })}

      {/* Creator actions */}
      {canClose && votingIsOpen && (
        <TouchableOpacity style={S.closeVoteBtn} onPress={closeVoting}>
          <Text style={S.closeVoteText}>Close Voting & Confirm Top Slot</Text>
        </TouchableOpacity>
      )}

      {/* Confirmed attendees */}
      {confirmedAttendees.length > 0 && (
        <View style={S.attendeesSection}>
          <Text style={S.attendeesTitle}>Confirmed Players ({confirmedAttendees.length})</Text>
          {confirmedAttendees.map((p) => (
            <View key={p.id} style={S.attendeeRow}>
              <View style={S.attendeeAvatar}>
                <Text style={S.attendeeInitial}>{p.full_name[0].toUpperCase()}</Text>
              </View>
              <Text style={S.attendeeName}>{p.full_name}</Text>
              <Text style={S.attendeeRating}>{p.rating}</Text>
            </View>
          ))}
        </View>
      )}

      <ConfirmModal
        visible={!!closeWinner}
        title="Close voting & confirm?"
        body={closeWinner ? `The winning slot (${closeWinner.vote_count} votes) will be set as the confirmed time. This cannot be undone.` : ''}
        primaryLabel="Confirm"
        variant="primary"
        busy={closing}
        onConfirm={confirmCloseVoting}
        onClose={() => setCloseWinner(null)}
      />

      <ContactPickerModal
        visible={showGuestPicker}
        busy={invitingGuests}
        onConfirm={sendGuestInvites}
        onClose={() => setShowGuestPicker(false)}
      />
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    header: { backgroundColor: c.surface, padding: 16, marginBottom: 8 },
    desc: { fontSize: 14, color: c.textSub, marginBottom: 8 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    dotOpen: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.primary },
    dotScheduled: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1565c0' },
    dotClosed: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#e65100' },
    statusOpen: { fontSize: 14, color: c.primary, fontWeight: '600' },
    statusScheduled: { fontSize: 14, color: '#1565c0', fontWeight: '600' },
    statusClosed: { fontSize: 14, color: '#e65100', fontWeight: '600' },
    voteDeadline: { fontSize: 12, color: c.textMuted, marginTop: 4 },
    confirmedBanner: { backgroundColor: '#1565c0', margin: 12, borderRadius: 14, padding: 18, alignItems: 'center', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 4 },
    confirmedLabel: { fontSize: 12, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
    confirmedDate: { fontSize: 20, fontWeight: '800', color: '#fff' },
    confirmedTime: { fontSize: 16, color: 'rgba(255,255,255,0.9)', marginTop: 2 },
    confirmedAttendeeCount: { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 6 },

    recordBtn:      { marginTop: 12, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
    recordBtnText:  { color: '#fff', fontSize: 14, fontWeight: '700' },

    matchesSection:       { marginHorizontal: 12, marginTop: 4, marginBottom: 12, padding: 14, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border },
    matchesSectionTitle:  { fontSize: 13, fontWeight: '800', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
    matchRow:             { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border },
    matchRowTeams:        { fontSize: 14, fontWeight: '700', color: c.text },
    matchRowMeta:         { fontSize: 12, color: c.textSub, marginTop: 2 },
    voteInstruction: { fontSize: 13, color: c.textMuted, textAlign: 'center', marginVertical: 8, paddingHorizontal: 16 },
    inviteGuestsBtn: { marginHorizontal: 12, marginBottom: 8, borderWidth: 1.5, borderColor: c.primary, borderRadius: 12, paddingVertical: 12, alignItems: 'center', backgroundColor: c.primaryLight },
    inviteGuestsText: { color: c.primary, fontSize: 14, fontWeight: '700' },
    slotCard: { backgroundColor: c.surface, marginHorizontal: 12, marginBottom: 10, borderRadius: 14, padding: 14, borderWidth: 2, borderColor: 'transparent', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3 },
    slotCardVoted: { borderColor: c.primary, backgroundColor: c.primaryLight },
    slotCardWinner: { borderColor: '#1565c0', backgroundColor: '#e8eaf6' },
    slotTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
    slotDateBlock: {},
    slotDay: { fontSize: 15, fontWeight: '700', color: c.text },
    slotTime: { fontSize: 14, color: c.textSub, marginTop: 2 },
    slotRight: { alignItems: 'flex-end' },
    winnerStar: { fontSize: 22, color: '#1565c0' },
    myVoteBadge: { backgroundColor: c.primaryLight, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
    myVoteText: { fontSize: 12, color: c.primary, fontWeight: '700' },
    progressBg: { height: 6, backgroundColor: c.border, borderRadius: 3, overflow: 'hidden', marginBottom: 6 },
    progressFill: { height: 6, backgroundColor: c.primary, borderRadius: 3 },
    progressFillWinner: { backgroundColor: '#1565c0' },
    voteCount: { fontSize: 12, color: c.textMuted },
    voterWrap:       { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
    voterChip:       { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.surfaceAlt, borderRadius: 12, paddingVertical: 3, paddingHorizontal: 7, borderWidth: 1, borderColor: c.border },
    voterAvatar:     { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: c.primaryLight },
    voterAvatarText: { fontSize: 11, fontWeight: '700', color: c.primary },
    voterName:       { fontSize: 12, color: c.textSub, maxWidth: 90 },
    closeVoteBtn: { marginHorizontal: 12, marginTop: 8, marginBottom: 4, backgroundColor: '#e65100', borderRadius: 12, padding: 16, alignItems: 'center' },
    closeVoteText: { color: '#fff', fontWeight: '700', fontSize: 15 },
    attendeesSection: { backgroundColor: c.surface, margin: 12, borderRadius: 14, padding: 16, elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3 },
    attendeesTitle: { fontSize: 16, fontWeight: '700', color: c.text, marginBottom: 12 },
    attendeeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.bg },
    attendeeAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.primaryLight, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
    attendeeInitial: { fontSize: 16, fontWeight: '700', color: c.primary },
    attendeeName: { flex: 1, fontSize: 15, fontWeight: '500', color: c.text },
    attendeeRating: { fontSize: 14, fontWeight: '700', color: c.primary },
  });
}
