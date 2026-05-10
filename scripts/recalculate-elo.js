/**
 * Recalculates all ELO ratings from scratch by replaying match history.
 * Produces accurate singles_rating, doubles_rating, mixed_doubles_rating,
 * and player_location_ratings (split into doubles_gendered / doubles_mixed).
 * Safe to re-run — resets everything before replaying.
 */
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const K = 32;

function expected(rA, rB) {
  return 1.0 / (1.0 + Math.pow(10, (rB - rA) / 400));
}

function delta(rA, rB, won) {
  return Math.round(K * ((won ? 1 : 0) - expected(rA, rB)));
}

function classifyDoubles(genderMap, p1, pa1, p2, pa2) {
  const ids = [p1, pa1, p2, pa2];
  const gs  = ids.map(id => genderMap[id] ?? null);
  if (gs.some(g => g == null || g === 'prefer-not-to-say')) return 'unspecified';
  return new Set(gs).size === 1 ? 'gendered' : 'mixed';
}

async function run() {
  const { data: allProfiles } = await s.from('profiles').select('id, full_name, gender');
  const genderMap = Object.fromEntries(allProfiles.map(p => [p.id, p.gender]));

  // 1. Reset all ratings to 1000
  const ratings        = {}; // overall
  const singlesRatings = {};
  const doublesRatings = {}; // gendered doubles
  const mixedRatings   = {}; // mixed doubles
  const locationRatings = {}; // key: `${userId}|${location}|${type}`

  allProfiles.forEach(p => {
    ratings[p.id]        = 1000;
    singlesRatings[p.id] = 1000;
    doublesRatings[p.id] = 1000;
    mixedRatings[p.id]   = 1000;
  });

  // 2. Replay all matches in chronological order
  const { data: matches } = await s
    .from('matches')
    .select('*')
    .order('played_at', { ascending: true });

  console.log(`Replaying ${matches.length} matches...`);

  const matchUpdates = []; // {id, p1before, p2before, p1after, p2after, category}
  const counts = { singles: 0, gendered: 0, mixed: 0, unspecified: 0 };

  for (const m of matches) {
    const p1 = m.player1_id, p2 = m.player2_id;
    const pa1 = m.partner1_id, pa2 = m.partner2_id;
    const isDoubles = m.match_type === 'doubles';
    const won1 = m.winner_team === 'team1' || m.winner_id === p1;

    const category = isDoubles
      ? classifyDoubles(genderMap, p1, pa1, p2, pa2)
      : null;
    if (isDoubles) counts[category]++; else counts.singles++;

    // Overall rating used for ELO calc (regardless of category)
    const r1  = ratings[p1]  ?? 1000;
    const r2  = ratings[p2]  ?? 1000;
    const rp1 = ratings[pa1] ?? 1000;
    const rp2 = ratings[pa2] ?? 1000;

    const t1avg = isDoubles ? (r1 + rp1) / 2 : r1;
    const t2avg = isDoubles ? (r2 + rp2) / 2 : r2;
    const d1 = delta(t1avg, t2avg, won1);
    const d2 = -d1;

    // Unspecified doubles: snapshot before, leave after = before, no rating impact
    if (isDoubles && category === 'unspecified') {
      matchUpdates.push({
        id: m.id, p1before: r1, p2before: r2,
        p1after: r1, p2after: r2, category: 'unspecified',
      });
      continue;
    }

    matchUpdates.push({
      id: m.id, p1before: r1, p2before: r2,
      p1after: r1 + d1, p2after: r2 + d2,
      category,
    });

    // Update overall
    ratings[p1] = (ratings[p1] ?? 1000) + d1;
    ratings[p2] = (ratings[p2] ?? 1000) + d2;
    if (isDoubles) {
      if (pa1) ratings[pa1] = (ratings[pa1] ?? 1000) + d1;
      if (pa2) ratings[pa2] = (ratings[pa2] ?? 1000) + d2;
    }

    // Update split rating
    if (!isDoubles) {
      singlesRatings[p1] = (singlesRatings[p1] ?? 1000) + d1;
      singlesRatings[p2] = (singlesRatings[p2] ?? 1000) + d2;
    } else if (category === 'gendered') {
      for (const [uid, dlt] of [[p1, d1], [p2, d2], [pa1, d1], [pa2, d2]]) {
        if (uid) doublesRatings[uid] = (doublesRatings[uid] ?? 1000) + dlt;
      }
    } else if (category === 'mixed') {
      for (const [uid, dlt] of [[p1, d1], [p2, d2], [pa1, d1], [pa2, d2]]) {
        if (uid) mixedRatings[uid] = (mixedRatings[uid] ?? 1000) + dlt;
      }
    }

    // Update location ratings
    if (m.location_name) {
      let locType;
      if (!isDoubles)                  locType = 'singles';
      else if (category === 'gendered') locType = 'doubles_gendered';
      else if (category === 'mixed')    locType = 'doubles_mixed';
      else continue; // unspecified — skip location too

      for (const [uid, dlt, won] of [
        [p1,  d1, won1],
        [p2,  d2, !won1],
        ...(isDoubles && pa1 ? [[pa1, d1, won1]]  : []),
        ...(isDoubles && pa2 ? [[pa2, d2, !won1]] : []),
      ]) {
        const key = `${uid}|${m.location_name}|${locType}`;
        if (!locationRatings[key]) {
          locationRatings[key] = { user_id: uid, location_name: m.location_name, match_type: locType, rating: 1000, wins: 0, losses: 0 };
        }
        locationRatings[key].rating += dlt;
        if (won) locationRatings[key].wins++; else locationRatings[key].losses++;
      }
    }
  }

  console.log(`  singles=${counts.singles}, gendered=${counts.gendered}, mixed=${counts.mixed}, unspecified=${counts.unspecified}`);

  // 3. Persist profile ratings
  console.log('Updating profile ratings...');
  let profilesUpdated = 0;
  for (const p of allProfiles) {
    await s.from('profiles').update({
      rating:               ratings[p.id]        ?? 1000,
      singles_rating:       singlesRatings[p.id] ?? 1000,
      doubles_rating:       doublesRatings[p.id] ?? 1000,
      mixed_doubles_rating: mixedRatings[p.id]   ?? 1000,
    }).eq('id', p.id);
    profilesUpdated++;
  }
  console.log('  Updated', profilesUpdated, 'profiles');

  // 4. Persist match rating snapshots + doubles_category
  console.log('Updating match snapshots + categories...');
  let matchesUpdated = 0;
  for (const u of matchUpdates) {
    await s.from('matches').update({
      player1_rating_before: u.p1before,
      player2_rating_before: u.p2before,
      player1_rating_after:  u.p1after,
      player2_rating_after:  u.p2after,
      doubles_category:      u.category, // null for singles
    }).eq('id', u.id);
    matchesUpdated++;
  }
  console.log('  Updated', matchesUpdated, 'match snapshots');

  // 5. Persist location ratings (upsert)
  //    Wipe any stale rows first so the script is fully idempotent.
  console.log('Resetting + upserting location ratings...');
  await s.from('player_location_ratings').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  const locRows = Object.values(locationRatings);
  let locUpdated = 0;
  for (const row of locRows) {
    await s.from('player_location_ratings').upsert(row, { onConflict: 'user_id,location_name,match_type' });
    locUpdated++;
  }
  console.log('  Upserted', locUpdated, 'location rating rows');

  // 6. Print final standings
  const { data: final } = await s.from('profiles')
    .select('full_name, rating, singles_rating, doubles_rating, mixed_doubles_rating')
    .order('rating', { ascending: false }).limit(8);
  console.log('\nFinal standings:');
  console.log('  Player               Overall  Singles  Gendered  Mixed');
  final.forEach(p => {
    console.log(
      '  ' + p.full_name.padEnd(21) +
      String(p.rating).padEnd(9) +
      String(p.singles_rating).padEnd(9) +
      String(p.doubles_rating).padEnd(10) +
      String(p.mixed_doubles_rating)
    );
  });

  // 7. Sample location ratings for top player
  const topPlayer = final[0];
  const { data: locSample } = await s.from('player_location_ratings')
    .select('location_name, match_type, rating, wins, losses')
    .eq('user_id', allProfiles.find(p => p.full_name === topPlayer.full_name)?.id)
    .order('rating', { ascending: false });
  console.log('\n' + topPlayer.full_name + ' location ratings:');
  locSample?.forEach(r => console.log('  📍 ' + r.location_name.padEnd(35) + r.match_type.padEnd(18) + r.rating + ' (' + r.wins + 'W-' + r.losses + 'L)'));
}

run().catch(console.error);
