// Edge function: godmode-create-user
//
// JWT-gated admin tool. Creates a Supabase auth user with email pre-confirmed,
// usable immediately. Callable only by users whose auth.user.id appears in the
// godmode allowlist below (server-enforced — do not rely on client gating).
//
// Body: { first_name, last_name, email?, password?, gender? }
// Returns: { user_id, email, password, username, full_name }
//
// On top of the auth user, this also seeds the profile with random:
// gender (if not supplied), avatar, tagline, 2-3 play tags, and a default
// paddle — so godmode test accounts look like real users out of the gate.

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

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

// 40% male, 40% female, 10% other, 10% prefer-not-to-say
const GENDER_BAG = [
  'male','male','male','male',
  'female','female','female','female',
  'other',
  'prefer-not-to-say',
];

// Free avatars only (matches AVATARS[1..17] in profileCustomization.ts).
const FREE_AVATARS: { id: number; emoji: string; bgColor: string }[] = [
  { id: 1,  emoji: '🐻', bgColor: '#c8a97e' },
  { id: 2,  emoji: '🐼', bgColor: '#e0e0e0' },
  { id: 3,  emoji: '🐸', bgColor: '#a5d6a7' },
  { id: 4,  emoji: '🦊', bgColor: '#ffb74d' },
  { id: 5,  emoji: '🐱', bgColor: '#f8bbd0' },
  { id: 6,  emoji: '🐶', bgColor: '#ffe082' },
  { id: 7,  emoji: '🐯', bgColor: '#ffa726' },
  { id: 8,  emoji: '🦁', bgColor: '#ffcc80' },
  { id: 9,  emoji: '🐺', bgColor: '#b0bec5' },
  { id: 10, emoji: '🐧', bgColor: '#81d4fa' },
  { id: 11, emoji: '🦄', bgColor: '#e1bee7' },
  { id: 12, emoji: '🦅', bgColor: '#90caf9' },
  { id: 13, emoji: '🦋', bgColor: '#b3e5fc' },
  { id: 14, emoji: '🐲', bgColor: '#c8e6c9' },
  { id: 15, emoji: '🤖', bgColor: '#cfd8dc' },
  { id: 16, emoji: '👾', bgColor: '#ce93d8' },
  { id: 17, emoji: '🦝', bgColor: '#b0bec5' },
];

// Free play tags (no `unlock` field) — slugs only.
const FREE_TAGS = [
  'dink-master','power-banger','net-rusher','baseline-camper','spin-doctor',
  'touch-player','counterpuncher','kitchen-wizard','drop-shot-artist','all-court',
  'the-attacker','serve-and-volley','poacher','patient-player','the-grinder',
  'speed-demon','defensive-wall','shake-and-bake','third-shot-legend','the-strategist',
  'wind-reader','fast-twitch','aggressive-baseline',
  'the-lobber','dink-or-die','never-dinks','lucky-lobber','banana-roll',
  'atp-enthusiast','snack-bringer','trash-talker','the-encourager','left-handed-terror',
  'tennis-convert','ping-pong-pro','volleyball-convert','weekend-warrior',
  'teaching-pro','beginner-vibes',
];

// Pickleball-themed taglines (50 char max per profiles.tagline_check).
const TAGLINES = [
  'Live, laugh, dink',
  'Just here for the kitchen',
  'Crushing 4th shots since forever',
  'Dink responsibly',
  'Pickleball is my therapy',
  'Banger by day, dinker by night',
  'My third shot drop is a vibe',
  'Will paddle for snacks',
  'Cross-court dinks or bust',
  'Born to lob',
  'Erne enthusiast',
  'Stacking is an art form',
  'Reset, dink, repeat',
  'Pickleball > everything else',
  'Bring me your bangers',
  'Soft hands, fast feet',
  'Court-aware and proud',
  'Pickleball curious since 2024',
  '11-9 every single time',
  'Don\'t lob me, please',
];

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
  const gender = body.gender || pick(GENDER_BAG);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, full_name: fullName, gender },
  });
  if (error) return json({ error: error.message }, 400);

  const userId = data.user?.id;
  if (!userId) return json({ error: 'Auth user created but no id returned' }, 500);

  // Roll random profile dressing.
  const avatar  = pick(FREE_AVATARS);
  const tagline = pick(TAGLINES);
  const tagCount = 2 + Math.floor(Math.random() * 2); // 2 or 3
  const tags = pickN(FREE_TAGS, tagCount);

  // Update profile (handle_new_user trigger already inserted the row).
  // Service-role bypasses RLS so this just works.
  const { error: profileErr } = await admin
    .from('profiles')
    .update({
      gender,
      avatar_id:       avatar.id,
      avatar_emoji:    avatar.emoji,
      avatar_bg_color: avatar.bgColor,
      tagline,
      selected_tags:   tags,
    })
    .eq('id', userId);
  if (profileErr) {
    // Profile dressing is best-effort; the auth user is still usable.
    console.warn('godmode-create-user: profile dressing failed:', profileErr.message);
  }

  // Random default paddle: pick one model row, attach to user.
  const { data: models, error: modelsErr } = await admin
    .from('paddle_models')
    .select('id, brand_id, name, thickness_mm')
    .limit(500);
  if (!modelsErr && models && models.length > 0) {
    const m = pick(models as { id: string; brand_id: string; name: string; thickness_mm: number | null }[]);
    const { error: paddleErr } = await admin
      .from('player_paddles')
      .insert({
        user_id:     userId,
        brand_id:    m.brand_id,
        model_name:  m.name,
        thickness_mm: m.thickness_mm,
        is_default:  true,
      });
    if (paddleErr) {
      console.warn('godmode-create-user: paddle insert failed:', paddleErr.message);
    }
  }

  return json({
    user_id: userId,
    email,
    password,
    username,
    full_name: fullName,
    gender,
    avatar_emoji: avatar.emoji,
    tagline,
    tags,
  });
});
