// Vendored from @just-messin-around/expo-foundation@1.37.0 (server kit). Edit upstream, then re-vendor.
// Numbered vote buttons: vote on 2 or 3 proposed times from the lock screen.
//
// A button set has to be registered on the phone BEFORE the push arrives, and
// the push that opens a vote is the first the phone hears of it, so the
// buttons cannot carry the real times. Instead every app registers two fixed
// sets and the push body lists the times, numbered by start time:
//
//   2 times  -> the pick2 set: [1st time] [2nd time] [Both work]
//   3 times  -> the pick3 set: [1st time] [2nd time] [3rd time]
//   4+ times -> no buttons; the tap opens the vote (buttons for only the first
//               times would push lock-screen votes toward them)
//
// One press approves one time ("Both work" approves both). The OS removes the
// notification on a press, so the confirmation notice offers the SAME numbered
// set again, with the times listed, until every time is picked. Taking a vote
// back stays in the app.
//
// PURE: this file imports nothing (no react-native, no expo), so a Deno
// function or a Node script can use the same helpers (the server-kit vendor
// script copies it next to the Deno files). The device half, which runs the
// write and posts the notice, is runOptionVoteAction in /platform/push.
//
// The app's catalog data file still spells out both sets (it must stay
// import-free); defineOptionVote checks the ids at compile time when given the
// catalog, and reports order / flag mistakes in `problems`.

/** The time zone used when a user's is unknown or invalid. */
export const DEFAULT_TIME_ZONE = 'America/Los_Angeles';

type ActionLike = { buttonTitle?: string; opensApp?: boolean; textInput?: unknown; link?: boolean };
type SpecLike = Record<string, { actions: Record<string, ActionLike> }>;

type Pick2Ids<P extends string> = `${P}1` | `${P}2` | `${P}all`;
type Pick3Ids<P extends string> = `${P}1` | `${P}2` | `${P}3`;

/** The catalog shape defineOptionVote requires: both categories, with exactly these action ids. */
export type OptionVoteSpec<P extends string, C2 extends string, C3 extends string> = {
  readonly [K in C2]: { readonly actions: { readonly [A in Pick2Ids<P>]: ActionLike } };
} & {
  readonly [K in C3]: { readonly actions: { readonly [A in Pick3Ids<P>]: ActionLike } };
};

export type OptionVoteConfig<P extends string, C2 extends string, C3 extends string> = {
  /** Action ids are `${actionPrefix}1`, `${actionPrefix}2`, `${actionPrefix}3` and
   *  `${actionPrefix}all` ("Both work"), shared by both sets. One prefix per write: an event
   *  vote and a drill-time pick are different writes, so they get different prefixes. */
  actionPrefix: P;
  /** Category id of the 2-time set, actions in this order: 1, 2, all. */
  pick2: C2;
  /** Category id of the 3-time set, actions in this order: 1, 2, 3. */
  pick3: C3;
};

/** 0-based option indexes, or 'all' ("Both work"). */
export type OptionVotePick = number[] | 'all';

export type OptionVoteKit<P extends string = string, C2 extends string = string, C3 extends string = string> = {
  readonly actionPrefix: P;
  readonly pick2: C2;
  readonly pick3: C3;
  readonly actionIds: { readonly first: `${P}1`; readonly second: `${P}2`; readonly third: `${P}3`; readonly all: `${P}all` };
  /** The set for a vote with `count` times: 2 -> pick2, 3 -> pick3, anything else -> null (no buttons). */
  categoryFor(count: number): C2 | C3 | null;
  /** True for one of this kit's action ids. */
  isVoteAction(actionId: string | null | undefined): boolean;
  /** A pressed action id -> the option(s) it approves, or null when it is not this kit's. */
  parse(actionId: string | null | undefined): OptionVotePick | null;
  /** A pick -> concrete 0-based indexes for a vote with `count` times ('all' expands; out of range drops). */
  indexes(pick: OptionVotePick, count: number): number[];
  /** Mistakes in the catalog passed to defineOptionVote, as readable lines; [] when clean or no catalog given. */
  readonly problems: string[];
};

function sameOrder(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((a, i) => a === expected[i]);
}

/**
 * defineOptionVote({ actionPrefix: 'vote_', pick2: 'app.vote2', pick3: 'app.vote3' }, CATALOG)
 * Pass the app's import-free CATALOG to have tsc check that both categories exist with
 * exactly these ids, and to get order / flag mistakes in `kit.problems`.
 */
