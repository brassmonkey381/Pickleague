// Seed a complete 12-week historical season for Hub 4.5-5.0 Rec League:
//   • 1 league_seasons row, 12 weeks total, lock_frequency_weeks = 3 (→ 4 periods)
//   • 6 scheduled play events (status=scheduled, with confirmed slot + votes)
//   • ~170 matches distributed across the season (mix of singles + doubles)
//   • 4 lock-in snapshots (replicating lock_season_period logic)
//   • Final standings (median rank across periods, sorted ascending)
//
// Notes on ELO: matches are inserted via the normal trigger so profile.rating
// drifts. We snapshot the current rating into elo_at_snapshot — the rank
// itself is computed period-by-period from wins/losses, so this is fine.
// We do NOT call complete_season() because that resets all participant ELOs
// to 1000 + bonus, which would clobber the live state. We write final
// standings directly and set elo_reset_applied=true to keep the UI consistent.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const LEAGUE_NAME           = 'Hub 4.5-5.0 Rec League';
const SEASON_NAME           = 'Winter 2026';
const SEASON_START          = '2026-01-05';     // Monday
const TOTAL_WEEKS           = 12;
const LOCK_FREQUENCY_WEEKS  = 3;                // → 4 periods
const TOTAL_MATCHES         = 170;
const DOUBLES_RATIO         = 0.55;             // 55% doubles, 45% singles
const NUM_EVENTS            = 6;

