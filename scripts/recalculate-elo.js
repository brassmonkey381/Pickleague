/**
 * Recalculates all ELO ratings from scratch by replaying match history.
 * Produces accurate singles_rating, doubles_rating, and player_location_ratings.
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

async function run() {
  // 1. Reset all ratings to 1000
  const { data: allProfiles } = await s.from('profiles').select('id, full_name');
  const ratings = {};         // overall
  const singlesRatings = {};  // singles only
  const doublesRatings = {};  // doubles only
  const locationRatings = {}; // key: `${userId}|${location}|${type}`

  allProfiles.forEach(p => {
    ratings[p.id] = 1000;
    singlesRatings[p.id] = 1000;
    doublesRatings[p.id] = 1000;
  });

  // 2. Replay all matches in chronological order
  const { data: matches } = await s
    .from('matches')
    .select('*')
    .order('played_at', { ascending: true });

  console.log(`Replaying ${matches.length} matches...`);

  const matchUpdates = []; // {id, p1before, p2before, p1after, p2after}

  for (const m of matches) {
    const p1 = m.player1_id, p2 = m.player2_id;
    const pa1 = m.partner1_id, pa2 = m.partner2_id;
    const isDoubles = m.match_type === 'doubles';
    const won1 = m.winner_team === 'team1' || m.winner_id === p1;

    // Overall rating for ELO calc
    const r1 = ratings[p1] ?? 1000;
    const r2 = ratings[p2] ?? 1000;
    const rp1 = ratings[pa1] ?? 1000;
    const rp2 = ratings[pa2] ?? 1000;

    let t1avg = isDoubles ? (r1 + rp1) / 2 : r1;
    let t2avg = isDoubles ? (r2 + rp2) / 2 : r2;

    const d1 = delta(t1avg, t2avg, won1);
    const d2 = -d1;

    // Snapshot before
    matchUpdates.push({ id: m.id, p1before: r1, p2before: r2, p1after: r1 + d1, p2after: r2 + d2 });

    // Update overall
    ratings[p1] = (ratings[p1] ?? 1000) + d1;
    ratings[p2] = (ratings[p2] ?? 1000) + d2;
    if (isDoubles) {
      if (pa1) ratings[pa1] = (ratings[pa1] ?? 1000) + d1;
      if (pa2) ratings[pa2] = (ratings[pa2] ?? 1000) + d2;
    }

    // Update split
    if (isDoubles) {
      doublesRatings[p1] = (doublesRatings[p1] ?? 1000) + d1;
      doublesRatings[p2] = (doublesRatings[p2] ?? 1000) + d2;
      if (pa1) doublesRatings[pa1] = (doublesRatings[pa1] ?? 1000) + d1;
      if (pa2) doublesRatings[pa2] = (doublesRatings[pa2] ?? 1000) + d2;
    } else {
      singlesRatings[p1] = (singlesRatings[p1] ?? 1000) + d1;
      singlesRatings[p2] = (singlesRatings[p2] ?? 1000) + d2;
    }

    // Update location ratings
    if (m.location_name) {
      for (const [uid, dlt, won] of [
        [p1,  d1, won1],
        [p2,  d2, !won1],
        ...(isDoubles && pa1 ? [[pa1, d1, won1]]  : []),
        ...(isDoubles && pa2 ? [[pa2, d2, !won1]] : []),
      ]) {
        const type = isDoubles ? 'doubles' : 'singles';
        const key = `${uid}|${m.location_name}|${type}`;
        if (!locationRatings[key]) locationRatings[key] = { user_id: uid, location_name: m.location_name, match_type: type, rating: 1000, wins: 0, losses: 0 };
        locationRatings[key].rating += dlt;
        if (won) locationRatings[key].wins++; else locationRatings[key].losses++;
      }
    }
  }

  // 3. Persist profile ratings
  console.log('Updating profile ratings...');
  let profilesUpdated = 0;
  for (const p of allProfiles) {
    await s.from('profiles').update({
      rating:         ratings[p.id]        ?? 1000,
      singles_rating: singlesRatings[p.id] ?? 1000,
      doubles_rating: doublesRatings[p.id] ?? 1000,
    }).eq('id', p.id);
    profilesUpdated++;
  }
  console.log('  Updated', profilesUpdated, 'profiles');

  // 4. Persist match rating snapshots
  console.log('Updating match snapshots...');
  let matchesUpdated = 0;
  for (const u of matchUpdates) {
    await s.from('matches').update({
      player1_rating_before: u.p1before,
      player2_rating_before: u.p2before,
      player1_rating_after:  u.p1after,
      player2_rating_after:  u.p2after,
    }).eq('id', u.id);
    matchesUpdated++;
  }
  console.log('  Updated', matchesUpdated, 'match snapshots');

  // 5. Persist location ratings (upsert)
  console.log('Upserting location ratings...');
  const locRows = Object.values(locationRatings);
  let locUpdated = 0;
  for (const row of locRows) {
    await s.from('player_location_ratings').upsert(row, { onConflict: 'user_id,location_name,match_type' });
    locUpdated++;
  }
  console.log('  Upserted', locUpdated, 'location rating rows');

  // 6. Print final standings
  const { data: final } = await s.from('profiles').select('full_name, rating, singles_rating, doubles_rating').order('rating', { ascending: false }).limit(8);
  console.log('\nFinal standings:');
  console.log('  Player               Overall  Singles  Doubles');
  final.forEach(p => {
    console.log('  ' + p.full_name.padEnd(21) + String(p.rating).padEnd(9) + String(p.singles_rating).padEnd(9) + p.doubles_rating);
  });

  // 7. Sample location ratings for top player
  const topPlayer = final[0];
  const { data: locSample } = await s.from('player_location_ratings')
    .select('location_name, match_type, rating, wins, losses')
    .eq('user_id', allProfiles.find(p => p.full_name === topPlayer.full_name)?.id)
    .order('rating', { ascending: false });
  console.log('\n' + topPlayer.full_name + ' location ratings:');
  locSample?.forEach(r => console.log('  📍 ' + r.location_name.padEnd(35) + r.match_type.padEnd(10) + r.rating + ' (' + r.wins + 'W-' + r.losses + 'L)'));
}

run().catch(console.error);
