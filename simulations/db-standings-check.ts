/**
 * PKL-090 #3: the real server's MLP standings (mlp_team_standings) against the approved rules, after EVERY score.
 * Small by design (Brian: little load): a few seeded MLP round robins of 4 teams, all inside ONE transaction that is
 * rolled back, so nothing is kept. Runs on the linked project (Brian's pick "090 rollback").
 *
 *   npx tsx db-standings-check.ts [--seed 7] [--tournaments 2]
 *
 * Exit 1 on any mismatch; the seed replays it.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { oracleMlpRows, type OracleMeeting } from '../mobile/src/lib/standingsOracle';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SEED = Number(arg('--seed', String(Date.now() % 100000)));
const N_T = Number(arg('--tournaments', '2'));
const SB = 'C:/Users/Brian/tools/supabase/supabase.exe';
const REPO = path.resolve(__dirname, '..');

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r = rng(SEED);
const shuffle = <T,>(xs: T[]) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// 4 teams, round robin: meetings (0,1)(0,2)(0,3)(1,2)(1,3)(2,3), as generate_mlp_bracket orders them (by seed).
const PAIRS: [number, number][] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
type Step = { t: number; order: number; s1: number; s2: number };
type Game = { status: 'completed' | 'pending' | 'cancelled'; winner: 1 | 2 | null; s1: number | null; s2: number | null };

// Plan every tournament's scores in TypeScript, so the oracle can follow the same sequence.
const plans: { steps: Step[]; states: OracleMeeting[][] }[] = [];
for (let t = 0; t < N_T; t++) {
  const meetings: Game[][] = PAIRS.map(() => Array.from({ length: 5 }, () => ({ status: 'pending' as const, winner: null, s1: null, s2: null })));
  const steps: Step[] = [];
  const states: OracleMeeting[][] = [];
  const snap = () => meetings.map((g, k) => ({ a: `T${PAIRS[k][0]}`, b: `T${PAIRS[k][1]}`, games: g.map((x) => ({ ...x })) }));
  for (const [k, gi] of shuffle(PAIRS.flatMap((_, k) => [0, 1, 2, 3].map((gi) => [k, gi] as [number, number])))) {
    const lose = Math.floor(r() * 10), t1 = r() < 0.5;
    const [s1, s2] = t1 ? [11, lose] : [lose, 11];
    const g = meetings[k];
    g[gi] = { status: 'completed', winner: t1 ? 1 : 2, s1, s2 };
    steps.push({ t, order: k * 5 + gi + 1, s1, s2 });
    const a = g.slice(0, 4).filter((x) => x.winner === 1).length, b = g.slice(0, 4).filter((x) => x.winner === 2).length;
    if ((a >= 3 || b >= 3) && g[4].status === 'pending') g[4] = { status: 'cancelled', winner: null, s1: null, s2: null };   // the server cancels it
    states.push(snap());
    if (a === 2 && b === 2 && g.slice(0, 4).every((x) => x.status === 'completed')) {
      const w = r() < 0.5, other = 13 + Math.floor(r() * 7);
      g[4] = { status: 'completed', winner: w ? 1 : 2, s1: w ? 21 : other, s2: w ? other : 21 };
      steps.push({ t, order: k * 5 + 5, s1: g[4].s1!, s2: g[4].s2! });
      states.push(snap());
    }
  }
  plans.push({ steps, states });
}

const steps = plans.flatMap((p) => p.steps);
const stepArr = (f: (s: Step) => number) => `array[${steps.map(f).join(',')}]::int[]`;
const sql = `begin;
set local statement_timeout = '120s';
alter table public.tournaments disable trigger trg_pl_tournament_create_cost;
create temp table _snap(step int, t int, team text, mw int, ml int, gw int, gl int, pd int);
do $$
declare
  u uuid[]; tids uuid[] := '{}'; tid uuid; i int; k int; t int;
  st_t int[] := ${stepArr((s) => s.t)}; st_o int[] := ${stepArr((s) => s.order)};
  st_1 int[] := ${stepArr((s) => s.s1)}; st_2 int[] := ${stepArr((s) => s.s2)};
begin
  -- test accounts in no active tournament, so a running rehearsal is never touched
  select array_agg(id) into u from (select p.id from public.profiles p where coalesce(p.is_test_account, false)
    and not exists (select 1 from public.tournament_registrations tr join public.tournaments x on x.id = tr.tournament_id
                     where tr.user_id = p.id and x.status in ('registration', 'active'))
    order by p.created_at limit ${16 * N_T}) s;
  if coalesce(array_length(u, 1), 0) < ${16 * N_T} then raise exception 'not enough free test accounts'; end if;
  for t in 0..${N_T - 1} loop
    insert into public.tournaments(name, format, match_type, created_by, status, mlp_play_format, mlp_pool_count, pickle_ante)
      values ('[SIM] PKL-090 db check', 'mlp', 'doubles', u[t * 16 + 1], 'registration', 'round_robin', 2, 0) returning id into tid;
    tids := tids || tid;
    insert into public.tournament_registrations(tournament_id, user_id, status) select tid, x, 'approved' from unnest(u[t * 16 + 1:t * 16 + 16]) x;
    for k in 0..3 loop
      insert into public.mlp_teams(tournament_id, name, captain_id, male_1_id, male_2_id, female_1_id, female_2_id, status, created_at)
        values (tid, 'T' || k, u[t * 16 + k * 4 + 1], u[t * 16 + k * 4 + 1], u[t * 16 + k * 4 + 2], u[t * 16 + k * 4 + 3], u[t * 16 + k * 4 + 4], 'locked', now() + make_interval(secs => k));
    end loop;
    perform set_config('request.jwt.claims', json_build_object('sub', u[t * 16 + 1], 'role', 'authenticated')::text, true);
    perform public.generate_mlp_bracket(tid);
  end loop;
  for i in 1..array_length(st_t, 1) loop
    update public.tournament_matches set status = 'completed', team1_score = st_1[i], team2_score = st_2[i],
           winner_team = case when st_1[i] > st_2[i] then 'team1' else 'team2' end
     where tournament_id = tids[st_t[i] + 1] and match_order = st_o[i] and status = 'pending';
    insert into _snap select i, st_t[i], s.team_name, s.matchups_won, s.matchups_lost, s.sub_matches_won, s.sub_matches_lost, s.point_diff
      from public.mlp_team_standings(tids[st_t[i] + 1]) s;
  end loop;
end $$;
select coalesce(json_agg(row_to_json(x) order by x.step, x.team), '[]'::json) as snaps from _snap x;
rollback;
`;
const file = path.join(os.tmpdir(), `pkl090-db-${SEED}.sql`);
fs.writeFileSync(file, sql);
console.log(`PKL-090 db check: seed ${SEED}, ${N_T} tournament(s), ${steps.length} scores, one rolled-back transaction`);
const out = execFileSync(SB, ['db', 'query', '--linked', '-f', file, '-o', 'json'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const i0 = out.indexOf('['); let d = 0, e = i0;
for (; e < out.length; e++) { if (out[e] === '[') d++; else if (out[e] === ']') { d--; if (!d) break; } }
const rows = JSON.parse(out.slice(i0, e + 1));
const snapsRaw = rows[0]?.snaps;
const snaps: { step: number; t: number; team: string; mw: number; ml: number; gw: number; gl: number; pd: number }[] =
  typeof snapsRaw === 'string' ? JSON.parse(snapsRaw) : snapsRaw;

// Compare every snapshot with the oracle at the same step.
const teams = [0, 1, 2, 3].map((k) => ({ id: `T${k}`, pool: '', seed: k + 1, tieRank: null }));
const bad: string[] = [];
let idx = 0;
for (const p of plans) {
  for (const state of p.states) {
    idx++;
    const want = new Map(oracleMlpRows(teams, state).map((x) => [x.team_id, x]));
    const got = snaps.filter((s) => s.step === idx);
    if (got.length !== 4) { bad.push(`step ${idx}: ${got.length} rows`); continue; }
    for (const g of got) {
      const w = want.get(g.team)!;
      const a = `${g.mw}-${g.ml} games ${g.gw}-${g.gl} ${g.pd}`, b = `${w.matchups_won}-${w.matchups_lost} games ${w.games_won}-${w.games_lost} ${w.point_diff}`;
      if (a !== b) bad.push(`step ${idx} ${g.team}: server ${a}, rules ${b}`);
    }
  }
}
console.log(`${idx} snapshots x 4 teams compared: ${bad.length ? `${bad.length} MISMATCHES` : 'all match'}`);
for (const b of bad.slice(0, 10)) console.log('  ' + b);
process.exit(bad.length ? 1 : 0);
