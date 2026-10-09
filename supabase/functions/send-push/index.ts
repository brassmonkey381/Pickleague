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

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createOutboxDispatcher, type OutboxRow, type ServiceClient } from '../_kit/outboxDispatch.ts';
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
]);

type Row = OutboxRow & {
  category: string | null;
  entity_type: string | null;
  entity_id: string | null;
  notification_id: string | null;
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

/**
 * Which buttons this recipient gets, from the entity's CURRENT state (at send
 * time, on every attempt): a reminder queued while voting was open must not
 * offer "I'm in" for a slot voting has since discarded. Also returns the data
 * the buttons need, because they run with no app open and no chance to query.
 */
const baseData = (row: Row): Record<string, unknown> => ({
  notification_id: row.notification_id,
  type: row.kind,
  entity_type: row.entity_type,
  entity_id: row.entity_id,
  title: row.title,
});

async function resolveButtons(row: Row): Promise<Buttons> {
  const data = baseData(row);
  const id = row.entity_id;
  if (!id) return { data };
  const me = row.recipient_id;

  if (row.entity_type === 'event') {
    const { data: ev } = await admin.from('league_events').select('status, confirmed_slot_id').eq('id', id).maybeSingle();
    // Voting: several slots in play, so only the decline is unambiguous.
    if (ev?.status === 'voting') return { category: CATEGORY.event_vote, data };
    if (ev?.confirmed_slot_id) {
      return { category: CATEGORY.event_confirmed, data: { ...data, confirmed_slot_id: ev.confirmed_slot_id } };
    }
    return { data }; // cancelled or finished: nothing left to answer
  }

  if (row.entity_type === 'match') {
    // Every condition is a real rejection inside confirm_match(), so offering
    // the button without it would be a Confirm that errors.
    const { data: m } = await admin
      .from('matches')
      .select('status, confirm_deadline, player1_id, partner1_id, player2_id, partner2_id, team1_confirmed_by, team2_confirmed_by')
      .eq('id', id)
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

  if (row.entity_type === 'drill') {
    // entity_id is a drill request (request / response pushes) or a drill
    // session (reminders, partner RSVPs).
    const { data: req } = await admin
      .from('drill_requests')
      .select('status, to_user_id, proposed_slots')
      .eq('id', id)
      .maybeSingle();
    if (req) {
      if (req.status !== 'pending' || req.to_user_id !== me) return { data };
      const slots = Array.isArray(req.proposed_slots) ? req.proposed_slots.length : 0;
      return { category: slots === 1 ? CATEGORY.drill_request : CATEGORY.drill_request_pick, data };
    }
    const { data: ses } = await admin.from('drill_sessions').select('starts_at, player1_id, player2_id').eq('id', id).maybeSingle();
    const upcoming = !!ses?.starts_at && new Date(ses.starts_at).getTime() > Date.now() - 30 * 60_000;
    if (ses && upcoming && (me === ses.player1_id || me === ses.player2_id)) {
      const { data: rsvp } = await admin.from('drill_session_rsvps').select('status').eq('session_id', id).eq('user_id', me).maybeSingle();
      if (!rsvp) return { category: CATEGORY.drill_reminder, data };
    }
    return { data };
  }

  if (row.entity_type === 'tournament') {
    // Any tournament push while the recipient holds a pending invite offers
    // Accept: the button is accurate whichever push carries it.
    const { data: reg } = await admin
      .from('tournament_registrations')
      .select('id')
      .eq('tournament_id', id)
      .eq('user_id', me)
      .eq('status', 'pending')
      .not('invited_by', 'is', null)
      .maybeSingle();
    if (reg) return { category: CATEGORY.tournament_invite, data: { ...data, registration_id: reg.id } };
    return { data };
  }

  return { data };
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
