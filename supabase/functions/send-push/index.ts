// Edge function: send-push
//
// Invoked by the AFTER INSERT trigger on public.notifications (see
// migration_push_notifications.sql) for every notification row. It:
//   1. verifies a shared secret (the function is deployed --no-verify-jwt),
//   2. checks the recipient's push preferences (master + per-category),
//   3. looks up their device push tokens, and
//   4. delivers the same title/body to Expo's Push API, with deep-link data.
// Dead tokens (DeviceNotRegistered) are pruned so we don't keep retrying them.
//
// Deploy:  supabase functions deploy send-push --no-verify-jwt
// Secret:  supabase secrets set PUSH_SHARED_SECRET=<same value as app_config.send_push_secret>
//
// !! --no-verify-jwt IS NOT OPTIONAL. The platform default is verify_jwt=true,
// and with it on the gateway rejects the trigger with 401
// UNAUTHORIZED_NO_AUTH_HEADER before this file ever executes. The trigger sends
// x-push-secret, never an Authorization header, and it swallows errors so the
// insert can't roll back — so the failure is completely silent. This shipped
// wrong and lost every push for months (fixed 2026-08-06). After any redeploy,
// insert a notifications row and check net._http_response for {"sent":N}.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

type NotificationRow = {
  id: string;
  user_id: string;
  title: string;
  body: string;
  type: string;
  entity_id: string | null;
  entity_type: string | null;
  // Optional precise gate (e.g. 'notifyEventReminders'). When present it takes
  // precedence over the coarse type map below. Set by the notification
  // generators in migration_notification_generators.sql.
  category: string | null;
};

// Coarse fallback for rows without an explicit `category`: maps a notification
// `type` to the preference key that gates its push. `null` → no per-category
// gate (still subject to the master pushEnabled).
const TYPE_TO_PREF: Record<string, string | null> = {
  match:      'notifyMatchResults',
  league:     'notifyLeagueUpdates',
  tournament: 'notifyTournamentUpdates',
  drill:      null,
  info:       null,
};

