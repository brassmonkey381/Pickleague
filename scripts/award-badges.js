/**
 * Evaluates all badge criteria against existing data and awards badges retroactively.
 * Safe to re-run — uses upsert/conflict-ignore so no duplicates are created.
 * Run after adding new badge definitions to back-fill existing players.
 */
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let awarded = 0;

async function award(userId, badgeId, leagueId, context) {
  const payload = { user_id: userId, badge_id: badgeId, league_id: leagueId ?? null, context };
  // Use upsert — but partial unique indexes mean we need to check manually
  const { data: existing } = await s.from('player_badges')
    .select('id')
    .eq('user_id', userId)
    .eq('badge_id', badgeId)
    .is('league_id', leagueId ?? null)
    .maybeSingle();
  if (existing) return; // already awarded
  const { error } = await s.from('player_badges').insert(payload);
  if (!error) { awarded++; process.stdout.write('.'); }
  else if (!error.message.includes('unique')) console.error('\n  ✗', error.message);
}

async function run() {
  const { data: badges }   = await s.from('badges').select('*');
  const { data: profiles } = await s.from('profiles').select('*');
  const { data: matches }  = await s.from('matches').select('*').order('played_at');
  const { data: leagues }  = await s.from('leagues').select('id');

  const badgeMap = Object.fromEntries(badges.map(b => [b.name, b]));

  console.log(`Evaluating ${badges.length} badges for ${profiles.length} players across ${matches.length} matches...\n`);

  for (const player of profiles) {
    const uid = player.id;
    const playerMatches = matches.filter(m =>
      m.player1_id === uid || m.player2_id === uid ||
      m.partner1_id === uid || m.partner2_id === uid
    );

    function onTeam1(m) { return m.player1_id === uid || m.partner1_id === uid; }
    function won(m) { return onTeam1(m) ? m.winner_team === 'team1' : m.winner_team === 'team2'; }
    function myScore(m) { return onTeam1(m) ? m.player1_score : m.player2_score; }
    function oppScore(m) { return onTeam1(m) ? m.player2_score : m.player1_score; }

    // ── PROFILE BADGES ──────────────────────────────────────────────

    // Welcome — everyone with an account
    await award(uid, badgeMap['Welcome'].id, null, 'Account created');

    // First Rally — played at least 1 match
    if (playerMatches.length >= 1)
      await award(uid, badgeMap['First Rally'].id, null, `Played first match on ${playerMatches[0].played_at.slice(0,10)}`);

    // Hot Streak — 5 consecutive wins
    let streak = 0, maxStreak = 0;
    for (const m of playerMatches) {
      if (won(m)) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
    }
    if (maxStreak >= 5)
      await award(uid, badgeMap['Hot Streak'].id, null, `Hit a ${maxStreak}-match win streak`);

    // Court Hopper — 5+ distinct locations
    const locations = new Set(playerMatches.map(m => m.location_name).filter(Boolean));
    if (locations.size >= 5)
      await award(uid, badgeMap['Court Hopper'].id, null, `Played at ${locations.size} different courts`);

    // Doubles Dynamo — 20 doubles matches
    const doublesCount = playerMatches.filter(m => m.match_type === 'doubles').length;
    if (doublesCount >= 20)
      await award(uid, badgeMap['Doubles Dynamo'].id, null, `Played ${doublesCount} doubles matches`);

    // Singles Specialist — 25 singles matches
    const singlesCount = playerMatches.filter(m => m.match_type === 'singles').length;
    if (singlesCount >= 25)
      await award(uid, badgeMap['Singles Specialist'].id, null, `Played ${singlesCount} singles matches`);

    // Top Rated — ELO >= 1150
    if (player.rating >= 1150)
      await award(uid, badgeMap['Top Rated'].id, null, `Reached ${player.rating} ELO`);

    // Veteran — account age >= 30 days
    const ageDays = (Date.now() - new Date(player.created_at).getTime()) / 86400000;
    if (ageDays >= 30)
      await award(uid, badgeMap['Veteran'].id, null, `${Math.floor(ageDays)} days as a member`);

    // ── LEAGUE BADGES (per league the player is in) ──────────────────

    for (const league of leagues) {
      const lid = league.id;
      const lm = playerMatches.filter(m => m.league_id === lid);
      if (lm.length === 0) continue;

      // Hat Trick — won 3+ matches in one calendar day in this league
      const winsByDay = {};
      for (const m of lm) {
        if (!won(m)) continue;
        const day = m.played_at.slice(0, 10);
        winsByDay[day] = (winsByDay[day] || 0) + 1;
      }
      const hatTrickDay = Object.entries(winsByDay).find(([, count]) => count >= 3);
      if (hatTrickDay)
        await award(uid, badgeMap['Hat Trick'].id, lid, `Won ${hatTrickDay[1]} matches on ${hatTrickDay[0]}`);

      // Home Court Hero — 5 home wins in this league
      const homeWins = lm.filter(m => m.is_home_court && won(m)).length;
      if (homeWins >= 5)
        await award(uid, badgeMap['Home Court Hero'].id, lid, `${homeWins} home court wins`);

      // League Regular — 15+ matches in this league
      if (lm.length >= 15)
        await award(uid, badgeMap['League Regular'].id, lid, `Played ${lm.length} matches in this league`);

      // Dominant — won a match 11-0 or 11-1
      const blowout = lm.find(m => won(m) && myScore(m) === 11 && oppScore(m) <= 1);
      if (blowout)
        await award(uid, badgeMap['Dominant'].id, lid, `Won ${myScore(blowout)}-${oppScore(blowout)} on ${blowout.played_at.slice(0,10)}`);

      // Iron Player — played on 5+ distinct calendar days in this league
      const playDays = new Set(lm.map(m => m.played_at.slice(0, 10)));
      if (playDays.size >= 5)
        await award(uid, badgeMap['Iron Player'].id, lid, `Played on ${playDays.size} different days`);

      // Comeback King — scored 8+ points in a loss
      const toughLoss = lm.find(m => !won(m) && myScore(m) >= 8);
      if (toughLoss)
        await award(uid, badgeMap['Comeback King'].id, lid, `Scored ${myScore(toughLoss)} in a loss on ${toughLoss.played_at.slice(0,10)}`);
    }

    // League Leader — currently #1 in any league (check by ELO)
    for (const league of leagues) {
      const lid = league.id;
      const { data: members } = await s.from('league_members')
        .select('user_id, profile:profiles(rating)')
        .eq('league_id', lid);
      if (!members || members.length === 0) continue;
      const sorted = [...members].sort((a, b) => (b.profile?.rating ?? 0) - (a.profile?.rating ?? 0));
      if (sorted[0]?.user_id === uid)
        await award(uid, badgeMap['League Leader'].id, lid, `#1 rated in this league`);
    }
  }

  console.log(`\n\nAwarded ${awarded} new badges.\n`);

  // Summary by badge
  const { data: summary } = await s
    .from('player_badges')
    .select('badge_id, badges(name, icon)')
    .order('earned_at');

  const counts = {};
  for (const r of summary) {
    const name = r.badges?.name ?? r.badge_id;
    counts[name] = (counts[name] || 0) + 1;
  }

  console.log('Badge distribution:');
  Object.entries(counts).sort((a,b) => b[1]-a[1]).forEach(([name, count]) => {
    console.log(`  ${count.toString().padStart(3)}x  ${name}`);
  });
}

run().catch(console.error);
