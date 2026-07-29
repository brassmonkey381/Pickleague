#!/usr/bin/env node
// Pull a DUPR club roster from api.dupr.gg and upsert it into public.dupr_club_members,
// then link rows to Pickleague accounts.
//
// Two quirks of the DUPR API this script exists to encapsulate:
//   • limit is hard-capped at 25 ("Limit should not be more than 25 results"), so
//     a 473-member club is 19 paged calls — there is no bulk variant on this route.
//   • query:"" returns total:0 with status SUCCESS. You must send query:"*" to
//     match everything. Silent empty result otherwise.
//
// The bearer token is a logged-in dashboard.dupr.com session token (DevTools →
// Application → Cookies → accessToken). They are long-lived (months), so treat
// DUPR_TOKEN as a secret: never commit it, and log out of DUPR to revoke.
//
//   # preview — hits DUPR, writes nothing:
//   DUPR_TOKEN=.. node scripts/import-dupr-club.mjs --club 8354485564 --dry-run
//   # real run:
//   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. DUPR_TOKEN=.. \
//     node scripts/import-dupr-club.mjs --club 8354485564
//   # roster to disk only, no DB at all:
//   DUPR_TOKEN=.. node scripts/import-dupr-club.mjs --club 8354485564 --out alameda.json

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const DUPR_BASE = 'https://api.dupr.gg';
const PAGE_LIMIT = 25; // server-enforced ceiling; larger is a 400

const CLUB_ID = opt('--club', '8354485564');
const TOKEN = process.env.DUPR_TOKEN;
const SUPA_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY = flag('--dry-run');
const OUT = opt('--out', null);
const QUERY = opt('--query', '*');
const NO_MATCH = flag('--no-match');

const num = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null; // "NR" and null both land here
};
const dateOnly = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

// roles is an array of role objects, one per club the membership touches. Flatten
// the entry for THIS club so the common queries don't have to dig through jsonb.
function flattenRole(roles) {
  if (!Array.isArray(roles)) return {};
  const mine = roles.find((r) => String(r?.clubId) === String(CLUB_ID)) ?? roles[0];
  if (!mine) return {};
  return {
    dupr_role: mine.role ?? null,
    dupr_role_approval_status: mine.approvalStatus ?? null,
    dupr_join_type: mine.joinType ?? null,
  };
}

// ---------------------------------------------------------------- DUPR fetch

async function fetchClub() {
  const res = await fetch(`${DUPR_BASE}/club/v1.0/${CLUB_ID}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`club lookup ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body).result ?? {};
}

