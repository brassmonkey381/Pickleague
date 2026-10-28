// What starting a league or a tournament costs, and how many active ones an
// account may run. Mirrors _pl_create_cost / _pl_create_limit in
// supabase/migration_create_costs.sql (the server charges and enforces; these
// only word it before the tap).
export const LEAGUE_CREATE_COST = 5000;
export const TOURNAMENT_CREATE_COST = 2500;

/** "Starting a league costs 5,000 pickles." */
export function createCostLine(kind: 'league' | 'tournament'): string {
  const cost = kind === 'league' ? LEAGUE_CREATE_COST : TOURNAMENT_CREATE_COST;
  return `Starting a ${kind} costs ${cost.toLocaleString('en-US')} pickles. You can run one active ${kind} at a time.`;
}
