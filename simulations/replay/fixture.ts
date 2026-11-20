/**
 * PKL-054: an offline, made-up tournament for trying the replay page without the database.
 * Doubles pool play, 8 fixed teams in 2 pools, 2 courts, top 2 per pool into semis, a final and a third place match.
 * Pool A ends in a 3-way tie on W-L and point diff, so the admin has to order it (PKL-052); one score is corrected.
 */
import type { REvent, RAlert, RCheck, RMatch, ReplayData } from './collect';

export function fixtureReplay(): ReplayData {
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const uuid = (n: number, kind = 'a') => `00000000-0000-4000-8000-${kind.charCodeAt(0).toString(16)}${String(n).padStart(10, '0')}`;
  const P = Array.from({ length: 16 }, (_, i) => uuid(i + 1, 'p'));
  const people: ReplayData['people'] = {};
  P.forEach((id, i) => { people[id] = { name: i === 0 ? 'Brian' : `QA Bot ${i}`, seed: i + 1, role: i === 0 ? 'admin' : 'member', bot: i > 0 }; });
  const host = P[0];
  const teams = Array.from({ length: 8 }, (_, i) => [P[i * 2], P[i * 2 + 1]]);
  const poolA = [teams[0], teams[3], teams[4], teams[7]];
  const poolB = [teams[1], teams[2], teams[5], teams[6]];
  const tid = uuid(1, 't');
  let clock = Date.parse('2026-11-21T15:00:00Z');
  const iso = () => new Date(clock).toISOString();
  const adv = (min: number) => { clock += min * 60_000; };
  const events: REvent[] = []; const alerts: RAlert[] = []; const checks: RCheck[] = [];
  const nm = (id: string) => people[id].name;
  const tn = (t: (string | null)[]) => t.filter(Boolean).map((x) => nm(x!)).join(' & ');
  const ev = (e: Omit<REvent, 'at'>) => events.push({ at: iso(), ...e });
  const alert = (user_id: string, title: string, body: string, kind: string) => alerts.push({ at: iso(), user_id, title, body, kind, push: `sent ${iso()}` });
  const check = (ok: boolean, desc: string, detail?: string, match_id?: string) => checks.push({ at: iso(), ok, desc, detail, match_id });

  ev({ kind: 'tournament_created', admin: true, actor: host, text: 'Tournament created (Brian)' });
  adv(1);
  for (const p of P) { ev({ kind: 'registered', user_id: p, data: { status: 'approved' }, text: `${nm(p)} joined (approved)` }); clock += 7000; }
  adv(3);
  ev({ kind: 'settings_changed', admin: true, actor: host, data: { courts: [null, ['1', '2']] }, text: 'Settings edited (Brian): courts null -> ["1","2"]' });
  adv(20);
  ev({ kind: 'tournament_status', admin: true, actor: host, data: { status: ['registration', 'active'] }, text: 'Tournament registration -> active (Brian)' });

  const rounds: ReplayData['rounds'] = [];
  const matches: RMatch[] = [];
  const addRound = (label: string, round_type: string, n: number, admin = false) => {
    const r = { id: uuid(rounds.length + 1, 'r'), label, round_type, round_number: n, created_at: iso() };
    rounds.push(r);
    ev({ kind: 'round_added', admin, actor: admin ? host : null, data: { round_id: r.id, label, round_type }, text: `${label} drawn${admin ? ' (Brian)' : ''}` });
    return r;
  };
  const addMatch = (round_id: string, order: number, t1: (string | null)[], t2: (string | null)[], play_round: number | null) => {
    const m: RMatch = { id: uuid(matches.length + 1, 'm'), round_id, match_order: order, match_type: 'doubles', play_round, is_dreambreaker: false, created_at: iso(), initial: { t1: [...t1], t2: [...t2] } };
    matches.push(m); return m;
  };
  const rA = addRound('Pool A', 'pool', 1), rB = addRound('Pool B', 'pool', 2);
  const rr = (pool: string[][]) => [[0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2]].map(([a, b, c, d]) => [[pool[a], pool[b]], [pool[c], pool[d]]]);
  const queue: { m: RMatch; t1: string[]; t2: string[]; plan?: [number, number] }[] = [];
  // Pool A: A1>A2, A2>A3, A3>A1 at 11-9; all three beat A4 11-5. Three-way tie on 2-1 and +6.
  const planA = new Map<string, [number, number]>([['0-1', [11, 9]], ['2-3', [11, 5]], ['0-2', [9, 11]], ['1-3', [11, 5]], ['0-3', [11, 5]], ['1-2', [11, 9]]]);
  const idx = (pool: string[][], t: string[]) => pool.indexOf(t);
  for (let pr = 0; pr < 3; pr++) {
    for (const [pool, r] of [[poolA, rA], [poolB, rB]] as const) {
      for (const [x, y] of rr(pool)[pr]) {
        const m = addMatch(r.id, matches.filter((q) => q.round_id === r.id).length, x, y, pr + 1);
        const key = `${idx(pool, x)}-${idx(pool, y)}`;
        queue.push({ m, t1: x, t2: y, plan: pool === poolA ? planA.get(key) : undefined });
      }
    }
  }
  for (const p of P) alert(p, 'Your first match', 'Pool play is drawn. Check the Courts tab.', 'tm_ready');

  const randScore = (): [number, number] => { const lose = Math.floor(rand() * 10); return rand() < 0.5 ? [11, lose] : [lose, 11]; };
  type Live = { q: typeof queue[number]; court: string; ends: number };
  const live: Live[] = [];
  const free = ['1', '2'];
  const pending = [...queue];
  let corrected = false;
  const call = () => {
    while (free.length && pending.length) {
      // Next match whose players are all free.
      const busy = new Set(live.flatMap((l) => [...l.q.t1, ...l.q.t2]));
      const i = pending.findIndex((q) => ![...q.t1, ...q.t2].some((p) => busy.has(p)));
      if (i < 0) break;
      const q = pending.splice(i, 1)[0];
      const court = free.shift()!;
      ev({ kind: 'match_called', match_id: q.m.id, data: { court: [null, court], called_at: [null, iso()] }, text: `Court ${court}: ${tn(q.t1)} v ${tn(q.t2)} called` });
      for (const p of [...q.t1, ...q.t2]) alert(p, `Court ${court} now`, `${tn(q.t1)} v ${tn(q.t2)}`, 'tm_court');
      live.push({ q, court, ends: clock + (12 + Math.floor(rand() * 8)) * 60_000 });
    }
  };
  const finish = (l: Live) => {
    clock = l.ends;
    const [s1, s2] = l.q.plan ?? randScore();
    const by = l.q.t1[1];
    ev({ kind: 'match_scored', match_id: l.q.m.id, actor: by,
      data: { score: [s1, s2], team1_score: [null, s1], team2_score: [null, s2], winner_team: [null, s1 > s2 ? 'team1' : 'team2'], status: ['pending', 'completed'] },
      text: `${rounds.find((r) => r.id === l.q.m.round_id)!.label} #${l.q.m.match_order + 1}: ${tn(l.q.t1)} ${s1}-${s2} ${tn(l.q.t2)}, entered by ${nm(by)}` });
    for (const p of [...l.q.t1, ...l.q.t2]) if (p !== by) alert(p, (l.q.t1.includes(p) ? s1 > s2 : s2 > s1) ? `You won ${Math.max(s1, s2)}-${Math.min(s1, s2)}` : `You lost ${Math.min(s1, s2)}-${Math.max(s1, s2)}`, `Entered by ${nm(by)}.`, 'tm_score');
    check(true, `score ${s1}-${s2} stored and both teams' W-L moved by one`, undefined, l.q.m.id);
    live.splice(live.indexOf(l), 1); free.push(l.court); free.sort();
    if (!corrected && l.q.m.round_id === rB.id && l.q.m.play_round === 2) {
      corrected = true; clock += 90_000;
      const fixed = s1 > s2 ? [11, Math.max(0, s2 - 2)] : [Math.max(0, s1 - 2), 11];
      ev({ kind: 'score_edited', admin: true, actor: host, match_id: l.q.m.id, data: { score: fixed, team1_score: [s1, fixed[0]], team2_score: [s2, fixed[1]] },
        text: `Score corrected (Brian): Pool B #${l.q.m.match_order + 1} is now ${fixed[0]}-${fixed[1]}` });
      for (const p of [...l.q.t1, ...l.q.t2]) alert(p, `Score fixed: ${fixed[0]}-${fixed[1]}`, 'Corrected by Brian.', 'tm_fix');
      check(true, 'a corrected score re-sorts the pool and alerts all 4 players');
    }
  };
  call();
  while (live.length) { finish(live.sort((a, b) => a.ends - b.ends)[0]); clock += 20_000; call(); }

  adv(1);
  for (const p of P) alert(p, 'Pool play is done', 'The host draws the playoff next.', 'tm_rr_done');
  alert(host, 'Draw the playoff', 'Pool A has a tie on W-L and point diff. Set the tie order first.', 'tm_draw_due');
  check(true, 'Pool A: three teams level on 2-1 and +6, shown as a tie waiting for the admin');
  check(false, 'the playoff button stays locked while Pool A is tied', 'Create playoff was enabled 40 s before the tie order (demo of a FAIL)');
  adv(4);
  const key = (t: string[]) => [...t].sort().join(':');
  ev({ kind: 'tie_order', admin: true, actor: host, data: { order: [key(poolA[2]), key(poolA[0]), key(poolA[1])] },
    text: `Tie order set by Brian: ${tn(poolA[2])} > ${tn(poolA[0])} > ${tn(poolA[1])}` });
  check(true, 'tie order puts A3 first, A1 second: they advance, A2 is out');
  adv(2);
  // Pool B order from its scores.
  const bRows = poolB.map((t) => ({ t, w: 0, d: 0 }));
  const finalScores = new Map<string, [number, number]>();
  for (const e of events) if ((e.kind === 'match_scored' || e.kind === 'score_edited') && e.match_id) finalScores.set(e.match_id, e.data!.score as [number, number]);
  for (const q of queue) if (q.m.round_id === rB.id) {
    const [s1, s2] = finalScores.get(q.m.id)!;
    const a = bRows.find((r) => r.t === q.t1)!, b = bRows.find((r) => r.t === q.t2)!;
    a.d += s1 - s2; b.d += s2 - s1; if (s1 > s2) a.w++; else b.w++;
  }
  bRows.sort((a, b) => b.w - a.w || b.d - a.d);
  const sf = addRound('Semifinals', 'semifinals', 3, true);
  const s1 = addMatch(sf.id, 0, poolA[2], bRows[1].t, null), s2 = addMatch(sf.id, 1, bRows[0].t, poolA[0], null);
  const fr = addRound('Final', 'finals', 4, true), tp = addRound('Third Place Match', 'third_place_match', 5, true);
  const fm = addMatch(fr.id, 0, [null, null], [null, null], null), tm = addMatch(tp.id, 0, [null, null], [null, null], null);
  for (const p of P) alert(p, poolA[2].includes(p) || poolA[0].includes(p) || bRows[0].t.includes(p) || bRows[1].t.includes(p) ? "You're in the Semifinals" : 'The playoff is drawn', 'Semis: A1 v B2, B1 v A2.', 'tm_playoff');
  check(true, 'semis pair Pool A #1 v Pool B #2 and Pool B #1 v Pool A #2');
  const play = (m: RMatch, t1: string[], t2: string[], court: string): [string[], string[]] => {
    adv(1);
    ev({ kind: 'match_called', match_id: m.id, data: { court: [null, court], called_at: [null, iso()] }, text: `Court ${court}: ${tn(t1)} v ${tn(t2)} called` });
    adv(16 + Math.floor(rand() * 6));
    const sc = randScore();
    ev({ kind: 'match_scored', match_id: m.id, actor: t1[0],
      data: { score: sc, team1_score: [null, sc[0]], team2_score: [null, sc[1]], winner_team: [null, sc[0] > sc[1] ? 'team1' : 'team2'], status: ['pending', 'completed'] },
      text: `${rounds.find((r) => r.id === m.round_id)!.label}: ${tn(t1)} ${sc[0]}-${sc[1]} ${tn(t2)}, entered by ${nm(t1[0])}` });
    for (const p of [...t1, ...t2]) if (p !== t1[0]) alert(p, 'Score in', `${sc[0]}-${sc[1]}`, 'tm_score');
    check(true, 'playoff score advances the winner', undefined, m.id);
    return sc[0] > sc[1] ? [t1, t2] : [t2, t1];
  };
  const [w1, l1] = play(s1, poolA[2], bRows[1].t, '1');
  const [w2, l2] = play(s2, bRows[0].t, poolA[0], '2');
  const fill = (m: RMatch, t1: string[], t2: string[]) => ev({ kind: 'slots_filled', match_id: m.id,
    data: { team1_player1: [null, t1[0]], team1_player2: [null, t1[1]], team2_player1: [null, t2[0]], team2_player2: [null, t2[1]] },
    text: `${rounds.find((r) => r.id === m.round_id)!.label}: ${tn(t1)} v ${tn(t2)}` });
  fill(fm, w1, w2); fill(tm, l1, l2);
  check(true, 'final and third place match fill in from the semis');
  const [champ, second] = play(fm, w1, w2, '1');
  const [third, fourth] = play(tm, l1, l2, '2');
  adv(1);
  ev({ kind: 'tournament_status', data: { status: ['active', 'completed'] }, text: 'Tournament active -> completed' });
  const order = [champ, second, third, fourth];
  const ranks = order.flatMap((t, i) => t.map((p) => ({ user_id: p, rank: i + 1, wins: 0, losses: 0 })));
  ev({ kind: 'final_ranks', data: { ranks }, text: `Final ranks: 1. ${tn(champ)}, 2. ${tn(second)}, 3. ${tn(third)}` });
  for (const [i, t] of order.slice(0, 3).entries()) for (const p of t) {
    ev({ kind: 'payout', user_id: p, data: { place: i + 1, paid: [500, 300, 200][i] }, text: `${nm(p)}: place ${i + 1}, paid ${[500, 300, 200][i]} pickles` });
    alert(p, `You placed ${i + 1}`, `+${[500, 300, 200][i]} pickles from the prize pool.`, 'tm_done');
  }
  check(true, 'payouts 500 / 300 / 200 per player match the prize pool split');

  return {
    version: 1, built_at: new Date(0).toISOString(),
    tournament: { id: tid, name: 'Demo: doubles pool play (made-up data)', format: 'pool_play', match_type: 'doubles', status: 'completed', pool_count: 2,
      playoff_format: 'top_2_per_pool', playoff_third_place: true, courts: ['1', '2'], prize_pool: 2000, pickle_ante: 250, created_by: host },
    people, teams: {}, rounds, matches, events, alerts, checks,
    notes: ['Made-up demo data (no database): it shows what a replay looks like before the first live run.'],
  };
}