async function fetchPage(offset, exclude = []) {
  const res = await fetch(`${DUPR_BASE}/club/${CLUB_ID}/members/v1.0/all`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ exclude, limit: PAGE_LIMIT, offset, filter: {}, query: QUERY }),
  });
  const body = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new Error(`DUPR rejected the token (${res.status}). Grab a fresh accessToken from dashboard.dupr.com.`);
  }
  if (!res.ok) throw new Error(`members ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body).result ?? {};
}

// DUPR's paging has NO stable sort: rows shift position between requests, so a
// straight offset walk returns some members twice and misses others entirely.
// (On a 473-member club that was 473 rows but only 462 distinct people.)
//
// So: sweep once by offset, then gap-fill using the API's own `exclude` param —
// passing every id already seen makes the endpoint return only the stragglers,
// and it decrements `total` accordingly, which gives a clean termination signal.
async function fetchRoster() {
  const byId = new Map();
  let total;

  const absorb = (hits) => {
    let added = 0;
    for (const h of hits) {
      if (h?.id == null || byId.has(h.id)) continue;
      byId.set(h.id, h);
      added += 1;
    }
    return added;
  };

  // Pass 1 — straight offset sweep.
  let offset = 0;
  let fetched = 0;
  for (;;) {
    const page = await fetchPage(offset);
    const hits = page.hits ?? [];
    total = page.total ?? total;
    fetched += hits.length;
    absorb(hits);
    process.stderr.write(`\r  fetched ${byId.size}${total ? `/${total}` : ''} distinct (${fetched} rows)   `);
    if (hits.length === 0) break;
    offset += hits.length;
    if (total && fetched >= total) break;
    if (offset > 20000) break; // runaway guard
  }

  // Pass 2 — gap-fill whatever the shifting sort skipped.
  let sweeps = 0;
  while (total && byId.size < total && sweeps < 20) {
    sweeps += 1;
    let page;
    try {
      page = await fetchPage(0, [...byId.keys()]);
    } catch (e) {
      // Very large exclude lists could be rejected; don't fail the whole import.
      console.warn(`\n  ! gap-fill request failed (${e.message.slice(0, 80)})`);
      break;
    }
    const added = absorb(page.hits ?? []);
    process.stderr.write(`\r  fetched ${byId.size}/${total} distinct (gap-fill sweep ${sweeps}, +${added})   `);
    if (added === 0) break; // nothing new on offer — stop rather than spin
  }

  process.stderr.write('\n');
  const members = [...byId.values()];
  if (total && members.length !== total) {
    console.warn(`  ! club reports ${total} members but only ${members.length} distinct were retrievable`);
  }
  return { members, total };
}

// ------------------------------------------------------------------ mapping

function toRow(m, club) {
  return {
    dupr_club_id: Number(CLUB_ID),
    dupr_club_name: club.clubName ?? null,

    dupr_member_id: m.id,
    dupr_id: m.duprId ?? null,
    dupr_full_name: m.fullName ?? null,
    dupr_username: m.username ?? null,

    dupr_email: m.email ?? null,
    dupr_verified_email: m.verifiedEmail ?? null,
    dupr_phone: m.phone ?? null,
    dupr_verified_phone: m.verifiedPhone ?? null,

    dupr_short_address: m.shortAddress ?? null,
    dupr_formatted_address: m.formattedAddress ?? null,
    dupr_latitude: m.latitude ?? null,
    dupr_longitude: m.longitude ?? null,
    dupr_iso_alpha2_code: m.isoAlpha2Code ?? null,

    dupr_gender: m.gender ?? null,
    dupr_birthdate: dateOnly(m.birthdate),
    dupr_age: Number.isFinite(m.age) ? m.age : null,
    dupr_hand: m.hand ?? null,
    dupr_image_url: m.imageUrl ?? null,

    dupr_singles: num(m.singles),
    dupr_singles_raw: m.singles ?? null,
    dupr_singles_verified: m.singlesVerified ?? null,
    dupr_singles_provisional: m.singlesProvisional ?? null,
    dupr_singles_reliability: m.singlesReliability ?? null,
    dupr_provisional_singles_rating: m.provisionalSinglesRating ?? null,

    dupr_doubles: num(m.doubles),
    dupr_doubles_raw: m.doubles ?? null,
    dupr_doubles_verified: m.doublesVerified ?? null,
    dupr_doubles_provisional: m.doublesProvisional ?? null,
    dupr_doubles_reliability: m.doublesReliability ?? null,
    dupr_provisional_doubles_rating: m.provisionalDoublesRating ?? null,

    dupr_default_rating: m.defaultRating ?? null,

    dupr_status: m.status ?? null,
    dupr_roles: m.roles ?? null,
    ...flattenRole(m.roles),
    dupr_enable_privacy: m.enablePrivacy ?? null,
    dupr_created: m.created ?? null,

    dupr_raw: m,
    last_synced_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- Supabase

const rest = (path, init = {}) =>
  fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

async function upsert(allRows) {
  // Postgres rejects a batch that touches the same conflict target twice
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), so the
  // last-wins dedupe here is a hard requirement, not just tidiness.
  const deduped = [...new Map(allRows.map((r) => [r.dupr_member_id, r])).values()];
  if (deduped.length !== allRows.length) {
    console.log(`  deduped ${allRows.length - deduped.length} repeated member id(s) before upsert`);
  }

  // on_conflict mirrors the unique (dupr_club_id, dupr_member_id) constraint.
  const rows = deduped;
  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const res = await rest('dupr_club_members?on_conflict=dupr_club_id,dupr_member_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`upsert failed ${res.status}: ${(await res.text()).slice(0, 400)}`);
    written += chunk.length;
    process.stderr.write(`\r  upserted ${written}/${rows.length}   `);
  }
  process.stderr.write('\n');
  return written;
}

// Link roster rows to Pickleague accounts by dupr_id only — a user pastes their
// own DUPR code into their profile, so it is self-asserted and unambiguous.
// Email matching is deliberately NOT done: profiles carries no email (it lives in
// auth.users), and matching on it would silently link accounts that merely share
// an address. matched_by leaves room for 'email'/'name' if that changes.
async function linkProfiles() {
  const res = await rest('profiles?select=id,dupr_id&dupr_id=not.is.null');
  if (!res.ok) throw new Error(`profile fetch failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const byDuprId = new Map((await res.json()).map((p) => [String(p.dupr_id).toUpperCase(), p.id]));
  if (byDuprId.size === 0) return { linked: 0, candidates: 0 };

  const mres = await rest(`dupr_club_members?select=id,dupr_id&dupr_club_id=eq.${CLUB_ID}&profile_id=is.null`);
  if (!mres.ok) throw new Error(`member fetch failed ${mres.status}`);
  const pending = await mres.json();

  let linked = 0;
  for (const row of pending) {
    const profileId = row.dupr_id ? byDuprId.get(String(row.dupr_id).toUpperCase()) : null;
    if (!profileId) continue;
    const p = await rest(`dupr_club_members?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ profile_id: profileId, matched_by: 'dupr_id' }),
    });
    if (p.ok) linked += 1;
  }
  return { linked, candidates: pending.length };
}

// --------------------------------------------------------------------- main

async function main() {
  if (!TOKEN) {
    console.error('DUPR_TOKEN is required (dashboard.dupr.com → DevTools → Application → Cookies → accessToken).');
    process.exit(1);
  }
  if (!DRY && !OUT && (!SUPA_URL || !KEY)) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or use --dry-run / --out).');
    process.exit(1);
  }

  const club = await fetchClub();
  console.log(`Club: ${club.clubName ?? CLUB_ID} (${club.shortAddress ?? '?'}) — ${club.clubMemberCount ?? '?'} members`);

  console.log('Fetching roster...');
  const { members } = await fetchRoster();

  const rows = members.map((m) => toRow(m, club));
  const rated = rows.filter((r) => r.dupr_doubles !== null).length;
  const withEmail = rows.filter((r) => r.dupr_email).length;
  const withPhone = rows.filter((r) => r.dupr_phone).length;
  console.log(`\n  ${rows.length} members — ${rated} with a doubles rating, ${withEmail} w/ email, ${withPhone} w/ phone`);

  if (OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(OUT, JSON.stringify(members, null, 2));
    console.log(`  wrote raw roster -> ${OUT}  (contains PII — keep it out of git)`);
  }

  if (DRY) {
    console.log('\n[dry-run] nothing written. Sample row:');
    console.log(JSON.stringify({ ...rows[0], dupr_raw: '<omitted>' }, null, 2));
    return;
  }

  if (!SUPA_URL || !KEY) return; // --out only

  console.log('\nUpserting into public.dupr_club_members...');
  await upsert(rows);

  if (!NO_MATCH) {
    const { linked, candidates } = await linkProfiles();
    console.log(`  linked ${linked} of ${candidates} unlinked rows to profiles by dupr_id`);
    if (candidates > 0 && linked === 0) {
      console.log('  (no matches — profiles.dupr_id is populated when users claim their DUPR code)');
    }
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
