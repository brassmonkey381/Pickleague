/**
 * Creates "Summer Slam Doubles" — fixed partners, 2 pools of round-robin,
 * top 2 from each pool advance to semi-finals and final.
 *
 * Teams (ELO-balanced pairing: rank 1 + rank 12, 2 + 11, …):
 *   Pool A: Team 1 (Brian + Jordan), Team 3 (Sarah + Rachel), Team 5 (Derek + Lauren)
 *   Pool B: Team 2 (Marcus + Megan), Team 4 (Priya + Carlos), Team 6 (Kevin + Tyler)
 *
 * Pool round-robin: 3 matches per pool.
 * Bracket: Semi 1 (A1 vs B2), Semi 2 (B1 vs A2), Final.
 */
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const LEAGUE = '4bf3f42a-8c7c-42b7-b61d-1e83db55cd88';
const BRIAN = '252a36e1-5d89-4ad2-8a3e-b786579f019a';

// All players sorted by ELO desc (from earlier runs)
const PLAYERS = [
  { id: '252a36e1-5d89-4ad2-8a3e-b786579f019a', name: 'Brian'            },
  { id: '1952ae44-20e7-4752-b926-04aad95bbf8a', name: 'Marcus Rivera'    },
  { id: 'a84662e0-05a4-4d11-88d7-cfc2b028bd12', name: 'Sarah Chen'       },
  { id: '64a9bb93-0267-4174-a8b3-4b6320511f23', name: 'Priya Patel'      },
  { id: 'bd506b6e-0b85-422e-b18a-ab1214e3b1cd', name: 'Derek Thompson'   },
  { id: '26a641dd-13b3-4530-a876-246663e8ef2e', name: 'Kevin Okafor'     },
  { id: 'ce5192a2-8b10-40f8-8083-c7ee7aa7cd8a', name: 'Ashley Nguyen'    },
  { id: '62971d61-374f-4029-89e3-e3f8b16599b1', name: 'Tyler Brooks'     },
  { id: '6380d220-dbc3-4243-8f71-8390274afb85', name: 'Lauren Summers'   },
  { id: '8d902b05-e7c7-4547-b4d0-9bfd5271e13a', name: 'Carlos Mendez'    },
  { id: '40cb0f53-ca88-4d71-9e78-99a08d64f77c', name: 'Rachel Kim'       },
  { id: 'eb6bbd6d-ef84-4a77-8b27-70fc358f7331', name: 'Megan Foster'     },
];

// Balanced team pairing: rank1+rank12, rank2+rank11, ...
const TEAMS = [
  [PLAYERS[0],  PLAYERS[11]], // Team 1: Brian + Megan
  [PLAYERS[1],  PLAYERS[10]], // Team 2: Marcus + Rachel
  [PLAYERS[2],  PLAYERS[9]],  // Team 3: Sarah + Carlos
  [PLAYERS[3],  PLAYERS[8]],  // Team 4: Priya + Lauren
  [PLAYERS[4],  PLAYERS[7]],  // Team 5: Derek + Tyler
  [PLAYERS[5],  PLAYERS[6]],  // Team 6: Kevin + Ashley
];

// Snake-draft into pools: T1→A, T2→B, T3→A, T4→B, T5→A, T6→B
const POOL_A = [TEAMS[0], TEAMS[2], TEAMS[4]]; // Brian/Megan, Sarah/Carlos, Derek/Tyler
const POOL_B = [TEAMS[1], TEAMS[3], TEAMS[5]]; // Marcus/Rachel, Priya/Lauren, Kevin/Ashley

