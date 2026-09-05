// Pure version-string comparison, deliberately kept in its own module with ZERO
// imports so it stays unit-testable. Its caller (lib/minVersion) reaches
// Supabase, expo-constants and react-native, and pulling that graph into a
// vitest run fails to transform — the same reason every other tested helper in
// lib/ is dependency-free.

/**
 * Compare two dotted numeric version strings.
 * Returns <0 when `a` is older, 0 when equal, >0 when `a` is newer.
 *
 * Segment-wise numeric comparison, NOT lexicographic: "1.0.10" is newer than
 * "1.0.9", which plain string comparison gets backwards. Missing segments count
 * as 0, so "1.1" and "1.1.0" are equal.
 *
 * Anything unparseable returns 0 — equal, therefore never "older", therefore
 * never a reason to lock someone out. See the fail-open note in lib/minVersion.
 */
/**
 * One segment's numeric value, or NaN if it is not a plain non-negative integer.
 *
 * The distinction that matters: a segment PAST the end of the string is a
 * legitimate implied zero ("1.1" === "1.1.0"), but a segment that is present and
 * empty is malformed. Number('') is 0, not NaN — so without this split, ''
 * compares as version zero and reads as "older than everything", which is
 * precisely the input that would lock every user out. A test caught it.
 */
function segment(parts: string[], i: number): number {
  if (i >= parts.length) return 0;
  const raw = parts[i].trim();
  if (raw === '') return NaN;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = segment(pa, i);
    const y = segment(pb, i);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
