// PKL-092: the tournament share cards Brian approved (mock rows 2-3, "I like them all"): four layouts, A Scorecard,
// B Bracket, C Poster and D Team photo, for two moments, after pool play and the finish. This file turns a
// tournament into the words and numbers those layouts show. It's pure, so vitest covers it; ShareCardArt draws it.
//
// The rules (PKL-085, PKL-090):
//   - Two stages, never mixed. Pool results are labelled pool play; the final place comes from the playoff (or, with
//     no playoff, from the table).
//   - No "tied" text anywhere. Shared places just repeat (two 3rds when there's no 3rd-place match).
//   - MLP speaks in teams and matchup scores (3-2, Dreambreaker 21-19); other formats in players and match scores.
//   - No middle dots in Pickleague copy: commas.
import { ordinal, type FinishPlayer } from './finishShare';

export type StoryStage = 'pool' | 'quarterfinals' | 'semifinals' | 'third_place_match' | 'finals';
export type StoryEntrant = { key: string; name: string; people: FinishPlayer[] };
/** One meeting. MLP: a matchup, scores are games won (3-1) and the Dreambreaker's points when it was played.
 *  Other formats: one match, scores are points (11-8). */
export type StoryMatchup = {
  stage: StoryStage;
  a: string;
  b: string;
  aScore: number | null;
  bScore: number | null;
  winner: 'a' | 'b' | null;
  dreambreaker?: [number, number] | null;
  /** Points for and against over the whole meeting (MLP: every game), for the ± stat. */
  aPoints?: number;
  bPoints?: number;
};
export type StoryInput = {
  title: string;
  dateLabel: string | null;
  isMlp: boolean;
  /** The sharer's entrant key (MLP: team id; doubles: "p1|p2" sorted; singles: the player id). */
  me: string;
  entrants: StoryEntrant[];
  /** "Pool A". null: one round robin. */
  poolLabel: string | null;
  /** My pool / round robin finish once pool play is over. */
  poolPlace: number | null;
  matchups: StoryMatchup[];
  hasPlayoff: boolean;
  completed: boolean;
  /** Stored final places (tournament_final_ranks), by entrant. */
  finalPlace: number | null;
  podium: { place: number; keys: string[] }[];
};

export type StoryRow = { lead: 'W' | 'L' | 'next'; text: string; score: string | null };
export type StoryPair = { a: { name: string; score: string | null }; b: { name: string; score: string | null }; winner: 'a' | 'b' | null; mine: boolean };
export type StoryColumn = { stage: string; pairs: StoryPair[] };
export type TournamentStory = {
  moment: 'pool' | 'finish';
  isMlp: boolean;
  title: string;
  dateLabel: string | null;
  me: StoryEntrant;
  /** A Scorecard */
  kicker: string;
  headline: string;
  stats: { value: string; label: string }[];
  rows: StoryRow[];
  note: string | null;
  /** B Bracket */
  bracketHeadline: string;
  bracketSub: string;
  columns: StoryColumn[];
  bracketFoot: string;
  /** C Poster */
  posterKicker: string;
  posterTop: string | null;
  posterBig: string;
  posterLine: string;
  /** D Team photo */
  banner: string;
  photoSub: string;
  photoRows: StoryRow[];
  podium: { place: number; names: string[] }[] | null;
  members: string;
  /** The share text. */
  message: string;
  champion: boolean;
};

const STAGE_NAME: Record<StoryStage, string> = {
  pool: 'Pool', quarterfinals: 'Quarterfinal', semifinals: 'Semifinal', third_place_match: '3rd place', finals: 'Final',
};
const STAGE_COLUMN: Record<StoryStage, string> = {
  pool: 'Pool play', quarterfinals: 'Quarterfinals', semifinals: 'Semifinals', third_place_match: '3rd place', finals: 'Final',
};
const ON_TO: Record<StoryStage, string> = {
  pool: 'the playoff', quarterfinals: 'the quarterfinals', semifinals: 'the semis', third_place_match: 'the 3rd-place match', finals: 'the Final',
};
const INTO: Record<StoryStage, string> = {
  pool: 'Into the playoff.', quarterfinals: 'Into the quarterfinals.', semifinals: 'Into the semis.', third_place_match: 'Into the 3rd-place match.', finals: 'Into the Final.',
};
const NEXT_SHORT: Record<StoryStage, string> = {
  pool: 'Playoff', quarterfinals: 'Quarterfinals', semifinals: 'Semis', third_place_match: '3rd-place match', finals: 'Final',
};
const ORDER: StoryStage[] = ['pool', 'quarterfinals', 'semifinals', 'third_place_match', 'finals'];

