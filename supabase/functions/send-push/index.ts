// Edge function: send-push — the push outbox dispatcher.
//
// Built on the foundation server kit (vendored in ../_kit; re-vendor with
// `node mobile/node_modules/@just-messin-around/expo-foundation/scripts/vendor-server-kit.mjs supabase/functions/_kit`).
// Called with x-push-secret by:
//   - the push_outbox INSERT webhook  {record:{id}}          (fast path)
//   - the 2-minute drain              {processPending:true}  (catches anything the webhook missed)
//   - the 30-minute receipt poll      {pollReceipts:true}
// The kit never trusts the request body for content: it re-reads and CLAIMS
// each outbox row (pending -> sending) before sending, resolves preferences and
// the button category at send time, records each device's result in
// push_deliveries (a retry sends only to devices that failed), skips expired
// rows, and puts outboxId on every push so the app can dedupe a resend.
//
// Deploy:  supabase functions deploy send-push --no-verify-jwt
// Secrets: PUSH_SHARED_SECRET (= private.app_config.send_push_secret)
//          PUSH_SECRET_MODE=enforce
//
// !! --no-verify-jwt IS NOT OPTIONAL. With the platform default (verify_jwt=true)
// the gateway rejects every DB call with 401 before this file runs, silently.
// That shipped wrong once and lost every push for months (fixed 2026-08-06).
// After any redeploy: select status, count(*) from push_outbox
//   where created_at > now() - interval '1 hour' group by 1;  -- nothing stuck in pending
//
// Old app builds (1.0.3) register no categories: a category they don't know
// just shows the push without buttons, so new categories are always safe to send.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createOutboxDispatcher, type OutboxRow, type ServiceClient } from '../_kit/outboxDispatch.ts';
import { defineOptionVote, optionVoteData } from '../_kit/optionVote.ts';
import catalog from './catalog.json' with { type: 'json' };

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Category ids come from the generated catalog (mobile/src/lib/
// notificationCatalog.data.ts -> scripts/push-catalog.mjs). A typo here fails
// type-checking at deploy instead of silently rendering a push with no buttons.
const CATEGORY = Object.fromEntries(Object.keys(catalog).map((k) => [k, k])) as Record<keyof typeof catalog, string>;

// Coarse fallback for rows without an explicit `category`: notification type ->
// the preference key that gates its push. null = only the master pushEnabled.
const TYPE_TO_PREF: Record<string, string | null> = {
  match: 'notifyMatchResults',
  league: 'notifyLeagueUpdates',
  tournament: 'notifyTournamentUpdates',
  drill: 'notifyDrillRequests',
  info: null,
};

// Preference keys recognized as push gates; guards against a stray category
// value silently disabling delivery.
const KNOWN_PREF_KEYS = new Set([
  'notifyMatchResults',
  // Separate from results: a confirm request is a 1-hour action, and gating it
  // behind results meant muting results silently cost real matches.
  'notifyMatchConfirms',
  'notifyEventReminders',
  'notifyLeagueUpdates',
  'notifyTournamentUpdates',
  'notifyChallenges',
  'notifyDrillRequests',
  // Friend requests and "accepted your friend request" (presence Phase 1).
  'notifyFriendRequests',
]);

type Row = OutboxRow & {
  category: string | null;
  entity_type: string | null;
  entity_id: string | null;
  notification_id: string | null;
  /** Set only by SECURITY DEFINER generators (migration_push_data.sql). */
  push_data?: Record<string, unknown> | null;
};

async function resolvePrefs(row: OutboxRow): Promise<boolean> {
  const r = row as Row;
  if (r.kind === 'test') return true;
  const { data } = await admin.from('user_preferences').select('prefs').eq('user_id', r.recipient_id).maybeSingle();
  const prefs = (data?.prefs ?? {}) as Record<string, unknown>;
  // Push is opt-in: only an explicit true sends.
  if (prefs.pushEnabled !== true) return false;
  const key = r.category && KNOWN_PREF_KEYS.has(r.category) ? r.category : TYPE_TO_PREF[r.kind] ?? null;
  return !(key && prefs[key] === false);
}

type Buttons = { category?: string; data: Record<string, unknown> };
type Data = Record<string, unknown>;

// push_data keys that ride on the push for the app (buttons, links, routing).
// Everything else in push_data stays server-side.
const PASS_KEYS = ['kind', 'league_id', 'invite_code', 'partner_id', 'rsvp_status'] as const;

/**
 * Which buttons this recipient gets, from the entity's CURRENT state (at send
 * time, on every attempt): a reminder queued while voting was open must not
 * offer "I'm in" for a slot voting has since discarded. Also returns the data
 * the buttons need, because they run with no app open and no chance to query.
 */
const baseData = (row: Row): Data => {
  const pd = row.push_data && typeof row.push_data === 'object' ? row.push_data : {};
  const extra: Data = {};
  for (const k of PASS_KEYS) {
    const v = pd[k];
    if (typeof v === 'string' && v.length > 0 && v.length <= 200) extra[k] = v;
  }
  return {
    notification_id: row.notification_id,
    type: row.kind,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    title: row.title,
    ...extra,
  };
};

const kindOf = (row: Row): string | null => {
  const k = row.push_data && typeof row.push_data === 'object' ? row.push_data.kind : null;
  return typeof k === 'string' ? k : null;
};

// ── Events ──────────────────────────────────────────────────────────────────
// Numbered time votes (foundation vote kit). The categories come from the
// generated catalog, so a missing one fails type-checking at deploy.
const eventVote = defineOptionVote({
  actionPrefix: 'event_vote_',
  pick2: CATEGORY.event_vote_pick2,
  pick3: CATEGORY.event_vote_pick3,
});

const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length > 0 && v.length <= 10 && v.every((x) => typeof x === 'string' && x.length <= 80)
    ? (v as string[])
    : null;

/**
 * The 1st / 2nd / 3rd time buttons for a vote push, or null. The generator
 * wrote the body and push_data.option_ids / option_labels together
 * (migration_event_vote_buttons.sql); the buttons go on only while those are
 * still the event's times in the same order (starts_at, id), so button N is
 * always the Nth time in the body.
 */
async function voteButtons(row: Row, eventId: string, d: Data): Promise<Buttons | null> {
  const pd = row.push_data && typeof row.push_data === 'object' ? row.push_data : {};
  const ids = stringList(pd.option_ids);
  const labels = stringList(pd.option_labels);
  if (!ids || !labels || ids.length !== labels.length) return null;
  const category = eventVote.categoryFor(ids.length);
  if (!category) return null;
  const { data: slots } = await admin
    .from('event_slots')
    .select('id')
    .eq('event_id', eventId)
    .order('starts_at')
    .order('id');
  const current = (slots ?? []).map((s: { id: string }) => s.id);
  if (current.length !== ids.length || current.some((sid, i) => sid !== ids[i])) return null;
  return { category, data: { ...d, ...optionVoteData(ids.map((sid, i) => ({ id: sid, label: labels[i] }))) } };
}

async function eventButtons(row: Row, data: Data, kind: string | null): Promise<Buttons> {
  const id = row.entity_id!;
  const me = row.recipient_id;
  const { data: ev } = await admin
    .from('league_events')
    .select('status, confirmed_slot_id, created_by, league_id')
    .eq('id', id)
    .maybeSingle();
  if (!ev) return { data };
  const d = { ...data, league_id: ev.league_id };
  const organizer = !!ev.created_by && ev.created_by === me;

  // The vote failed: the organizer can start a new one; members have nothing to answer.
  if (kind === 'event_cancelled') {
    return organizer && ev.status === 'cancelled' ? { category: CATEGORY.event_cancelled_organizer, data: d } : { data: d };
  }

  if (ev.status === 'voting') {
    // The organizer never gets "Can't make it" on their own event (it would
    // decline it): Text group, or Close vote, which opens the app to confirm.
    if (organizer) return { category: CATEGORY.event_organizer_vote, data: d };
    if (kind === 'event_nudge_vote') return { data: d };
    // New vote / Vote closing soon with 2 or 3 times: the numbered set.
    if (kind === 'event_vote_opened' || kind === 'event_vote_closing') {
      const vote = await voteButtons(row, id, d);
      if (vote) return vote;
    }
    // 4+ times (or the times changed since the body was written): decline only.
    return { category: CATEGORY.event_vote, data: d };
  }

  if (ev.status !== 'scheduled' || !ev.confirmed_slot_id) return { data: d }; // nothing left to answer

  if (kind === 'event_nudge_tomorrow' || kind === 'event_nudge_today') {
    return organizer ? { category: CATEGORY.event_organizer, data: d } : { data: d };
  }

  const { data: slot } = await admin.from('event_slots').select('starts_at').eq('id', ev.confirmed_slot_id).maybeSingle();
  const started = !!slot?.starts_at && new Date(slot.starts_at).getTime() <= Date.now();
  if (started) {
    // "How did it go?": Record result. Never I'm in / Can't make it after the
    // event: a decline then deletes the vote for the time that was played.
    return !kind || kind === 'event_record' ? { category: CATEGORY.event_record, data: d } : { data: d };
  }
  if (kind === 'event_record') return { data: d };

  // Scheduled and upcoming: someone who already voted for that time only
  // needs Can't make it; everyone else can also say I'm in.
  const { data: vote } = await admin
    .from('event_slot_votes')
    .select('slot_id')
    .eq('slot_id', ev.confirmed_slot_id)
    .eq('user_id', me)
    .maybeSingle();
  return {
    category: vote ? CATEGORY.event_reminder : CATEGORY.event_confirmed,
    data: { ...d, confirmed_slot_id: ev.confirmed_slot_id },
  };
}

// ── Matches ─────────────────────────────────────────────────────────────────
async function matchButtons(row: Row, data: Data): Promise<Buttons> {
  const me = row.recipient_id;
  // Every condition is a real rejection inside confirm_match(), so offering
  // the button without it would be a Confirm that errors.
  const { data: m } = await admin
    .from('matches')
    .select('status, confirm_deadline, player1_id, partner1_id, player2_id, partner2_id, team1_confirmed_by, team2_confirmed_by')
    .eq('id', row.entity_id!)
    .maybeSingle();
  if (m && m.status === 'pending') {
    const live = !m.confirm_deadline || new Date(m.confirm_deadline) > new Date();
    const onTeam1 = me === m.player1_id || me === m.partner1_id;
    const onTeam2 = me === m.player2_id || me === m.partner2_id;
    const done = (onTeam1 && m.team1_confirmed_by) || (onTeam2 && m.team2_confirmed_by);
    if (live && (onTeam1 || onTeam2) && !done) return { category: CATEGORY.match_confirm, data };
  }
  return { data };
}

// ── Drills ──────────────────────────────────────────────────────────────────
type DateSlot = { date: string; slot: number };

/** Proposed slots in time order: the order the push body numbers them in
 *  (notify_on_drill_request) and the order accept_drill_slot counts in. */
function sortedSlots(raw: unknown): DateSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s, i) => ({ s: s as Partial<DateSlot>, i }))
    .filter(({ s }) => !!s && typeof s.date === 'string' && Number.isInteger(s.slot))
    .sort((a, b) => (a.s.date! < b.s.date! ? -1 : a.s.date! > b.s.date! ? 1 : a.s.slot! - b.s.slot! || a.i - b.i))
    .map(({ s }) => ({ date: s.date!, slot: s.slot! }));
}

