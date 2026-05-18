// Edge function: godmode-create-user
//
// JWT-gated admin tool. Creates a Supabase auth user with email pre-confirmed,
// usable immediately. Callable only by users whose auth.user.id appears in the
// godmode allowlist below (server-enforced — do not rely on client gating).
//
// Body: { first_name, last_name, email?, password?, gender? }
// Returns: { user_id, email, password, username, full_name }
//
// Defaults: email `${first}.${last}@pickleague.test`, password `Pickle123!`,
// gender `prefer-not-to-say`. Username + full_name follow RegisterScreen's
// derivation so triggers that key on user_metadata see the same shape as a
// normal sign-up.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GODMODE_USER_IDS = new Set<string>([
  '252a36e1-5d89-4ad2-8a3e-b786579f019a', // Brian Stockman (bsaucey)
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Missing Authorization header' }, 401);

  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: callerData, error: getUserErr } = await caller.auth.getUser();
  if (getUserErr || !callerData.user) return json({ error: 'Invalid auth' }, 401);
  if (!GODMODE_USER_IDS.has(callerData.user.id)) return json({ error: 'Forbidden — godmode only' }, 403);

  let body: {
    first_name?: string;
    last_name?: string;
    email?: string;
    password?: string;
    gender?: string;
  };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const first = (body.first_name ?? '').trim();
  const last = (body.last_name ?? '').trim();
  if (!first || !last) return json({ error: 'first_name and last_name required' }, 400);

  const username = `${slug(first)}${slug(last)}`;
  const fullName = `${first} ${last}`;
  const email = body.email?.trim() || `${slug(first)}.${slug(last)}@pickleague.test`;
  const password = body.password || 'Pickle123!';
  const gender = body.gender || 'prefer-not-to-say';

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, full_name: fullName, gender },
  });
  if (error) return json({ error: error.message }, 400);

  return json({
    user_id: data.user?.id,
    email,
    password,
    username,
    full_name: fullName,
  });
});
