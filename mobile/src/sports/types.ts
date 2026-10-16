// Sport vertical types (see ./CLAUDE.md and docs/basketball-vertical.md).
//
// Minimal for now: only the fields something reads today. Scoring, formats,
// match types, rating params and copy join this config with the multi-sport
// work, as the plan lays out.

export type SportId = 'pickleball';

export type SportConfig = {
  id: SportId;
  /** "Pickleball". */
  label: string;
  /** venues.sport values the court picker searches (pickleball is often played on tennis courts). */
  venueSports: string[];
  /** The venues.sport value a court check-in, play session or court lookup must match (resolve_court's p_sport). */
  courtSport: string;
};
