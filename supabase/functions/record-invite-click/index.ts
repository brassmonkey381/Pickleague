// record-invite-click: remember that SOMEONE on this network opened an invite
// link, so the app can attribute the referral after they install it (ported
// from Doggle; see supabase/migration_referrals.sql section 9 for why this is
// needed and what it cannot do).
//
// Deployed WITHOUT JWT verification: the visitor is a stranger who has not
// signed up yet, which is the whole point. The endpoint is write-only, stores
// no raw IP, and returns nothing readable, so an open door here leaks nothing.
// CORS is open because the caller is the web invite landing in a browser.
//
// Setup (once):
//   supabase secrets set INVITE_CLICK_SALT=<long random string>
//   supabase functions deploy record-invite-click --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// One network may not stack up more than this many rows inside an hour (the
// claim side only looks back 2 hours anyway).
const MAX_ROWS_PER_NETWORK_PER_HOUR = 12;

/** Salted SHA-256 of the caller's IP. The salt lives in a function secret,
 *  never in the database, so a leaked table cannot be reversed into addresses. */
async function hashIp(ip: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${ip}|${salt}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** First hop in x-forwarded-for is the client; the rest are proxies. */
function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  const first = fwd.split(',')[0]?.trim();
  return first || req.headers.get('cf-connecting-ip') || '';
}

/** Coarse platform only: enough to avoid matching an Android click to an iOS
 *  install, deliberately not enough to identify a device. */
function platformOf(ua: string): string {
  const s = ua.toLowerCase();
  if (/iphone|ipad|ipod/.test(s)) return 'ios';
  if (/android/.test(s)) return 'android';
  return 'other';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Fail closed rather than silently storing weakly-hashed IPs.
  const salt = Deno.env.get('INVITE_CLICK_SALT');
  if (!salt) {
    console.error('INVITE_CLICK_SALT is not set; refusing to record');
    return json({ error: 'not configured' }, 503);
  }

  let body: { code?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code || code.length > 64 || !/^[A-Za-z0-9_-]+$/.test(code)) return json({ error: 'invalid code' }, 400);

  const ip = clientIp(req);
  if (!ip) return json({ ok: false, reason: 'no client ip' }, 200); // nothing to match on

  const ipHash = await hashIp(ip, salt);
  const platform = platformOf(req.headers.get('user-agent') ?? '');

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Bound what one network can write. Stuffing the window only ever DENIES
  // attribution (the claim side refuses ambiguous matches); it cannot steal it.
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count } = await supabase
    .from('deferred_invite_clicks')
    .select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash)
    .gte('created_at', since);

  if ((count ?? 0) >= MAX_ROWS_PER_NETWORK_PER_HOUR) {
    return json({ ok: false, reason: 'rate limited' }, 200);
  }

  const { error } = await supabase
    .from('deferred_invite_clicks')
    .insert({ code: code.toLowerCase(), ip_hash: ipHash, platform });

  if (error) {
    console.error('record-invite-click insert failed', error.message);
    return json({ error: 'insert failed' }, 500);
  }

  // Deliberately no echo of what was stored.
  return json({ ok: true }, 200);
});
