/**
 * PKL-054: rebuild one tournament's timeline from its own rows, for the replay page (replay.html).
 *
 * Sources, each with its own timestamp:
 *   tournaments.created_at, tournament_registrations.registered_at, tournament_rounds.created_at,
 *   tournament_matches.created_at / called_at / completed_at, notifications.created_at (+ push_outbox),
 *   tournament_final_ranks.computed_at, tournament_placement_grants.granted_at,
 *   and tournament_events (migration_tournament_events.sql): who did what, corrections, court moves,
 *   status and settings changes, bracket slots, the admin's tie order.
 * Without tournament_events (anything played before PKL-054) the timeline is built from the timestamps alone,
 * and the page says what is missing.
 *
 * QA runs add their checks: [{ at, ok, desc, detail?, known?, match_id? }]. A check with a match_id is pinned to
 * the moment that match was scored; otherwise to `at`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type Slots = { t1: (string | null)[]; t2: (string | null)[] };
export type RMatch = {
  id: string; round_id: string; match_order: number; match_type: string; play_round: number | null;
  is_dreambreaker: boolean; created_at: string;
  /** What it looked like when it appeared. */
  initial: Slots;
};
export type REvent = {
  at: string;
  kind: string;
  /** One line for the feed. */
  text: string;
  /** An admin's hand on the tournament (shown purple). */
  admin?: boolean;
  actor?: string | null;
  match_id?: string | null;
  user_id?: string | null;
  data?: Record<string, unknown>;
  /** true = rebuilt from a timestamp, not from the event log. */
  derived?: boolean;
};
export type RAlert = { at: string; user_id: string; title: string; body: string; kind: string | null; push: string | null };
export type RCheck = { at: string; ok: boolean; desc: string; detail?: string; known?: string; match_id?: string | null };
export type ReplayData = {
  version: 1;
  built_at: string;
  tournament: Record<string, any>;
  people: Record<string, { name: string; seed: number | null; role: string | null; bot?: boolean }>;
  /** MLP: player -> team. */
  teams: Record<string, { id: string; name: string }>;
  rounds: { id: string; label: string | null; round_type: string; round_number: number; created_at: string }[];
  matches: RMatch[];
  events: REvent[];
  alerts: RAlert[];
  checks: RCheck[];
  notes: string[];
};

const fmtScore = (a: unknown, b: unknown) => `${a ?? '?'}-${b ?? '?'}`;

async function all<T>(q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string, notes: string[]): Promise<T[]> {
  const { data, error } = await q;
  if (error) { notes.push(`${what}: ${error.message}`); return []; }
  return data ?? [];
}