export function defineOptionVote<const P extends string, const C2 extends string, const C3 extends string>(
  cfg: OptionVoteConfig<P, C2, C3>,
  spec?: OptionVoteSpec<NoInfer<P>, NoInfer<C2>, NoInfer<C3>>,
): OptionVoteKit<P, C2, C3> {
  const p = cfg.actionPrefix;
  const actionIds = { first: `${p}1`, second: `${p}2`, third: `${p}3`, all: `${p}all` } as const as OptionVoteKit<P, C2, C3>['actionIds'];
  const byId: Record<string, OptionVotePick> = {
    [actionIds.first]: [0],
    [actionIds.second]: [1],
    [actionIds.third]: [2],
    [actionIds.all]: 'all',
  };

  const problems: string[] = [];
  if (!p) problems.push('actionPrefix is empty');
  if ((cfg.pick2 as string) === (cfg.pick3 as string)) problems.push('pick2 and pick3 must be different categories');
  if (spec) {
    const s = spec as unknown as SpecLike;
    const expect: Array<[string, string[]]> = [
      [cfg.pick2, [actionIds.first, actionIds.second, actionIds.all]],
      [cfg.pick3, [actionIds.first, actionIds.second, actionIds.third]],
    ];
    for (const [categoryId, ids] of expect) {
      const def = s[categoryId];
      if (!def || !def.actions) {
        problems.push(`${categoryId}: missing from the catalog`);
        continue;
      }
      const actual = Object.keys(def.actions);
      if (!sameOrder(actual, ids)) {
        problems.push(`${categoryId}: actions must be exactly [${ids.join(', ')}] in that order, got [${actual.join(', ')}]`);
      }
      for (const [actionId, a] of Object.entries(def.actions)) {
        if (!(actionId in byId)) continue;
        if (a.opensApp) problems.push(`${categoryId}.${actionId}: a vote button writes in the background; drop opensApp`);
        if (a.link) problems.push(`${categoryId}.${actionId}: a vote button is not a link button`);
        if (a.textInput) problems.push(`${categoryId}.${actionId}: a vote button takes no text input`);
      }
    }
  }

  return {
    actionPrefix: cfg.actionPrefix,
    pick2: cfg.pick2,
    pick3: cfg.pick3,
    actionIds,
    categoryFor: (count) => (count === 2 ? cfg.pick2 : count === 3 ? cfg.pick3 : null),
    isVoteAction: (actionId) => !!actionId && actionId in byId,
    parse: (actionId) => {
      if (!actionId || !(actionId in byId)) return null;
      const pick = byId[actionId];
      return pick === 'all' ? 'all' : [...pick];
    },
    indexes: (pick, count) => {
      const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
      if (pick === 'all') return Array.from({ length: n }, (_, i) => i);
      return pick.filter((i) => Number.isInteger(i) && i >= 0 && i < n);
    },
    problems,
  };
}

// ── Times ────────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Wall = { y: number; mo: number; d: number; h: number; mi: number };
type PartsFormatter = { formatToParts(d: Date): Array<{ type: string; value: string }> };

const formatters = new Map<string, PartsFormatter | null>();

function formatterFor(timeZone: string): PartsFormatter | null {
  if (formatters.has(timeZone)) return formatters.get(timeZone) ?? null;
  let f: PartsFormatter | null = null;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    if (typeof (dtf as Partial<PartsFormatter>).formatToParts === 'function') f = dtf as unknown as PartsFormatter;
  } catch {
    f = null; // an unknown zone, or an engine without Intl time zones
  }
  if (formatters.size > 64) formatters.clear();
  formatters.set(timeZone, f);
  return f;
}

function wallClockIn(ms: number, timeZone: string): Wall | null {
  const f = formatterFor(timeZone);
  if (!f) return null;
  try {
    const parts: Record<string, string> = {};
    for (const part of f.formatToParts(new Date(ms))) parts[part.type] = part.value;
    let h = Number(parts.hour);
    const period = (parts.dayPeriod ?? '').toUpperCase();
    if (period === 'PM' && h < 12) h += 12; // an engine that ignored hourCycle
    if (period === 'AM' && h === 12) h = 0;
    if (h === 24) h = 0;
    const w = { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h, mi: Number(parts.minute) };
    return Object.values(w).every((v) => Number.isFinite(v)) ? w : null;
  } catch {
    return null;
  }
}

