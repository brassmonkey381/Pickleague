// A league event (plan section 5, "Event"). One section order per state:
//
//   Voting     identity chips (status · league › · court) → You card ("Your
//              vote: none · 1d left") → slot cards (tap to vote) → Can't make
//              it → min-players note → Manage
//   Confirmed  identity → time card (the You card: date, place, N in, I'm in /
//              Can't make it, Record match, Add to calendar) → Who's in →
//              Matches recorded → Vote results (collapsed) → Manage
//   Cancelled  identity ("Cancelled") → Vote results (collapsed)
//
// Manage (collapsed) holds every organiser tool: invite guests, nudge and the
// webhook setup, close voting, edit details. Each is shown only to who can
// actually use it (see the gates below). Arriving with `focus` scrolls to that
// control; a push's openNudge / openClose opens Manage and scrolls to it.
// "Done" is a text link at the end that pops back to Home.
import { useNavReserve, useScreenBottomInset } from '../lib/appChrome';
import React, { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Pressable, StyleSheet, Platform, TextInput,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { RouteProp, useFocusEffect, useIsFocused } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  AvatarPile, Badge, ClampText, CollapsibleSection, FilterPill, Panel, SectionHeader, StatusBanner,
  StickyActionBar,
} from '@just-messin-around/expo-foundation/ui';
import { Icon, type IconName } from '@just-messin-around/expo-foundation/icons';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { getLeagueRole, isPrivileged } from '../lib/leagueRole';
import { LeagueEvent, EventSlot, SlotVoter, RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import ConfirmModal from '../components/ConfirmModal';
import ContactPickerModal from '../components/ContactPickerModal';
import { sendSmsInvite, shareViaWhatsApp } from '../lib/sms';
import { postToChatWebhook, isLikelyChatWebhookUrl } from '@just-messin-around/expo-foundation/platform';
import { buildNudgeMessage, loadInvitedPhones, pickNudgeKind } from '../lib/eventNudge';
import { shareInvite } from '../lib/share';
import { addToCalendar } from '../lib/calendar';
import { DeviceContact } from '../lib/contacts';
import BookmarkButton from '../components/BookmarkButton';
import ShareLinkButton from '../components/ShareLinkButton';
import CourtPicker, { CourtResult } from '../components/CourtPicker';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { useStatusMessage } from '../lib/useStatusMessage';
import { optionNumbers } from '../lib/eventVote';
import { displayCourtName } from '../lib/courtNickname';
import { entityIcon } from '../lib/entityGlyph';
import { trackSectionToggle } from '../lib/analytics';
import { sbCall, friendlySbMessage, insertIgnoringDuplicate, currentUserId as localUserId } from '@just-messin-around/expo-foundation/supabase';
import EventSlotCard from '../components/event/EventSlotCard';
import EventTimeCard from '../components/event/EventTimeCard';
import { isImageShareAvailable } from '@just-messin-around/expo-foundation/platform';
import PickleShareStudio from '../components/share/PickleShareStudio';
import ShareCallout from '../components/share/ShareCallout';
import { eventCardModel } from '../lib/shareCards';
import VoterChips from '../components/event/VoterChips';
import {
  categorizeEvent, eventStatusLabel, eventStatusTone, timeLeftLabel, LIVE_WINDOW_MS,
} from '../components/event/eventModel';
import AlbumSection from '../components/AlbumSection';
import GroupSessionSection from '../components/GroupSessionSection';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'EventDetail'>;
  route: RouteProp<RootStackParamList, 'EventDetail'>;
};

const ANALYTICS_SCREEN = 'EventDetail';

