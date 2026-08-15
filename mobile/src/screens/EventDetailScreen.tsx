import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Platform, TextInput,
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
import { sendSmsInvite, shareViaWhatsApp } from '../lib/sms';
import { postToChatWebhook, isLikelyChatWebhookUrl } from '@just-messin-around/expo-foundation/platform';
import { buildNudgeMessage, loadInvitedPhones, pickNudgeKind } from '../lib/eventNudge';
import { shareInvite } from '../lib/share';
import { addToCalendar } from '../lib/calendar';
import { DeviceContact } from '../lib/contacts';
import BookmarkButton from '../components/BookmarkButton';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { sbCall, friendlySbMessage, currentUserId as localUserId } from '@just-messin-around/expo-foundation/supabase';

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
  // "Can't make it" — informational only. It lives in its own table, so it can
  // never be picked as the winning slot no matter how many people choose it.
  const [decliners, setDecliners] = useState<Profile[]>([]);
  const [iDeclined, setIDeclined] = useState(false);
  const [nudging, setNudging] = useState(false);
  // League chat webhook (Discord/Slack). Null when unset OR unreadable — RLS
  // only lets the league creator see it.
  const [chatWebhookUrl, setChatWebhookUrl] = useState<string | null>(null);
  const [isLeagueCreator, setIsLeagueCreator] = useState(false);
  const [webhookSetupOpen, setWebhookSetupOpen] = useState(false);
  const [webhookInput, setWebhookInput] = useState('');
  const [webhookSaving, setWebhookSaving] = useState(false);
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

  // Alert.alert is a no-op on react-native-web, so every write on this screen
  // used to fail (and succeed) completely silently on pickleague.club.
  const status = useStatusMessage();
  // A vote toggle is a delete-or-insert pair; overlapping taps on two slots
  // would race each other's reload and leave the UI showing the wrong state.
  const voteInFlight = useRef(false);

  useFocusEffect(useCallback(() => { load(); }, []));
  const refresh = useRefresh(load);

  async function load() {
    // LOCAL session read: getUser() is a network call that resolves null on a
    // flaky connection, which made every slot render as "not voted" and let the
    // user re-cast a vote they had already placed.
    const uid = await localUserId(supabase);
    setCurrentUserId(uid);

    const { data: ev } = await supabase.from('league_events').select('*').eq('id', eventId).single();
    if (!ev) return;
    setEvent(ev);

    const { count } = await supabase
      .from('league_members')
      .select('*', { count: 'exact', head: true })
      .eq('league_id', ev.league_id);
    setMemberCount(count ?? 0);

    const { data: lg } = await supabase.from('leagues').select('name, created_by').eq('id', ev.league_id).single();
    setLeagueName(lg?.name ?? '');
    setIsLeagueCreator(!!uid && lg?.created_by === uid);

    // League chat webhook. RLS is league-creator-only, so for anyone else this
    // simply returns nothing and the chat button never renders — the URL is a
    // capability secret and must not reach non-creators.
    const { data: hook } = await supabase
      .from('league_chat_webhooks')
      .select('url')
      .eq('league_id', ev.league_id)
      .maybeSingle();
    setChatWebhookUrl(hook?.url ?? null);

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
        my_vote: slotVotes.some((v) => v.user_id === uid),
        voters: slotVotes.map((v: any) => v.profile).filter(Boolean),
      };
    });
    setSlots(enriched);

    const { data: declineRows } = await supabase
      .from('event_declines')
      .select('user_id, profile:profiles(id, full_name, avatar_emoji, avatar_bg_color)')
      .eq('event_id', eventId);
    setDecliners((declineRows ?? []).map((d: any) => d.profile).filter(Boolean));
    setIDeclined((declineRows ?? []).some((d: any) => d.user_id === uid));

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
    if (voteInFlight.current) return;
    if (!currentUserId) return;
    const votingOpen = event && event.status === 'voting' && new Date(event.vote_ends_at) > new Date();
    if (!votingOpen) return;

    voteInFlight.current = true;
    setVoting(slot.id);
    status.clear();
    try {
      // Both halves are keyed by (slot, user), so a retried attempt after a
      // dropped socket lands on the same row — safe to let sbCall retry.
      if (slot.my_vote) {
        await sbCall(() => supabase
          .from('event_slot_votes')
          .delete()
          .eq('slot_id', slot.id)
          .eq('user_id', currentUserId));
      } else {
        await sbCall(() => supabase
          .from('event_slot_votes')
          .insert({ slot_id: slot.id, user_id: currentUserId }));
      }
      await load();
    } catch (e) {
      // The result was discarded before, so a dropped vote just silently didn't
      // stick and the user had no idea their availability wasn't recorded.
      status.error(friendlySbMessage(e, 'Could not save your vote. Tap the time again to retry.'));
    } finally {
      // In a finally: without it a thrown error left the slot disabled with its
      // spinner up until the screen was left and re-entered.
      voteInFlight.current = false;
      setVoting(null);
    }
  }

  // "I can't make any of these." Mutually exclusive with slot votes — a DB
  // trigger clears the other side either way, so this only has to write one row.
  async function toggleDecline() {
    if (voteInFlight.current) return;
    if (!currentUserId) return;
    const votingOpen = event && event.status === 'voting' && new Date(event.vote_ends_at) > new Date();
    if (!votingOpen) return;

    voteInFlight.current = true;
    setVoting('decline');
    status.clear();
    try {
      if (iDeclined) {
        await sbCall(() => supabase
          .from('event_declines')
          .delete()
          .eq('event_id', eventId)
          .eq('user_id', currentUserId));
      } else {
        await sbCall(() => supabase
          .from('event_declines')
          .insert({ event_id: eventId, user_id: currentUserId }));
      }
      await load();
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not save that. Tap again to retry.'));
    } finally {
      voteInFlight.current = false;
      setVoting(null);
    }
  }

  // Follow-up nudge to the group that was already texted. The app writes the
  // message and supplies the recipients; the user still taps send, because the
  // text going out from their own number is the thing that makes it convert.
  async function sendNudge(via: 'sms' | 'whatsapp' | 'chat') {
    if (!event || nudging) return;
    const confirmedSlot = slots.find(s => s.id === event.confirmed_slot_id) ?? null;
    const kind = pickNudgeKind(event, confirmedSlot);
    if (!kind) return;

    setNudging(true);
    status.clear();
    try {
      const voterIds = new Set<string>();
      for (const s of slots) for (const v of s.voters ?? []) voterIds.add(v.id);

      const message = buildNudgeMessage({
        kind,
        event,
        slots,
        confirmedSlot,
        voterCount: voterIds.size,
        attendeeNames: confirmedAttendees.map(a => a.full_name).filter(Boolean) as string[],
      });

      if (via === 'chat') {
        // The one no-tap channel: posts straight into the league's Discord or
        // Slack via its incoming webhook. Foundation shapes the payload.
        if (!chatWebhookUrl) return;
        const r = await postToChatWebhook({ url: chatWebhookUrl, text: message });
        if (r.ok) {
          status.success(r.confirmed ? 'Posted to the league chat.' : 'Sent to the league chat (delivery unconfirmed).');
        } else {
          status.error(`Chat post failed${r.status ? ` (HTTP ${r.status})` : ''} — check the webhook URL.`);
        }
        return;
      }

      // WhatsApp takes no recipient list: its chat picker is the point, because
      // it can post into the group the friends already use.
      const res = via === 'sms'
        ? await sendSmsInvite({ message, recipients: await loadInvitedPhones(eventId) })
        : await shareViaWhatsApp({ message });

      if (res.copied) {
        status.success('Message copied — paste it into your group chat.');
      } else if (!res.sent) {
        status.error('Could not open a messaging app. Try the other button.');
      }
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not build the message. Please try again.'));
    } finally {
      setNudging(false);
    }
  }

  async function saveChatWebhook() {
    if (!event || webhookSaving) return;
    const url = webhookInput.trim();
    if (!isLikelyChatWebhookUrl(url)) {
      status.error('That does not look like an https webhook URL.');
      return;
    }
    setWebhookSaving(true);
    try {
      // Keyed by league_id, so retries land on the same row.
      await sbCall(() => supabase
        .from('league_chat_webhooks')
        .upsert({ league_id: event.league_id, url, updated_by: currentUserId }));
      setChatWebhookUrl(url);
      setWebhookSetupOpen(false);
      setWebhookInput('');
      status.success('League chat connected — nudges can now post there directly.');
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not save the webhook.'));
    } finally {
      setWebhookSaving(false);
    }
  }

  function closeVoting() {
    if (!event) return;
    const winner = [...slots].sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))[0];
    if (!winner) return;
    setCloseWinner(winner);
  }
  async function confirmCloseVoting() {
    if (closing) return;
    if (!event || !closeWinner) return;
    setClosing(true);
    status.clear();
    try {
      // Via the RPC rather than a direct update so closing early applies the
      // same min_players rule the scheduled finalizer does — otherwise pressing
      // this button would schedule an event that letting the clock run out
      // would have cancelled. Idempotent: it no-ops unless status is 'voting'.
      const outcome = await sbCall(() => supabase
        .rpc('close_event_vote', { p_event_id: event.id })) as unknown as string | null;
      setCloseWinner(null);
      status.success(
        outcome === 'cancelled'
          ? `Voting closed — cancelled, as no time reached ${event.min_players} players.`
          : 'Voting closed — the winning time is confirmed.',
      );
      await load();
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not close voting. Please try again.'));
    } finally {
      // Keeps the confirm modal usable instead of stranding it mid-spin.
      setClosing(false);
    }
  }

  const countdown = useCountdown(event?.vote_ends_at ?? new Date().toISOString());
  const votingIsOpen = event?.status === 'voting' && new Date(event.vote_ends_at) > new Date();
  const nudgeKind = event
    ? pickNudgeKind(event, slots.find(s => s.id === event.confirmed_slot_id) ?? null)
    : null;
  const [canClose, setCanClose] = React.useState(false);
  React.useEffect(() => {
    if (event?.league_id) getLeagueRole(event.league_id).then(r => {
      // 'unknown' means the role read failed, not that the user lacks the role —
      // demoting an admin because their WiFi blipped would hide "close voting"
      // from the only person who can use it. Keep whatever we last knew.
      if (r !== 'unknown') setCanClose(isPrivileged(r));
    }).catch(() => { /* keep the last known privilege */ });
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

  // Mints a shared guest invite and returns its token, or null (after reporting).
  // Catches a rejected rpc (network failure) too, so callers never throw.
  // invitedPhones is index-aligned with invitedNames so the server can attach a
  // phone to the guest who later picks their name from the roster.
  async function createGuestInvite(invitedNames: string[], invitedPhones: string[] = []): Promise<string | null> {
    if (!event) return null;
    try {
      // Not retried: each call mints a new token, so a retry after a lost reply
      // leaves a live invite nobody holds.
      const data = await sbCall<unknown>(() => supabase.rpc('create_guest_invite', {
        p_league_id:      event.league_id,
        p_event_id:       eventId,
        p_invited_names:  invitedNames,
        p_invited_phones: invitedPhones,
      }), { retries: 0 });
      const token = typeof data === 'string' ? data : (Array.isArray(data) ? data[0] : null);
      if (!token) {
        status.error('Could not create invite. Please try again.');
        return null;
      }
      return token;
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not create invite. Please try again.'));
      return null;
    }
  }

  // Native: pick phone contacts → mint invite → group-text the link.
  async function sendGuestInvites(contacts: DeviceContact[]) {
    if (invitingGuests) return;
    if (!event || contacts.length === 0) return;
    setInvitingGuests(true);
    try {
      const token = await createGuestInvite(contacts.map(c => c.name), contacts.map(c => c.phone));
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
        status.success('Invite link copied — paste it into a group text to your guests.');
      }
    } finally {
      setInvitingGuests(false);
    }
  }

  if (loading) return <View style={{ flex: 1, backgroundColor: c.bg }}><SkeletonList rows={6} /></View>;
  if (!event) return <Text style={{ padding: 24, color: c.text }}>Event not found.</Text>;

  const confirmedSlot = event.confirmed_slot_id ? slots.find((s) => s.id === event.confirmed_slot_id) : null;
  // "Live": the confirmed slot has started and is still within its 24h open
  // window — the event is open for recording matches and gets the red treatment.
  const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
  const slotStart = confirmedSlot ? new Date(confirmedSlot.starts_at).getTime() : null;
  const isLive = slotStart != null && Date.now() >= slotStart && Date.now() < slotStart + LIVE_WINDOW_MS;

  return (
    <ScrollView style={S.container} contentContainerStyle={{ paddingBottom: 40 }} refreshControl={<AppRefreshControl {...refresh} />}>
      {/* Header */}
      <View style={S.header}>
        <View style={{ position: 'absolute', top: 8, right: 12 }}>
          <BookmarkButton targetType="event" targetId={eventId} />
        </View>
        {event.description ? <Text style={S.desc}>{event.description}</Text> : null}
        <View style={S.statusRow}>
          {votingIsOpen ? (
            <>
              <View style={S.dotOpen} />
              <Text style={S.statusOpen}>Voting open · {countdown}</Text>
            </>
          ) : isLive ? (
            <>
              <View style={S.dotLive} />
              <Text style={S.statusLive}>Live now · record your matches</Text>
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

      {status.value && (
        <View style={S.bannerWrap}>
          <StatusBanner status={status.value} />
        </View>
      )}

      {/* Confirmed slot banner */}
      {confirmedSlot && (
        <View style={[S.confirmedBanner, isLive && S.confirmedBannerLive]}>
          <Text style={S.confirmedLabel}>{isLive ? '🔴 Live now' : 'Confirmed Time'}</Text>
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
          <TouchableOpacity
            style={S.calBtn}
            activeOpacity={0.85}
            onPress={() => addToCalendar({
              title: event.title,
              startsAt: confirmedSlot.starts_at,
              endsAt: confirmedSlot.ends_at,
              location: leagueName || null,
              description: event.description || (leagueName ? `${leagueName} event on Pickleague` : 'Pickleague event'),
            })}
          >
            <Text style={S.calBtnText}>📅 Add to calendar</Text>
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

      {/* Invite guests (league admins / co-admins only, while voting is open) */}
      {votingIsOpen && canClose && (
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

      {/* "Can't make it" — deliberately outside the slot list. It is not a time
          option and can never win; it just tells the organiser who is out. */}
      <TouchableOpacity
        style={[S.declineCard, iDeclined && S.declineCardActive]}
        onPress={toggleDecline}
        disabled={!votingIsOpen || voting === 'decline'}
        activeOpacity={0.8}
      >
        <Text style={[S.declineTitle, iDeclined && S.declineTitleActive]}>
          {voting === 'decline' ? 'Saving…' : "🚫 Can't make it"}
        </Text>
        <Text style={S.declineSub}>
          {decliners.length > 0
            ? `${decliners.length} ${decliners.length === 1 ? 'player' : 'players'} can't make any of these times`
            : 'None of these times work for you?'}
        </Text>

        {decliners.length > 0 && (
          <View style={S.voterWrap}>
            {decliners.map((dp) => {
              const first = (dp.full_name ?? '?').trim().split(' ')[0] || '?';
              return (
                <View key={dp.id} style={S.voterChip}>
                  <View style={[S.voterAvatar, dp.avatar_bg_color ? { backgroundColor: dp.avatar_bg_color } : null]}>
                    <Text style={S.voterAvatarText}>{dp.avatar_emoji ?? (first[0]?.toUpperCase() ?? '?')}</Text>
                  </View>
                  <Text style={S.voterName}>{first}</Text>
                </View>
              );
            })}
          </View>
        )}
      </TouchableOpacity>

      {/* What the threshold means, while it can still change the outcome. */}
      {event.min_players != null && votingIsOpen && (
        <Text style={S.minPlayersNote}>
          Needs {event.min_players} players on one time — otherwise this event is
          cancelled when voting closes.
        </Text>
      )}

      {/* Nudge the group. Creator only — they are the one who has the thread. */}
      {canClose && nudgeKind && (
        <View style={S.nudgeCard}>
          <Text style={S.nudgeTitle}>
            {nudgeKind === 'vote' ? '📣 Chase the stragglers'
              : nudgeKind === 'today' ? '📣 Remind them it’s today'
              : '📣 Tell them it’s locked in'}
          </Text>
          <Text style={S.nudgeSub}>
            Opens your messaging app with the group and the message ready — you tap send.
          </Text>
          <View style={S.nudgeBtnRow}>
            <TouchableOpacity
              style={[S.nudgeBtn, S.nudgeBtnSms]}
              onPress={() => sendNudge('sms')}
              disabled={nudging}
            >
              <Text style={S.nudgeBtnText}>{nudging ? '…' : '💬 Text'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.nudgeBtn, S.nudgeBtnWa]}
              onPress={() => sendNudge('whatsapp')}
              disabled={nudging}
            >
              <Text style={S.nudgeBtnText}>{nudging ? '…' : '🟢 WhatsApp'}</Text>
            </TouchableOpacity>
            {chatWebhookUrl && (
              <TouchableOpacity
                style={[S.nudgeBtn, S.nudgeBtnChat]}
                onPress={() => sendNudge('chat')}
                disabled={nudging}
              >
                <Text style={S.nudgeBtnText}>{nudging ? '…' : '📢 League chat'}</Text>
              </TouchableOpacity>
            )}
          </View>
          {/* Setup is offered only to the league creator: RLS would reject the
              write (and hide the row) for anyone else. */}
          {!chatWebhookUrl && isLeagueCreator && !webhookSetupOpen && (
            <TouchableOpacity onPress={() => setWebhookSetupOpen(true)}>
              <Text style={S.webhookSetupLink}>
                Connect a Discord/Slack webhook to post nudges with one tap →
              </Text>
            </TouchableOpacity>
          )}
          {webhookSetupOpen && (
            <View style={S.webhookSetupBox}>
              <Text style={S.webhookSetupHint}>
                Discord: channel → Edit → Integrations → Webhooks → Copy URL.
                Anyone with this URL can post to the channel, so it stays
                visible only to you.
              </Text>
              <TextInput
                style={S.webhookInput}
                placeholder="https://discord.com/api/webhooks/…"
                placeholderTextColor={c.textMuted}
                value={webhookInput}
                onChangeText={setWebhookInput}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={S.nudgeBtnRow}>
                <TouchableOpacity
                  style={[S.nudgeBtn, S.nudgeBtnChat]}
                  onPress={saveChatWebhook}
                  disabled={webhookSaving}
                >
                  <Text style={S.nudgeBtnText}>{webhookSaving ? 'Saving…' : 'Save'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[S.nudgeBtn, S.nudgeBtnCancel]}
                  onPress={() => setWebhookSetupOpen(false)}
                  disabled={webhookSaving}
                >
                  <Text style={[S.nudgeBtnText, { color: c.textSub }]}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      )}

      {/* Creator actions */}
      {canClose && votingIsOpen && (
        <TouchableOpacity style={S.closeVoteBtn} onPress={closeVoting}>
          <Text style={S.closeVoteText}>Close Voting & Confirm Top Slot</Text>
        </TouchableOpacity>
      )}

      {/* Done — back to home */}
      <TouchableOpacity style={S.doneBtn} onPress={() => navigation.navigate('Home')}>
        <Text style={S.doneBtnText}>Done</Text>
      </TouchableOpacity>

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
    bannerWrap: { paddingHorizontal: 16, paddingTop: 12 },
    header: { backgroundColor: c.surface, padding: 16, marginBottom: 8 },
    desc: { fontSize: 14, color: c.textSub, marginBottom: 8 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    dotOpen: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.primary },
    dotScheduled: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1565c0' },
    dotClosed: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#e65100' },
    dotLive: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.danger },
    statusOpen: { fontSize: 14, color: c.primary, fontWeight: '600' },
    statusLive: { fontSize: 14, color: c.danger, fontWeight: '700' },
    statusScheduled: { fontSize: 14, color: '#1565c0', fontWeight: '600' },
    statusClosed: { fontSize: 14, color: '#e65100', fontWeight: '600' },
    voteDeadline: { fontSize: 12, color: c.textMuted, marginTop: 4 },
    confirmedBanner: { backgroundColor: '#1565c0', margin: 12, borderRadius: 14, padding: 18, alignItems: 'center', elevation: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 4 },
    confirmedBannerLive: { backgroundColor: c.danger },
    confirmedLabel: { fontSize: 12, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
    confirmedDate: { fontSize: 20, fontWeight: '800', color: '#fff' },
    confirmedTime: { fontSize: 16, color: 'rgba(255,255,255,0.9)', marginTop: 2 },
    confirmedAttendeeCount: { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 6 },

    recordBtn:      { marginTop: 12, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
    recordBtnText:  { color: '#fff', fontSize: 14, fontWeight: '700' },
    calBtn:         { marginTop: 8, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
    calBtnText:     { color: '#fff', fontSize: 14, fontWeight: '700' },

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
    nudgeCard:       { marginHorizontal: 12, marginTop: 12, padding: 14, borderRadius: 12, backgroundColor: c.primaryLight },
    nudgeTitle:      { fontSize: 15, fontWeight: '800', color: c.primary },
    nudgeSub:        { fontSize: 12, color: c.textSub, marginTop: 3, lineHeight: 17 },
    nudgeBtnRow:     { flexDirection: 'row', gap: 10, marginTop: 12 },
    nudgeBtn:        { flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: 'center' },
    nudgeBtnSms:     { backgroundColor: c.primary },
    nudgeBtnWa:      { backgroundColor: '#25D366' },
    nudgeBtnChat:    { backgroundColor: '#5865F2' },
    nudgeBtnCancel:  { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    nudgeBtnText:    { color: '#fff', fontWeight: '800', fontSize: 13 },
    webhookSetupLink:{ fontSize: 12, color: c.primary, fontWeight: '700', marginTop: 10 },
    webhookSetupBox: { marginTop: 10 },
    webhookSetupHint:{ fontSize: 11, color: c.textMuted, lineHeight: 16, marginBottom: 8 },
    webhookInput:    { borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 13, color: c.text, backgroundColor: c.surface, marginBottom: 10 },
    declineCard:      { marginHorizontal: 12, marginTop: 10, padding: 14, borderRadius: 12, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surface },
    declineCardActive:{ borderColor: c.danger, backgroundColor: c.surfaceAlt },
    declineTitle:     { fontSize: 15, fontWeight: '800', color: c.textSub },
    declineTitleActive:{ color: c.danger },
    declineSub:       { fontSize: 12, color: c.textMuted, marginTop: 3 },
    minPlayersNote:   { marginHorizontal: 12, marginTop: 8, fontSize: 12, color: c.textMuted, textAlign: 'center', lineHeight: 17 },
    closeVoteBtn: { marginHorizontal: 12, marginTop: 8, marginBottom: 4, backgroundColor: '#e65100', borderRadius: 12, padding: 16, alignItems: 'center' },
    doneBtn:      { marginHorizontal: 12, marginTop: 12, marginBottom: 4, backgroundColor: c.primary, borderRadius: 12, padding: 16, alignItems: 'center' },
    doneBtnText:  { color: '#fff', fontWeight: '700', fontSize: 15 },
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