export async function collectReplay(sb: SupabaseClient, tid: string, checks: RCheck[] = []): Promise<ReplayData> {
  const notes: string[] = [];
  const { data: t, error: te } = await sb.from('tournaments').select('*').eq('id', tid).maybeSingle();
  if (te || !t) throw new Error(`tournament ${tid}: ${te?.message ?? 'not found'}`);

  const regs = await all<any>(sb.from('tournament_registrations').select('user_id, status, seed, role, registered_at').eq('tournament_id', tid), 'registrations', notes);
  const rounds = await all<any>(sb.from('tournament_rounds').select('id, label, round_type, round_number, created_at').eq('tournament_id', tid), 'rounds', notes);
  const matches = await all<any>(sb.from('tournament_matches').select('*').eq('tournament_id', tid).order('match_order'), 'matches', notes);
  const log = await all<any>(sb.from('tournament_events').select('*').eq('tournament_id', tid).order('at').order('id'), 'event log', notes);
  const ties = await all<any>(sb.from('tournament_tie_orders').select('*').eq('tournament_id', tid), 'tie orders', notes);
  const ranks = await all<any>(sb.from('tournament_final_ranks').select('*').eq('tournament_id', tid), 'final ranks', notes);
  const grants = await all<any>(sb.from('tournament_placement_grants').select('*').eq('tournament_id', tid), 'payouts', notes);
  const mlp = await all<any>(sb.from('mlp_teams').select('*').eq('tournament_id', tid), 'mlp teams', notes);
  const notifs = await all<any>(sb.from('notifications').select('id, user_id, title, body, type, created_at, push_data').eq('entity_id', tid).order('created_at'), 'alerts', notes);
  const outbox: any[] = [];
  for (let i = 0; i < notifs.length; i += 200) {
    outbox.push(...await all<any>(sb.from('push_outbox').select('notification_id, status, sent_at, error').in('notification_id', notifs.slice(i, i + 200).map((n) => n.id)), 'pushes', notes));
  }
  if (!log.length) notes.push('No event log for this tournament (played before PKL-054): who entered each score, corrections, court moves, settings edits and the bracket filling in are not known; scores, calls and alerts come from their timestamps.');

  // People.
  const ids = new Set<string>([t.created_by]);
  for (const r of regs) ids.add(r.user_id);
  for (const m of matches) for (const k of ['team1_player1', 'team1_player2', 'team2_player1', 'team2_player2']) if (m[k]) ids.add(m[k]);
  for (const e of log) { if (e.actor) ids.add(e.actor); if (e.user_id) ids.add(e.user_id); }
  for (const n of notifs) ids.add(n.user_id);
  const profs: any[] = [];
  const idList = [...ids].filter(Boolean);
  for (let i = 0; i < idList.length; i += 200) profs.push(...await all<any>(sb.from('profiles').select('id, full_name, username').in('id', idList.slice(i, i + 200)), 'profiles', notes));
  const people: ReplayData['people'] = {};
  for (const p of profs) people[p.id] = { name: (p.full_name || p.username || 'Player').trim(), seed: null, role: null };
  for (const r of regs) people[r.user_id] = { ...(people[r.user_id] ?? { name: 'Player' }), seed: r.seed, role: r.role };
  const nm = (id: string | null | undefined) => (id ? people[id]?.name ?? 'someone' : 'the server');
  const admins = new Set<string>([t.created_by, ...regs.filter((r) => r.role === 'admin' || r.role === 'co-admin').map((r) => r.user_id)]);

  const teams: ReplayData['teams'] = {};
  for (const tm of mlp) for (const k of ['male_1_id', 'male_2_id', 'female_1_id', 'female_2_id']) if (tm[k]) teams[tm[k]] = { id: tm.id, name: tm.name };

  const side = (m: any, n: 1 | 2) => [m[`team${n}_player1`], m[`team${n}_player2`]].filter(Boolean);
  const sideName = (ids: (string | null)[]) => ids.filter(Boolean).map((i) => nm(i)).join(' & ') || 'TBD';
  const roundOf = new Map(rounds.map((r) => [r.id, r]));
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const mLabel = (m: any) => { const r = roundOf.get(m.round_id); return `${r?.label ?? 'Match'} #${(m.match_order ?? 0) + 1}`; };

  const events: REvent[] = [];
  const logged = (kind: string, pred: (e: any) => boolean = () => true) => log.some((e) => e.kind === kind && pred(e));

  // ── from the event log ──
  const tieGroups = new Map<string, any[]>();
  for (const e of log) {
    const m = e.match_id ? matchById.get(e.match_id) : null;
    const d = e.data ?? {};
    const by = e.actor ? ` (${nm(e.actor)})` : '';
    const isAdminActor = !!e.actor && admins.has(e.actor);
    const base = { at: e.at, kind: e.kind, actor: e.actor, match_id: e.match_id, user_id: e.user_id, data: d };
    switch (e.kind) {
      case 'tie_rank_set': {
        const k = `${e.at}|${e.actor ?? ''}`;
        if (!tieGroups.has(k)) tieGroups.set(k, []);
        tieGroups.get(k)!.push(e);
        break;
      }
      case 'match_scored':
        events.push({ ...base, text: `${m ? mLabel(m) : 'Match'}: ${m ? sideName(side(m, 1)) : ''} ${fmtScore(d.score?.[0], d.score?.[1])} ${m ? sideName(side(m, 2)) : ''}${e.actor ? `, entered by ${nm(e.actor)}` : ''}` });
        break;
      case 'score_edited':
        events.push({ ...base, admin: true, text: `Score corrected${by}: ${m ? mLabel(m) : 'match'} is now ${fmtScore(d.score?.[0], d.score?.[1])}` });
        break;
      case 'match_cancelled': events.push({ ...base, admin: true, text: `${m ? mLabel(m) : 'Match'} cancelled${by}` }); break;
      case 'match_reopened': events.push({ ...base, admin: true, text: `${m ? mLabel(m) : 'Match'} reopened${by}` }); break;
      case 'match_status': events.push({ ...base, text: `${m ? mLabel(m) : 'Match'}: ${d.status?.[0]} -> ${d.status?.[1]}` }); break;
      case 'match_called':
        events.push({ ...base, text: `Court ${d.court?.[1] ?? '?'}: ${m ? `${sideName(side(m, 1))} v ${sideName(side(m, 2))}` : 'match'} called` });
        break;
      case 'court_changed': events.push({ ...base, admin: isAdminActor, text: `${m ? mLabel(m) : 'Match'} moved${d.court ? ` to court ${d.court[1] ?? 'none'}` : ''}${by}` }); break;
      case 'slots_filled': {
        const filled = Object.entries(d).filter(([, v]: any) => v?.[1]).map(([, v]: any) => nm(v[1]));
        events.push({ ...base, text: `${m ? mLabel(m) : 'Bracket'}: ${filled.join(' & ') || 'a slot'} moves in` });
        break;
      }
      case 'round_added':
        events.push({ ...base, admin: isAdminActor && !['winners', 'pool'].includes(String(d.round_type)), text: `${d.label ?? d.round_type} drawn${by}` });
        break;
      case 'tournament_created': events.push({ ...base, admin: true, text: `Tournament created${by}` }); break;
      case 'tournament_status': events.push({ ...base, admin: isAdminActor, text: `Tournament ${d.status?.[0]} -> ${d.status?.[1]}${by}` }); break;
      case 'settings_changed':
        events.push({ ...base, admin: true, text: `Settings edited${by}: ${Object.entries(d).map(([k, v]: any) => `${k} ${JSON.stringify(v[0])} -> ${JSON.stringify(v[1])}`).join(', ')}` });
        break;
      case 'registered': events.push({ ...base, text: `${nm(e.user_id)} joined (${d.status}${d.role && d.role !== 'member' ? ', ' + d.role : ''})` }); break;
      case 'registration_changed':
        events.push({ ...base, admin: isAdminActor || !e.actor, text: `${nm(e.user_id)}: ${Object.entries(d).map(([k, v]: any) => `${k} ${v[0]} -> ${v[1]}`).join(', ')}${by}` });
        break;
      default: events.push({ ...base, text: `${e.kind}${by}` });
    }
  }
  for (const [, rows] of tieGroups) {
    rows.sort((a, b) => a.data.tie_rank - b.data.tie_rank);
    const order = rows.map((r) => String(r.data.entrant_key));
    const names = order.map((k) => [...new Set(k.split(':'))].map((i) => nm(i)).join(' & '));
    events.push({ at: rows[0].at, kind: 'tie_order', admin: true, actor: rows[0].actor, data: { order },
      text: `Tie order set by ${nm(rows[0].actor)}: ${names.join(' > ')}` });
  }

  // ── rebuilt from timestamps where the log has nothing ──
  if (!logged('tournament_created')) events.push({ at: t.created_at, kind: 'tournament_created', admin: true, actor: t.created_by, derived: true, text: `Tournament created (${nm(t.created_by)})` });
  for (const r of regs) if (r.registered_at && !logged('registered', (e) => e.user_id === r.user_id))
    events.push({ at: r.registered_at, kind: 'registered', user_id: r.user_id, derived: true, data: { status: r.status, role: r.role }, text: `${nm(r.user_id)} joined` });
  for (const r of rounds) if (!logged('round_added', (e) => e.data?.round_id === r.id))
    events.push({ at: r.created_at, kind: 'round_added', derived: true, data: { round_id: r.id, label: r.label, round_type: r.round_type }, text: `${r.label ?? r.round_type} drawn` });
  for (const m of matches) {
    if (m.called_at && !logged('match_called', (e) => e.match_id === m.id))
      events.push({ at: m.called_at, kind: 'match_called', match_id: m.id, derived: true, data: { court: [null, m.court], called_at: [null, m.called_at] },
        text: `Court ${m.court ?? '?'}: ${sideName(side(m, 1))} v ${sideName(side(m, 2))} called` });
    if (m.status === 'completed' && m.completed_at && !logged('match_scored', (e) => e.match_id === m.id))
      events.push({ at: m.completed_at, kind: 'match_scored', match_id: m.id, derived: true,
        data: { score: [m.team1_score, m.team2_score], team1_score: [null, m.team1_score], team2_score: [null, m.team2_score],
          winner_team: [null, m.winner_team], status: ['pending', 'completed'], game_scores: [null, m.game_scores] },
        text: `${mLabel(m)}: ${sideName(side(m, 1))} ${fmtScore(m.team1_score, m.team2_score)} ${sideName(side(m, 2))}` });
  }
  if (!logged('tournament_status') && t.status === 'completed') {
    const last = matches.map((m) => m.completed_at).filter(Boolean).sort().pop();
    if (last) events.push({ at: last, kind: 'tournament_status', derived: true, data: { status: ['active', 'completed'] }, text: 'Tournament completed' });
  }
  if (ranks.length) {
    const at = ranks.map((r) => r.computed_at).sort().pop();
    events.push({ at, kind: 'final_ranks', derived: true, data: { ranks: ranks.map((r) => ({ user_id: r.user_id, rank: r.final_rank, wins: r.wins, losses: r.losses })) },
      text: `Final ranks: ${[...ranks].sort((a, b) => a.final_rank - b.final_rank).slice(0, 4).map((r) => `${r.final_rank}. ${nm(r.user_id)}`).join(', ')}` });
  }
  for (const g of grants) events.push({ at: g.granted_at, kind: 'payout', user_id: g.user_id, derived: true, data: { place: g.place, paid: g.paid },
    text: `${nm(g.user_id)}: place ${g.place}, paid ${g.paid} pickles` });
  // Tie orders set before the log existed.
  if (ties.length && !events.some((e) => e.kind === 'tie_order')) {
    const order = [...ties].sort((a, b) => a.tie_rank - b.tie_rank).map((x) => String(x.entrant_key));
    events.push({ at: ties.map((x) => x.set_at).sort().pop(), kind: 'tie_order', admin: true, actor: ties[0].set_by, derived: true, data: { order },
      text: `Tie order set by ${nm(ties[0].set_by)}` });
  }

  // Initial slots: the "before" of the first slot change, else the final lineup.
  const rMatches: RMatch[] = matches.map((m) => {
    const init: Slots = { t1: [m.team1_player1, m.team1_player2], t2: [m.team2_player1, m.team2_player2] };
    const first = new Map<string, any>();
    for (const e of log) if (e.match_id === m.id && e.kind === 'slots_filled') for (const [k, v] of Object.entries<any>(e.data ?? {})) if (!first.has(k)) first.set(k, v[0]);
    for (const [k, v] of first) { const mm = k.match(/^team([12])_player([12])$/); if (mm) (mm[1] === '1' ? init.t1 : init.t2)[Number(mm[2]) - 1] = v; }
    return { id: m.id, round_id: m.round_id, match_order: m.match_order, match_type: m.match_type, play_round: m.play_round,
      is_dreambreaker: !!m.is_dreambreaker, created_at: m.created_at, initial: init };
  });

  const pushOf = new Map(outbox.map((o) => [o.notification_id, o.status === 'sent' ? `sent ${o.sent_at ?? ''}`.trim() : `${o.status}${o.error ? ': ' + o.error : ''}`]));
  const alerts: RAlert[] = notifs.map((n) => ({ at: n.created_at, user_id: n.user_id, title: n.title, body: n.body,
    kind: n.push_data?.kind ?? n.type ?? null, push: pushOf.get(n.id) ?? null }));

  // Checks pinned to their match's score when they name one.
  const scoredAt = new Map<string, string>();
  for (const e of events) if (e.kind === 'match_scored' && e.match_id && !scoredAt.has(e.match_id)) scoredAt.set(e.match_id, e.at);
  const pinned = checks.map((c) => ({ ...c, at: (c.match_id && scoredAt.get(c.match_id)) || c.at }));

  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const tKeep = ['id', 'name', 'format', 'match_type', 'status', 'seeding', 'pool_count', 'partner_rotation', 'registration_mode',
    'playoff_format', 'playoff_third_place', 'mlp_play_format', 'mlp_pool_count', 'mlp_playoff_teams', 'team_creation', 'courts',
    'prize_pool', 'pickle_ante', 'start_time', 'created_at', 'location_name', 'created_by'];
  return {
    version: 1,
    built_at: new Date().toISOString(),
    tournament: Object.fromEntries(tKeep.map((k) => [k, t[k]])),
    people, teams,
    rounds: rounds.map((r) => ({ id: r.id, label: r.label, round_type: r.round_type, round_number: r.round_number, created_at: r.created_at })),
    matches: rMatches,
    events, alerts, checks: pinned, notes,
  };
}
