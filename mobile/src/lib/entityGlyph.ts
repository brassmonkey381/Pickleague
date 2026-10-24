// One place for the glyph that stands for each kind of thing in the app, plus
// the small text helpers the compact rows (LeagueRow / TournamentRow) share.
//
// PURE (no react-native import): rows, tiles, section labels and tests all read
// it.
//
// Glyphs (2026-10-24, glyphs-ui-plan.md): ENTITY_ICON / entityIcon() name the
// drawn glyph for each kind (lib/glyphs.tsx registers the Pickleague art), and
// rows draw it with <Icon>. A TOURNAMENT is the trophy, a LEAGUE the
// pickleball, a DRILL the paddle (so the paddle can't also be the league).
// The emoji table that stood beside it went once every screen drew glyphs;
// text that leaves the app (push, share) writes its emoji where it is built.
import type { Theme } from '@just-messin-around/expo-foundation/theme';
import type { IconName } from '@just-messin-around/expo-foundation/icons';

export type EntityKind =
  | 'league'
  | 'tournament'
  | 'event'
  | 'vote'
  | 'drill'
  | 'court'
  | 'match'
  | 'season'
  | 'player'
  | 'shop'
  | 'pickles';

/** The drawn glyph per kind. Event and season share the calendar (the filled
 *  `calendar-event`, so it sits with the other filled glyphs; the outline
 *  `calendar` read as the odd one out beside trophy and group). */
export const ENTITY_ICON: Readonly<Record<EntityKind, IconName>> = {
  league: 'pickleball',
  tournament: 'trophy',
  event: 'calendar-event',
  vote: 'ballot',
  drill: 'paddle',
  court: 'pin',
  match: 'medal',
  season: 'calendar-event',
  player: 'person',
  shop: 'cart',
  pickles: 'pickle',
};

/** The glyph name for an entity kind: <Icon name={entityIcon(kind)} />. */
export function entityIcon(kind: EntityKind): IconName {
  return ENTITY_ICON[kind];
}

/** Background + border for a row's glyph tile, from theme tokens only (no
 *  hex: the tile follows light/dark). Leagues read as the brand, tournaments as
 *  the gold of the trophy, events as info. */
export function entityTileColors(kind: EntityKind, c: Theme): { bg: string; border: string } {
  switch (kind) {
    case 'league':
      return { bg: c.primaryLight, border: c.primary };
    case 'tournament':
      return { bg: c.rarityLegendaryLight, border: c.rarityLegendary };
    case 'event':
    case 'vote':
    case 'season':
      return { bg: c.infoLight, border: c.info };
    case 'drill':
    case 'match':
      return { bg: c.successLight, border: c.success };
    case 'pickles':
      return { bg: c.primaryLight, border: c.primary };
    default:
      return { bg: c.surfaceAlt, border: c.border };
  }
}

/** A glyph's own tile colours, for a glyph that stands for itself rather than
 *  an entity (a notification title's 🔥 or 🏆): fire is warning orange, the
 *  trophy, medal and crown gold, the pickle the brand green, a tick success.
 *  Null for a glyph with no colour of its own (the row then uses its kind's). */
export function glyphTileColors(icon: IconName, c: Theme): { bg: string; border: string } | null {
  switch (icon) {
    case 'fire':
    case 'warning':
      return { bg: c.warningLight, border: c.warning };
    case 'trophy':
    case 'medal':
    case 'crown':
      return { bg: c.rarityLegendaryLight, border: c.rarityLegendary };
    case 'pickle':
      return { bg: c.primaryLight, border: c.primary };
    case 'check':
    case 'check-mark':
      return { bg: c.successLight, border: c.success };
    default:
      return null;
  }
}

// ── Row text helpers (shared by LeagueRow / TournamentRow) ──────────────────

/** Join the truthy facts of a subtitle with " · ". Blank strings, null,
 *  undefined and false drop out, so callers can write `cond && 'fact'`. */
export function joinFacts(parts: ReadonlyArray<string | null | undefined | false>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
    .join(' · ');
}

/** "1 player" / "12 players". Null for 0, unknown or negative counts: a row
 *  never says "0 players" (content rule 3 — no zero values to non-admins). */
export function playerCountLabel(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return n === 1 ? '1 player' : `${n} players`;
}

/** The one row-level membership chip for a league role. Null for a non-member
 *  or an unknown role (never render "Unknown"). */
export function leagueRoleChip(
  role: 'admin' | 'co-admin' | 'member' | 'unknown' | null | undefined,
): { label: string; tone: RowChipTone } | null {
  if (role === 'admin') return { label: 'Admin', tone: 'warning' };
  if (role === 'co-admin') return { label: 'Co-admin', tone: 'success' };
  if (role === 'member') return { label: 'Member', tone: 'neutral' };
  return null;
}

/** A chip tone the foundation Chip / Badge understands. */
export type RowChipTone = 'neutral' | 'brand' | 'success' | 'danger' | 'warning' | 'info';

/** A tournament's lifecycle as a row chip (tournaments.status). Null for an
 *  unrecognised status, so a row never shows a raw enum value. */
export function tournamentStatusChip(
  status: string | null | undefined,
): { label: string; tone: RowChipTone } | null {
  switch (status) {
    case 'registration': return { label: 'Open', tone: 'brand' };
    case 'active': return { label: 'In progress', tone: 'success' };
    case 'completed': return { label: 'Ended', tone: 'neutral' };
    case 'cancelled': return { label: 'Cancelled', tone: 'danger' };
    default: return null;
  }
}

/** The viewer's own registration as a row chip (tournament_registrations
 *  .status; an invite is `pending` with `invited_by` set). Null when there is
 *  nothing to say: no registration, or a rejection (not shown on a row). */
export function myRegistrationChip(
  status: 'pending' | 'approved' | 'rejected' | 'waitlisted' | string | null | undefined,
  invited?: boolean,
): { label: string; tone: RowChipTone } | null {
  if (status === 'pending') return invited ? { label: 'Invited', tone: 'warning' } : { label: 'Requested', tone: 'info' };
  if (status === 'approved') return { label: 'Registered', tone: 'success' };
  if (status === 'waitlisted') return { label: 'Waitlist', tone: 'neutral' };
  return null;
}
