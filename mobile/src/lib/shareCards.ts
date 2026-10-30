// The Instagram share cards (PKL-013): the options every card offers and what
// each card says, apart from the React code so vitest covers them. Doggle's
// walk studio is the model (walkShareConfig): five looks, layouts by photo
// count, a banner over photos, two logo styles, SHOW toggles, up to 4 photos.
//
// One studio (components/share/PickleShareStudio) draws five kinds of card
// from a ShareCardModel: a season or tournament finish, a match result, a play
// session, an event, and a tournament bracket (my path through it). A builder
// here turns each screen's facts into that model.
//
// Privacy (lib/finishShare): other players are "First L." with initials, never
// photos; blocked and deleted players are "a player". A card that shows other
// players' scores (a match, a bracket) carries SCORE_DISCLAIMER above Share.
import {
  placeHeadline,
  recordLabel,
  type FinishPlayer,
  type FinishShareData,
} from './finishShare';

export const MAX_SHARE_PHOTOS = 4;

// ── Looks ───────────────────────────────────────────────────────────────
export type ShareLookId = 'court' | 'night' | 'ball' | 'clay' | 'cream';
/** The texture behind the photo-less layouts. */
export type SharePattern = 'lines' | 'balls' | 'net';
export type ShareLookDef = {
  label: string;
  ground: string;
  ink: string;
  muted: string;
  accent: string;
  /** Chips and panels behind text. */
  chip: string;
  pattern: SharePattern;
  /** The pattern's strokes. */
  patternInk: string;
};
export const SHARE_LOOK_IDS: ShareLookId[] = ['court', 'night', 'ball', 'clay', 'cream'];
export const SHARE_LOOKS: Record<ShareLookId, ShareLookDef> = {
  court: { label: 'Court', ground: '#1f6f4a', ink: '#ffffff', muted: 'rgba(255,255,255,0.75)', accent: '#c6f36b', chip: 'rgba(255,255,255,0.16)', pattern: 'lines', patternInk: 'rgba(255,255,255,0.14)' },
  night: { label: 'Night', ground: '#14213d', ink: '#ffffff', muted: 'rgba(255,255,255,0.72)', accent: '#ffd166', chip: 'rgba(255,255,255,0.14)', pattern: 'net', patternInk: 'rgba(255,255,255,0.08)' },
  ball: { label: 'Ball', ground: '#e4f04a', ink: '#1d2b22', muted: 'rgba(29,43,34,0.7)', accent: '#1f6f4a', chip: 'rgba(29,43,34,0.09)', pattern: 'balls', patternInk: 'rgba(29,43,34,0.10)' },
  // #b4472f, not a brighter clay: white small text needs the 5:1 step.
  clay: { label: 'Clay', ground: '#b4472f', ink: '#ffffff', muted: 'rgba(255,255,255,0.82)', accent: '#ffe8a3', chip: 'rgba(255,255,255,0.16)', pattern: 'lines', patternInk: 'rgba(255,255,255,0.16)' },
  cream: { label: 'Cream', ground: '#f6f1e3', ink: '#1d2b22', muted: 'rgba(29,43,34,0.68)', accent: '#2e8b57', chip: 'rgba(29,43,34,0.08)', pattern: 'balls', patternInk: 'rgba(29,43,34,0.07)' },
};

// ── Layouts, by how many photos there are ───────────────────────────────
export type ShareTemplateId =
  | 'grind'
  | 'poster'
  | 'big'
  | 'scorecard'
  | 'photo-full'
  | 'photo-panel'
  | 'polaroid'
  | 'strip'
  | 'grid'
  | 'duo';
export const SHARE_TEMPLATE_LABEL: Record<ShareTemplateId, string> = {
  grind: 'Put in the work',
  poster: 'Poster',
  big: 'Big number',
  scorecard: 'Scorecard',
  'photo-full': 'Full photo',
  'photo-panel': 'Photo + stats',
  polaroid: 'Polaroid',
  strip: 'Big + strip',
  grid: 'Grid',
  duo: 'Two + stats',
};
/** A drill leads with its own photo-less layout: the hours, the weeks, the work. */
export function shareTemplatesFor(n: number, kind?: ShareKind): ShareTemplateId[] {
  if (n <= 0) return kind === 'drill' ? ['grind', 'poster', 'big', 'scorecard'] : ['poster', 'big', 'scorecard'];
  if (n === 1) return ['photo-full', 'photo-panel', 'polaroid'];
  return ['strip', 'grid', 'duo', 'polaroid', 'photo-full'];
}

