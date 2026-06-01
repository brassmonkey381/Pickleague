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

  // Master toggle. Defaults ON when unset (parity with DEFAULT_PREFS).
  if (prefs.pushEnabled === false) {
    return json({ skipped: 'pushEnabled is false' });
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

  // ── Deliver to Expo ────────────────────────────────────────────────────
  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    title: record.title,
    body: record.body,
    data: {
      notification_id: record.id,
      type: record.type,
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      title: record.title,
    },
  }));

  const expoRes = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  const expoJson = await expoRes.json().catch(() => null);

  // ── Prune dead tokens ──────────────────────────────────────────────────
  // Expo returns one ticket per message, in order. A DeviceNotRegistered error
  // means the token is permanently invalid → delete it.
  const tickets: any[] = expoJson?.data ?? [];
  const dead: string[] = [];
  tickets.forEach((t, i) => {
    if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') {
      dead.push(tokens[i]);
    }
  });
  if (dead.length > 0) {
    await admin.from('push_tokens').delete().in('token', dead);
  }

  return json({ sent: tokens.length - dead.length, pruned: dead.length });
});