// Preference keys we recognize as valid push gates. Guards against a stray
// category value silently disabling delivery.
const KNOWN_PREF_KEYS = new Set([
  'notifyMatchResults',
  'notifyEventReminders',
  'notifyLeagueUpdates',
  'notifyTournamentUpdates',
  'notifyChallenges',
]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // ── Auth: shared secret set by the DB trigger ──────────────────────────
  const expected = Deno.env.get('PUSH_SHARED_SECRET') ?? '';
  const provided = req.headers.get('x-push-secret') ?? '';
  if (!expected || provided !== expected) {
    return json({ error: 'Forbidden' }, 403);
  }

  let record: NotificationRow;
  try {
    const body = await req.json();
    record = body.record;
  } catch {
    return json({ error: 'Bad payload' }, 400);
  }
  if (!record?.user_id) return json({ error: 'Missing user_id' }, 400);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── Preference gate ────────────────────────────────────────────────────
  const { data: prefRow } = await admin
    .from('user_preferences')
    .select('prefs')
    .eq('user_id', record.user_id)
    .maybeSingle();
  const prefs = (prefRow?.prefs ?? {}) as Record<string, unknown>;

  // Master toggle. Push is opt-in: deliver only when the user has explicitly
  // enabled it. Missing/undefined/false all mean "not opted in" → skip. (A token
  // only exists after opt-in anyway, but this is the authoritative gate.)
  if (prefs.pushEnabled !== true) {
    return json({ skipped: 'push not enabled' });
  }
  // Prefer the precise category gate when the row carries one; else fall back
  // to the coarse type→pref map.
  const prefKey =
    record.category && KNOWN_PREF_KEYS.has(record.category)
      ? record.category
      : TYPE_TO_PREF[record.type] ?? null;
  if (prefKey && prefs[prefKey] === false) {
    return json({ skipped: `${prefKey} is false` });
  }

  // ── Tokens ─────────────────────────────────────────────────────────────
  const { data: tokenRows } = await admin
    .from('push_tokens')
    .select('token')
    .eq('user_id', record.user_id);
  const tokens = (tokenRows ?? []).map((r: { token: string }) => r.token);
  if (tokens.length === 0) return json({ skipped: 'no tokens' });

  // ── Action buttons ─────────────────────────────────────────────────────
  // `categoryId` tells iOS/Android which button set to draw. The identifiers
  // MUST match the ones registered by the app in
  // mobile/src/lib/notificationActions.ts — there is no shared module across
  // this boundary, so renaming one means grepping for the other.
  //
  // Resolved here rather than stored on the row so the existing generators stay
  // untouched, and so the buttons always reflect the event's CURRENT state: a
  // reminder queued while voting was open should not still offer "I'm in" for a
  // slot that voting has since discarded.
  let categoryId: string | undefined;
  let confirmedSlotId: string | null = null;

  if (record.entity_type === 'event' && record.entity_id) {
    const { data: ev } = await admin
      .from('league_events')
      .select('status, confirmed_slot_id')
      .eq('id', record.entity_id)
      .maybeSingle();

    if (ev?.status === 'voting') {
      // Several slots are still in play, so a single tap cannot say WHICH time
      // the user means. Only the decline is unambiguous; picking a time opens
      // the app, which the plain tap already does.
      categoryId = 'event_vote';
    } else if (ev?.confirmed_slot_id) {
      // Exactly one time survives finalisation, so "I'm in" is unambiguous.
      categoryId = 'event_confirmed';
      confirmedSlotId = ev.confirmed_slot_id;
    }
    // Cancelled or finished: no buttons. Nothing useful is left to answer.
  }

  if (record.entity_type === 'match' && record.entity_id) {
    // Only the "needs your team to confirm" push earns a button, and only for a
    // recipient who can actually still act. Every condition below is a real
    // rejection inside confirm_match(), so offering the button without checking
    // would mean a Confirm that errors instead of working:
    //   - status must still be 'pending'
    //   - confirm_deadline must not have passed (expire_pending_matches deletes
    //     lapsed rows every minute, so this goes stale fast)
    //   - the recipient must be a player on the match
    // Plus one that is not an error but is noise: their team has already
    // confirmed, so there is nothing left for them to do.
    const { data: m } = await admin
      .from('matches')
      .select(
        'status, confirm_deadline, player1_id, partner1_id, player2_id, partner2_id, team1_confirmed_by, team2_confirmed_by',
      )
      .eq('id', record.entity_id)
      .maybeSingle();

    if (m && m.status === 'pending') {
      const live = !m.confirm_deadline || new Date(m.confirm_deadline) > new Date();
      const onTeam1 = record.user_id === m.player1_id || record.user_id === m.partner1_id;
      const onTeam2 = record.user_id === m.player2_id || record.user_id === m.partner2_id;
      const alreadyConfirmed =
        (onTeam1 && m.team1_confirmed_by) || (onTeam2 && m.team2_confirmed_by);

      if (live && (onTeam1 || onTeam2) && !alreadyConfirmed) {
        categoryId = 'match_confirm';
      }
    }
  }

  // ── Deliver to Expo ────────────────────────────────────────────────────
  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    title: record.title,
    body: record.body,
    ...(categoryId ? { categoryId } : {}),
    data: {
      notification_id: record.id,
      type: record.type,
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      title: record.title,
      // The buttons run with no app open and no chance to query, so whatever
      // they need has to travel with the push.
      confirmed_slot_id: confirmedSlotId,
    },
  }));

  const expoRes = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });

  // A non-2xx response means Expo didn't accept the batch (rate limit, outage,
  // bad request). Surface it instead of falsely reporting success — and don't
  // prune, since we have no per-token verdicts.
  if (!expoRes.ok) {
    const detail = await expoRes.text().catch(() => '');
    return json({ error: 'expo push failed', status: expoRes.status, detail }, 502);
  }

  const expoJson = await expoRes.json().catch(() => null);

  // ── Prune dead tokens ──────────────────────────────────────────────────
  // Expo returns one ticket per message, in the same order. A DeviceNotRegistered
  // error means the token is permanently invalid → delete it. Only prune when
  // the ticket count matches the tokens we sent, so a malformed/short response
  // can never delete the wrong token.
  const tickets: any[] = Array.isArray(expoJson?.data) ? expoJson.data : [];
  const dead: string[] = [];
  if (tickets.length === tokens.length) {
    tickets.forEach((t, i) => {
      if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') {
        dead.push(tokens[i]);
      }
    });
  }
  if (dead.length > 0) {
    await admin.from('push_tokens').delete().in('token', dead);
  }

  return json({ sent: tokens.length - dead.length, pruned: dead.length });
});
