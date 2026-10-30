// Event and tournament photo albums (supabase/migration_event_tournament_albums.sql;
// rules in lib/albumRules.ts). Everyone in the event or tournament sees and adds;
// the uploader and the organizers remove. Files are private: the app reads
// them through signed URLs that last an hour.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { pickedImageBytes, type PickedImage } from '@just-messin-around/expo-foundation/platform';
import { supabase } from '../lib/supabase';
import {
  ALBUM_CAP_PER_PERSON,
  ALBUM_URL_TTL_S,
  albumColumn,
  albumContentType,
  albumExt,
  albumPath,
  albumToken,
  type AlbumKind,
} from '../lib/albumRules';

const BUCKET = 'album-photos';
const BOUND = { timeoutMs: 12_000 };
// Writes don't retry: a retried insert that had landed fails on the unique path.
const WRITE = { timeoutMs: 12_000, retries: 0 };
// No retry: the bucket has no update policy, so a second try at the same path
// can only fail; the photo's row comes back out instead.
const UPLOAD = { timeoutMs: 60_000, retries: 0 };

export type AlbumAccess = { canView: boolean; canAdd: boolean; canManage: boolean; mine: number; cap: number };

export type AlbumPhoto = {
  id: string;
  path: string;
  url: string;
  uploaderId: string;
  uploaderName: string | null;
  createdAt: string;
};

export type Album = { access: AlbumAccess; photos: AlbumPhoto[] };

const NO_ACCESS: AlbumAccess = { canView: false, canAdd: false, canManage: false, mine: 0, cap: ALBUM_CAP_PER_PERSON };

export async function getAlbumAccess(kind: AlbumKind, id: string): Promise<AlbumAccess> {
  const j = (await sbCall(() => supabase.rpc('album_access', { p_kind: kind, p_id: id }), BOUND)) as
    | Record<string, unknown>
    | null;
  if (!j) return NO_ACCESS;
  return {
    canView: !!j.can_view,
    canAdd: !!j.can_add,
    canManage: !!j.can_manage,
    mine: Number(j.mine ?? 0),
    cap: Number(j.cap ?? ALBUM_CAP_PER_PERSON),
  };
}

/** The album, oldest first (the cover leads). Not in it: no photos. */
export async function getAlbum(kind: AlbumKind, id: string): Promise<Album> {
  const access = await getAlbumAccess(kind, id);
  if (!access.canView) return { access, photos: [] };
  const rows = ((await sbCall(
    () =>
      supabase
        .from('album_photos')
        .select('id, path, uploader_id, created_at, uploader:profiles!album_photos_uploader_id_fkey(full_name)')
        .eq(albumColumn(kind), id)
        .order('created_at', { ascending: true }),
    BOUND,
  )) ?? []) as {
    id: string;
    path: string;
    uploader_id: string;
    created_at: string;
    uploader: { full_name: string | null } | { full_name: string | null }[] | null;
  }[];
  if (rows.length === 0) return { access, photos: [] };
  const signed = ((await sbCall(
    () => supabase.storage.from(BUCKET).createSignedUrls(rows.map((r) => r.path), ALBUM_URL_TTL_S),
    BOUND,
  )) ?? []) as { path: string | null; signedUrl: string | null; error: string | null }[];
  const urlOf = new Map(signed.filter((s) => s.path && s.signedUrl).map((s) => [s.path as string, s.signedUrl as string]));
  const photos: AlbumPhoto[] = [];
  for (const r of rows) {
    const url = urlOf.get(r.path);
    // No file behind the row (an upload that never finished): leave it out.
    if (!url) continue;
    const up = Array.isArray(r.uploader) ? r.uploader[0] : r.uploader;
    photos.push({ id: r.id, path: r.path, url, uploaderId: r.uploader_id, uploaderName: up?.full_name ?? null, createdAt: r.created_at });
  }
  return { access, photos };
}

/** The album's photo URLs, cover first (for the share studio). */
export async function getEventAlbum(eventId: string): Promise<string[]> {
  return (await getAlbum('event', eventId)).photos.map((p) => p.url);
}
export async function getTournamentAlbum(tournamentId: string): Promise<string[]> {
  return (await getAlbum('tournament', tournamentId)).photos.map((p) => p.url);
}

export type AddResult = { added: number; error: unknown | null };

/**
 * Add picked photos, one at a time: the row first (the server checks I'm in
 * the album and under my 20), then the file at the row's path. A file that
 * fails takes its row back out. Stops at the first refusal (album full).
 */
export async function addAlbumPhotos(
  kind: AlbumKind,
  albumId: string,
  uploaderId: string,
  images: readonly PickedImage[],
): Promise<AddResult> {
  let added = 0;
  for (const img of images) {
    const ext = albumExt(img.ext);
    const path = albumPath(kind, albumId, uploaderId, albumToken(), ext);
    let rowId: string | null = null;
    try {
      const row = (await sbCall(
        () =>
          supabase
            .from('album_photos')
            .insert({
              [albumColumn(kind)]: albumId,
              uploader_id: uploaderId,
              path,
              width: img.width > 0 ? Math.round(img.width) : null,
              height: img.height > 0 ? Math.round(img.height) : null,
            })
            .select('id')
            .single(),
        WRITE,
      )) as { id: string } | null;
      rowId = row?.id ?? null;
      const bytes = await pickedImageBytes(img);
      await sbCall(
        () => supabase.storage.from(BUCKET).upload(path, bytes, { contentType: albumContentType(ext), upsert: false }),
        UPLOAD,
      );
      added += 1;
    } catch (e) {
      if (rowId) {
        const id = rowId;
        await supabase.from('album_photos').delete().eq('id', id).then(() => undefined, () => undefined);
      }
      return { added, error: e };
    }
  }
  return { added, error: null };
}

/** Remove a photo: the row (the server checks it's mine or I run the album), then its file. */
export async function removeAlbumPhoto(photo: Pick<AlbumPhoto, 'id' | 'path'>): Promise<void> {
  const gone = ((await sbCall(
    () => supabase.from('album_photos').delete().eq('id', photo.id).select('id'),
    BOUND,
  )) ?? []) as { id: string }[];
  if (gone.length === 0) throw new Error('That photo is already gone, or it isn’t yours to remove.');
  // Best effort: the row is what shows it; a file left behind is unreachable.
  await supabase.storage.from(BUCKET).remove([photo.path]).then(() => undefined, () => undefined);
}
