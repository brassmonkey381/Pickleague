// Vendored from @just-messin-around/expo-foundation@1.111.0 (server kit). Edit upstream, then re-vendor.
// Types for sourceWatch.mjs (1.111): `@just-messin-around/expo-foundation/sourceWatch`.

export declare const SOURCE_FETCH_TIMEOUT_MS: number;
export declare const SOURCE_GAP_MS: number;
export declare const SOURCE_MIN_TEXT: number;

export declare function normalizePageText(html: string): string;
export declare function pageHash(text: string): Promise<string>;
export declare function robotsAllows(robotsTxt: string, path: string, userAgent: string): boolean;

export type CheckPageResult = { status: string; hash: string | null };

export type CheckPageOptions = {
  /** Sent on every request, e.g. 'PickleagueScheduleCheck/1.0 (+https://pickleague.club)'. */
  userAgent: string;
  /** The name robots.txt groups match, e.g. 'PickleagueScheduleCheck'. Default `userAgent`. */
  token?: string;
  timeoutMs?: number;
  gapMs?: number;
  minText?: number;
  /** For tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export declare function checkPage(url: string, opts: CheckPageOptions): Promise<CheckPageResult>;
export declare function checkPages<S extends { url: string }>(
  sources: readonly S[],
  opts: CheckPageOptions,
  onResult: (source: S, result: CheckPageResult) => Promise<void> | void,
): Promise<void>;