// ── Banner: what's behind the text where it sits over a photo ────────────
export type ShareBannerId = 'brand' | 'light' | 'see' | 'dark' | 'solid';
export const SHARE_BANNERS: { id: ShareBannerId; label: string }[] = [
  { id: 'brand', label: 'Brand' },
  { id: 'light', label: 'Light' },
  { id: 'see', label: 'See-through' },
  { id: 'dark', label: 'Dark' },
  { id: 'solid', label: 'Solid' },
];
/** Layouts with a banner, and the one each starts with. */
export const SHARE_BANNER_DEFAULT: Partial<Record<ShareTemplateId, ShareBannerId>> = {
  'photo-full': 'see',
  strip: 'see',
  grid: 'brand',
};
export const SHARE_BANNER_FALLBACK: ShareBannerId = 'brand';
/** The banner's fill and the ink on it. 'brand' is the look's own ground. */
export function bannerColors(id: string, look: ShareLookDef): { bg: string; ink: string; muted: string; accent: string } {
  switch (id) {
    case 'light':
      return { bg: 'rgba(255,255,255,0.86)', ink: '#1d2b22', muted: 'rgba(29,43,34,0.7)', accent: '#1f6f4a' };
    case 'see':
      // 0.42: at 0.32 white text washed out over a bright court photo.
      return { bg: 'rgba(0,0,0,0.42)', ink: '#ffffff', muted: 'rgba(255,255,255,0.8)', accent: '#c6f36b' };
    case 'dark':
      return { bg: 'rgba(0,0,0,0.62)', ink: '#ffffff', muted: 'rgba(255,255,255,0.78)', accent: '#c6f36b' };
    case 'solid':
      return { bg: '#000000', ink: '#ffffff', muted: 'rgba(255,255,255,0.75)', accent: '#c6f36b' };
    default:
      return { bg: look.ground, ink: look.ink, muted: look.muted, accent: look.accent };
  }
}

export type ShareLogoId = 'full' | 'small';
export const SHARE_LOGOS: { id: ShareLogoId; label: string }[] = [
  { id: 'full', label: 'Pickle + name' },
  { id: 'small', label: 'Pickle only' },
];

// ── Copy ────────────────────────────────────────────────────────────────
/** Above Share on a card that shows other players' scores (Brian, 2026-10-29). */
export const SCORE_DISCLAIMER =
  'Always ask your teammates and opponents if they are OK with you posting their scores to social media.';
export const SHARE_ERROR = 'Could not share right now. Please try again.';
export const SHARE_TEXT_ONLY = 'Shared a link. Image sharing works in the app.';

/** The toast after an image share. */
export function shareToastText(p: { invite: boolean; aspect: 'post' | 'story'; reward: string }): string {
  const what = p.invite ? 'Your invite link is copied' : 'The Pickleague link is copied';
  const earn = p.invite ? ` Friends who join from it get you both ${p.reward} pickles.` : '';
  return p.aspect === 'story'
    ? `${what}. In your Story, add a Link sticker and paste it.${earn}`
    : `${what}. Posts can’t have tappable links, so paste it in your bio or a Story.${earn}`;
}

// ── The card model ──────────────────────────────────────────────────────
export type ShareKind = 'finish' | 'match' | 'session' | 'drill' | 'event' | 'bracket';