async function run() {
  // 1. Create tournament
  const { data: tour, error: tErr } = await s.from('tournaments').insert({
    league_id:         LEAGUE,
    name:              'Summer Slam Doubles',
    description:       '2-pool round-robin followed by semi-finals and grand final. Top 2 teams from each pool advance.',
    created_by:        BRIAN,
    format:            'pool_play',
    match_type:        'doubles',
    seeding:           'elo',
    pool_count:        2,
    registration_mode: 'invite_only',
    max_players:       12,
    bracket_release_time: new Date(Date.now() + 86400000).toISOString(),
    start_time:        new Date(Date.now() + 3 * 86400000).toISOString(),
    location_name:     'Mitchell Park Pickleball Courts',
    location_lat:      37.4067,
    location_lng:      -122.1152,
  }).select().single();
  if (tErr) { console.error('Create failed:', tErr.message); return; }
  console.log('✓  Created:', tour.name, '(' + tour.id + ')');

  // 2. Register all 12 players (Brian = admin)
  for (const p of PLAYERS) {
    await s.from('tournament_registrations').upsert({
      tournament_id: tour.id, user_id: p.id,
      status: 'approved', role: p.id === BRIAN ? 'admin' : 'member',
    });
  }
  console.log('✓  Registered', PLAYERS.length, 'players');

  // 3. Create Pool A round (3 round-robin matches)
  const { data: roundA } = await s.from('tournament_rounds').insert({
    tournament_id: tour.id, round_number: 1,
    label: 'Pool A — Round Robin', round_type: 'pool',
  }).select().single();

  const poolAMatches = [
    [POOL_A[0], POOL_A[1]], // Team1 vs Team3
    [POOL_A[0], POOL_A[2]], // Team1 vs Team5
    [POOL_A[1], POOL_A[2]], // Team3 vs Team5
  ];
  await s.from('tournament_matches').insert(poolAMatches.map(([t1, t2], i) => ({
    tournament_id: tour.id, round_id: roundA.id, match_order: i, match_type: 'doubles',
    team1_player1: t1[0].id, team1_player2: t1[1].id,
    team2_player1: t2[0].id, team2_player2: t2[1].id,
  })));
  console.log('✓  Pool A: 3 matches');

  // 4. Create Pool B round
  const { data: roundB } = await s.from('tournament_rounds').insert({
    tournament_id: tour.id, round_number: 2,
    label: 'Pool B — Round Robin', round_type: 'pool',
  }).select().single();

  const poolBMatches = [
    [POOL_B[0], POOL_B[1]],
    [POOL_B[0], POOL_B[2]],
    [POOL_B[1], POOL_B[2]],
  ];
  await s.from('tournament_matches').insert(poolBMatches.map(([t1, t2], i) => ({
    tournament_id: tour.id, round_id: roundB.id, match_order: i, match_type: 'doubles',
    team1_player1: t1[0].id, team1_player2: t1[1].id,
    team2_player1: t2[0].id, team2_player2: t2[1].id,
  })));
  console.log('✓  Pool B: 3 matches');

  // 5. Semi-finals (TBD — blank slots)
  const { data: roundSF } = await s.from('tournament_rounds').insert({
    tournament_id: tour.id, round_number: 3,
    label: 'Semi-Finals', round_type: 'semifinals',
  }).select().single();

  await s.from('tournament_matches').insert([
    { tournament_id: tour.id, round_id: roundSF.id, match_order: 0, match_type: 'doubles',
      team1_player1: null, team2_player1: null },  // 1st Pool A vs 2nd Pool B
    { tournament_id: tour.id, round_id: roundSF.id, match_order: 1, match_type: 'doubles',
      team1_player1: null, team2_player1: null },  // 1st Pool B vs 2nd Pool A
  ]);
  console.log('✓  Semi-finals: 2 TBD slots');

  // 6. Final (TBD)
  const { data: roundF } = await s.from('tournament_rounds').insert({
    tournament_id: tour.id, round_number: 4,
    label: 'Final', round_type: 'finals',
  }).select().single();

  await s.from('tournament_matches').insert({
    tournament_id: tour.id, round_id: roundF.id, match_order: 0, match_type: 'doubles',
    team1_player1: null, team2_player1: null,
  });
  console.log('✓  Final: 1 TBD slot');

  // 7. Flip to active so bracket shows
  await s.from('tournaments').update({ status: 'active' }).eq('id', tour.id);
  console.log('\n📋  Summer Slam Doubles summary:');
  console.log('    Pool A:', POOL_A.map(t => t[0].name + ' & ' + t[1].name).join(' | '));
  console.log('    Pool B:', POOL_B.map(t => t[0].name + ' & ' + t[1].name).join(' | '));
  console.log('    7 pool matches + 2 semi slots + 1 final slot = 10 total');
  console.log('    Status: active — bracket view ready');
}
run().catch(console.error);
