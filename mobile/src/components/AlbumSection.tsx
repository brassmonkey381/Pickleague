// An event's or tournament's shared photo album (data/albums.ts). Everyone in
// it sees every photo (with who added it) and can add up to 20 of their own,
// several at a time; you remove your own, organizers remove anyone's, and
// anyone can report one. Hidden from everyone who isn't in it, and while the
// album SQL isn't live yet.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PhotoGallery } from '@just-messin-around/expo-foundation/ui';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { pickImagesFromLibrary } from '@just-messin-around/expo-foundation/platform';
import { useToast } from '@just-messin-around/expo-foundation/toast';
import { currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { supabase } from '../lib/supabase';
import { useBlockedIds } from '../lib/moderation';
import { isServerRefusal } from '../lib/refusals';
import {
  ALBUM_CACHE_TTL_MS,
  ALBUM_JPEG_QUALITY,
  addedLine,
  albumKey,
  albumRoom,
  orderAlbum,
  type AlbumKind,
} from '../lib/albumRules';
import { addAlbumPhotos, getAlbum, removeAlbumPhoto, type AlbumPhoto } from '../data/albums';
import ReportPlayerModal from './ReportPlayerModal';

type Props = {
  kind: AlbumKind;
  id: string;
};

function errorText(e: unknown, fallback: string): string {
  if (isServerRefusal(e)) return (e as { message: string }).message;
  return friendlySbMessage(e, fallback);
}

export default function AlbumSection({ kind, id }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const blocked = useBlockedIds();
  const [adding, setAdding] = React.useState(false);
  const [me, setMe] = React.useState<string | null>(null);
  const [reporting, setReporting] = React.useState<AlbumPhoto | null>(null);
  const query = useCachedQuery(albumKey(kind, id), () => getAlbum(kind, id), { ttlMs: ALBUM_CACHE_TTL_MS });

  React.useEffect(() => {
    let alive = true;
    currentUserId(supabase).then((u) => alive && setMe(u ?? null)).catch(() => {});
    return () => { alive = false; };
  }, []);

  const album = query.data;
  // Not in it, not loaded, or the album SQL isn't live: nothing to show.
  if (!album || !album.access.canView) return null;

  const photos = orderAlbum(album.photos, blocked);
  const room = albumRoom(album.access.mine, album.access.cap);
  const canAdd = album.access.canAdd && room.left > 0 && !!me;
  const byId = new Map(photos.map((p) => [p.id, p]));

  async function onAdd() {
    if (!me || adding) return;
    const picked = await pickImagesFromLibrary({ limit: room.pick, quality: ALBUM_JPEG_QUALITY, base64: true }).catch(() => []);
    if (!picked.length) return;
    setAdding(true);
    try {
      const { added, error } = await addAlbumPhotos(kind, id, me, picked);
      await query.refresh();
      if (error) {
        const why = errorText(error, 'Couldn’t add your photos. Try again in a moment.');
        toast.error(added > 0 ? `${addedLine(added, picked.length)}. ${why}` : why);
      } else {
        toast.success(addedLine(added, picked.length));
      }
    } finally {
      setAdding(false);
    }
  }

  async function onDelete(photoId: string) {
    const p = byId.get(photoId);
    if (!p) return;
    try {
      await removeAlbumPhoto(p);
      await query.refresh();
      toast.success('Photo removed');
    } catch (e) {
      toast.error(errorText(e, 'Couldn’t remove that photo. Try again in a moment.'));
    }
  }

  if (photos.length === 0 && !canAdd) return null;

  const who = kind === 'event' ? 'Everyone in this event' : 'Everyone in this tournament';
  return (
    <View style={styles.wrap}>
      <PhotoGallery
        title={`Photos${photos.length ? ` (${photos.length})` : ''}`}
        photos={photos.map((p) => ({
          id: p.id,
          uri: p.url,
          attribution: p.uploaderId === me ? 'Added by you' : `Added by ${p.uploaderName ?? 'a player'}`,
          canDelete: p.uploaderId === me || album.access.canManage,
        }))}
        carousel={photos.length > 0}
        canAdd={canAdd}
        adding={adding}
        onAdd={() => void onAdd()}
        onDelete={(pid) => void onDelete(pid)}
        onReport={(pid) => setReporting(byId.get(pid) ?? null)}
      />
      {album.access.canAdd ? (
        <Text style={[t.caption, styles.hint, { color: c.textMuted }]}>
          {room.left > 0
            ? `${who} sees what you add. You can add ${room.left} more.`
            : `${who} sees what you add. You've added all ${album.access.cap}; remove one to add another.`}
        </Text>
      ) : null}
      {reporting ? (
        <ReportPlayerModal
          visible
          subjectUserId={reporting.uploaderId}
          subjectName={reporting.uploaderName ?? 'this player'}
          subjectType="photo"
          subjectId={reporting.id}
          snapshot={{ path: reporting.path, album: `${kind}:${id}` }}
          onClose={() => setReporting(null)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 8 },
  hint: { marginTop: 6 },
});