async function drillButtons(row: Row, data: Data, kind: string | null): Promise<Buttons> {
  const id = row.entity_id!;
  const me = row.recipient_id;
  // entity_id is a drill request (request, response and chat pushes) or a
  // drill session (reminders, partner RSVPs, and 'drill_locked': the court +
  // time lock-in notice, which takes the Confirm / Can't make it buttons below
  // like a reminder does).
  const { data: req } = await admin
    .from('drill_requests')
    .select('status, from_user_id, to_user_id, proposed_slots')
    .eq('id', id)
    .maybeSingle();
  if (req) {
    const participant = me === req.from_user_id || me === req.to_user_id;
    if (!participant) return { data };
    const pendingForMe = req.status === 'pending' && req.to_user_id === me;
    const slots = sortedSlots(req.proposed_slots);

    // A chat message: Reply from the lock screen; the invitee of a pending
    // request can also answer it (the times aren't in a chat body, so 2+
    // times get Decline only).
    if (kind === 'drill_chat') {
      if (pendingForMe) {
        return slots.length === 1
          ? { category: CATEGORY.drill_chat_pending, data: { ...data, slots } }
          : { category: CATEGORY.drill_chat_pick, data };
      }
      return { category: CATEGORY.drill_chat, data };
    }

    if (pendingForMe) {
      // The body lists the times, numbered in this order.
      const n = slots.length;
      const category =
        n === 1 ? CATEGORY.drill_request
        : n === 2 ? CATEGORY.drill_request_pick2
        : n === 3 ? CATEGORY.drill_request_pick3
        : CATEGORY.drill_request_pick;
      // Only the 1/2/3-time buttons read the slots; 4+ get Decline only, and
      // an unbounded slot list could push the message past Expo's 4 KB limit.
      return n <= 3 ? { category, data: { ...data, slots } } : { category, data };
    }

    // The requester hears back.
    if (me === req.from_user_id && (!kind || kind === 'drill_response')) {
      if (req.status === 'accepted') return { category: CATEGORY.drill_accepted, data };
      if (req.status === 'declined') return { category: CATEGORY.drill_declined, data };
    }
    return { data };
  }

  const { data: ses } = await admin.from('drill_sessions').select('starts_at, player1_id, player2_id').eq('id', id).maybeSingle();
  if (!ses || (me !== ses.player1_id && me !== ses.player2_id)) return { data };
  const partner = me === ses.player1_id ? ses.player2_id : ses.player1_id;

  // "Your partner can't make it": find a new time with them, never "Confirm".
  if (kind === 'drill_rsvp' && data.rsvp_status === 'cant_make_it') {
    const { data: theirs } = await admin
      .from('drill_session_rsvps')
      .select('status')
      .eq('session_id', id)
      .eq('user_id', partner)
      .maybeSingle();
    if (theirs?.status === 'cant_make_it') {
      return { category: CATEGORY.drill_partner_out, data: { ...data, partner_id: partner } };
    }
  }

  const upcoming = !!ses.starts_at && new Date(ses.starts_at).getTime() > Date.now() - 30 * 60_000;
  if (upcoming) {
    const { data: rsvp } = await admin.from('drill_session_rsvps').select('status').eq('session_id', id).eq('user_id', me).maybeSingle();
    if (!rsvp) return { category: CATEGORY.drill_reminder, data };
  }
  return { data };
}

