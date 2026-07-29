// Edge function: request-claim
//
// "Claim this account" on an unclaimed (DUPR-seeded) profile. Sends a magic link
// to the DUPR email on file, so only whoever controls that inbox can proceed.
//
// Supabase's BUILT-IN SMTP is wired only to Auth emails — there is no
// send-arbitrary-mail API — so the claim mail has to be an auth mail. That is a
// feature here: clicking it signs the person in with a CONFIRMED email, which is
// exactly the proof the claim needs. The app then calls claim_my_dupr_profile()
// to absorb the placeholder.
//
// Leak-proofing:
//   * the caller never learns the address (not even masked) — the response is
//     identical whether or not the profile is claimable, so this cannot be used
//     to probe who is on the roster;
//   * rate-limited per profile via public.recent_claim_count(), so the button
//     cannot be used to bomb a stranger's inbox;
//   * deployed WITH verify_jwt — it triggers outbound mail, so it must not be an
//     open internet endpoint. Anonymous sign-ins are enabled on this project, so
//     every app client already carries a JWT and nothing breaks.
//
// Deploy: supabase functions deploy request-claim        (verify_jwt defaults on)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MAX_CLAIMS_PER_DAY = 3;
const LINK_TTL_HOURS = 24;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// One response for every outcome that could reveal roster membership.
const OPAQUE_OK = { ok: true, message: 'If that account can be claimed, an email is on its way.' };

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let profileId: string | undefined;
  try {
    profileId = (await req.json())?.profile_id;
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (!profileId || typeof profileId !== 'string') return json({ error: 'bad request' }, 400);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Must be a real, still-unclaimed placeholder.
  const { data: profile } = await admin
    .from('profiles')
    .select('id, is_unclaimed')
    .eq('id', profileId)
    .maybeSingle();
  if (!profile?.is_unclaimed) return json(OPAQUE_OK);

  // Rate limit before we look anything up or send anything.
  const { data: recent, error: rlErr } = await admin
    .rpc('recent_claim_count', { p_profile_id: profileId });
  if (rlErr) return json({ error: 'internal' }, 500);
  if ((recent ?? 0) >= MAX_CLAIMS_PER_DAY) return json(OPAQUE_OK);

  // The real address, which never leaves this function.
  const { data: member } = await admin
    .from('dupr_club_members')
    .select('dupr_email')
    .eq('profile_id', profileId)
    .not('dupr_email', 'is', null)
    .maybeSingle();
  if (!member?.dupr_email) return json(OPAQUE_OK);

  const redirectTo = `${Deno.env.get('CLAIM_REDIRECT_URL') ?? 'https://pickleague.club'}/claim`;

  // Sends via whatever SMTP the project has configured (built-in by default).
  // shouldCreateUser: the claimer usually has no Pickleague account yet.
  const { error: mailErr } = await admin.auth.signInWithOtp({
    email: member.dupr_email,
    options: { shouldCreateUser: true, emailRedirectTo: redirectTo },
  });
  if (mailErr) {
    // Most likely the built-in SMTP hourly cap. Log it; stay opaque to the caller.
    console.error('claim mail failed', mailErr.message);
    return json(OPAQUE_OK);
  }

  const expires = new Date(Date.now() + LINK_TTL_HOURS * 3600_000).toISOString();
  await admin.from('profile_claims').insert({
    profile_id: profileId,
    // No token of ours to store — Supabase owns the link. Keep the column's
    // uniqueness meaningful with a per-request marker instead.
    token_hash: `magiclink:${crypto.randomUUID()}`,
    sent_to_email: member.dupr_email,
    expires_at: expires,
    requested_ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  });

  return json(OPAQUE_OK);
});
