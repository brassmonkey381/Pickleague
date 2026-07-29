#!/usr/bin/env node
// Create UNCLAIMED Pickleague profiles from an imported DUPR club roster, so
// leaderboards/search look populated and a real player can later claim their row.
//
// Each seeded profile is a normal public.profiles row (no special-casing anywhere
// in the app) backed by an auth.users row with a SYNTHETIC email:
//   dupr-<member_id>@unclaimed.pickleague.club
// The person's real address stays only in public.dupr_club_members, behind RLS,
// and is written into auth.users only when a claim succeeds. That means no
// Supabase auth mail can ever reach someone who hasn't asked for it.
//
// NOTHING about DUPR PII lands in profiles: name + ratings only. profiles.phone
// is deliberately left alone.
//
//   # preview (no writes):
//   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. node scripts/seed-claimable-profiles.mjs --dry-run
//   # seed 25 to eyeball in the app first:
//   ... node scripts/seed-claimable-profiles.mjs --club 8354485564 --limit 25
//   # remove every seeded profile again (auth user delete cascades to profiles):
//   ... node scripts/seed-claimable-profiles.mjs --delete

import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const SUPA_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLUB_ID = opt('--club', '8354485564');
const LIMIT = Number(opt('--limit', '0')) || null;
const DRY = flag('--dry-run');
const DELETE = flag('--delete');
const INCLUDE_UNRATED = flag('--include-unrated');
const MAIL_DOMAIN = opt('--mail-domain', 'unclaimed.pickleague.club');

if (!SUPA_URL || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const db = createClient(SUPA_URL, KEY, { auth: { persistSession: false } });
const CLAIM_SOURCE = `dupr_club:${CLUB_ID}`;
const syntheticEmail = (memberId) => `dupr-${memberId}@${MAIL_DOMAIN}`;

const genderMap = { MALE: 'male', FEMALE: 'female' };

// Username seed only — the on_auth_user_created trigger strips non-alphanumerics
// and resolves collisions itself (appending 2, 3, ...), so we don't dedupe here.
const usernameSeed = (fullName, memberId) => {
  const base = String(fullName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return base.length >= 3 ? base.slice(0, 20) : `player${memberId}`;
};

async function removeSeeded() {
  const { data, error } = await db
    .from('profiles')
    .select('id, username')
    .eq('claim_source', CLAIM_SOURCE);
  if (error) throw new Error(error.message);
  console.log(`Found ${data.length} seeded profiles for ${CLAIM_SOURCE}.`);
  if (DRY) { console.log('[dry-run] nothing deleted.'); return; }

  let gone = 0;
  for (const p of data) {
    // Deleting the auth user cascades to profiles via the FK.
    const { error: e } = await db.auth.admin.deleteUser(p.id);
    if (e) console.warn(`  ! ${p.username}: ${e.message}`);
    else gone += 1;
    process.stderr.write(`\r  deleted ${gone}/${data.length}   `);
  }
  process.stderr.write('\n');
  console.log(`Removed ${gone} seeded profiles.`);
}

async function seed() {
  // Only roster rows not already linked to a profile.
  let q = db
    .from('dupr_club_members')
    .select('id, dupr_member_id, dupr_id, dupr_full_name, dupr_gender, dupr_singles, dupr_doubles, dupr_email')
    .eq('dupr_club_id', CLUB_ID)
    .is('profile_id', null)
    .order('dupr_doubles', { ascending: false, nullsFirst: false });
  if (LIMIT) q = q.limit(LIMIT);

  const { data: roster, error } = await q;
  if (error) throw new Error(error.message);

  const candidates = roster.filter((r) => INCLUDE_UNRATED || r.dupr_doubles != null || r.dupr_singles != null);
  const skipped = roster.length - candidates.length;

  console.log(`Club ${CLUB_ID}: ${roster.length} unlinked roster rows, ${candidates.length} to seed` +
              (skipped ? ` (${skipped} skipped as unrated — pass --include-unrated to keep them)` : ''));

  if (DRY) {
    console.log('\n[dry-run] first 5 profiles that would be created:');
    for (const r of candidates.slice(0, 5)) {
      console.log(`  ${String(r.dupr_full_name).padEnd(24)} ${usernameSeed(r.dupr_full_name, r.dupr_member_id).padEnd(20)} ` +
                  `rating ${(r.dupr_doubles ?? r.dupr_singles ?? '—')}  <${syntheticEmail(r.dupr_member_id)}>`);
    }
    console.log(`\n[dry-run] would create ${candidates.length} auth users + profiles. Nothing written.`);
    return;
  }

  let made = 0;
  const failures = [];
  for (const r of candidates) {
    const rating = r.dupr_doubles ?? r.dupr_singles ?? null;
    const { data: created, error: e } = await db.auth.admin.createUser({
      email: syntheticEmail(r.dupr_member_id),
      email_confirm: false,
      password: crypto.randomUUID() + crypto.randomUUID(),
      user_metadata: {
        username: usernameSeed(r.dupr_full_name, r.dupr_member_id),
        full_name: r.dupr_full_name ?? 'Player',
        gender: genderMap[r.dupr_gender] ?? 'prefer-not-to-say',
      },
    });
    if (e) { failures.push(`${r.dupr_full_name}: ${e.message}`); continue; }

    // The trigger already inserted the profile; fill in the DUPR-derived parts.
    // PLUPR is on the same scale as DUPR, so ratings carry over unconverted.
    const patch = { is_unclaimed: true, claim_source: CLAIM_SOURCE, dupr_id: r.dupr_id };
    if (rating != null) {
      patch.rating = rating;
      patch.singles_rating = r.dupr_singles ?? rating;
      patch.doubles_rating = r.dupr_doubles ?? rating;
      patch.mixed_doubles_rating = r.dupr_doubles ?? rating;
    }
    const { error: pe } = await db.from('profiles').update(patch).eq('id', created.user.id);
    if (pe) { failures.push(`${r.dupr_full_name}: profile patch ${pe.message}`); continue; }

    const { error: le } = await db
      .from('dupr_club_members')
      .update({ profile_id: created.user.id, matched_by: 'dupr_id' })
      .eq('id', r.id);
    if (le) failures.push(`${r.dupr_full_name}: link ${le.message}`);

    made += 1;
    process.stderr.write(`\r  seeded ${made}/${candidates.length}   `);
  }
  process.stderr.write('\n');
  console.log(`Created ${made} unclaimed profiles.`);
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`);
    for (const f of failures.slice(0, 20)) console.log(`  ! ${f}`);
  }
}

(DELETE ? removeSeeded() : seed()).catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
