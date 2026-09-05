import { describe, it, expect } from 'vitest';
import { compareVersions } from '../versionCompare';

// Only compareVersions is unit-tested here. isUpdateRequired talks to Supabase,
// expo-constants and Platform, so it belongs to an integration pass — but every
// decision it makes rests on this function, and this is where the interesting
// mistakes live.

describe('compareVersions — ordering', () => {
  it('reports older, equal and newer', () => {
    expect(compareVersions('1.0.2', '1.0.3')).toBeLessThan(0);
    expect(compareVersions('1.0.3', '1.0.3')).toBe(0);
    expect(compareVersions('1.0.4', '1.0.3')).toBeGreaterThan(0);
  });

  it('compares segments numerically, not as strings', () => {
    // The whole reason this function exists instead of a < b: string comparison
    // puts "1.0.10" BEFORE "1.0.9", which would lock out the newer build.
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect('1.0.10' < '1.0.9').toBe(true); // the trap, documented
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
  });

  it('treats missing trailing segments as zero', () => {
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.1', '1.1.1')).toBeLessThan(0);
    expect(compareVersions('1.2', '1.1.9')).toBeGreaterThan(0);
  });
});

describe('compareVersions — fail open on garbage', () => {
  // Every one of these must read as "equal", because the caller blocks the user
  // only on a strictly-less-than result. Returning anything else here would
  // lock people out of a working app over a typo in a config row.
  it('returns 0 for unparseable input rather than guessing', () => {
    expect(compareVersions('1.0.x', '1.0.0')).toBe(0);
    expect(compareVersions('', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', 'latest')).toBe(0);
    expect(compareVersions('not-a-version', 'also-not')).toBe(0);
  });

  it('never reports a build as older than a malformed minimum', () => {
    for (const bad of ['', 'v1.0.0', '1.0.0-beta', 'null', '  ']) {
      expect(compareVersions('1.0.3', bad)).not.toBeLessThan(0);
    }
  });
});