/** Which moment a tournament can share now: after pool play (pools done, playoff ahead) or the finish. */
export function storyMoment(i: Pick<StoryInput, 'hasPlayoff' | 'completed' | 'matchups'>): 'pool' | 'finish' | null {
  if (i.completed) return 'finish';
  if (!i.hasPlayoff) return null;
  const pool = i.matchups.filter((m) => m.stage === 'pool');
  return pool.length > 0 && pool.every((m) => m.winner != null) ? 'pool' : null;
}

export function buildTournamentStory(i: StoryInput): TournamentStory | null {
  const moment = storyMoment(i);
  if (!moment) return null;
  const byKey = new Map(i.entrants.map((e) => [e.key, e]));
  const me = byKey.get(i.me);
  if (!me) return null;
  const nameOf = (k: string) => byKey.get(k)?.name ?? 'a player';
  const mine = i.matchups.filter((m) => m.a === i.me || m.b === i.me);
  const view = (m: StoryMatchup) => {
    const isA = m.a === i.me;
    const my = isA ? m.aScore : m.bScore, their = isA ? m.bScore : m.aScore;
    const won = m.winner == null ? null : (m.winner === 'a') === isA;
    const db = m.dreambreaker ? (isA ? m.dreambreaker : [m.dreambreaker[1], m.dreambreaker[0]] as [number, number]) : null;
    return { m, opp: nameOf(isA ? m.b : m.a), won, score: my != null && their != null ? `${my}-${their}` : null, db,
      pf: (isA ? m.aPoints : m.bPoints) ?? 0, pa: (isA ? m.bPoints : m.aPoints) ?? 0 };
  };
  const played = mine.map(view).filter((v) => v.won != null);
  const poolPlayed = played.filter((v) => v.m.stage === 'pool');
  const playoffPlayed = played.filter((v) => v.m.stage !== 'pool');
  const tally = (vs: typeof played) => ({ w: vs.filter((v) => v.won).length, l: vs.filter((v) => !v.won).length,
    pf: vs.reduce((n, v) => n + v.pf, 0), pa: vs.reduce((n, v) => n + v.pa, 0),
    gw: vs.reduce((n, v) => n + (v.score ? Number(v.score.split('-')[0]) : 0), 0),
    gl: vs.reduce((n, v) => n + (v.score ? Number(v.score.split('-')[1]) : 0), 0) });
  const pool = tally(poolPlayed);
  const all = tally(played);
  const poolName = i.poolLabel ?? 'Round robin';
  const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;

  // my next (or furthest) playoff meeting
  const myPlayoff = mine.filter((m) => m.stage !== 'pool').sort((x, y) => ORDER.indexOf(x.stage) - ORDER.indexOf(y.stage));
  const pendingNext = myPlayoff.find((m) => m.winner == null) ?? null;
  const qualified = myPlayoff.length > 0;
  const nextStage: StoryStage | null = pendingNext?.stage ?? null;

  const stats = (t: ReturnType<typeof tally>) => i.isMlp
    ? [{ value: `${t.w}-${t.l}`, label: 'Matchups' }, { value: `${t.gw}-${t.gl}`, label: 'Games' }, { value: signed(t.pf - t.pa), label: 'Points' }]
    : [{ value: `${t.w}-${t.l}`, label: 'Record' }, { value: signed(t.pf - t.pa), label: 'Points' }];
  const row = (v: ReturnType<typeof view>, withStage: boolean): StoryRow => ({
    lead: v.won ? 'W' : 'L', text: withStage ? `${STAGE_NAME[v.m.stage]}, ${v.opp}` : v.opp, score: v.score,
  });
  const members = me.people.map((p) => p.name.split(' ')[0]).join(', ');
  const placeWord = i.poolPlace === 1 ? 'won' : i.poolPlace != null ? ordinal(i.poolPlace) : 'done';
  const POOL = poolName.toUpperCase();
  const columns = bracketColumns(i, nameOf, moment);

  if (moment === 'pool') {
    const into = qualified && nextStage ? INTO[nextStage] : qualified ? INTO.pool : 'Pool play done.';
    const nextRow: StoryRow[] = qualified
      ? [{ lead: 'next', text: `Next: ${nextStage ? STAGE_NAME[nextStage] : 'Playoff'}${pendingNext ? ` v ${nameOf(pendingNext.a === i.me ? pendingNext.b : pendingNext.a)}` : ''}`, score: null }]
      : [];
    const undefeated = pool.l === 0 && pool.w > 0;
    const onTo = qualified ? `On to ${ON_TO[nextStage ?? 'pool']}.` : 'Pool play done.';
    const gamesTo = i.isMlp ? `${pool.gw} games to ${pool.gl}` : `${signed(pool.pf - pool.pa)} points`;
    return {
      moment, isMlp: i.isMlp, title: i.title, dateLabel: i.dateLabel, me,
      kicker: `${i.title}, ${poolName}`,
      headline: into,
      stats: stats(pool),
      rows: [...poolPlayed.map((v) => row(v, false)), ...nextRow],
      note: null,
      bracketHeadline: `${poolName}, ${placeWord}. ${qualified ? `${NEXT_SHORT[nextStage ?? 'pool']} next.` : 'Pool play done.'}`,
      bracketSub: me.name,
      columns,
      bracketFoot: `${pool.w}-${pool.l} in pool play, ${gamesTo}`,
      posterKicker: `${poolName}, ${i.title}`,
      posterTop: null,
      posterBig: `${pool.w}-${pool.l}`,
      posterLine: qualified && undefeated ? `Undefeated. ${onTo}` : onTo,
      banner: i.poolPlace === 1 ? `${POOL} WINNERS` : i.poolPlace != null ? `${POOL}, ${ordinal(i.poolPlace).toUpperCase()}` : 'POOL PLAY DONE',
      photoSub: `${i.title}, ${pool.w}-${pool.l} in pool play${qualified ? `, ${(nextStage ? STAGE_NAME[nextStage] : 'playoff').toLowerCase()} next` : ''}`,
      photoRows: poolPlayed.map((v) => row(v, false)),
      podium: null,
      members,
      message: `${me.name}: ${pool.w}-${pool.l} in pool play at ${i.title}${qualified ? `, on to ${ON_TO[nextStage ?? 'pool']}` : ''} on Pickleague 🥒`,
      champion: false,
    };
  }

  // ── the finish ──
  const place = i.finalPlace;
  const champion = place === 1;
  const final = playoffPlayed.find((v) => v.m.stage === 'finals') ?? null;
  const last = playoffPlayed[playoffPlayed.length - 1] ?? null;
  const dbNote = (v: ReturnType<typeof view> | null) => (v?.db ? `Dreambreaker ${v.db[0]}-${v.db[1]}` : null);
  const placeText = place != null ? `${ordinal(place)} place` : 'Finished';
  const howLine = (): string => {
    // "over Ben Q." already ends its sentence: no second period
    if (champion && final) return `over ${final.opp}${final.opp.endsWith('.') ? '' : '.'}${final.db ? ` Won the Dreambreaker ${final.db[0]}-${final.db[1]}.` : ''}`;
    if (!last) {
      const where = i.poolPlace ? `${poolName} ${ordinal(i.poolPlace)}` : poolName;
      return i.hasPlayoff ? `${where}, ${pool.w}-${pool.l}. Didn't reach the playoff.` : `${all.w}-${all.l} in ${poolName.toLowerCase()}.`;
    }
    if (last.m.stage === 'finals') return last.score ? `Lost the Final ${last.score}.` : 'Lost the Final.';
    if (last.m.stage === 'third_place_match') return last.won ? 'Won the 3rd-place match.' : 'Lost the 3rd-place match.';
    return `Out in the ${STAGE_COLUMN[last.m.stage].toLowerCase()}.`;
  };
  const podium = i.podium.filter((p) => p.place <= 3).sort((a, b) => a.place - b.place)
    .map((p) => ({ place: p.place, names: p.keys.map(nameOf) }));
  const finalLine = final ? [`Final${final.score ? ` ${final.score}` : ''}`, dbNote(final)].filter(Boolean).join(', ') : null;
  return {
    moment, isMlp: i.isMlp, title: i.title, dateLabel: i.dateLabel, me,
    kicker: `${i.title}, ${champion ? 'Champions' : placeText}`,
    headline: champion ? `${all.w}-${all.l}. Title won.` : `${placeText.charAt(0).toUpperCase()}${placeText.slice(1)}.`,
    stats: stats(all),
    rows: played.slice(-6).map((v) => row(v, true)),
    note: final?.db ? `Final decided in the Dreambreaker, ${final.db[0]}-${final.db[1]}` : null,
    bracketHeadline: champion ? 'Champions.' : `${placeText.charAt(0).toUpperCase()}${placeText.slice(1)}.`,
    bracketSub: `${me.name}, through the bracket`,
    columns,
    bracketFoot: finalLine ?? `${all.w}-${all.l}`,
    posterKicker: champion ? `${i.title}, Final` : i.title,
    posterTop: champion ? 'CHAMPS' : null,
    posterBig: champion && final?.score ? final.score : place != null ? ordinal(place) : `${all.w}-${all.l}`,
    posterLine: howLine(),
    banner: champion ? 'CHAMPIONS' : place != null ? `${ordinal(place).toUpperCase()} PLACE` : 'FINISHED',
    photoSub: [i.title, `${all.w}-${all.l}`, champion && final ? `Final ${final.score} over ${final.opp}` : null].filter(Boolean).join(', '),
    photoRows: played.slice(-4).map((v) => row(v, true)),
    podium: podium.length ? podium : null,
    members,
    message: champion
      ? `${me.name} won ${i.title} on Pickleague 🥒`
      : `${me.name}: ${placeText} at ${i.title} on Pickleague 🥒`,
    champion,
  };
}