/** Re-render on a clock so countdowns and the live / RSVP windows stay true. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// A web refresh turns a boolean route param into the string 'true'.
const flag = (v: unknown) => v === true || v === 'true';

type ScrollTarget = 'vote' | 'rsvp' | 'manage';

export default function EventDetailScreen({ navigation, route }: Props) {
  const { eventId, focus } = route.params;
  const openNudge = flag(route.params.openNudge);
  const openClose = flag(route.params.openClose);
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = makeStyles(c);
  const isFocused = useIsFocused();
  // The navigator already keeps the bottom bar and the island clear (lib/appChrome).
  const bottomInset = useScreenBottomInset(SPACE.xl);
  const navReserve = useNavReserve();
  const now = useNow(30_000);

  const [event, setEvent] = useState<LeagueEvent | null>(null);
  const [leagueName, setLeagueName] = useState<string>('');
  const [showGuestPicker, setShowGuestPicker] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [invitingGuests, setInvitingGuests] = useState(false);
  const [closeWinner, setCloseWinner] = useState<EventSlot | null>(null);
  const [closing, setClosing]         = useState(false);
  // Cancel event: the organizer chooses each time whether the league hears
  // about it and whether it stays in the events list (a mistake being remade
  // should do neither).
  const [cancelOpen, setCancelOpen]       = useState(false);
  const [cancelNotify, setCancelNotify]   = useState(true);
  const [cancelRemove, setCancelRemove]   = useState(false);
  const [cancelling, setCancelling]       = useState(false);
  const [cancelError, setCancelError]     = useState<string | null>(null);
  const [slots, setSlots] = useState<EventSlot[]>([]);
  const [memberCount, setMemberCount] = useState(0);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [confirmedAttendees, setConfirmedAttendees] = useState<SlotVoter[]>([]);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState<string | null>(null); // slot id / 'decline' / 'rsvp_in' / 'rsvp_out'
  // "Can't make it" — informational only. It lives in its own table, so it can
  // never be picked as the winning slot no matter how many people choose it.
  const [decliners, setDecliners] = useState<SlotVoter[]>([]);
  const [iDeclined, setIDeclined] = useState(false);
  const [nudging, setNudging] = useState(false);
  // League chat webhook (Discord/Slack). Null when unset OR unreadable — RLS
  // only lets the league creator see it.
  const [chatWebhookUrl, setChatWebhookUrl] = useState<string | null>(null);
  const [isLeagueCreator, setIsLeagueCreator] = useState(false);
  const [webhookSetupOpen, setWebhookSetupOpen] = useState(false);
  const [webhookInput, setWebhookInput] = useState('');
  const [webhookSaving, setWebhookSaving] = useState(false);
  // Creator-only edit of the vote's location + description. Location goes
  // through the standard venue picker, same as event creation and tournaments.
  const [detailsEditOpen, setDetailsEditOpen] = useState(false);
  const [editDesc, setEditDesc] = useState('');
  const [editLoc, setEditLoc] = useState<CourtResult | null>(null);
  const [detailsSaving, setDetailsSaving] = useState(false);
  // Manage is controlled so a push (openNudge / openClose) can open it.
  const [manageOpen, setManageOpen] = useState(openNudge || openClose);
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

  // ── Scroll anchors ──────────────────────────────────────────────
  // `pendingScroll` is what this visit arrived for (focus param or a push
  // intent); it's consumed once, when its anchor has laid out.
  //
  // The vote and RSVP blocks are placed from the HEIGHTS of what sits above
  // them (the identity head, and the "Your vote" card), not from their own
  // onLayout y: react-native-web fires onLayout only from a ResizeObserver, so
  // a block that moves without resizing (the description's more/less, the
  // "Link copied" banner) never reports its new y, and the sticky RSVP bar
  // would switch on at a stale offset. A height change does fire, on web and
  // native. Manage keeps its onLayout y: it's read once, at arrival, before
  // anything above it can have moved.
  const scrollRef = useRef<ScrollView>(null);
  const headH = useRef<number | null>(null);
  const youCardH = useRef<number | null>(null);
  const rsvpH = useRef<number | null>(null);
  const voteSeen = useRef(false);
  const manageY = useRef<number | null>(null);
  const pendingScroll = useRef<ScrollTarget | null>(
    openNudge || openClose ? 'manage' : focus === 'vote' || focus === 'rsvp' ? focus : null,
  );
  const [timeCardOff, setTimeCardOff] = useState(false);

  useFocusEffect(useCallback(() => { load(); }, []));
  const refresh = useRefresh(load);

  async function load() {
    // LOCAL session read: getUser() is a network call that resolves null on a
    // flaky connection, which made every slot render as "not voted" and let the
    // user re-cast a vote they had already placed.
    const uid = await localUserId(supabase);
    setCurrentUserId(uid);

    const { data: ev } = await supabase.from('league_events').select('*').eq('id', eventId).single();
    if (!ev) { setLoading(false); return; }
    setEvent(ev);
    // The header is the event's own title, never the push that opened it
    // ('🗳️ New vote: ...' used to leak into it).
    if (ev.title) navigation.setOptions({ title: ev.title });

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
      // The vote push numbers times in this order (starts_at, id): Option N here
      // must be the Nth time in the push body and the Nth button.
      .order('starts_at')
      .order('id');

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

    // Who's in = the votes on the confirmed time. Avatar fields feed the pile.
    if (ev.confirmed_slot_id) {
      const { data: winnerVotes } = await supabase
        .from('event_slot_votes')
        .select('user_id, profile:profiles(id, full_name, avatar_emoji, avatar_bg_color)')
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
      .neq('status', 'scheduled')
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

  // RSVP once a time is confirmed. Same writes as the confirmed-event push
  // buttons (event_accept / event_decline): a plain insert, never an upsert,
  // because event_slot_votes has no UPDATE policy; 23505 means the answer is
  // already recorded. The DB triggers keep the two sides exclusive (a vote
  // clears a decline, a decline clears this user's votes), so each answer is
  // one row, exactly as toggleVote / toggleDecline rely on.
  async function respondToConfirmed(answer: 'in' | 'out') {
    if (voteInFlight.current) return;
    if (!currentUserId || !event?.confirmed_slot_id) return;
    const slotId = event.confirmed_slot_id;

    voteInFlight.current = true;
    setVoting(answer === 'in' ? 'rsvp_in' : 'rsvp_out');
    status.clear();
    try {
      if (answer === 'in') {
        await insertIgnoringDuplicate(supabase
          .from('event_slot_votes')
          .insert({ slot_id: slotId, user_id: currentUserId }));
      } else {
        await insertIgnoringDuplicate(supabase
          .from('event_declines')
          .insert({ event_id: eventId, user_id: currentUserId }));
      }
      await load();
    } catch (e) {
      // The only RLS refusal for your own row is an expired guest pass.
      status.error(friendlySbMessage(e, 'Could not save your RSVP. Tap again to retry.', {
        permission: "Your guest pass has expired, so you can't RSVP. Ask the organizer for a new invite.",
      }));
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

  function openDetailsEdit() {
    if (!event) return;
    setEditDesc(event.description ?? '');
    // Rebuild a picker value from the stored fields. Legacy hand-typed
    // locations have a name and no coords — 0/0 keeps them selectable and
    // clearable; picking a real venue replaces them with true coordinates.
    setEditLoc(event.location_name
      ? {
          name: event.location_name,
          address: '',
          lat: event.location_lat ?? 0,
          lng: event.location_lng ?? 0,
          placeId: `existing-${event.id}`,
        }
      : null);
    setDetailsEditOpen(true);
  }

  async function saveDetails() {
    if (!event || detailsSaving) return;
    setDetailsSaving(true);
    status.clear();
    try {
      // Idempotent write keyed by event id; RLS limits it to the creator.
      await sbCall(() => supabase
        .from('league_events')
        .update({
          description: editDesc.trim() || null,
          location_name: editLoc?.name ?? null,
          location_lat:  editLoc && editLoc.lat !== 0 ? editLoc.lat : null,
          location_lng:  editLoc && editLoc.lng !== 0 ? editLoc.lng : null,
        })
        .eq('id', event.id));
      setDetailsEditOpen(false);
      status.success('Event details updated.');
      await load();
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not save the changes.'));
    } finally {
      setDetailsSaving(false);
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

  function openCancel() {
    setCancelNotify(true);
    setCancelRemove(false);
    setCancelError(null);
    setCancelOpen(true);
  }
  async function confirmCancel() {
    if (cancelling || !event) return;
    setCancelling(true);
    setCancelError(null);
    // An already-cancelled event only offers Remove; it was announced (or not) back then.
    const alreadyCancelled = event.status === 'cancelled';
    const notify = !alreadyCancelled && cancelNotify;
    try {
      const outcome = await sbCall(() => supabase.rpc('cancel_league_event', {
        p_event_id: event.id,
        p_notify: notify,
        p_remove: alreadyCancelled || cancelRemove,
      })) as unknown as string | null;
      setCancelOpen(false);
      if (outcome === 'removed') {
        // Nothing left to show here.
        if (navigation.canGoBack()) navigation.goBack();
        else navigation.popTo('Home');
        return;
      }
      status.success(notify ? 'Event cancelled. The league has been told.' : 'Event cancelled. Nobody was notified.');
      await load();
    } catch (e) {
      setCancelError(friendlySbMessage(e, 'Could not cancel the event. Please try again.'));
    } finally {
      setCancelling(false);
    }
  }

  const votingIsOpen = event?.status === 'voting' && new Date(event.vote_ends_at).getTime() > now;
  const nudgeKind = event
    ? pickNudgeKind(event, slots.find(s => s.id === event.confirmed_slot_id) ?? null)
    : null;
  const isEventCreator = !!event && !!currentUserId && event.created_by === currentUserId;
  // A push button opened this screen to do one thing: Text group (openNudge)
  // opens the group-text composer, Close vote (openClose) opens the close
  // confirm. Once per visit, after the event has loaded, and only for the
  // organizer; the confirm dialog and the composer still need their own tap.
  // (Manage is opened and scrolled to separately, via pendingScroll.)
  const pushIntentDone = useRef(false);
  useEffect(() => {
    if (pushIntentDone.current || loading || !event || !currentUserId) return;
    if (!openNudge && !openClose) return;
    pushIntentDone.current = true;
    // Clear the params too, so a web refresh (they're in the URL) doesn't
    // reopen the confirm or the composer. Manage's open state and the scroll
    // were seeded from them at mount, so nothing else re-reads them.
    navigation.setParams({ openNudge: undefined, openClose: undefined });
    if (event.created_by !== currentUserId) return;
    if (openClose && event.status === 'voting') closeVoting();
    else if (openNudge && nudgeKind) void sendNudge('sms');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, event, currentUserId, openNudge, openClose, nudgeKind]);
  // League admins / co-admins: invite guests and nudge. Named for what it was
  // first used for; it no longer gates close voting (see canCloseVote).
  const [canClose, setCanClose] = React.useState(false);
  React.useEffect(() => {
    if (event?.league_id) getLeagueRole(event.league_id).then(r => {
      // 'unknown' means the role read failed, not that the user lacks the role —
      // demoting an admin because their WiFi blipped would hide the organiser
      // tools from the only person who can use them. Keep whatever we last knew.
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
    const link = `https://www.pickleague.club/g/${token}`;
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
      const token = await createGuestInvite(contacts.map(ct => ct.name), contacts.map(ct => ct.phone));
      if (token) {
        await sendSmsInvite({ message: buildGuestMessage(token), recipients: contacts.map(ct => ct.phone) });
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

  // Header bar (slot 0): [Share] [Bookmark]. Both get a real 44 box — RNW
  // ignores the hitSlop BookmarkButton relies on.
  useLayoutEffect(() => {
    if (!event) return;
    navigation.setOptions({
      headerRight: () => (
        <View style={S.headerActions}>
          {/* The event URL serves a live OG snapshot card, so wherever this
              lands — Discord, WhatsApp, iMessage — it unfurls into the poll. */}
          <ShareLinkButton
            url={`https://www.pickleague.club/events/${eventId}`}
            title={event.title}
            message={votingIsOpen ? `Vote on a time for "${event.title}"` : `"${event.title}" on Pickleague`}
            onCopied={() => status.success('Link copied — paste it anywhere; it unfurls into the vote card.')}
            style={S.headerShare}
          />
          <BookmarkButton targetType="event" targetId={eventId} style={S.headerIconBox} />
        </View>
      ),
    });
    // S is rebuilt per render from the same colors; status is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, event?.id, event?.title, votingIsOpen, eventId, c]);

  // ── Scrolling to what this visit is for ─────────────────────────
  function tryPendingScroll() {
    const want = pendingScroll.current;
    if (!want || loading || !event) return;
    // A link can name a control this state doesn't have (an RSVP push after
    // the event was cancelled, a vote link after it was confirmed): fall back
    // to the control that does exist, else give up quietly.
    const order: ScrollTarget[] = want === 'manage' ? ['manage'] : want === 'vote' ? ['vote', 'rsvp'] : ['rsvp', 'vote'];
    for (const target of order) {
      const y = anchorY(target);
      if (y == null) continue;
      pendingScroll.current = null;
      // Clear the param too, so a web refresh (the param is in the URL) or a
      // shared link doesn't re-arm the scroll.
      if (focus) navigation.setParams({ focus: undefined });
      // Next frame: the anchor's own layout pass may still be settling.
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: Math.max(0, y - SPACE.sm), animated: true }));
      return;
    }
  }
  // Content offset of an anchor (null until it, and what's above it, laid out).
  // SPACE.lg = S.content's top padding.
  function anchorY(target: ScrollTarget): number | null {
    if (target === 'manage') return manageY.current;
    if (headH.current == null) return null;
    if (target === 'rsvp') return rsvpH.current == null ? null : SPACE.lg + headH.current;
    return voteSeen.current && youCardH.current != null ? SPACE.lg + headH.current + youCardH.current : null;
  }
  // The scroll offset past which the time card is off screen (sticky bar on).
  function timeCardBottom(): number | null {
    const top = anchorY('rsvp');
    return top == null || rsvpH.current == null ? null : top + rsvpH.current;
  }
  const anchorLayout = (target: ScrollTarget) => (e: LayoutChangeEvent) => {
    if (target === 'manage') manageY.current = e.nativeEvent.layout.y;
    else if (target === 'rsvp') rsvpH.current = e.nativeEvent.layout.height;
    else voteSeen.current = true;
    tryPendingScroll();
  };
  const heightLayout = (ref: { current: number | null }) => (e: LayoutChangeEvent) => {
    ref.current = e.nativeEvent.layout.height;
    tryPendingScroll();
  };
  // Manage is reachable only for its users; anyone else arriving via a push
  // link simply lands at the top.
  useEffect(() => { tryPendingScroll(); });

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const y = e.nativeEvent.contentOffset.y;
    const bottom = timeCardBottom();
    const off = bottom != null && y > bottom;
    setTimeCardOff(prev => (prev === off ? prev : off));
  }

  function onSectionToggle(section: string, open: boolean) {
    trackSectionToggle({ screen: ANALYTICS_SCREEN, section, open });
  }

  if (loading) return <View style={{ flex: 1, backgroundColor: c.bg }}><SkeletonList rows={6} variant="row" /></View>;
  if (!event) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <EmptyState iconName="search" title="Event not found." actionLabel="Retry" onAction={() => { setLoading(true); void load(); }} />
      </View>
    );
  }

  const confirmedSlot = event.confirmed_slot_id ? slots.find((s) => s.id === event.confirmed_slot_id) ?? null : null;
  const category = categorizeEvent(event, confirmedSlot?.starts_at ?? null, now);
  const cancelled = category === 'cancelled';
  // "Live": the confirmed slot has started and is still within its 24h open
  // window — the event is open for recording matches.
  const slotStart = confirmedSlot ? new Date(confirmedSlot.starts_at).getTime() : null;
  const isLive = slotStart != null && now >= slotStart && now < slotStart + LIVE_WINDOW_MS;
  // RSVP stays open from confirmation until the confirmed time ends. Not on a
  // cancelled event, and not while the time vote itself is still running.
  const rsvpOpen = !!confirmedSlot && !votingIsOpen && !cancelled
    && now < new Date(confirmedSlot.ends_at).getTime();
  const iAmIn = confirmedSlot?.my_vote ?? false;
  const myVoteCount = slots.filter(s => s.my_vote).length;
  const timeLeft = timeLeftLabel(event.vote_ends_at, now);
  const place = event.location_name ? displayCourtName(event.location_name) : null;
  const optionNo = optionNumbers(slots);

  // ── Who may use which organiser tool ──
  // Invite guests + nudge: league admins / co-admins (the RPC allows any member
  // to invite; the UI keeps it to organisers, as before).
  const canInvite = canClose && votingIsOpen;
  const canNudge = canClose && !!nudgeKind && !cancelled;
  // Close voting: the event's creator. close_event_vote raises for anyone
  // else, so showing it to other admins only produced an error.
  const canCloseVote = isEventCreator && votingIsOpen;
  // Edit details: the creator only — RLS "Event creator can update".
  const canEdit = isEventCreator && !cancelled;
  // Webhook setup: the league creator only — RLS hides and rejects it for
  // anyone else.
  const canSetupWebhook = isLeagueCreator && !chatWebhookUrl && !cancelled;
  // Cancel: the creator or a league admin (cancel_league_event's rule). A
  // cancelled event keeps only Remove, so it can be cleared from the list.
  const canCancel = (isEventCreator || canClose) && !cancelled;
  const canRemove = (isEventCreator || canClose) && cancelled;
  const showManage = canRemove
    || (!cancelled && (canInvite || canNudge || canCloseVote || canEdit || canSetupWebhook || canCancel));

  const description = event.description?.trim() || '';

  // ── Sticky bar: repeats the time card's primary once it scrolls away ──
  const rsvpUnanswered = rsvpOpen && !iAmIn && !iDeclined;
  const stickyVisible = !!confirmedSlot && timeCardOff && (rsvpUnanswered || isLive);

  const recordMatch = () => navigation.navigate('MatchEntry', { leagueId: event.league_id, eventId });

  // ── Share this event (PKL-013): I was in, and it has started ──
  const shareModel = confirmedSlot && iAmIn && !cancelled && slotStart != null && now >= slotStart && isImageShareAvailable()
    ? eventCardModel({
        title: event.title,
        league: leagueName || null,
        court: place,
        date: new Date(confirmedSlot.starts_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
        count: confirmedAttendees.length,
      })
    : null;

  const voteResults = slots.length > 0 && (
    <CollapsibleSection
      compact
      title="Vote results"
      count={slots.length}
      summary={confirmedSlot
        ? `${confirmedSlot.vote_count ?? 0} voted for the confirmed time`
        : `${slots.length} time${slots.length === 1 ? '' : 's'} proposed`}
      onToggle={(next) => onSectionToggle('vote_results', next)}
    >
      {slots.map(slot => (
        <EventSlotCard
          key={slot.id}
          slot={slot}
          optionNo={slots.length > 1 ? optionNo.get(slot.id) : null}
          memberCount={memberCount}
          isWinner={slot.id === event.confirmed_slot_id}
          votable={false}
          busy={false}
          onToggle={() => {}}
        />
      ))}
      {decliners.length > 0 && (
        <View>
          <Text style={t.meta} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {decliners.length} can't make it
          </Text>
          <VoterChips voters={decliners} />
        </View>
      )}
    </CollapsibleSection>
  );

  return (
    <View style={S.root}>
      <ScrollView
        ref={scrollRef}
        style={S.container}
        contentContainerStyle={[S.content, { paddingBottom: bottomInset }]}
        refreshControl={<AppRefreshControl {...refresh} />}
        onScroll={onScroll}
        scrollEventThrottle={32}
      >
        {/* ── 1. Identity: status · league › · court, then the description ──
            One wrapper (with the banner) whose height places the blocks below;
            see the scroll-anchor note. The content has no gap, so the wrapper
            changes no spacing. */}
        <View onLayout={heightLayout(headH)}>
        <View style={S.chipRow}>
          <Badge label={eventStatusLabel(category)} tone={eventStatusTone(category)} align="center" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
          {leagueName ? (
            // FilterPill: the 28px neutral pill in a 44 box, with the league glyph
            // before the name and the chevron that says it opens.
            <FilterPill
              iconName={entityIcon('league')}
              label={leagueName}
              trailingIconName="chevron-right"
              accessibilityRole="button"
              accessibilityLabel={`League: ${leagueName}`}
              accessibilityState={{}}
              maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
              onPress={() => {
                // Back to the league, not a second copy of it. popTo matches by
                // name only (no getId) and lands on the NEAREST LeagueDetail
                // below us, so use it only when that route is this event's
                // league; otherwise (cold link, push, opened from Home) navigate
                // pushes a fresh one.
                const params = { leagueId: event.league_id, leagueName };
                const nearest = [...navigation.getState().routes].reverse().find(r => r.name === 'LeagueDetail');
                if ((nearest?.params as { leagueId?: string } | undefined)?.leagueId === event.league_id) {
                  navigation.popTo('LeagueDetail', params);
                } else {
                  navigation.navigate('LeagueDetail', params);
                }
              }}
            />
          ) : null}
          {place ? <Badge iconName="pin" label={place} tone="neutral" align="center" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} /> : null}
        </View>
        {description ? (
          <ClampText style={t.sub} containerStyle={S.descBlock}>{description}</ClampText>
        ) : null}

        {status.value ? <StatusBanner status={status.value} style={S.banner} /> : null}
        </View>

        {/* ── Voting ─────────────────────────────────────────────── */}
        {(category === 'voting_open' || category === 'vote_closed') && (
          <>
            <View onLayout={heightLayout(youCardH)}>
            <Panel emphasis style={S.youCard}>
              <Text style={t.label} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Your vote</Text>
              <Text style={[t.title, S.youTitle]}>
                {iDeclined ? "You can't make it"
                  : myVoteCount > 0 ? `Available for ${myVoteCount} time${myVoteCount === 1 ? '' : 's'}`
                  : "You haven't voted"}
              </Text>
              <Text style={t.sub} numberOfLines={2}>
                {votingIsOpen
                  ? `${timeLeft ?? 'Closing soon'} · tap every time that works for you`
                  : 'Voting has ended · the organizer is picking the time'}
              </Text>
            </Panel>
            </View>

            <View onLayout={anchorLayout('vote')} style={S.block}>
              {slots.map((slot) => (
                <EventSlotCard
                  key={slot.id}
                  slot={slot}
                  // Matches the numbered times (and 1st / 2nd / 3rd time buttons) in the vote push.
                  optionNo={slots.length > 1 ? optionNo.get(slot.id) : null}
                  memberCount={memberCount}
                  isWinner={slot.id === event.confirmed_slot_id}
                  votable={votingIsOpen}
                  busy={voting === slot.id}
                  onToggle={() => toggleVote(slot)}
                />
              ))}

              {/* "Can't make it" — deliberately outside the slot list. It is not a
                  time option and can never win; it just tells the organiser who is out. */}
              <TouchableOpacity
                style={[S.declineCard, iDeclined && S.declineCardActive]}
                onPress={toggleDecline}
                disabled={!votingIsOpen || voting === 'decline'}
                activeOpacity={0.8}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: iDeclined }}
              >
                {voting === 'decline' ? (
                  <Text style={[t.title, { color: iDeclined ? c.danger : c.textSub }]}>Saving…</Text>
                ) : (
                  <IconTitle iconName="block" color={iDeclined ? c.danger : c.textSub}>Can't make it</IconTitle>
                )}
                <Text style={t.meta} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                  {decliners.length > 0
                    ? `${decliners.length} ${decliners.length === 1 ? 'player' : 'players'} can't make any of these times`
                    : 'None of these times work for you?'}
                </Text>
                <VoterChips voters={decliners} />
              </TouchableOpacity>

              {/* What the threshold means, while it can still change the outcome. */}
              {event.min_players != null && votingIsOpen && (
                <Text style={[t.hint, S.note]}>
                  Needs {event.min_players} players on one time — otherwise this event is cancelled when voting closes.
                </Text>
              )}
            </View>
          </>
        )}

        {/* ── Confirmed (scheduled / live / past) ────────────────── */}
        {confirmedSlot && !cancelled && category !== 'voting_open' && category !== 'vote_closed' && (
          <>
            <View onLayout={anchorLayout('rsvp')} style={S.block}>
              <EventTimeCard
                startsAt={confirmedSlot.starts_at}
                endsAt={confirmedSlot.ends_at}
                isLive={isLive}
                place={place}
                inCount={confirmedAttendees.length}
                outCount={decliners.length}
                rsvpOpen={rsvpOpen}
                iAmIn={iAmIn}
                iDeclined={iDeclined}
                busy={voting === 'rsvp_in' || voting === 'rsvp_out' ? voting : voting ? 'other' : null}
                onRsvp={respondToConfirmed}
                onRecord={recordMatch}
                onAddToCalendar={() => addToCalendar({
                  title: event.title,
                  startsAt: confirmedSlot.starts_at,
                  endsAt: confirmedSlot.ends_at,
                  location: event.location_name || leagueName || null,
                  description: event.description || (leagueName ? `${leagueName} event on Pickleague` : 'Pickleague event'),
                })}
              />
            </View>

            {shareModel ? (
              <ShareCallout
                title={isLive ? "You're playing this event" : 'You played this event'}
                line="Make an Instagram post or Story of it, with your photos."
                buttonTitle="Share this event"
                onPress={() => setShareOpen(true)}
                style={S.block}
              />
            ) : null}

            {confirmedAttendees.length > 0 && (
              <View style={S.block}>
                <SectionHeader title="Who's in" count={confirmedAttendees.length} />
                <Panel>
                  <AvatarPile
                    items={confirmedAttendees}
                    keyOf={(p) => p.id}
                    labelOf={(p) => p.full_name || 'Player'}
                    // 44: each avatar is its own tap target (tap shows the name).
                    size={44}
                    maxVisible={10}
                    renderAvatar={(p, size) => (
                      <View style={[S.pileAvatar, { width: size, height: size }, p.avatar_bg_color ? { backgroundColor: p.avatar_bg_color } : null]}>
                        <Text style={t.title} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                          {p.avatar_emoji ?? (p.full_name?.trim()[0]?.toUpperCase() || '?')}
                        </Text>
                      </View>
                    )}
                  />
                  {decliners.length > 0 && (
                    <Text style={t.meta} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                      Can't make it: {decliners.map(d => (d.full_name ?? '').trim().split(' ')[0] || 'Player').join(', ')}
                    </Text>
                  )}
                </Panel>
              </View>
            )}
          </>
        )}

        {/* ── Matches recorded for this event ── */}
        {!cancelled && eventMatches.length > 0 && (
          <View style={S.block}>
            <SectionHeader title="Matches recorded" count={eventMatches.length} />
            <Panel padded={false}>
              {eventMatches.map((m, i) => {
                const teamA = [m.p1?.full_name, m.pn1?.full_name].filter(Boolean).join(' & ') || 'Player';
                const teamB = [m.p2?.full_name, m.pn2?.full_name].filter(Boolean).join(' & ') || 'Player';
                const scoreLabel = m.player1_score != null && m.player2_score != null
                  ? `${m.player1_score}–${m.player2_score}`
                  : null;
                const winSuffix = m.winner_team === 'team1' ? 'Team A won' : m.winner_team === 'team2' ? 'Team B won' : null;
                return (
                  <View key={m.id} style={[S.matchRow, i < eventMatches.length - 1 && S.divider]}>
                    <Text style={t.title} numberOfLines={1}>{teamA} vs {teamB}</Text>
                    <Text style={t.sub} numberOfLines={1}>
                      {[scoreLabel, winSuffix, m.status === 'completed' ? 'final' : m.status].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                );
              })}
            </Panel>
          </View>
        )}

        {/* ── Vote results (collapsed) — confirmed and cancelled ── */}
        {category !== 'voting_open' && category !== 'vote_closed' && voteResults}

        {/* ── Manage ─────────────────────────────────────────────── */}
        {showManage && (
          <View onLayout={anchorLayout('manage')}>
            <CollapsibleSection
              compact
              title="Manage"
              summary={[
                canCloseVote && 'Close voting',
                canNudge && 'Nudge',
                canInvite && 'Invite guests',
                canEdit && 'Edit details',
                canCancel && 'Cancel event',
                canRemove && 'Remove',
              ].filter(Boolean).join(' · ') || 'League chat'}
              open={manageOpen}
              onToggle={(next) => { setManageOpen(next); onSectionToggle('manage', next); }}
            >
              {canCloseVote && (
                <View style={S.manageRow}>
                  <View style={S.manageText}>
                    <Text style={t.title}>Close voting</Text>
                    <Text style={t.sub} numberOfLines={2}>Confirms the time with the most votes now.</Text>
                  </View>
                  <Button size="sm" title="Close" onPress={closeVoting} />
                </View>
              )}

              {canNudge && (
                <View style={S.manageGroup}>
                  <IconTitle iconName="megaphone">
                    {nudgeKind === 'vote' ? 'Chase the stragglers'
                      : nudgeKind === 'today' ? 'Remind them it’s today'
                      : 'Tell them it’s locked in'}
                  </IconTitle>
                  <Text style={t.sub} numberOfLines={2}>
                    Opens your messaging app with the group and the message ready — you tap send.
                  </Text>
                  <View style={S.btnRow}>
                    <Button size="sm" iconName="chat" title="Text" loading={nudging} onPress={() => sendNudge('sms')} />
                    <Button size="sm" variant="success" title="WhatsApp" disabled={nudging} onPress={() => sendNudge('whatsapp')} />
                    {chatWebhookUrl && (
                      <Button size="sm" variant="outline" iconName="megaphone" title="League chat" disabled={nudging} onPress={() => sendNudge('chat')} />
                    )}
                  </View>
                </View>
              )}

              {/* Setup is offered only to the league creator: RLS would reject the
                  write (and hide the row) for anyone else. */}
              {canSetupWebhook && (
                webhookSetupOpen ? (
                  <View style={S.manageGroup}>
                    <Text style={t.hint}>
                      Discord: channel → Edit → Integrations → Webhooks → Copy URL.
                      Anyone with this URL can post to the channel, so it stays
                      visible only to you.
                    </Text>
                    <TextInput
                      style={[S.input, webInputFontFloor(S.input)]}
                      placeholder="https://discord.com/api/webhooks/…"
                      placeholderTextColor={c.textMuted}
                      value={webhookInput}
                      onChangeText={setWebhookInput}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <View style={S.btnRow}>
                      <Button size="sm" title="Save" loading={webhookSaving} onPress={saveChatWebhook} />
                      <Button size="sm" variant="outline" title="Cancel" disabled={webhookSaving} onPress={() => setWebhookSetupOpen(false)} />
                    </View>
                  </View>
                ) : (
                  <Pressable onPress={() => setWebhookSetupOpen(true)} style={[S.linkBox, S.linkRow]} accessibilityRole="button">
                    <Text style={[t.meta, S.shrink, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                      Connect a Discord/Slack webhook to post nudges with one tap
                    </Text>
                    <Icon name="chevron-right" size={14} color={c.primary} />
                  </Pressable>
                )
              )}

              {canInvite && (
                <View style={S.manageRow}>
                  <View style={S.manageText}>
                    <IconTitle iconName="phone">Invite guests to vote</IconTitle>
                    <Text style={t.sub} numberOfLines={2}>No account needed — a 7-day guest pass.</Text>
                  </View>
                  <Button size="sm" variant="outline" title="Invite" loading={invitingGuests} onPress={onInviteGuests} />
                </View>
              )}

              {/* Only the creator may edit — matches RLS ("Event creator can update"). */}
              {canEdit && (
                detailsEditOpen ? (
                  <View style={S.manageGroup}>
                    <Text style={t.fieldLabel}>Location</Text>
                    <CourtPicker
                      value={editLoc}
                      onSelect={setEditLoc}
                      active={detailsEditOpen}
                      showNoneOption
                      placeholder="Search for a court or venue…"
                    />
                    <Text style={t.fieldLabel}>Description</Text>
                    <TextInput
                      style={[S.input, S.inputMulti, webInputFontFloor(S.input)]}
                      placeholder="Notes, what to bring..."
                      placeholderTextColor={c.textMuted}
                      value={editDesc}
                      onChangeText={setEditDesc}
                      multiline
                    />
                    <View style={S.btnRow}>
                      <Button size="sm" title="Save" loading={detailsSaving} onPress={saveDetails} />
                      <Button size="sm" variant="outline" title="Cancel" disabled={detailsSaving} onPress={() => setDetailsEditOpen(false)} />
                    </View>
                  </View>
                ) : (
                  <View style={S.manageRow}>
                    <View style={S.manageText}>
                      <IconTitle iconName="edit">Edit details</IconTitle>
                      <Text style={t.sub} numberOfLines={1}>Location and description</Text>
                    </View>
                    <Button size="sm" variant="outline" title="Edit" onPress={openDetailsEdit} />
                  </View>
                )
              )}

              {(canCancel || canRemove) && (
                <View style={S.manageRow}>
                  <View style={S.manageText}>
                    <IconTitle iconName={canRemove ? 'trash' : 'block'} color={c.danger}>
                      {canRemove ? 'Remove from history' : 'Cancel event'}
                    </IconTitle>
                    <Text style={t.sub} numberOfLines={2}>
                      {canRemove ? 'Takes it off the events list for everyone.' : 'You choose whether the league is told.'}
                    </Text>
                  </View>
                  <Button size="sm" variant="danger" title={canRemove ? 'Remove' : 'Cancel'} onPress={openCancel} />
                </View>
              )}
            </CollapsibleSection>
          </View>
        )}

        {/* The group session: who's playing at this event, and Join on its
            day (hidden unless you're in the event). */}
        <GroupSessionSection
          kind="event"
          id={eventId}
          title={event.title}
          startsAt={confirmedSlot?.starts_at ?? null}
          endsAt={confirmedSlot?.ends_at ?? null}
          over={leagueName || null}
          court={place}
        />

        {/* Photos: the event's shared album (hidden unless you're in it). */}
        <AlbumSection kind="event" id={eventId} />

        {/* Done — a text link at the end. popTo, not navigate: under React
            Navigation 7 navigate('Home') pushes a second Home, and with
            linking's initialRouteName Home is always in the stack. */}
        <Pressable onPress={() => navigation.popTo('Home')} style={S.doneBox} accessibilityRole="button">
          <Text style={[t.title, { color: c.primary }]}>Done</Text>
        </Pressable>

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

        <ConfirmModal
          visible={cancelOpen}
          title={cancelled ? 'Remove this event?' : 'Cancel this event?'}
          body={cancelled
            ? 'It disappears from the events list for everyone. This cannot be undone.'
            : 'Voting and RSVPs stop. This cannot be undone.'}
          primaryLabel={cancelled || cancelRemove ? 'Remove event' : 'Cancel event'}
          cancelLabel="Keep it"
          variant="danger"
          busy={cancelling}
          error={cancelError}
          extraField={cancelled ? undefined : (
            <View style={S.checkGroup}>
              <CheckRow
                label="Notify league members"
                sub={cancelNotify ? 'Everyone gets an “Event cancelled” push.' : 'Nobody is told. Good for fixing a mistake.'}
                checked={cancelNotify}
                onToggle={() => setCancelNotify(v => !v)}
              />
              <CheckRow
                label="Remove from history"
                sub={cancelRemove ? 'Deleted, along with its vote notices.' : 'Stays in the events list as Cancelled.'}
                checked={cancelRemove}
                onToggle={() => setCancelRemove(v => !v)}
              />
            </View>
          )}
          onConfirm={confirmCancel}
          onClose={() => { if (!cancelling) setCancelOpen(false); }}
        />

        <ContactPickerModal
          visible={showGuestPicker}
          busy={invitingGuests}
          onConfirm={sendGuestInvites}
          onClose={() => setShowGuestPicker(false)}
        />
      </ScrollView>

      {shareModel ? (
        <PickleShareStudio visible={shareOpen} onClose={() => setShareOpen(false)} title="Share this event" model={shareModel} />
      ) : null}

      {/* Last child of the root, outside the ScrollView (foundation rule). */}
      <StickyActionBar
        // It sits above the room the navigator keeps clear: its edge counts from the window bottom.
        bottomOffset={navReserve}
        style={navReserve > 0 ? { paddingBottom: SPACE.sm } : undefined}
        visible={stickyVisible}
        active={isFocused}
        summary={rsvpUnanswered ? 'Are you coming?' : 'Live now'}
        secondary={rsvpUnanswered
          ? { title: "Can't make it", onPress: () => respondToConfirmed('out'), disabled: voting != null }
          : undefined}
        primary={rsvpUnanswered
          ? { title: "I'm in", onPress: () => respondToConfirmed('in'), loading: voting === 'rsvp_in', disabled: voting != null }
          : { title: 'Record match', onPress: recordMatch }}
      />
    </View>
  );
}

// A card title with its glyph: the glyph at 16 beside the 15px title, both in
// the title's colour, centred on the line (glyphs-ui-plan.md 1.4: a row, never
// a glyph inside the Text).
function IconTitle({ iconName, color, children }: { iconName: IconName; color?: string; children: React.ReactNode }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const tint = color ?? c.text;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
      <Icon name={iconName} size={16} color={tint} />
      <Text style={[t.title, { color: tint, flexShrink: 1 }]}>{children}</Text>
    </View>
  );
}