/** A row's lead mark: a medal for a podium place, W / L for a result. */
export type ShareRowLead = { medal: number } | { won: boolean | null } | null;
export type ShareRowItem = { lead: ShareRowLead; people?: FinishPlayer[]; text?: string; trailing?: string };
export type ShareRows = { id: string; label: string; heading?: string; items: ShareRowItem[] };
export type ShareStat = { id: string; label: string; value: string };
/** A SHOW toggle that puts a quote on the card (my drill notes). */
export type ShareQuote = { id: string; label: string; text: string };
/** A SHOW toggle that puts a small bar chart on the card (minutes drilled per week, oldest first). */
export type ShareBars = { id: string; label: string; heading: string; values: number[]; caption: string | null };

export type ShareCardModel = {
  kind: ShareKind;
  /** The small caps line by the logo: "SEASON FINISH", "MATCH RESULT". */
  eyebrow: string;
  title: string;
  /** Above the title: the league, the court. */
  over: string | null;
  /** The big line, and the line under it. `medal`: a podium medal beside it. */
  hero: { big: string; small: string | null; medal: number | null };
  /** SHOW toggles, each a chip on the card. */
  stats: ShareStat[];
  /** SHOW toggles, each a list on the card (the podium, the players, my path). */
  rows: ShareRows[];
  /** SHOW toggle: a quote (null: none). */
  quote?: ShareQuote | null;
  /** SHOW toggle: a bar chart (null: none). */
  bars?: ShareBars | null;
  /** The SHOW toggles that start off. */
  offByDefault: string[];
  /** The look a card opens on. */
  defaultLook: ShareLookId;
  /** Other players' scores are on it: SCORE_DISCLAIMER shows above Share. */
  showsScores: boolean;
  /** The share text before the link. */
  message: string;
};

/** The SHOW toggles a card offers (only ones with something behind them). */
export function shareDetailOptions(m: ShareCardModel): { id: string; label: string }[] {
  return [
    ...m.stats.map((s) => ({ id: s.id, label: s.label })),
    ...m.rows.filter((r) => r.items.length > 0).map((r) => ({ id: r.id, label: r.label })),
    ...(m.bars && m.bars.values.some((v) => v > 0) ? [{ id: m.bars.id, label: m.bars.label }] : []),
    ...(m.quote && m.quote.text.trim() ? [{ id: m.quote.id, label: m.quote.label }] : []),
  ];
}

/**
 * The studio's identity for a card: the toggles it offers. The studio reads its
 * SHOW defaults once, so a card offering other toggles needs a fresh studio
 * (else a toggle that wasn't offered before reads as off and its chip hides).
 */
export function shareStudioKey(m: ShareCardModel): string {
  return `${m.kind}|${shareDetailOptions(m).map((o) => o.id).join(',')}`;
}

/** Every toggle's starting value. */
export function shareDefaultDetails(m: ShareCardModel): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const o of shareDetailOptions(m)) out[o.id] = !m.offByDefault.includes(o.id);
  return out;
}

