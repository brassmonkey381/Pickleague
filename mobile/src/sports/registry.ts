// The one import site for sport behaviour (./CLAUDE.md): screens and data
// modules read getSport(...), never a sport folder directly.
import type { SportConfig, SportId } from './types';
import { pickleball } from './pickleball';

export const SPORTS: Record<SportId, SportConfig> = { pickleball };

export const SPORT_IDS = Object.keys(SPORTS) as SportId[];

/** Every league, court and session is pickleball until the sport dimension lands. */
export const DEFAULT_SPORT: SportId = 'pickleball';

export function getSport(id: SportId = DEFAULT_SPORT): SportConfig {
  return SPORTS[id] ?? SPORTS[DEFAULT_SPORT];
}