/** The playoff as columns of pairs, the sharer's pair marked. After pool play a stage still to come shows "?". */
function bracketColumns(i: StoryInput, nameOf: (k: string) => string, moment: 'pool' | 'finish'): StoryColumn[] {
  const stages: StoryStage[] = ['quarterfinals', 'semifinals', 'finals'];
  const out: StoryColumn[] = [];
  for (const st of stages) {
    const ms = i.matchups.filter((m) => m.stage === st);
    if (!ms.length) {
      // the Final not drawn yet, after pool play: a placeholder after the drawn semifinals
      if (moment === 'pool' && st === 'finals' && out.length) out.push({ stage: STAGE_COLUMN.finals, pairs: [{ a: { name: '?', score: null }, b: { name: '?', score: null }, winner: null, mine: false }] });
      continue;
    }
    out.push({
      stage: STAGE_COLUMN[st],
      pairs: ms.map((m) => ({
        a: { name: nameOf(m.a), score: m.aScore != null && m.winner ? String(m.aScore) : null },
        b: { name: nameOf(m.b), score: m.bScore != null && m.winner ? String(m.bScore) : null },
        winner: m.winner,
        mine: m.a === i.me || m.b === i.me,
      })),
    });
  }
  return out;
}

// ── From the tournament's rows (TournamentDetailScreen, the lab) ────────
export type StoryRoundIn = { id: string; round_type: string; round_number: number; label?: string | null };
export type StoryMatchIn = {
  id: string; round_id?: string | null; status: string; winner_team: 'team1' | 'team2' | null;
  team1_player1: string | null; team1_player2: string | null; team2_player1: string | null; team2_player2: string | null;
  team1_score?: number | null; team2_score?: number | null; is_dreambreaker?: boolean | null; match_order?: number | null;
};
export type StoryTeamIn = { id: string; name: string; male_1_id: string | null; male_2_id: string | null; female_1_id: string | null; female_2_id: string | null };