/** "Pat D. & Sam L."; none: "a player". */
export function joinPeople(people: readonly FinishPlayer[]): string {
  const names = people.map((p) => p.name);
  if (names.length === 0) return 'a player';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** "+0.12", "-0.08"; null stays null. */
export function pluprDeltaLabel(d: number | null | undefined): string | null {
  if (d == null || !Number.isFinite(d)) return null;
  const r = Math.round(d * 100) / 100;
  return `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}`;
}

// ── Finish (season or tournament) ───────────────────────────────────────
export function finishCardModel(d: FinishShareData): ShareCardModel {
  const record = recordLabel(d.wins, d.losses);
  const where = d.kind === 'season' && d.league ? `${d.league} (${d.title})` : d.title;
  const what = d.rank === 1 ? `I won ${where}` : `I finished ${placeHeadline(d.rank, d.of).replace(' place', '')} in ${where}`;
  return {
    kind: 'finish',
    eyebrow: d.kind === 'season' ? 'SEASON FINISH' : 'TOURNAMENT FINISH',
    title: d.title,
    over: d.kind === 'season' ? d.league : null,
    hero: {
      big: placeHeadline(d.rank, d.of),
      small: d.rank === 1 ? `${d.me} took 1st` : d.of ? `${d.me} · of ${d.of}` : d.me,
      medal: d.rank <= 3 ? d.rank : null,
    },
    stats: record ? [{ id: 'record', label: 'Record', value: `Record ${record}` }] : [],
    rows: d.podium.length
      ? [{
          id: 'podium',
          label: 'Podium',
          heading: 'Podium',
          items: d.podium.map((p) => ({ lead: { medal: p.rank }, people: p.players.slice(0, 2) })),
        }]
      : [],
    offByDefault: ['podium'],
    defaultLook: d.rank === 1 ? 'night' : 'court',
    showsScores: false,
    message: `${what} on Pickleague 🥒`,
  };
}

// ── Match result ────────────────────────────────────────────────────────
export type MatchShareData = {
  doubles: boolean;
  won: boolean;
  myScore: number;
  oppScore: number;
  /** "First L." */
  me: string;
  partner: FinishPlayer | null;
  opponents: FinishPlayer[];
  pluprDelta: number | null;
  court: string | null;
  /** "Oct 27". */
  date: string;
  /** The league or tournament it counted in. */
  scope: string | null;
};

export function matchCardModel(d: MatchShareData): ShareCardModel {
  const delta = pluprDeltaLabel(d.pluprDelta);
  const score = `${d.myScore}–${d.oppScore}`;
  const stats: ShareStat[] = [];
  if (delta) stats.push({ id: 'plupr', label: 'PLUPR', value: `PLUPR ${delta}` });
  stats.push({ id: 'date', label: 'Date', value: d.date });
  if (d.court) stats.push({ id: 'court', label: 'Court', value: d.court });
  const myTeam: FinishPlayer[] = [{ name: d.me, initials: initialsFromShort(d.me) }, ...(d.partner ? [d.partner] : [])];
  return {
    kind: 'match',
    eyebrow: d.doubles ? 'DOUBLES MATCH' : 'SINGLES MATCH',
    title: `vs ${joinPeople(d.opponents)}`,
    over: d.scope,
    hero: { big: score, small: d.won ? 'Win' : 'Good game', medal: null },
    stats,
    rows: [{
      id: 'players',
      label: 'Players',
      items: [
        { lead: { won: d.won }, people: myTeam, trailing: String(d.myScore) },
        { lead: { won: !d.won }, people: d.opponents, trailing: String(d.oppScore) },
      ],
    }],
    offByDefault: [],
    defaultLook: d.won ? 'court' : 'night',
    showsScores: true,
    message: d.won
      ? `Won ${score} vs ${joinPeople(d.opponents)} on Pickleague 🥒`
      : `Played ${score} vs ${joinPeople(d.opponents)} on Pickleague 🥒`,
  };
}

/** "Pat D." -> "PD"; "Cher" -> "C". */
export function initialsFromShort(name: string): string {
  const parts = name.replace(/\./g, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '')).toUpperCase();
}

// ── Lengths and the type of play ────────────────────────────────────────

/** "45 min", "1 h", "1 h 45 min" (whole minutes; under a minute is "1 min"). */
export function lengthLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

/** Minutes between two ISO instants (0 when either is missing or they're backwards). */
export function minutesBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number {
  const a = fromIso ? Date.parse(fromIso) : NaN;
  const b = toIso ? Date.parse(toIso) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / 60_000;
}

/** Closed group, open play or drill: a check-in's windows (lib/courtRoutineRules PlayMode). */
export type SharePlayMode = 'closed' | 'open' | 'drill';
const MODE_WORDS: Record<SharePlayMode, { label: string; short: string }> = {
  open: { label: 'Open play', short: 'open play' },
  closed: { label: 'Closed group', short: 'closed group' },
  drill: { label: 'Drill', short: 'drilling' },
};
export type ShareWindowIn = { startsAt: string; endsAt: string; mode: SharePlayMode | null };

/**
 * How a session's time split by mode: its check-in's windows clipped to when it
 * really ran, merged per mode in the order each first came. Windows with no
 * mode said are left out. Parts under a minute are dropped.
 */