// ── Tournaments ─────────────────────────────────────────────────────────────
async function tournamentButtons(row: Row, data: Data, kind: string | null): Promise<Buttons> {
  const id = row.entity_id!;
  const me = row.recipient_id;
  // Any tournament push while the recipient holds a pending invite offers
  // Accept / Decline: the buttons are accurate whichever push carries them.
  const { data: reg } = await admin
    .from('tournament_registrations')
    .select('id, status, invited_by')
    .eq('tournament_id', id)
    .eq('user_id', me)
    .maybeSingle();
  if (reg && reg.status === 'pending' && reg.invited_by) {
    return { category: CATEGORY.tournament_invite, data: { ...data, registration_id: reg.id } };
  }

  // New tournament / registration closing: Request to join, only while the
  // RLS self-request path would accept it (request mode, open, before close)
  // and the recipient has no registration row at all. The fee is in the body.
  if (!reg && (kind === 'new_tournament' || kind === 'registration_closing')) {
    const { data: t } = await admin
      .from('tournaments')
      .select('status, registration_mode, registration_closes_at')
      .eq('id', id)
      .maybeSingle();
    const open =
      !!t &&
      t.status === 'registration' &&
      t.registration_mode === 'request' &&
      (!t.registration_closes_at || new Date(t.registration_closes_at).getTime() > Date.now());
    if (open) return { category: CATEGORY.tournament_request, data };
  }
  return { data };
}

