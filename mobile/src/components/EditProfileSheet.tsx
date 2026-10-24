// The Edit profile sheet (plan section 5, "Edit profile sheet"): ONE Save for
// everything a player sets about themselves — avatar, display name, username,
// tagline, gender, play-style tags and badge privacy.
//
// Why a sheet with pages instead of the old inline form + two picker Modals:
//   - The avatar and tag pickers were Modals over a long form whose Save button
//     sat ~1,500px further down. Picking an avatar and leaving the screen threw
//     the pick away without a word. Here Save is always in the sheet's header,
//     and the pickers open as PAGES inside the sheet (back arrow to the form),
//     reporting every pick live into the sheet's draft.
//   - A second Modal on top of a Modal is unreliable (iOS shows one at a time),
//     so nothing in here opens one: the pickers run in presentation='page' and
//     show their errors inline.
//
// Display name moved here from Settings (Settings stops editing it in P6).
// Nothing is written to the profile until Save; Cancel, the backdrop, Escape
// and Android back discard the draft (on a picker page they step back to the
// form first). A picked photo is uploaded right away, but to its own new object,
// so it only goes live when Save points avatar_url at it.
//
// Built on the foundation BottomSheet (no title: the sheet draws its own
// Cancel / Save header). Its onClose is handleDismiss, which RNW's Modal
// calls on Escape (top-most Modal only, once), Android back calls, and the
// backdrop calls: on a picker page it only steps back to the form.
// keyboardShrink keeps the header and Save above the keyboard on native.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  Platform, useWindowDimensions,
} from 'react-native';
import { CachedImage } from '@just-messin-around/expo-foundation/ui/CachedImage';
import { BottomSheet, FilterChipRow, StatusBanner, ThemedSwitch } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { useStatusMessage } from '@just-messin-around/expo-foundation/hooks';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { Gender } from '../types';
import { AVATARS, PLAY_TAGS } from '../data/profileCustomization';
import AvatarPickerModal, { PremiumAvatar } from './AvatarPickerModal';
import TagPickerModal from './TagPickerModal';

/** The editable fields, as the sheet opens with them. */
export type EditProfileValues = {
  fullName: string;
  username: string;
  tagline: string;
  gender: Gender | null;
  selectedTags: string[];
  avatarId: number;
  photoUrl: string | null;
  /** An equipped Shop avatar (profiles.avatar_emoji + avatar_bg_color). */
  premium: PremiumAvatar | null;
  badgesPublic: boolean;
};

/** The profiles columns a successful Save wrote, for the caller to merge. */
export type EditProfileSaved = {
  full_name: string;
  username: string;
  tagline: string | null;
  gender: Gender | null;
  selected_tags: string[];
  avatar_id: number;
  avatar_url: string | null;
  avatar_emoji: string | null;
  avatar_bg_color: string | null;
  badges_public: boolean;
};

type Props = {
  visible: boolean;
  userId: string;
  /** Read each time the sheet opens; edits never write back into it. */
  initial: EditProfileValues;
  earnedBadgeNames: string[];
  /** Shop avatars the player owns (offered in the avatar page). */
  purchasedAvatars: PremiumAvatar[];
  maxTagSlots: number;
  onClose: () => void;
  /** After a successful Save, with the columns written. The sheet then closes. */
  onSaved: (saved: EditProfileSaved) => void;
};

type Page = 'form' | 'avatar' | 'tags';

const TAGLINE_MAX = 50;
/** Same 50-char budget as the tagline; a name is one line everywhere it shows. */
const NAME_MAX = 50;
const SHEET_MAX_WIDTH = 560;
const AVATAR = 64;

const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'male',              label: 'Male' },
  { value: 'female',            label: 'Female' },
  { value: 'other',             label: 'Other' },
  { value: 'prefer-not-to-say', label: 'Prefer not to say' },
];