// A tappable checkbox row for the cancel dialog's two choices.
function CheckRow({ label, sub, checked, onToggle }: {
  label: string; sub: string; checked: boolean; onToggle: () => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, minHeight: 44 }}
    >
      <View style={{
        width: 22, height: 22, marginTop: 1, borderRadius: RADIUS.sm, borderWidth: 2,
        borderColor: checked ? c.primary : c.border,
        backgroundColor: checked ? c.primary : 'transparent',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {checked && <Icon name="check-mark" size={14} color={c.textInverse} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={t.title}>{label}</Text>
        <Text style={t.sub}>{sub}</Text>
      </View>
    </Pressable>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:        { flex: 1, backgroundColor: c.bg },
    container:   { flex: 1, backgroundColor: c.bg },
    content:     { padding: SPACE.lg },
    headerActions: { flexDirection: 'row', alignItems: 'center' },
    // ShareLinkButton's pill becomes a text button in a 44 box in the header.
    headerShare: { borderWidth: 0, backgroundColor: 'transparent', minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.sm },
    headerIconBox: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    chipRow:     { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE.sm, minHeight: 44 },
    descBlock:   { marginBottom: SPACE.sm },
    banner:      { marginTop: 0, marginBottom: SPACE.md },
    youCard:     { marginBottom: SPACE.md },
    youTitle:    { marginTop: SPACE.xxs },
    block:       { marginBottom: SPACE.md },
    declineCard: {
      minHeight: 56, padding: SPACE.md, gap: SPACE.xxs, borderRadius: RADIUS.md,
      borderWidth: HAIRLINE, borderColor: c.border, backgroundColor: c.surface,
    },
    declineCardActive: { borderColor: c.danger, backgroundColor: c.dangerLight },
    note:        { marginTop: SPACE.sm, textAlign: 'center' },
    pileAvatar:  { alignItems: 'center', justifyContent: 'center', backgroundColor: c.primaryLight },
    matchRow:    { minHeight: 56, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md, justifyContent: 'center' },
    divider:     { borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    manageRow:   { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 56 },
    manageText:  { flex: 1, minWidth: 0 },
    manageGroup: { gap: SPACE.xs },
    checkGroup:  { gap: SPACE.sm, marginBottom: SPACE.md },
    btnRow:      { flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.sm },
    linkBox:     { minHeight: 44, justifyContent: 'center' },
    linkRow:     { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    shrink:      { flexShrink: 1 },
    input: {
      borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md,
      paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.base, color: c.text, backgroundColor: c.surface,
      minHeight: 44,
    },
    inputMulti:  { minHeight: 72, textAlignVertical: 'top' },
    doneBox:     { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: SPACE.sm },
  });
}