// ── Leagues ─────────────────────────────────────────────────────────────────
async function leagueButtons(row: Row, data: Data, kind: string | null): Promise<Buttons> {
  // A league invite code (send_invite_code_to_users): Join, unless already in.
  if (kind === 'league_invite' && typeof data.invite_code === 'string') {
    const { data: member } = await admin
      .from('league_members')
      .select('user_id')
      .eq('league_id', row.entity_id!)
      .eq('user_id', row.recipient_id)
      .maybeSingle();
    if (!member) return { category: CATEGORY.league_invite, data };
  }
  return { data };
}

// ── Friends ─────────────────────────────────────────────────────────────────
async function friendButtons(row: Row, data: Data, kind: string | null): Promise<Buttons> {
  // "Sam wants to be friends" (entity_id = the requester): Accept / Decline,
  // only while that request to this recipient is still pending.
  if (kind !== 'friend_request') return { data };
  const { data: req } = await admin
    .from('friendships')
    .select('status')
    .eq('requester_id', row.entity_id!)
    .eq('addressee_id', row.recipient_id)
    .maybeSingle();
  if (req?.status === 'pending') return { category: CATEGORY.friend_request, data };
  return { data };
}

async function resolveButtons(row: Row): Promise<Buttons> {
  const data = baseData(row);
  if (!row.entity_id) return { data };
  const kind = kindOf(row);
  switch (row.entity_type) {
    case 'event':
      return eventButtons(row, data, kind);
    case 'match':
      return matchButtons(row, data);
    case 'drill':
      return drillButtons(row, data, kind);
    case 'tournament':
      return tournamentButtons(row, data, kind);
    case 'league':
      return leagueButtons(row, data, kind);
    case 'friend':
      return friendButtons(row, data, kind);
    default:
      return { data };
  }
}

// categoryFor and dataFor are both asked per row; resolve once per row.
const resolved = new Map<string, Promise<Buttons>>();
function buttonsFor(row: OutboxRow): Promise<Buttons> {
  let p = resolved.get(row.id);
  if (!p) {
    // A failed lookup costs only the buttons, never the push.
    p = resolveButtons(row as Row).catch(() => ({ data: baseData(row as Row) }));
    resolved.set(row.id, p);
    setTimeout(() => resolved.delete(row.id), 60_000);
  }
  return p;
}

Deno.serve(
  createOutboxDispatcher({
    supabase: admin as unknown as ServiceClient,
    tables: { outbox: 'push_outbox', tokens: 'push_tokens', deliveries: 'push_deliveries' },
    tokenColumns: { recipient: 'user_id', token: 'token' },
    claimRpc: 'claim_pending_push',
    releaseRpc: 'release_push_claims',
    resolvePrefs,
    categoryFor: async (row) => (await buttonsFor(row)).category,
    dataFor: async (row) => (await buttonsFor(row)).data,
    expoAccessToken: Deno.env.get('EXPO_ACCESS_TOKEN') || undefined,
  }),
);