const STAGE_OF: Record<string, StoryStage> = {
  winners: 'pool', pool: 'pool', quarterfinals: 'quarterfinals', semifinals: 'semifinals',
  third_place_match: 'third_place_match', finals: 'finals', grand_final: 'finals',
};

/** Builds StoryInput from saved rounds and matches. `player` masks a player's name (lib/finishShare cardPlayer). */
export function storyInputFrom(d: {
  title: string; dateLabel: string | null; format: string; hasPlayoff: boolean; completed: boolean;
  myUserId: string; rounds: readonly StoryRoundIn[]; matches: readonly StoryMatchIn[];
  mlpTeams?: readonly StoryTeamIn[] | null; player: (id: string) => FinishPlayer;
  /** My table and place in it (standingsData myStanding), once pool play is over. */
  poolLabel: string | null; poolPlace: number | null;
  finalRanks: readonly { user_id: string; final_rank: number }[];
}): StoryInput {
  const isMlp = d.format === 'mlp' || d.format === 'mlp_random';
  const members = (t: StoryTeamIn) => [t.male_1_id, t.male_2_id, t.female_1_id, t.female_2_id].filter(Boolean) as string[];
  const teamOfUser = new Map<string, StoryTeamIn>();
  for (const t of d.mlpTeams ?? []) for (const u of members(t)) teamOfUser.set(u, t);
  const sideKey = (p1: string | null, p2: string | null): string | null => {
    if (!p1) return null;
    if (isMlp) return teamOfUser.get(p1)?.id ?? null;
    return p2 ? [p1, p2].sort().join('|') : p1;
  };
  const entrants = new Map<string, StoryEntrant>();
  const addEntrant = (key: string, ids: string[]) => {
    if (entrants.has(key)) return;
    if (isMlp) {
      const t = (d.mlpTeams ?? []).find((x) => x.id === key);
      entrants.set(key, { key, name: t?.name ?? 'a team', people: t ? members(t).map(d.player) : [] });
    } else {
      const people = ids.map(d.player);
      entrants.set(key, { key, name: people.map((p) => p.name).join(' & '), people });
    }
  };
  const roundOf = new Map(d.rounds.map((r) => [r.id, r]));
  const real = d.matches.filter((m) => !!m.team1_player1 && !!m.team2_player1 && m.status !== 'cancelled');
  const matchups: StoryMatchup[] = [];
  const groups = new Map<string, StoryMatchIn[]>();
  for (const m of real) {
    const r = m.round_id ? roundOf.get(m.round_id) : undefined;
    if (!r || !STAGE_OF[r.round_type]) continue;
    const g = isMlp ? r.id : m.id;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(m);
  }
  for (const ms of groups.values()) {
    const r = roundOf.get(ms[0].round_id!)!;
    const first = ms.find((m) => !m.is_dreambreaker) ?? ms[0];
    const a = sideKey(first.team1_player1, first.team1_player2), b = sideKey(first.team2_player1, first.team2_player2);
    if (!a || !b) continue;
    addEntrant(a, [first.team1_player1, first.team1_player2].filter(Boolean) as string[]);
    addEntrant(b, [first.team2_player1, first.team2_player2].filter(Boolean) as string[]);
    // a game's sides, from a's point of view (MLP games keep the same team on side 1 within a round, but check)
    const aIsT1 = (m: StoryMatchIn) => sideKey(m.team1_player1, m.team1_player2) === a;
    let aw = 0, bw = 0, ap = 0, bp = 0; let db: [number, number] | null = null;
    for (const m of ms) {
      if (m.status !== 'completed' || !m.winner_team) continue;
      const t1 = aIsT1(m);
      const s1 = m.team1_score ?? 0, s2 = m.team2_score ?? 0;
      ap += t1 ? s1 : s2; bp += t1 ? s2 : s1;
      const aWon = (m.winner_team === 'team1') === t1;
      if (aWon) aw++; else bw++;
      if (m.is_dreambreaker) db = t1 ? [s1, s2] : [s2, s1];
    }
    const open = ms.some((m) => m.status === 'pending');
    const winner: 'a' | 'b' | null = isMlp
      ? (aw >= 3 ? 'a' : bw >= 3 ? 'b' : !open && aw !== bw ? (aw > bw ? 'a' : 'b') : null)
      : (ms[0].status === 'completed' && ms[0].winner_team ? (aw > bw ? 'a' : 'b') : null);
    matchups.push({
      stage: STAGE_OF[r.round_type], a, b, winner,
      aScore: winner ? (isMlp ? aw : ap) : null, bScore: winner ? (isMlp ? bw : bp) : null,
      dreambreaker: db, aPoints: ap, bPoints: bp,
    });
  }
  const me = isMlp ? teamOfUser.get(d.myUserId)?.id ?? null
    : (() => { for (const m of real) for (const [p1, p2] of [[m.team1_player1, m.team1_player2], [m.team2_player1, m.team2_player2]] as [string | null, string | null][]) {
      if (p1 === d.myUserId || p2 === d.myUserId) return sideKey(p1, p2); } return null; })();
  // places: the whole entrant shares its place
  const rankOfKey = new Map<string, number>();
  for (const r of d.finalRanks) {
    const k = isMlp ? teamOfUser.get(r.user_id)?.id : [...entrants.keys()].find((x) => x.split('|').includes(r.user_id));
    if (k && !rankOfKey.has(k)) rankOfKey.set(k, r.final_rank);
  }
  const podium = new Map<number, string[]>();
  for (const [k, p] of rankOfKey) { if (!podium.has(p)) podium.set(p, []); podium.get(p)!.push(k); }
  return {
    title: d.title, dateLabel: d.dateLabel, isMlp, me: me ?? '', entrants: [...entrants.values()],
    poolLabel: d.poolLabel, poolPlace: d.poolPlace, matchups, hasPlayoff: d.hasPlayoff, completed: d.completed,
    finalPlace: me ? rankOfKey.get(me) ?? null : null,
    podium: [...podium.entries()].map(([place, keys]) => ({ place, keys })),
  };
}
