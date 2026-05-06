import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator,
} from 'react-native';
import { RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { getLeagueRole, isPrivileged } from '../lib/leagueRole';
import { LeagueEvent, EventSlot, Profile, RootStackParamList } from '../types';

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
  const [event, setEvent] = useState<LeagueEvent | null>(null);
  const [slots, setSlots] = useState<EventSlot[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [creatorProfile, setCreatorProfile] = useState<Profile | null>(null);
  const [confirmedAttendees, setConfirmedAttendees] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState<string | null>(null); // slot id being toggled

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

    const { data: slotRows } = await supabase
      .from('event_slots')
      .select('*')
      .eq('event_id', eventId)
      .order('starts_at');

    const { data: voteRows } = await supabase
      .from('event_slot_votes')
      .select('slot_id, user_id')
      .in('slot_id', (slotRows ?? []).map((s) => s.id));

    const enriched: EventSlot[] = (slotRows ?? []).map((s) => ({
      ...s,
      vote_count: voteRows?.filter((v) => v.slot_id === s.id).length ?? 0,
      my_vote: voteRows?.some((v) => v.slot_id === s.id && v.user_id === user?.id) ?? false,
    }));
    setSlots(enriched);

    // Confirmed attendees (if voting is closed)
    if (ev.confirmed_slot_id) {
      const { data: winnerVotes } = await supabase
        .from('event_slot_votes')
        .select('user_id, profile:profiles(id, full_name, username)')
        .eq('slot_id', ev.confirmed_slot_id);
      setConfirmedAttendees((winnerVotes ?? []).map((v: any) => v.profile).filter(Boolean));
    }

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

  async function closeVoting() {
    if (!event) return;
    const winner = [...slots].sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))[0];
    if (!winner) return;

    Alert.alert(
      'Close voting & confirm?',
      `The winning slot (${winner.vote_count} votes) will be set as the confirmed time. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: 'default',
          onPress: async () => {
            await supabase
              .from('league_events')
              .update({ status: 'scheduled', confirmed_slot_id: winner.id })
              .eq('id', event.id);
            await load();
          },
        },
      ]
    );
  }

  const countdown = useCountdown(event?.vote_ends_at ?? new Date().toISOString());
  const votingIsOpen = event?.status === 'voting' && new Date(event.vote_ends_at) > new Date();
  const [canClose, setCanClose] = React.useState(false);
  React.useEffect(() => {
    if (event?.league_id) getLeagueRole(event.league_id).then(r => setCanClose(isPrivileged(r)));
  }, [event?.league_id]);

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#2e7d32" />;
  if (!event) return <Text style={{ padding: 24 }}>Event not found.</Text>;

  const confirmedSlot = event.confirmed_slot_id ? slots.find((s) => s.id === event.confirmed_slot_id) : null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      {/* Header */}
      <View style={styles.header}>
        {event.description ? <Text style={styles.desc}>{event.description}</Text> : null}
        <View style={styles.statusRow}>
          {votingIsOpen ? (
            <>
              <View style={styles.dotOpen} />
              <Text style={styles.statusOpen}>Voting open · {countdown}</Text>
            </>
          ) : event.status === 'scheduled' ? (
            <>
              <View style={styles.dotScheduled} />
              <Text style={styles.statusScheduled}>Confirmed</Text>
            </>
          ) : (
            <>
              <View style={styles.dotClosed} />
              <Text style={styles.statusClosed}>Voting closed · {countdown}</Text>
            </>
          )}
        </View>
        {votingIsOpen && (
          <Text style={styles.voteDeadline}>
            Deadline: {new Date(event.vote_ends_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}
      </View>

      {/* Confirmed slot banner */}
      {confirmedSlot && (
        <View style={styles.confirmedBanner}>
          <Text style={styles.confirmedLabel}>Confirmed Time</Text>
          <Text style={styles.confirmedDate}>
            {new Date(confirmedSlot.starts_at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </Text>
          <Text style={styles.confirmedTime}>
            {new Date(confirmedSlot.starts_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            {' – '}
            {new Date(confirmedSlot.ends_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </Text>
          <Text style={styles.confirmedAttendeeCount}>{confirmedAttendees.length} player{confirmedAttendees.length !== 1 ? 's' : ''} confirmed</Text>
        </View>
      )}

      {/* Voting instruction */}
      {votingIsOpen && (
        <Text style={styles.voteInstruction}>
          Tap the slots you're available for. You can select multiple.
        </Text>
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
            style={[styles.slotCard, isWinner && styles.slotCardWinner, isMyVote && styles.slotCardVoted]}
            onPress={() => toggleVote(slot)}
            disabled={!votingIsOpen || isTogglingThis}
            activeOpacity={votingIsOpen ? 0.7 : 1}
          >
            <View style={styles.slotTop}>
              <View style={styles.slotDateBlock}>
                <Text style={styles.slotDay}>
                  {new Date(slot.starts_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                </Text>
                <Text style={styles.slotTime}>
                  {new Date(slot.starts_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  {' – '}
                  {new Date(slot.ends_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
              <View style={styles.slotRight}>
                {isWinner && <Text style={styles.winnerStar}>★</Text>}
                {isMyVote && !isWinner && (
                  <View style={styles.myVoteBadge}>
                    <Text style={styles.myVoteText}>✓ Available</Text>
                  </View>
                )}
              </View>
            </View>

            {/* Progress bar */}
            <View style={styles.progressBg}>
              <View style={[styles.progressFill, { width: `${pct * 100}%` as any }, isWinner && styles.progressFillWinner]} />
            </View>
            <Text style={styles.voteCount}>
              {slot.vote_count} / {memberCount} {memberCount === 1 ? 'player' : 'players'} available
            </Text>
          </TouchableOpacity>
        );
      })}

      {/* Creator actions */}
      {canClose && votingIsOpen && (
        <TouchableOpacity style={styles.closeVoteBtn} onPress={closeVoting}>
          <Text style={styles.closeVoteText}>Close Voting & Confirm Top Slot</Text>
        </TouchableOpacity>
      )}

      {/* Confirmed attendees */}
      {confirmedAttendees.length > 0 && (
        <View style={styles.attendeesSection}>
          <Text style={styles.attendeesTitle}>Confirmed Players ({confirmedAttendees.length})</Text>
          {confirmedAttendees.map((p) => (
            <View key={p.id} style={styles.attendeeRow}>
              <View style={styles.attendeeAvatar}>
                <Text style={styles.attendeeInitial}>{p.full_name[0].toUpperCase()}</Text>
              </View>
              <Text style={styles.attendeeName}>{p.full_name}</Text>
              <Text style={styles.attendeeRating}>{p.rating}</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const GREEN = '#2e7d32';
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: { backgroundColor: '#fff', padding: 16, marginBottom: 8 },
  desc: { fontSize: 14, color: '#555', marginBottom: 8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dotOpen: { width: 8, height: 8, borderRadius: 4, backgroundColor: GREEN },
  dotScheduled: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1565c0' },
  dotClosed: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#e65100' },
  statusOpen: { fontSize: 14, color: GREEN, fontWeight: '600' },
  statusScheduled: { fontSize: 14, color: '#1565c0', fontWeight: '600' },
  statusClosed: { fontSize: 14, color: '#e65100', fontWeight: '600' },
  voteDeadline: { fontSize: 12, color: '#888', marginTop: 4 },
  confirmedBanner: { backgroundColor: '#1565c0', margin: 12, borderRadius: 12, padding: 18, alignItems: 'center' },
  confirmedLabel: { fontSize: 12, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
  confirmedDate: { fontSize: 20, fontWeight: '800', color: '#fff' },
  confirmedTime: { fontSize: 16, color: 'rgba(255,255,255,0.9)', marginTop: 2 },
  confirmedAttendeeCount: { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 6 },
  voteInstruction: { fontSize: 13, color: '#888', textAlign: 'center', marginVertical: 8, paddingHorizontal: 16 },
  slotCard: { backgroundColor: '#fff', marginHorizontal: 12, marginBottom: 10, borderRadius: 12, padding: 14, borderWidth: 2, borderColor: 'transparent', elevation: 1 },
  slotCardVoted: { borderColor: GREEN, backgroundColor: '#f0faf0' },
  slotCardWinner: { borderColor: '#1565c0', backgroundColor: '#e8eaf6' },
  slotTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  slotDateBlock: {},
  slotDay: { fontSize: 15, fontWeight: '700', color: '#1a1a1a' },
  slotTime: { fontSize: 14, color: '#555', marginTop: 2 },
  slotRight: { alignItems: 'flex-end' },
  winnerStar: { fontSize: 22, color: '#1565c0' },
  myVoteBadge: { backgroundColor: '#e8f5e9', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  myVoteText: { fontSize: 12, color: GREEN, fontWeight: '700' },
  progressBg: { height: 6, backgroundColor: '#eee', borderRadius: 3, overflow: 'hidden', marginBottom: 6 },
  progressFill: { height: 6, backgroundColor: GREEN, borderRadius: 3 },
  progressFillWinner: { backgroundColor: '#1565c0' },
  voteCount: { fontSize: 12, color: '#888' },
  closeVoteBtn: { marginHorizontal: 12, marginTop: 8, marginBottom: 4, backgroundColor: '#e65100', borderRadius: 10, padding: 16, alignItems: 'center' },
  closeVoteText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  attendeesSection: { backgroundColor: '#fff', margin: 12, borderRadius: 12, padding: 16 },
  attendeesTitle: { fontSize: 16, fontWeight: '700', color: '#1a1a1a', marginBottom: 12 },
  attendeeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  attendeeAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#e8f5e9', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  attendeeInitial: { fontSize: 16, fontWeight: '700', color: GREEN },
  attendeeName: { flex: 1, fontSize: 15, fontWeight: '500', color: '#1a1a1a' },
  attendeeRating: { fontSize: 14, fontWeight: '700', color: GREEN },
});