// ── helpers ────────────────────────────────────────────────────
const DAY_MS = 86400000;
function addDays(date, n)  { return new Date(date.getTime() + n * DAY_MS); }
function isoDate(d)        { return d.toISOString().slice(0, 10); }
function pick(arr)         { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function rollScore() {
  const r = Math.random();
  let loser;
  if (r < 0.55)      loser = 7 + Math.floor(Math.random() * 3);   // 7-9 close
  else if (r < 0.85) loser = 4 + Math.floor(Math.random() * 3);   // 4-6 medium
  else               loser = Math.floor(Math.random() * 4);       // 0-3 blowout
  if (loser === 9 && Math.random() < 0.18) return [12, 10];       // deuce
  return [11, loser];
}

const SCHED_HOURS = [9, 10, 11, 17, 18, 19];   // morning + evening play
function randomTimeOnDate(date) {
  const d = new Date(date);
  d.setHours(pick(SCHED_HOURS), pick([0, 15, 30, 45]), 0, 0);
  return d;
}

// "Skill" weight per player so some win more than others (purely synthetic).
// Higher = better; ranges roughly 0.85–1.30 for fun spread.
function skillWeight(seed) {
  const x = Math.sin(seed * 9301 + 49297) * 0.5 + 0.5;
  return 0.85 + x * 0.45;
}

async function main() {
  // ── 1. Look up league + members ─────────────────────────────
  const { data: league, error: lErr } = await supabase
    .from('leagues').select('id, name, created_by').eq('name', LEAGUE_NAME).single();
  if (lErr || !league) throw new Error(`League "${LEAGUE_NAME}" not found: ${lErr?.message}`);
  console.log(`League: ${league.name} (${league.id})`);

  const { data: members } = await supabase
    .from('league_members')
    .select('user_id, profile:profiles(full_name, rating)')
    .eq('league_id', league.id);
  const memberIds = members.map(m => m.user_id);
  console.log(`Members: ${memberIds.length}`);
  if (memberIds.length < 4) throw new Error('Need at least 4 league members');

  const skillById = new Map(memberIds.map((id, i) => [id, skillWeight(i + 1)]));
  const nameById  = new Map(members.map(m => [m.user_id, m.profile?.full_name ?? '?']));

  // ── 2. Skip if season already exists ───────────────────────
  const { data: existing } = await supabase
    .from('league_seasons')
    .select('id, name')
    .eq('league_id', league.id)
    .eq('name', SEASON_NAME)
    .maybeSingle();
  if (existing) {
    console.log(`\nSeason "${SEASON_NAME}" already exists (id=${existing.id}). Wiping its data and re-seeding.`);
    await supabase.from('league_seasons').delete().eq('id', existing.id); // cascades snapshots + finals
  }

  // ── 3. Create season ────────────────────────────────────────
  const seasonStart = new Date(SEASON_START + 'T12:00:00Z');
  const seasonEnd   = addDays(seasonStart, TOTAL_WEEKS * 7);

  const { data: season, error: sErr } = await supabase
    .from('league_seasons')
    .insert({
      league_id:            league.id,
      name:                 SEASON_NAME,
      start_date:           isoDate(seasonStart),
      end_date:             isoDate(seasonEnd),
      total_weeks:          TOTAL_WEEKS,
      lock_frequency_weeks: LOCK_FREQUENCY_WEEKS,
      status:               'upcoming',
      elo_reset_applied:    true,    // skip ELO reset on completion
      created_by:           league.created_by,
    })
    .select().single();
  if (sErr) throw new Error(`Insert season: ${sErr.message}`);

  console.log(`\nSeason created: ${season.name} (${season.start_date} → ${season.end_date}, ${season.total_periods} periods)`);

  // ── 4. Generate scheduled play events ───────────────────────
  console.log(`\nCreating ${NUM_EVENTS} scheduled events…`);
  const eventGap = Math.floor(TOTAL_WEEKS * 7 / NUM_EVENTS);
  let evtCreated = 0, slotCreated = 0, voteCreated = 0;
  for (let e = 0; e < NUM_EVENTS; e++) {
    const eventDayStart = addDays(seasonStart, e * eventGap + 3 + Math.floor(Math.random() * 4));
    const voteEndsAt    = addDays(eventDayStart, -2);

    const { data: evt, error: eErr } = await supabase
      .from('league_events')
      .insert({
        league_id:    league.id,
        title:        `Open Play — Week ${e * Math.round(TOTAL_WEEKS / NUM_EVENTS) + 1}`,
        description:  'League members get-together. Bring your A-game.',
        created_by:   league.created_by,
        status:       'scheduled',
        vote_ends_at: voteEndsAt.toISOString(),
      })
      .select().single();
    if (eErr) { console.error('  ✗ event:', eErr.message); continue; }
    evtCreated++;

    // 3 candidate slots per event
    const slotRows = [];
    for (let i = 0; i < 3; i++) {
      const slotDate = addDays(eventDayStart, i);
      const startsAt = randomTimeOnDate(slotDate);
      const endsAt   = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
      slotRows.push({ event_id: evt.id, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() });
    }
    const { data: slots, error: slErr } = await supabase
      .from('event_slots').insert(slotRows).select();
    if (slErr) { console.error('  ✗ slots:', slErr.message); continue; }
    slotCreated += slots.length;

    // Random votes per slot — ~50-80% of members vote on each, tracked locally
    const voteCounts = new Map(slots.map(s => [s.id, 0]));
    for (const slot of slots) {
      const voters = shuffle(memberIds).slice(0, Math.floor(memberIds.length * (0.5 + Math.random() * 0.3)));
      for (const uid of voters) {
        const { error: vErr } = await supabase.from('event_slot_votes').insert({ slot_id: slot.id, user_id: uid });
        if (!vErr) { voteCreated++; voteCounts.set(slot.id, voteCounts.get(slot.id) + 1); }
      }
    }

    // Confirm the slot that won the vote
    const winnerSlotId = [...voteCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    await supabase.from('league_events')
      .update({ confirmed_slot_id: winnerSlotId })
      .eq('id', evt.id);
  }
  console.log(`  ✓ ${evtCreated} events, ${slotCreated} slots, ${voteCreated} votes`);

  // ── 5. Generate matches ─────────────────────────────────────
  // Distributed evenly across the 12 weeks. Each match picks players weighted
  // toward higher-skill so the standings differentiate.
  console.log(`\nGenerating ${TOTAL_MATCHES} matches…`);
  const matchRows = [];
  for (let i = 0; i < TOTAL_MATCHES; i++) {
    const dayOffset = Math.floor((i / TOTAL_MATCHES) * TOTAL_WEEKS * 7) + Math.floor(Math.random() * 2);
    const matchDate = addDays(seasonStart, Math.min(dayOffset, TOTAL_WEEKS * 7 - 1));
    const playedAt  = randomTimeOnDate(matchDate);

    const isDoubles = Math.random() < DOUBLES_RATIO;
    const pool = shuffle(memberIds);

    if (isDoubles) {
      const [p1, partner1, p2, partner2] = pool.slice(0, 4);
      const team1Skill = (skillById.get(p1) + skillById.get(partner1)) / 2;
      const team2Skill = (skillById.get(p2) + skillById.get(partner2)) / 2;
      const team1WinProb = team1Skill / (team1Skill + team2Skill);
      const team1Wins    = Math.random() < team1WinProb;
      const [winS, loseS] = rollScore();

      matchRows.push({
        league_id:     league.id,
        match_type:    'doubles',
        player1_id:    p1, partner1_id: partner1,
        player2_id:    p2, partner2_id: partner2,
        player1_score: team1Wins ? winS : loseS,
        player2_score: team1Wins ? loseS : winS,
        winner_id:     team1Wins ? p1 : p2,
        winner_team:   team1Wins ? 'team1' : 'team2',
        played_at:     playedAt.toISOString(),
      });
    } else {
      const [p1, p2] = pool.slice(0, 2);
      const team1Skill = skillById.get(p1);
      const team2Skill = skillById.get(p2);
      const team1WinProb = team1Skill / (team1Skill + team2Skill);
      const team1Wins    = Math.random() < team1WinProb;
      const [winS, loseS] = rollScore();

      matchRows.push({
        league_id:     league.id,
        match_type:    'singles',
        player1_id:    p1,
        player2_id:    p2,
        player1_score: team1Wins ? winS : loseS,
        player2_score: team1Wins ? loseS : winS,
        winner_id:     team1Wins ? p1 : p2,
        winner_team:   team1Wins ? 'team1' : 'team2',
        played_at:     playedAt.toISOString(),
      });
    }
  }

  // Sort chronologically so the ELO trigger evolves naturally over time
  matchRows.sort((a, b) => a.played_at.localeCompare(b.played_at));

  let inserted = 0, failed = 0;
  for (let i = 0; i < matchRows.length; i += 25) {
    const chunk = matchRows.slice(i, i + 25);
    const { error } = await supabase.from('matches').insert(chunk);
    if (error) { failed += chunk.length; console.error(`  ✗ chunk ${i}: ${error.message}`); }
    else { inserted += chunk.length; }
  }
  console.log(`  ✓ ${inserted} matches inserted (${failed} failed)`);

  // ── 6. Compute snapshots for each lock-in period ───────────
  console.log(`\nComputing ${season.total_periods} lock-in period snapshots…`);

  // Pull current ratings (post-match-insert) — cosmetic for elo_at_snapshot
  const { data: currentProfiles } = await supabase
    .from('profiles').select('id, rating').in('id', memberIds);
  const ratingById = new Map(currentProfiles.map(p => [p.id, p.rating]));

  const snapshotInserts = [];
  for (let period = 1; period <= season.total_periods; period++) {
    const snapshotDate = addDays(seasonStart, period * LOCK_FREQUENCY_WEEKS * 7 - 1);
    const snapshotIso  = isoDate(snapshotDate);

    // Count wins/losses for each member in [season_start, snapshot_date]
    const stats = new Map(memberIds.map(id => [id, { wins: 0, losses: 0 }]));
    const { data: periodMatches } = await supabase
      .from('matches')
      .select('player1_id, partner1_id, player2_id, partner2_id, winner_team, played_at')
      .eq('league_id', league.id)
      .gte('played_at', season.start_date)
      .lte('played_at', snapshotIso + 'T23:59:59');

    for (const m of periodMatches ?? []) {
      const team1 = [m.player1_id, m.partner1_id].filter(Boolean);
      const team2 = [m.player2_id, m.partner2_id].filter(Boolean);
      const winnerTeam = m.winner_team === 'team1' ? team1 : team2;
      const loserTeam  = m.winner_team === 'team1' ? team2 : team1;
      for (const uid of winnerTeam) if (stats.has(uid)) stats.get(uid).wins++;
      for (const uid of loserTeam)  if (stats.has(uid)) stats.get(uid).losses++;
    }

    // Sort: wins desc, rating desc (matches the SQL function exactly)
    const ranked = [...memberIds]
      .map(id => ({ id, wins: stats.get(id).wins, losses: stats.get(id).losses, rating: ratingById.get(id) ?? 1000 }))
      .sort((a, b) => b.wins - a.wins || b.rating - a.rating);

    ranked.forEach((r, idx) => {
      snapshotInserts.push({
        season_id:        season.id,
        league_id:        league.id,
        period_number:    period,
        snapshot_date:    snapshotIso,
        user_id:          r.id,
        elo_at_snapshot:  r.rating,
        rank_at_snapshot: idx + 1,
        wins_in_season:   r.wins,
        losses_in_season: r.losses,
      });
    });

    console.log(`  · Period ${period} (${snapshotIso}): ${ranked.length} ranked, top: ${nameById.get(ranked[0].id)} (${ranked[0].wins}-${ranked[0].losses})`);
  }

  // Insert snapshots
  for (let i = 0; i < snapshotInserts.length; i += 50) {
    const chunk = snapshotInserts.slice(i, i + 50);
    const { error } = await supabase.from('season_snapshots').insert(chunk);
    if (error) console.error(`  ✗ snapshots chunk ${i}: ${error.message}`);
  }
  console.log(`  ✓ ${snapshotInserts.length} snapshot rows inserted`);

  // ── 7. Compute final standings (median rank, ascending) ────
  console.log(`\nComputing final season standings…`);

  // Group ranks by user_id from the snapshots we just inserted
  const ranksByUser = new Map(memberIds.map(id => [id, []]));
  for (const s of snapshotInserts) {
    ranksByUser.get(s.user_id)?.push(s.rank_at_snapshot);
  }

  function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return 0;
    return n % 2 === 1
      ? sorted[(n - 1) / 2]
      : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }

  const finalRows = [...memberIds]
    .map(id => ({ id, ranks: ranksByUser.get(id), median: median(ranksByUser.get(id) ?? []) }))
    .sort((a, b) => a.median - b.median);

  const finalInserts = finalRows.map((r, idx) => {
    const rank = idx + 1;
    const bonus = rank === 1 ? 80 : rank === 2 ? 55 : rank === 3 ? 35 : rank === 4 ? 20 : rank === 5 ? 10 : 0;
    return {
      season_id:   season.id,
      league_id:   league.id,
      user_id:     r.id,
      final_rank:  rank,
      median_rank: r.median,
      elo_bonus:   bonus,
      new_elo:     1000 + bonus,
    };
  });

  const { error: fErr } = await supabase.from('season_final_standings').insert(finalInserts);
  if (fErr) console.error(`  ✗ final standings: ${fErr.message}`);
  else      console.log(`  ✓ ${finalInserts.length} final standings rows inserted`);

  // ── 8. Mark season completed ───────────────────────────────
  await supabase.from('league_seasons')
    .update({ status: 'completed' })
    .eq('id', season.id);

  // ── 9. Print results ──────────────────────────────────────
  console.log(`\n══════ Final Standings — ${SEASON_NAME} ══════`);
  console.log('Rank  Player                          Periods            Median');
  console.log('────  ─────────────────────────────  ─────────────────  ──────');
  for (const f of finalInserts) {
    const ranks = ranksByUser.get(f.user_id) ?? [];
    const ranksStr = ranks.map(r => String(r).padStart(2)).join(', ').padEnd(17);
    const name = (nameById.get(f.user_id) ?? '?').padEnd(30);
    const medal = f.final_rank === 1 ? '🥇' : f.final_rank === 2 ? '🥈' : f.final_rank === 3 ? '🥉' : '  ';
    console.log(`${String(f.final_rank).padStart(3)}.${medal} ${name} ${ranksStr}  ${f.median_rank.toFixed(1)}`);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
