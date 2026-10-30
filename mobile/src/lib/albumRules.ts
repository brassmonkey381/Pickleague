// Event and tournament photo albums (supabase/migration_event_tournament_albums.sql):
// the pure parts, so vitest covers them (lib/__tests__/albumRules.test.ts).
//
// A photo's file lives in the private album-photos bucket at
//   <kind>/<event or tournament id>/<uploader id>/<random>.<ext>
// and the server checks that shape: the album's folder, the uploader's own
// subfolder. The album shows oldest first, so the first photo is the cover.

export type AlbumKind = 'event' | 'tournament';

/** 4 photos per person per album (the server's album.full); no cap on the album. */
export const ALBUM_CAP_PER_PERSON = 4;
/** Most photos picked in one go: base64 copies of each sit in memory until uploaded. */
export const ALBUM_PICK_MAX = 4;
/** The picker re-encodes at this quality (a phone photo comes out around 1 MB). */
export const ALBUM_JPEG_QUALITY = 0.6;
/** Signed URLs last an hour; the album refetches well before. */
export const ALBUM_URL_TTL_S = 60 * 60;
export const ALBUM_CACHE_TTL_MS = 10 * 60 * 1000;

export const albumKey = (kind: AlbumKind, id: string) => `album:${kind}:${id}`;

export function albumColumn(kind: AlbumKind): 'event_id' | 'tournament_id' {
  return kind === 'event' ? 'event_id' : 'tournament_id';
}

/** A safe lowercase extension; HEIC stays HEIC, anything odd becomes jpg. */
export function albumExt(ext: string | null | undefined): string {
  const e = (ext ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (e === 'jpeg') return 'jpg';
  return ['jpg', 'png', 'webp', 'heic'].includes(e) ? e : 'jpg';
}

export function albumContentType(ext: string): string {
  const e = albumExt(ext);
  return e === 'jpg' ? 'image/jpeg' : `image/${e}`;
}

export function albumPath(kind: AlbumKind, albumId: string, uploaderId: string, token: string, ext: string): string {
  return `${kind}/${albumId}/${uploaderId}/${token}.${albumExt(ext)}`;
}

/** A random file name part (no crypto needed: the path is also unique-checked). */
export function albumToken(rand: () => number = Math.random): string {
  let s = Date.now().toString(36);
  for (let i = 0; i < 3; i++) s += rand().toString(36).slice(2, 8);
  return s;
}

/** How many more I can add, and how many to let the picker take. */
export function albumRoom(mine: number, cap: number = ALBUM_CAP_PER_PERSON): { left: number; pick: number } {
  const left = Math.max(0, cap - Math.max(0, mine));
  return { left, pick: Math.min(left, ALBUM_PICK_MAX) };
}

/** "3 photos added", "Added 2 of 3 photos". */
export function addedLine(added: number, tried: number): string {
  const word = (n: number) => (n === 1 ? 'photo' : 'photos');
  if (added === tried) return `${added} ${word(added)} added`;
  return `Added ${added} of ${tried} ${word(tried)}`;
}

/** Oldest first (the cover leads), photos from blocked players left out. */
export function orderAlbum<T extends { createdAt: string; uploaderId: string }>(
  photos: readonly T[],
  blocked: ReadonlySet<string>,
): T[] {
  return photos
    .filter((p) => !blocked.has(p.uploaderId))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
