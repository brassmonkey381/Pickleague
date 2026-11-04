// One availability, three kinds of time (the user, 2026-11-04: "merge into
// one, but it lives in its own Availability page. Users can edit the grid and
// choose which timeslots are for Drills, Play, or Either").
//
// Nothing new is stored: the two weekly grids profiles already has stay the
// source of truth, so everything that reads them keeps working.
//   profiles.availability        play time  (the "fits my schedule" filter,
//                                            league member overlap)
//   profiles.drill_availability  drill time (drill partner search)
// A cell in both is Either. Both are 336 half-hour cells, Monday first.
import { TOTAL_CELLS } from './availability';
import { toWeeklyTemplate } from './drillTime';

export const KIND = { off: 0, play: 1, drill: 2, either: 3 } as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

/** The paintable kinds, in the order the picker shows them. */
export const PAINT_KINDS = [
  { value: KIND.play, label: 'Play' },
  { value: KIND.drill, label: 'Drill' },
  { value: KIND.either, label: 'Either' },
] as const;

function cells(raw: unknown): boolean[] {
  return Array.isArray(raw) && raw.length === TOTAL_CELLS ? raw.map(Boolean) : Array(TOTAL_CELLS).fill(false);
}

/** The grid's values from the two stored grids. drill_availability may still
 *  be the old date-keyed shape, which toWeeklyTemplate folds into a week. */
export function toKinds(play: unknown, drill: unknown): number[] {
  const p = cells(play);
  const d = cells(Array.isArray(drill) ? drill : toWeeklyTemplate((drill ?? []) as never));
  return p.map((on, i) => (on && d[i] ? KIND.either : on ? KIND.play : d[i] ? KIND.drill : KIND.off));
}

/** The two stored grids from the grid's values. */
export function fromKinds(kinds: readonly number[]): { availability: boolean[]; drill_availability: boolean[] } {
  return {
    availability: kinds.map(k => k === KIND.play || k === KIND.either),
    drill_availability: kinds.map(k => k === KIND.drill || k === KIND.either),
  };
}

/** "6 h play, 2 h drill, 4 h either", or "Not set". Half-hour cells. */
export function kindsSummary(kinds: readonly number[]): string {
  const hours = (k: number) => kinds.filter(x => x === k).length / 2;
  const parts = [
    [hours(KIND.play), 'play'],
    [hours(KIND.drill), 'drill'],
    [hours(KIND.either), 'either'],
  ].filter(([h]) => (h as number) > 0).map(([h, l]) => `${h} h ${l}`);
  return parts.length ? parts.join(', ') : 'Not set';
}