function sameTags(a: string[], b: string[]) {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Best-effort cleanup after a Save changed the photo: each upload is its own
 * object (see AvatarPickerModal.uploadBlob), so superseded and discarded
 * uploads pile up under `avatars/<uid>/`. Removes every object there except
 * the one the saved avatar_url points at. Storage API only (a SQL delete on
 * storage.objects aborts). Never throws: an orphan is harmless, a failed Save
 * is not.
 */
async function pruneAvatarUploads(userId: string, savedUrl: string | null) {
  try {
    let keep: string | null = null;
    if (savedUrl) {
      // `<…>/storage/v1/object/public/avatars/<uid>/<file>?t=…`
      const marker = `/avatars/${userId}/`;
      const path = savedUrl.split('?')[0];
      const at = path.indexOf(marker);
      // Not one of our objects (unexpected shape): don't guess, delete nothing.
      if (at < 0) return;
      keep = decodeURIComponent(path.slice(at + marker.length));
    }
    const { data: files } = await supabase.storage.from('avatars').list(userId);
    const stale = (files ?? [])
      .map(f => f.name)
      .filter(name => name && name !== keep)
      .map(name => `${userId}/${name}`);
    if (stale.length > 0) await supabase.storage.from('avatars').remove(stale);
  } catch {
    // Best-effort; see above.
  }
}

export default function EditProfileSheet({
  visible, userId, initial, earnedBadgeNames, purchasedAvatars, maxTagSlots, onClose, onSaved,
}: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const S = useMemo(() => makeStyles(c), [c]);
  const { height: winH } = useWindowDimensions();
  const status = useStatusMessage();

  const [page, setPage] = useState<Page>('form');
  const [draft, setDraft] = useState<EditProfileValues>(initial);
  const [saving, setSaving] = useState(false);
  // Leaving the avatar page mid-upload would orphan the upload's result.
  const [uploading, setUploading] = useState(false);

  // A fresh draft every time the sheet opens, on the form page.
  useEffect(() => {
    if (!visible) return;
    setDraft(initial);
    setPage('form');
    setUploading(false);
    status.clear();
    // `initial` is read at open only: a profile refresh behind an open sheet
    // must not wipe what the user is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const set = useCallback(<K extends keyof EditProfileValues>(key: K, value: EditProfileValues[K]) => {
    setDraft(d => ({ ...d, [key]: value }));
  }, []);

  const dirty =
    draft.fullName !== initial.fullName ||
    draft.username !== initial.username ||
    draft.tagline !== initial.tagline ||
    draft.gender !== initial.gender ||
    !sameTags(draft.selectedTags, initial.selectedTags) ||
    draft.avatarId !== initial.avatarId ||
    draft.photoUrl !== initial.photoUrl ||
    (draft.premium?.emoji ?? null) !== (initial.premium?.emoji ?? null) ||
    (draft.premium?.bgColor ?? null) !== (initial.premium?.bgColor ?? null) ||
    draft.badgesPublic !== initial.badgesPublic;

  // Escape / Android back / backdrop: a picker page steps back to the form
  // (its picks are already in the draft); the form discards and closes.
  const handleDismiss = useCallback(() => {
    if (saving) return;
    if (page !== 'form') {
      if (!uploading) setPage('form');
      return;
    }
    onClose();
  }, [page, uploading, saving, onClose]);

  async function save() {
    if (saving) return;
    const fullName = draft.fullName.trim();
    const username = draft.username.trim();
    if (!fullName) { status.error('Add a display name.'); return; }
    if (!username) { status.error('Add a username.'); return; }

    // Only an explicit pick on the avatar page touches the Shop avatar: the
    // picker already reports `photoUrl ? null : premium` through onChange, so
    // picking or uploading a photo there still clears it. A player can have a
    // photo AND an equipped Shop avatar (Inventory Equip and Shop Buy & Equip
    // leave avatar_url alone), and an unrelated edit like the tagline must not
    // un-equip it. When nothing changed this writes the existing values back,
    // so the onSaved payload still carries the true columns.
    const premium = draft.premium;
    const payload: EditProfileSaved = {
      full_name:       fullName,
      username,
      tagline:         draft.tagline.trim() || null,
      gender:          draft.gender,
      selected_tags:   draft.selectedTags,
      avatar_id:       draft.avatarId,
      avatar_url:      draft.photoUrl,
      avatar_emoji:    premium?.emoji ?? null,
      avatar_bg_color: premium?.bgColor ?? null,
      badges_public:   draft.badgesPublic,
    };

    setSaving(true);
    status.clear();
    try {
      // .select() so an update that matched no row (expired session / RLS)
      // reads as a failure instead of a silent success.
      const rows = await sbCall(() =>
        supabase.from('profiles').update(payload).eq('id', userId).select('id'),
      ) as { id: string }[] | null;
      if (!rows || rows.length === 0) {
        status.error('Not saved. Your session may have expired. Please log out and back in.');
        return;
      }
      if (draft.photoUrl !== initial.photoUrl) void pruneAvatarUploads(userId, draft.photoUrl);
      onSaved(payload);
    } catch (e: any) {
      // No "username taken" case: migration_relax_username_uniqueness.sql
      // dropped the unique constraint, so a duplicate handle simply saves.
      status.error(friendlySbMessage(e, "Couldn't save your profile."));
    } finally {
      setSaving(false);
    }
  }

  // ── Derived display ──────────────────────────────────────────────────────
  const cartoon = AVATARS.find(a => a.id === draft.avatarId) ?? AVATARS[0];
  const shownEmoji = draft.premium?.emoji ?? cartoon.emoji;
  const shownBg = draft.premium?.bgColor ?? cartoon.bgColor;
  const avatarName = draft.photoUrl ? 'Your photo' : draft.premium ? draft.premium.name : `${cartoon.name} avatar`;
  const tagLabels = draft.selectedTags
    .map(slug => PLAY_TAGS.find(tag => tag.slug === slug)?.label)
    .filter((l): l is string => !!l);

  // Definite height so the picker pages (flex:1 ScrollViews) have room. In px:
  // a '%' height has no definite parent to resolve against inside the sheet's
  // backdrop. keyboardShrink caps it above the keyboard.
  const sheetHeight = Math.round(winH * 0.9);

  const formPage = (
    <>
      <View style={S.header}>
        <TouchableOpacity
          onPress={onClose}
          disabled={saving}
          style={S.headerSide}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Text style={[t.sub, { color: c.textSub }]}>Cancel</Text>
        </TouchableOpacity>
        <Text style={[t.title, S.headerTitle]} numberOfLines={1} accessibilityRole="header">
          Edit profile
        </Text>
        <View style={[S.headerSide, S.headerRight]}>
          <Button
            size="sm"
            title="Save"
            onPress={save}
            loading={saving}
            disabled={!dirty}
          />
        </View>
      </View>

      {/* Outside the scroll: Save lives in the fixed header, so its errors must
          show where the user is looking, not at scroll offset 0 (with the
          keyboard up and Tagline scrolled into view, a failed Save otherwise
          looked like nothing happened). The live region makes screen readers
          announce it too. Renders nothing when there is no status. */}
      <View accessibilityLiveRegion="polite">
        <StatusBanner status={status.value} style={S.banner} />
      </View>

      <ScrollView
        style={S.body}
        contentContainerStyle={S.bodyContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Avatar → avatar page */}
        <TouchableOpacity
          style={S.navRow}
          onPress={() => setPage('avatar')}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Avatar: ${avatarName}. Change`}
        >
          {draft.photoUrl ? (
            <CachedImage source={{ uri: draft.photoUrl }} style={S.avatar} />
          ) : (
            <View style={[S.avatar, { backgroundColor: shownBg }]}>
              <Text style={S.avatarEmoji}>{shownEmoji}</Text>
            </View>
          )}
          <View style={S.navText}>
            <Text style={t.title} numberOfLines={1}>Change avatar</Text>
            <Text style={t.sub} numberOfLines={1}>{avatarName}</Text>
          </View>
          <Icon name="chevron-right" size={16} color={c.textMuted} />
        </TouchableOpacity>

        <Text style={[t.fieldLabel, S.label]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Display name</Text>
        <TextInput
          style={[S.input, webInputFontFloor(S.input)]}
          value={draft.fullName}
          onChangeText={v => set('fullName', v.slice(0, NAME_MAX))}
          maxLength={NAME_MAX}
          placeholder="Your name"
          placeholderTextColor={c.textMuted}
          accessibilityLabel="Display name"
          returnKeyType="next"
        />

        <Text style={[t.fieldLabel, S.label]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Username</Text>
        <TextInput
          style={[S.input, webInputFontFloor(S.input)]}
          value={draft.username}
          onChangeText={v => set('username', v)}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="your handle"
          placeholderTextColor={c.textMuted}
          accessibilityLabel="Username"
        />
        <Text style={[t.meta, S.hint]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
          How you appear in league standings.
        </Text>

        <Text style={[t.fieldLabel, S.label]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Tagline</Text>
        <TextInput
          style={[S.input, webInputFontFloor(S.input)]}
          value={draft.tagline}
          onChangeText={v => set('tagline', v.slice(0, TAGLINE_MAX))}
          maxLength={TAGLINE_MAX}
          placeholder="Describe yourself in 50 chars…"
          placeholderTextColor={c.textMuted}
          accessibilityLabel="Tagline"
        />
        <Text
          style={[t.meta, S.hint, draft.tagline.length > TAGLINE_MAX - 6 && { color: c.warning }]}
          maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
        >
          {draft.tagline.length}/{TAGLINE_MAX}
        </Text>

        <Text style={[t.fieldLabel, S.label]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Gender</Text>
        <Text style={[t.sub, S.genderHint]} numberOfLines={2}>
          Sorts your doubles matches into Gendered or Mixed. Until set, they count as neither.
        </Text>
        <FilterChipRow<Gender | ''>
          size="md"
          scrollable={false}
          options={GENDER_OPTIONS}
          // '' = not set yet: no chip selected.
          value={draft.gender ?? ''}
          onChange={v => set('gender', v === '' ? null : v)}
        />

        {/* Tags → tags page */}
        <TouchableOpacity
          style={[S.navRow, S.navRowTop]}
          onPress={() => setPage('tags')}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Play style tags, ${draft.selectedTags.length} of ${maxTagSlots}. Edit`}
        >
          <View style={S.navText}>
            <Text style={t.title} numberOfLines={1}>Play style tags</Text>
            <Text style={t.sub} numberOfLines={1}>
              {tagLabels.length > 0 ? tagLabels.join(' · ') : `Pick up to ${maxTagSlots} that describe your game`}
            </Text>
          </View>
          <Text style={[t.meta, { color: c.textSub }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {draft.selectedTags.length}/{maxTagSlots}
          </Text>
          <Icon name="chevron-right" size={16} color={c.textMuted} />
        </TouchableOpacity>

        {/* The whole 56 row is the control: RNW's Switch is about 40x20, under
            the 44pt rule (and hitSlop doesn't apply on web). */}
        <TouchableOpacity
          style={[S.navRow, S.switchRow]}
          onPress={() => set('badgesPublic', !draft.badgesPublic)}
          activeOpacity={0.7}
          accessibilityRole="switch"
          accessibilityState={{ checked: draft.badgesPublic }}
          accessibilityLabel="Show badges on my public profile"
        >
          <View style={S.navText}>
            <Text style={t.title} numberOfLines={2}>Show badges on my public profile</Text>
            <Text style={t.sub} numberOfLines={1}>{draft.badgesPublic ? 'Public' : 'Private'}</Text>
          </View>
          {/* Visual only, so one tap toggles once (a live Switch would also
              fire its own change) and a screen reader reads the row, not both. */}
          <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            <ThemedSwitch value={draft.badgesPublic} />
          </View>
        </TouchableOpacity>
      </ScrollView>
    </>
  );

  return (
    <BottomSheet
      visible={visible}
      onClose={handleDismiss}
      height={sheetHeight}
      keyboardShrink
      cardStyle={S.card}
      contentStyle={S.content}
    >
      {page === 'avatar' ? (
        <AvatarPickerModal
          presentation="page"
          visible
          userId={userId}
          currentAvatarId={draft.avatarId}
          currentPhotoUrl={draft.photoUrl}
          currentPremium={draft.premium}
          earnedBadgeNames={earnedBadgeNames}
          purchasedAvatars={purchasedAvatars}
          onChange={(id, url, premium) => setDraft(d => ({ ...d, avatarId: id, photoUrl: url, premium }))}
          onUploadingChange={setUploading}
          onSave={(id, url, premium) => {
            setDraft(d => ({ ...d, avatarId: id, photoUrl: url, premium }));
            setPage('form');
          }}
          onClose={() => setPage('form')}
        />
      ) : page === 'tags' ? (
        <TagPickerModal
          presentation="page"
          visible
          selectedTags={draft.selectedTags}
          maxSlots={maxTagSlots}
          earnedBadgeNames={earnedBadgeNames}
          onChange={tags => set('selectedTags', tags)}
          onSave={tags => { set('selectedTags', tags); setPage('form'); }}
          onClose={() => setPage('form')}
        />
      ) : (
        formPage
      )}
    </BottomSheet>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    // Over BottomSheet's card: edge to edge on phones, a centred column on
    // wide web; no card padding (the header and pages bring their own).
    card: {
      width: '100%',
      maxWidth: SHEET_MAX_WIDTH,
      alignSelf: 'center',
      borderTopLeftRadius: RADIUS.lg,
      borderTopRightRadius: RADIUS.lg,
      overflow: 'hidden',
      paddingHorizontal: 0,
      paddingTop: 0,
      paddingBottom: Platform.OS === 'ios' ? SPACE.xl : 0,
    },
    // The page (form or picker) fills the card and shrinks with it.
    content: { minHeight: 0 },

    header: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 44,
      paddingHorizontal: SPACE.lg,
      paddingTop: SPACE.sm,
      paddingBottom: SPACE.xs,
      borderBottomWidth: HAIRLINE,
      borderBottomColor: c.border,
      gap: SPACE.sm,
    },
    // Both sides the same width so the title stays centred.
    headerSide:  { minWidth: 72, minHeight: 44, justifyContent: 'center' },
    headerRight: { alignItems: 'flex-end' },
    headerTitle: { flex: 1, textAlign: 'center' },

    body:        { flex: 1, minHeight: 0 },
    bodyContent: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.xl },

    navRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACE.md,
      minHeight: 56,
      paddingVertical: SPACE.sm,
    },
    navRowTop:   { marginTop: SPACE.md, borderTopWidth: HAIRLINE, borderTopColor: c.border },
    switchRow:   { borderTopWidth: HAIRLINE, borderTopColor: c.border },
    navText:     { flex: 1, minWidth: 0, gap: SPACE.xxs },
    avatar:      { width: AVATAR, height: AVATAR, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji: { fontSize: 34 },

    label:      { marginTop: SPACE.md, marginBottom: SPACE.xs },
    hint:       { marginTop: SPACE.xs },
    genderHint: { marginBottom: SPACE.xs },
    input: {
      minHeight: 44,
      borderWidth: HAIRLINE,
      borderColor: c.border,
      borderRadius: RADIUS.md,
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      // Web raises this to 16 at the input (webInputFontFloor): iOS Safari
      // zooms the page when a focused input's font is under 16px, pushing the
      // sheet's Save off screen.
      fontSize: FONT.size.lg,
      color: c.text,
      backgroundColor: c.surfaceAlt,
    },
    // StatusBanner keeps its own top margin; the scroll content below already
    // has top padding.
    banner: { marginHorizontal: SPACE.lg, marginBottom: 0 },
  });
}
