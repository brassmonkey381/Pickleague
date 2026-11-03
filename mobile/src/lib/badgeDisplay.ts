// Season "periods" are shown as "rounds" (Brian, 2026-11-03). The badges
// table keeps its names ('Period Champion', 'Period Sweeper') because SQL
// looks badges up by name, so the rename is display-only: every place that
// shows a badge's name, its description or an award's stored context passes
// it through here. Matching on badge names keeps the stored names.

const RENAMED: ReadonlyMap<string, string> = new Map([
  ['Period Champion', 'Round Champion'],
  ['Period Sweeper', 'Round Sweeper'],
]);

/** The name a player sees: 'Period Champion' reads 'Round Champion'. */
export function badgeDisplayName(name: string): string;
export function badgeDisplayName(name: string | null | undefined): string | null | undefined;
export function badgeDisplayName(name: string | null | undefined): string | null | undefined {
  return name == null ? name : RENAMED.get(name) ?? name;
}

/** An award's stored context: "Fall 2026 — Period 3" reads "Fall 2026 — Round 3". */
export function badgeDisplayContext(context: string | null | undefined): string | null {
  if (!context) return context ?? null;
  return context.replace(/\bPeriod (\d+)\b/g, 'Round $1').replace(/\bperiods?\b/g, (w) => (w === 'period' ? 'round' : 'rounds'));
}

/** A badge's description: only the two renamed badges' text changes. */
export function badgeDisplayDescription(name: string, description: string | null | undefined): string | null | undefined {
  if (!description || !RENAMED.has(name)) return description;
  return description.replace(/\bperiods?\b/gi, (w) => {
    const plural = w.toLowerCase() === 'periods';
    const word = plural ? 'rounds' : 'round';
    return w[0] === 'P' ? word[0].toUpperCase() + word.slice(1) : word;
  });
}
