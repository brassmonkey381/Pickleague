// claim-deferred-invite: after sign-in, ask whether anyone on this network
// opened an invite link recently. Answers that referral code, or null. The APP
// then calls claim_referral with it, so every attribution rule and the welcome
// toast are reused unchanged (ported from Doggle).
//
// Keeps the DEFAULT JWT verification: the caller has just signed in, and
// binding the claim to a real user is what lets us mark the click consumed.
// Guests (anonymous sign-ins) get null WITHOUT consuming anything: they cannot
// be referred, and the click should still be there if the same person signs
// up for real a minute later.
//
// The matching rules:
//   * same salted IP hash, same coarse platform, unclaimed, within 2 hours
//   * EXACTLY ONE distinct code. Two different codes from one network (shared
//     wifi, carrier NAT) answers null: crediting 2500 pickles to the wrong
//     person is worse than crediting nobody.
//
// Setup (once; the salt is shared with record-invite-click):
//   supabase secrets set INVITE_CLICK_SALT=<long random string>
//   supabase functions deploy claim-deferred-invite
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Long enough to cover "tap the link, install, open"; short enough that a
// shared network does not pile up unrelated clicks.
const MATCH_WINDOW_MS = 2 * 60 * 60_000;

async function hashIp(ip: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${ip}|${salt}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  const first = fwd.split(',')[0]?.trim();
  return first || req.headers.get('cf-connecting-ip') || '';
}

function platformOf(ua: string): string {
  const s = ua.toLowerCase();
  if (/iphone|ipad|ipod/.test(s)) return 'ios';
  if (/android/.test(s)) return 'android';
  return 'other';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const salt = Deno.env.get('INVITE_CLICK_SALT');
  if (!salt) {
    console.error('INVITE_CLICK_SALT is not set; cannot match');
    return json({ code: null }, 200); // a miss, not an error the app should surface
  }

  // Identify the caller from their own JWT (the gateway already verified it).
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData } = await supabase.auth.getUser(jwt);
  const user = userData?.user;
  if (!user?.id) return json({ error: 'not signed in' }, 401);
  if (user.is_anonymous) return json({ code: null }, 200);

  const ip = clientIp(req);
  if (!ip) return json({ code: null }, 200);

  const ipHash = await hashIp(ip, salt);
  const platform = platformOf(req.headers.get('user-agent') ?? '');
  const since = new Date(Date.now() - MATCH_WINDOW_MS).toISOString();

  const { data: rows, error } = await supabase
    .from('deferred_invite_clicks')
    .select('id, code')
    .eq('ip_hash', ipHash)
    .eq('platform', platform)
    .is('claimed_at', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(25);

  if (error) {
    console.error('claim-deferred-invite lookup failed', error.message);
    return json({ code: null }, 200);
  }

  const candidates = rows ?? [];
  const distinct = Array.from(new Set(candidates.map((r) => r.code)));
  // 0 = nobody clicked from here (the common, harmless miss).
  // 2+ = we cannot tell who invited them, so nobody is credited.
  if (distinct.length !== 1) {
    return json({ code: null, ambiguous: distinct.length > 1 }, 200);
  }

  const code = distinct[0];

  // Consume every row for this code and network so a second device on the same
  // network cannot claim the same click.
  await supabase
    .from('deferred_invite_clicks')
    .update({ claimed_at: new Date().toISOString(), claimed_by: user.id })
    .in('id', candidates.map((r) => r.id));

  return json({ code }, 200);
});