export function playMix(
  windows: readonly ShareWindowIn[] | null | undefined,
  startedAt: string,
  endedAt: string,
): { mode: SharePlayMode; minutes: number }[] {
  const s = Date.parse(startedAt);
  const e = Date.parse(endedAt);
  if (!windows?.length || !Number.isFinite(s) || !Number.isFinite(e) || e <= s) return [];
  const out: { mode: SharePlayMode; minutes: number }[] = [];
  const sorted = [...windows].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (const w of sorted) {
    if (!w.mode || !(w.mode in MODE_WORDS)) continue;
    const from = Math.max(s, Date.parse(w.startsAt));
    const to = Math.min(e, Date.parse(w.endsAt));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    const min = (to - from) / 60_000;
    const have = out.find((p) => p.mode === w.mode);
    if (have) have.minutes += min;
    else out.push({ mode: w.mode, minutes: min });
  }
  return out.filter((p) => Math.round(p.minutes) >= 1);
}

/**
 * The type of play in a few words: "Open play" (one mode, or one with 90% of
 * the time), else the split, "30 min open play · 1 h 15 min closed group".
 * No mode said: the session's own kind ("Open play", "Drill").
 */
export function playTypeLabel(mix: readonly { mode: SharePlayMode; minutes: number }[], fallback: string): string {
  if (mix.length === 0) return fallback;
  const total = mix.reduce((n, p) => n + p.minutes, 0);
  const lead = [...mix].sort((a, b) => b.minutes - a.minutes)[0];
  if (mix.length === 1 || lead.minutes >= total * 0.9) return MODE_WORDS[lead.mode].label;
  return mix.map((p) => `${lengthLabel(p.minutes)} ${MODE_WORDS[p.mode].short}`).join(' · ');
}

/** "5 games", "1 game". */
export function gamesLabel(n: number): string {
  return n === 1 ? '1 game' : `${n} games`;
}

// ── Play session ────────────────────────────────────────────────────────
export type SessionShareData = {
  court: string | null;
  /** The session's kind: "Open play", "Drill". */
  kindLabel: string;
  /** "Oct 27". */
  date: string;
  /** How long it ran. */
  minutes: number;
  /** playMix of its check-in's windows (empty: none said). */
  mix: { mode: SharePlayMode; minutes: number }[];
  games: number;
  wins: number | null;
  losses: number | null;
  /** Everyone I played with or against, once each. */
  people: FinishPlayer[];
};

export function sessionCardModel(d: SessionShareData): ShareCardModel {
  const record = recordLabel(d.wins, d.losses);
  const length = lengthLabel(d.minutes);
  const type = playTypeLabel(d.mix, d.kindLabel);
  const stats: ShareStat[] = [{ id: 'type', label: 'Type of play', value: type }];
  if (d.court) stats.push({ id: 'court', label: 'Court', value: d.court });
  if (d.games > 0) stats.push({ id: 'games', label: 'Games', value: gamesLabel(d.games) });
  if (record && d.games > 0) stats.push({ id: 'record', label: 'Record', value: `Record ${record}` });
  stats.push({ id: 'date', label: 'Date', value: d.date });
  return {
    kind: 'session',
    eyebrow: 'PLAY SESSION',
    title: d.court ?? (d.mix.length > 1 ? 'Pickleball' : type),
    over: d.court ? 'Played at' : null,
    hero: { big: length, small: d.games > 0 ? `on the court · ${gamesLabel(d.games)}` : 'on the court', medal: null },
    stats,
    rows: d.people.length
      ? [{ id: 'people', label: 'Players', heading: 'Played with', items: d.people.slice(0, 6).map((p) => ({ lead: null, people: [p] })) }]
      : [],
    // The court is already the title (its chip is there for photo layouts'
    // captions); with no court the type of play is, so its chip starts off too.
    offByDefault: d.court || d.mix.length > 1 ? ['court'] : ['court', 'type'],
    defaultLook: 'court',
    showsScores: false,
    message: `${length} of pickleball${d.court ? ` at ${d.court}` : ''} on Pickleague 🥒`,
  };
}

// ── Drill ───────────────────────────────────────────────────────────────
/** A drill session of mine for the drill stats (play_sessions of kind drill). */
export type DrillPlayIn = { startedAt: string; endedAt: string };