function toMs(start: string | number | Date): number {
  if (start instanceof Date) return start.getTime();
  if (typeof start === 'number') return start;
  // Postgres text output ("2026-10-18 16:00:00+00") is not ISO; some engines refuse it.
  const iso = String(start)
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2')
    .replace(/([+-]\d{2})$/, '$1:00');
  return Date.parse(iso);
}

/** A valid IANA time zone for this engine, else null. */
export function validTimeZone(timeZone: string | null | undefined): string | null {
  return typeof timeZone === 'string' && timeZone && formatterFor(timeZone) ? timeZone : null;
}

/** This device's IANA time zone (e.g. to store it for server-side push copy), or null. */
export function deviceTimeZone(): string | null {
  try {
    return validTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/**
 * "Sat Oct 18, 9 AM" / "Sat Oct 18, 9:30 AM" in `timeZone` (IANA). An unknown or missing zone
 * uses `fallbackTimeZone` (America/Los_Angeles), and an engine without Intl time zones uses
 * the device clock. Never throws; an unparseable time comes back as given.
 * The server kit's time_zone.template.sql formats the same way, so a body built in SQL and a
 * notice built here read the same.
 */
export function formatOptionLabel(
  start: string | number | Date,
  timeZone?: string | null,
  fallbackTimeZone: string = DEFAULT_TIME_ZONE,
): string {
  const ms = toMs(start);
  if (!Number.isFinite(ms)) return String(start);
  let w = (timeZone ? wallClockIn(ms, timeZone) : null) ?? wallClockIn(ms, fallbackTimeZone);
  if (!w) {
    const local = new Date(ms);
    w = { y: local.getFullYear(), mo: local.getMonth() + 1, d: local.getDate(), h: local.getHours(), mi: local.getMinutes() };
  }
  const weekday = WEEKDAYS[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()];
  const h12 = w.h % 12 === 0 ? 12 : w.h % 12;
  const minutes = w.mi ? `:${String(w.mi).padStart(2, '0')}` : '';
  return `${weekday} ${MONTHS[w.mo - 1]} ${w.d}, ${h12}${minutes} ${w.h < 12 ? 'AM' : 'PM'}`;
}

export type NumberedListOptions = {
  /** Between entries. Default '\n' (buttons only show on an expanded notification, which shows every line). */
  separator?: string;
  /** 0-based indexes to mark with " ✓" (e.g. the times just picked). */
  marks?: readonly number[];
};

/** ["Sat Oct 18, 9 AM", "Sun Oct 19, 10 AM"] -> "1) Sat Oct 18, 9 AM\n2) Sun Oct 19, 10 AM". */
export function formatNumberedList(labels: readonly string[], opts?: NumberedListOptions): string {
  const marks = new Set(opts?.marks ?? []);
  return labels.map((l, i) => `${i + 1}) ${l}${marks.has(i) ? ' ✓' : ''}`).join(opts?.separator ?? '\n');
}

/** Start times (in button order) -> the numbered list for a push body, in `timeZone`. */
export function formatOptionList(
  starts: ReadonlyArray<string | number | Date>,
  timeZone?: string | null,
  opts?: NumberedListOptions & { fallbackTimeZone?: string },
): string {
  return formatNumberedList(
    starts.map((s) => formatOptionLabel(s, timeZone, opts?.fallbackTimeZone)),
    opts,
  );
}

/** Options in button order: by start time, ties by id (SQL: `order by starts_at, id`). */
export function orderOptionsByStart<T extends { id: string; start: string | number | Date }>(options: readonly T[]): T[] {
  return [...options].sort((a, b) => {
    const d = toMs(a.start) - toMs(b.start);
    if (d) return Number.isFinite(d) ? d : 0;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ── Push data ────────────────────────────────────────────────────────────────
// Convention for what a vote push carries so a press can be matched to an option
// even if the vote's times change later: the option ids and the labels the body
// showed, in button order. The device half reads it back with readOptionVoteData.

export type OptionVoteData = { optionIds: string[]; optionLabels: string[] };

const MAX_OPTIONS = 10;
const MAX_LABEL = 80;

/** Server side: the push data for options already in button order. A missing label is formatted from `start`. */
export function optionVoteData(
  options: ReadonlyArray<{ id: string; label?: string; start?: string | number | Date }>,
  timeZone?: string | null,
): OptionVoteData {
  return {
    optionIds: options.map((o) => o.id),
    optionLabels: options.map((o) => o.label ?? (o.start != null ? formatOptionLabel(o.start, timeZone) : '')),
  };
}

/**
 * Device side: the option ids and labels a push carries (untrusted content: only strings,
 * at most 10, labels trimmed to 80 chars), or null when it carries none.
 * Labels come from `optionLabels`; without them, from `optionStarts` formatted in `timeZone`.
 */
export function readOptionVoteData(
  data: Record<string, unknown> | null | undefined,
  timeZone?: string | null,
): { ids: string[]; labels: string[]; count: number } | null {
  if (!data || typeof data !== 'object') return null;
  const strings = (v: unknown): string[] | null =>
    Array.isArray(v) && v.length > 0 && v.length <= MAX_OPTIONS && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  const ids = strings(data.optionIds) ?? [];
  let labels = strings(data.optionLabels);
  if (!labels) {
    const starts = strings(data.optionStarts);
    labels = starts ? starts.map((s) => formatOptionLabel(s, timeZone)) : [];
  }
  labels = labels.map((l) => (l.length > MAX_LABEL ? l.slice(0, MAX_LABEL - 1) + '…' : l));
  if (ids.length && labels.length && ids.length !== labels.length) labels = [];
  const count = ids.length || labels.length;
  return count ? { ids, labels, count } : null;
}

// ── The confirmation notice ──────────────────────────────────────────────────

/** Structurally the same as NoticeCopy in /platform/push (this file imports nothing). */
export type OptionVoteNoticeCopy = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  categoryId?: string;
};

export type OptionVoteNoticeArgs = {
  /** What was pressed. */
  pick: OptionVotePick;
  /** Every option's label, in button order. */
  labels: readonly string[];
  /** 'already' when the write found the vote already counted (a replay). Default 'voted'. */
  status?: 'voted' | 'already';
  /** Rides on the notice: the push's data, so a tap opens the vote and the re-offered buttons
   *  still find their options. `outboxId` is dropped (see noticeDataFor in /platform/push). */
  data?: Record<string, unknown>;
  /** "time" -> "1st time", "Voted for both times". */
  noun?: string;
  /** The line under the list when the buttons are offered again.
   *  Default "Free at another time too? Press and hold to add it." */
  hint?: string;
};

const ORDINALS = ['1st', '2nd', '3rd'];
const ordinal = (i: number) => ORDINALS[i] ?? `${i + 1}th`;

/**
 * The one notice after a vote press. Until every time is picked it offers the SAME numbered
 * set again, with the times listed and the picked ones marked, so the user can add another.
 */
export function optionVoteNotice(kit: OptionVoteKit, args: OptionVoteNoticeArgs): OptionVoteNoticeCopy {
  const noun = args.noun ?? 'time';
  const n = args.labels.length;
  const picked = kit.indexes(args.pick, n);
  const everything = n > 0 && (args.pick === 'all' || picked.length >= n);
  const already = args.status === 'already';
  const categoryId = !everything ? kit.categoryFor(n) : null;
  let data: Record<string, unknown> | undefined;
  if (args.data) {
    data = { ...args.data };
    delete data.outboxId;
  }

  let title: string;
  if (already) title = 'Already counted';
  else if (everything) title = n === 2 ? `Voted for both ${noun}s` : `Voted for all ${n} ${noun}s`;
  else if (picked.length === 1) title = `Voted: ${ordinal(picked[0])} ${noun}`;
  else title = 'Vote saved';

  let body: string;
  if (n === 0) body = 'Tap to see the vote.';
  else if (everything) {
    const names = args.labels.slice();
    body = (names.length === 2 ? names.join(' and ') : names.join(', ')) + '.';
  } else if (categoryId) {
    body = `${formatNumberedList(args.labels, { marks: picked })}\n${args.hint ?? `Free at another ${noun} too? Press and hold to add it.`}`;
  } else {
    body = picked.length ? picked.map((i) => args.labels[i]).join(', ') + '.' : 'Tap to see the vote.';
  }

  return { title, body, ...(data ? { data } : {}), ...(categoryId ? { categoryId } : {}) };
}
