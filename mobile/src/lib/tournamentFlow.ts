/**
 * tournamentFlow — predicts the full expected stage structure of a tournament
 * at (or before) bracket lock-in, so the UI can render the whole flow up
 * front: every stage that will exist, with how many schedule rows (matches +
 * bye slots) each will hold, before the DB has created those rounds.
 *
 * The shapes mirror the server exactly:
 *  - generate_playoff_bracket: top_2/4/8 seed Finals/Semifinals/Quarterfinals
 *    (top_2 with ≥4 entrants ALSO creates the Third Place Match round up
 *    front); top_N_per_pool pads 6-entrant brackets to 8 with 2 byes.
 *  - _advance_non_mlp_playoff_bracket: creates the next stage as the prior
 *    completes; Third Place Match (playoff_third_place) sorts last.
 *  - _advance_single_elim_bracket: labels interior rounds "Round N" and the
 *    2-entrant round "Finals".
 *
 * Formats whose structure is NOT predictable up front return null:
 * double_elimination (losers-bracket shape depends on results), MLP (server
 * expands each meeting into sub-matches + dreambreakers), rotating_partners
 * (full schedule already exists at lock-in, nothing left to predict).
 */
import { assignPools } from './tournament';

export type FlowStage = {
  key: string;
  label: string;
  kind: 'group' | 'playoff';
  /** Expected schedule rows in this stage — real matches plus bye slots. */
  matchCount: number;
  /** How many of matchCount are bye slots (elim stages padded past entrants). */
  byes: number;
};

export type FlowConfig = {
  format: string;
  playoffFormat?: string | null;
  playoffThirdPlace?: boolean | null;
  poolCount?: number | null;
  /** Competitive units: players for singles, teams for doubles. */
  entrants: number;
};

const rr = (n: number) => (n * (n - 1)) / 2;

function stageLabelForBracketSize(size: number): string {
  if (size <= 2) return 'Finals';
  if (size === 4) return 'Semifinals';
  if (size === 8) return 'Quarterfinals';
  return `Round of ${size}`;
}

/** Chain of elimination stages from a (possibly non-power-of-2) entrant count. */
function eliminationChain(entrants: number, opts: {
  kind: FlowStage['kind'];
  keyPrefix: string;
  /** single-elim main draws label interior rounds "Round N" (DB trigger),
   *  playoff brackets label by size (Quarterfinals/Semifinals/Finals). */
  labelStyle: 'bracket-size' | 'round-number';
  firstLabel?: string;
}): FlowStage[] {
  let size = 2;
  while (size < entrants) size *= 2;
  const stages: FlowStage[] = [];
  let roundNum = 1;
  let remaining = entrants;
  while (size >= 2) {
    const rows = size / 2;
    const byes = Math.max(0, size - remaining);
    const label =
      roundNum === 1 && opts.firstLabel ? opts.firstLabel :
      opts.labelStyle === 'bracket-size' ? stageLabelForBracketSize(size) :
      rows === 1 ? 'Finals' : `Round ${roundNum}`;
    stages.push({ key: `${opts.keyPrefix}_${size}`, label, kind: opts.kind, matchCount: rows, byes });
    remaining = rows; // every slot (winner or bye recipient) advances
    size = rows;
    roundNum++;
  }
  return stages;
}

/** Playoff stages for round_robin / pool_play, mirroring generate_playoff_bracket. */
function playoffStages(cfg: FlowConfig): FlowStage[] | null {
  const pf = cfg.playoffFormat ?? 'none';
  if (pf === 'none') return [];

  if (pf === 'top_2') {
    const stages: FlowStage[] = [
      { key: 'po_finals', label: 'Finals', kind: 'playoff', matchCount: 1, byes: 0 },
    ];
    if (cfg.entrants >= 4) {
      stages.push({ key: 'po_third', label: 'Third Place Match', kind: 'playoff', matchCount: 1, byes: 0 });
    }
    return stages;
  }

  if (pf === 'top_4' || pf === 'top_8') {
    const q = pf === 'top_4' ? 4 : 8;
    if (cfg.entrants < q) return null; // server refuses to seed — don't predict
    const stages = eliminationChain(q, { kind: 'playoff', keyPrefix: 'po', labelStyle: 'bracket-size' });
    if (cfg.playoffThirdPlace) {
      stages.push({ key: 'po_third', label: 'Third Place Match', kind: 'playoff', matchCount: 1, byes: 0 });
    }
    return stages;
  }

  if (pf === 'top_1_per_pool' || pf === 'top_2_per_pool') {
    const perPool = pf === 'top_1_per_pool' ? 1 : 2;
    const pools = cfg.poolCount ?? 0;
    const q = perPool * pools;
    // Same allowlist as generate_playoff_bracket — anything else raises there.
    if (![2, 4, 6, 8].includes(q)) return null;
    return eliminationChain(q, { kind: 'playoff', keyPrefix: 'po', labelStyle: 'bracket-size' });
  }

  return null; // unknown playoff format — don't guess
}

/**
 * Full expected stage list for a tournament, in schedule order.
 * Returns null when the structure can't be predicted up front.
 */
export function predictFlow(cfg: FlowConfig): FlowStage[] | null {
  if (cfg.entrants < 2) return null;

  if (cfg.format === 'round_robin') {
    const po = playoffStages(cfg);
    if (po === null) return null;
    return [
      { key: 'rr', label: 'Round Robin Schedule', kind: 'group', matchCount: rr(cfg.entrants), byes: 0 },
      ...po,
    ];
  }

  if (cfg.format === 'pool_play') {
    const pools = cfg.poolCount ?? 0;
    if (pools < 1 || cfg.entrants < pools * 2) return null;
    const po = playoffStages(cfg);
    if (po === null) return null;
    // Reuse the real snake assignment so predicted pool sizes always match
    // what lock-in actually generates.
    const sizes = assignPools(
      Array.from({ length: cfg.entrants }, (_, i) => `e${i}`), pools,
    ).map(p => p.length);
    const poolStages: FlowStage[] = sizes.map((k, i) => ({
      key: `pool_${i}`,
      label: `Pool ${String.fromCharCode(65 + i)}`,
      kind: 'group',
      matchCount: rr(k),
      byes: 0,
    }));
    return [...poolStages, ...po];
  }

  if (cfg.format === 'single_elimination') {
    return eliminationChain(cfg.entrants, {
      kind: 'playoff',
      keyPrefix: 'se',
      labelStyle: 'round-number',
      firstLabel: 'Single Elim Schedule',
    });
  }

  // double_elimination / mlp / mlp_random / rotating_partners: structure is
  // result-dependent or already fully materialized at lock-in.
  return null;
}

/** Total expected schedule rows across all stages (null when unpredictable). */
export function predictTotalMatches(cfg: FlowConfig): number | null {
  const stages = predictFlow(cfg);
  if (!stages) return null;
  return stages.reduce((sum, s) => sum + s.matchCount, 0);
}