/** Monday 00:00 local of the week `d` is in. */
function weekStart(d: Date): number {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - dow);
  return x.getTime();
}

export const DRILL_WEEKS = 8;

/**
 * My drilling lately: this calendar month's drills and minutes, the minutes in
 * each of the last DRILL_WEEKS weeks (oldest first, this week last), and the
 * streak: weeks in a row with a drill, counting back from this week (or from
 * last week while this one has none yet, so a streak doesn't break on Monday).
 */
export function drillStats(
  sessions: readonly DrillPlayIn[],
  now: Date,
): { monthCount: number; monthMinutes: number; weeks: number[]; weekStreak: number } {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const thisWeek = weekStart(now);
  const WEEK = 7 * 86_400_000;
  const weeks = new Array<number>(DRILL_WEEKS).fill(0);
  const byWeek = new Map<number, number>();
  let monthCount = 0;
  let monthMinutes = 0;
  for (const s of sessions) {
    const min = minutesBetween(s.startedAt, s.endedAt);
    const at = new Date(s.startedAt);
    const t = at.getTime();
    if (!Number.isFinite(t) || t > now.getTime()) continue;
    if (t >= monthStart) {
      monthCount += 1;
      monthMinutes += min;
    }
    const wk = weekStart(at);
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + Math.max(min, 1));
    const ago = Math.round((thisWeek - wk) / WEEK);
    if (ago >= 0 && ago < DRILL_WEEKS) weeks[DRILL_WEEKS - 1 - ago] += min;
  }
  // Week starts step by 7 days except across DST, so walk them by date.
  const back = (wk: number) => {
    const d = new Date(wk);
    d.setDate(d.getDate() - 7);
    return d.getTime();
  };
  let cursor = byWeek.has(thisWeek) ? thisWeek : back(thisWeek);
  let weekStreak = 0;
  while (byWeek.has(cursor)) {
    weekStreak += 1;
    cursor = back(cursor);
  }
  return { monthCount, monthMinutes, weeks, weekStreak };
}

/** "★★★★☆" for 4 of 5. */
export function starsLabel(n: number): string {
  const k = Math.max(0, Math.min(5, Math.round(n)));
  return '★'.repeat(k) + '☆'.repeat(5 - k);
}

/** Cut at a word near `max` characters, with an ellipsis. */
export function clipText(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

export type DrillShareData = {
  /** My drill partner ("First L."), or null. */
  partner: FinishPlayer | null;
  court: string | null;
  /** "Oct 27". */
  date: string;
  /** Time drilled (the play session's length), or null when there was no timer. */
  minutes: number | null;
  /** The shots I'm working on (my drill preferences' labels). */
  focus: string[];
  /** My review of this drill, when sent. */
  review: { rating: number | null; facets: { label: string; stars: number }[]; notes: string | null } | null;
  stats: { monthCount: number; monthMinutes: number; weeks: number[]; weekStreak: number };
};

export function drillCardModel(d: DrillShareData): ShareCardModel {
  const length = d.minutes != null && d.minutes >= 1 ? lengthLabel(d.minutes) : null;
  const rating = d.review?.rating ?? null;
  const stats: ShareStat[] = [];
  if (rating != null) stats.push({ id: 'rating', label: 'My rating', value: `${starsLabel(rating)} session` });
  if (d.stats.monthCount > 0) {
    stats.push({
      id: 'month',
      label: 'This month',
      value: `${d.stats.monthCount === 1 ? '1 drill' : `${d.stats.monthCount} drills`} · ${lengthLabel(d.stats.monthMinutes)} this month`,
    });
  }
  if (d.stats.weekStreak >= 2) stats.push({ id: 'streak', label: 'Streak', value: `🔥 ${d.stats.weekStreak}-week drill streak` });
  if (d.court) stats.push({ id: 'court', label: 'Court', value: d.court });
  stats.push({ id: 'date', label: 'Date', value: d.date });
  const rows: ShareRows[] = [];
  if (d.focus.length) {
    rows.push({ id: 'focus', label: 'Working on', heading: 'Working on', items: d.focus.slice(0, 4).map((f) => ({ lead: null, text: `• ${f}` })) });
  }
  const facets = (d.review?.facets ?? []).filter((f) => f.stars >= 1);
  if (facets.length) {
    rows.push({ id: 'facets', label: 'My review', heading: 'My review', items: facets.map((f) => ({ lead: null, text: f.label, trailing: starsLabel(f.stars) })) });
  }
  const notes = d.review?.notes?.trim() ? clipText(d.review.notes, 140) : null;
  const withWho = d.partner ? ` with ${d.partner.name}` : '';
  return {
    kind: 'drill',
    eyebrow: 'DRILL SESSION',
    title: d.partner ? `Drilled with ${d.partner.name}` : 'Drill session',
    over: d.court,
    hero: length
      ? { big: length, small: 'of drilling', medal: null }
      : rating != null
        ? { big: starsLabel(rating), small: 'my drill review', medal: null }
        : { big: 'Put in the work', small: null, medal: null },
    stats,
    rows,
    quote: notes ? { id: 'notes', label: 'My notes', text: notes } : null,
    bars: { id: 'weeks', label: 'Last 8 weeks', heading: `Last ${DRILL_WEEKS} weeks`, values: d.stats.weeks, caption: d.stats.weekStreak >= 2 ? `${d.stats.weekStreak} weeks in a row` : null },
    // Notes and the facet stars are personal: off until I turn them on.
    offByDefault: ['notes', 'facets', 'court'],
    defaultLook: 'night',
    showsScores: false,
    message: length
      ? `Put in ${length} of drilling${withWho} on Pickleague 🥒💪`
      : `Drilled${withWho} on Pickleague 🥒💪`,
  };
}

// ── Event ───────────────────────────────────────────────────────────────
export type EventShareData = {
  title: string;
  league: string | null;
  court: string | null;
  /** "Sat, Oct 25". */
  date: string;
  /** How many said they were in. */
  count: number;
};

export function eventCardModel(d: EventShareData): ShareCardModel {
  const stats: ShareStat[] = [{ id: 'date', label: 'Date', value: d.date }];
  if (d.court) stats.push({ id: 'court', label: 'Court', value: d.court });
  return {
    kind: 'event',
    eyebrow: 'EVENT',
    title: d.title,
    over: d.league,
    hero: d.count > 0
      ? { big: String(d.count), small: d.count === 1 ? 'player came' : 'players came', medal: null }
      : { big: 'I was there', small: null, medal: null },
    stats,
    rows: [],
    offByDefault: [],
    defaultLook: 'night',
    showsScores: false,
    message: `I played "${d.title}" on Pickleague 🥒`,
  };
}

// ── Tournament bracket: my path ─────────────────────────────────────────
export type BracketStep = {
  /** "Pool A · Round 2", "Semifinal". */
  round: string;
  won: boolean | null;
  /** "11–7" (mine first), null when not played. */
  score: string | null;
  opponents: FinishPlayer[];
};
export type BracketShareData = {
  title: string;
  /** My final place, when the tournament is done. */
  rank: number | null;
  of: number | null;
  wins: number;
  losses: number;
  steps: BracketStep[];
};

/** The tournament matches a bracket card reads (tournament_matches + its round). */
export type BracketMatchIn = {
  id: string;
  status: string;
  match_order?: number | null;
  winner_team: 'team1' | 'team2' | null;
  team1_player1: string | null;
  team1_player2: string | null;
  team2_player1: string | null;
  team2_player2: string | null;
  team1_score?: number | null;
  team2_score?: number | null;
  round?: { label: string | null; round_number: number } | null;
};

/** My completed matches, in round order, as path steps. `player` masks names. */
export function bracketSteps(
  matches: readonly BracketMatchIn[],
  me: string,
  player: (id: string) => FinishPlayer,
): BracketStep[] {
  const mine = matches.filter((m) =>
    m.status === 'completed'
    && [m.team1_player1, m.team1_player2, m.team2_player1, m.team2_player2].includes(me));
  mine.sort((a, b) =>
    (a.round?.round_number ?? 999) - (b.round?.round_number ?? 999) || (a.match_order ?? 0) - (b.match_order ?? 0));
  return mine.map((m) => {
    const onTeam1 = m.team1_player1 === me || m.team1_player2 === me;
    const opp = (onTeam1 ? [m.team2_player1, m.team2_player2] : [m.team1_player1, m.team1_player2]).filter(Boolean) as string[];
    const my = onTeam1 ? m.team1_score : m.team2_score;
    const their = onTeam1 ? m.team2_score : m.team1_score;
    return {
      round: m.round?.label?.trim() || (m.round ? `Round ${m.round.round_number}` : 'Match'),
      won: m.winner_team == null ? null : (m.winner_team === 'team1') === onTeam1,
      score: my != null && their != null ? `${my}–${their}` : null,
      opponents: opp.map(player),
    };
  });
}

export function bracketCardModel(d: BracketShareData): ShareCardModel {
  const record = `${d.wins}-${d.losses}`;
  const headline = d.rank != null ? placeHeadline(d.rank, d.of) : `Record ${record}`;
  return {
    kind: 'bracket',
    eyebrow: 'MY BRACKET',
    title: d.title,
    over: null,
    hero: {
      big: headline,
      small: d.rank != null ? `Record ${record}` : d.steps.length === 1 ? '1 match played' : `${d.steps.length} matches played`,
      medal: d.rank != null && d.rank <= 3 ? d.rank : null,
    },
    stats: [],
    rows: d.steps.length
      ? [{
          id: 'path',
          label: 'My path',
          heading: 'My path',
          items: d.steps.slice(-6).map((s) => ({
            lead: { won: s.won },
            text: `${s.round} · vs ${joinPeople(s.opponents)}`,
            trailing: s.score ?? undefined,
          })),
        }]
      : [],
    offByDefault: [],
    defaultLook: d.rank === 1 ? 'night' : 'court',
    showsScores: true,
    message: d.rank === 1
      ? `I won ${d.title} on Pickleague 🥒`
      : `My run in ${d.title} (${record}) on Pickleague 🥒`,
  };
}

/** The share text: the card's message, then the link so it unfurls. */
export function shareCardMessage(m: Pick<ShareCardModel, 'message'>, link: string): string {
  return `${m.message} ${link}`;
}

/** A match row a play session card reads. */
export type SessionMatchIn = {
  status: string;
  winner_team: 'team1' | 'team2' | null;
  player1_id: string | null;
  partner1_id: string | null;
  player2_id: string | null;
  partner2_id: string | null;
  play_session_id: string | null;
  created_at: string;
};

/** How long after a session ends a match still counts for it (list_my_play_sessions). */
export const SESSION_MATCH_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * My completed matches in a session: linked to it, or unlinked and recorded
 * between its start and two hours after its end (the history's own rule,
 * minus a match another session claimed). Games, W-L, and everyone else in
 * them once each, in order of first appearance.
 */
export function sessionTally(
  matches: readonly SessionMatchIn[],
  me: string,
  session: { id: string; startedAt: string; endedAt: string },
): { games: number; wins: number; losses: number; people: string[] } {
  const start = Date.parse(session.startedAt);
  const end = Date.parse(session.endedAt) + SESSION_MATCH_GRACE_MS;
  let wins = 0;
  let losses = 0;
  let games = 0;
  const people: string[] = [];
  for (const m of matches) {
    if (m.status !== 'completed') continue;
    const team1 = [m.player1_id, m.partner1_id];
    const team2 = [m.player2_id, m.partner2_id];
    const onTeam1 = team1.includes(me);
    if (!onTeam1 && !team2.includes(me)) continue;
    const at = Date.parse(m.created_at);
    const inSession = m.play_session_id === session.id || (m.play_session_id == null && at >= start && at <= end);
    if (!inSession) continue;
    games += 1;
    if (m.winner_team) {
      if ((m.winner_team === 'team1') === onTeam1) wins += 1;
      else losses += 1;
    }
    for (const id of [...team1, ...team2]) {
      if (id && id !== me && !people.includes(id)) people.push(id);
    }
  }
  return { games, wins, losses, people };
}
