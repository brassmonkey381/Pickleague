// Settings > Privacy, the court presence rows (rendered inside that section's
// Panel, under Blocked players):
//
//   Who sees me at the courts                          ›
//   Friends and league-mates
//   Hidden from                                        ›
//   2 players
//
// "Who sees my planned games" (presence_settings.plans_level) returns with
// Phase 3, when games can be planned (court_plans); until then it would be a
// control for nothing.
//
// Each opens a sheet: the level list (saved on tap), or the hide-from list with
// a Show button per player (people are added from the "⋯" menu on a profile).
// The rows copy SettingsScreen's ActionRow metrics so the section reads as one
// list. The server holds every value (presence_settings, presence_hidden_from);
// a read that failed says so and retries on tap instead of showing defaults.
//
// Not behind FRIENDS_AT_COURTS_ENABLED: check-ins name players from the day
// the presence SQL is live, so these controls (and the consent sheet that
// points here) ship with them.
import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BottomSheet } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../../lib/ThemeContext';
import { useToast } from '../../lib/useToast';
import { explainRefusal } from '../../lib/refusalNotices';
import {
  CHECKINS_LEVELS,
  LEAGUEMATES_NOTE,
  OTHERS_NOTE,
  checkinsLevelLabel,
  type CheckinsLevel,
} from '../../lib/presencePrivacy';
import {
  hidePresenceFrom,
  setPresenceSettings,
  usePresenceHidden,
  usePresenceSettings,
  type PresenceHiddenPlayer,
} from '../../data/presenceSettings';
import LevelChoiceList from './LevelChoiceList';

type Colors = ReturnType<typeof useTheme>['colors'];
type Sheet = null | 'checkins' | 'hidden';

export default function PresencePrivacyRows() {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const settings = usePresenceSettings();
  const hidden = usePresenceHidden();
  const [sheet, setSheet] = useState<Sheet>(null);

  const s = settings.data;
  const settingsFailed = !s && settings.error != null;
  const hiddenCount = hidden.data?.length;
  const open = (which: Exclude<Sheet, null>) => () => {
    if (which !== 'hidden' && !s) {
      void settings.refresh();
      return;
    }
    if (which === 'hidden' && hidden.data === undefined) void hidden.refresh();
    setSheet(which);
  };

  return (
    <>
      <View style={S.divider} />
      <Row
        S={S}
        label="Who sees me at the courts"
        desc={s ? checkinsLevelLabel(s.checkins_level) : settingsFailed ? "Couldn't load. Tap to retry" : 'Loading…'}
        onPress={open('checkins')}
      />
      <View style={S.divider} />
      <Row
        S={S}
        label="Hidden from"
        desc={
          hiddenCount == null
            ? 'Players who only ever see "a player"'
            : hiddenCount === 0
              ? 'No one'
              : `${hiddenCount} player${hiddenCount === 1 ? '' : 's'}`
        }
        onPress={open('hidden')}
      />

      {s ? (
        <LevelSheet<CheckinsLevel>
          visible={sheet === 'checkins'}
          title="Who sees me at the courts"
          intro="Who sees your name when you check in at a court or play there."
          options={CHECKINS_LEVELS}
          value={s.checkins_level}
          save={(level) => setPresenceSettings({ checkinsLevel: level })}
          onClose={() => setSheet(null)}
        />
      ) : null}
      <HiddenFromSheet visible={sheet === 'hidden'} query={hidden} onClose={() => setSheet(null)} />
    </>
  );
}

function Row({ S, label, desc, onPress }: { S: Styles; label: string; desc: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={S.row} onPress={onPress} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`${label}: ${desc}`}>
      <View style={S.rowText}>
        <Text style={S.rowLabel} numberOfLines={1}>{label}</Text>
        <Text style={S.rowDesc} numberOfLines={1}>{desc}</Text>
      </View>
      <Text style={S.chevron}>›</Text>
    </TouchableOpacity>
  );
}

function LevelSheet<L extends string>({
  visible,
  title,
  intro,
  options,
  value,
  save,
  onClose,
}: {
  visible: boolean;
  title: string;
  intro: string;
  options: { value: L; label: string; desc: string }[];
  value: L;
  save: (level: L) => Promise<unknown>;
  onClose: () => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [saving, setSaving] = useState<L | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(level: L) {
    setSaving(level);
    setError(null);
    try {
      await save(level);
      onClose();
    } catch (e) {
      setError(explainRefusal(e, "Couldn't save that. Try again."));
    } finally {
      setSaving(null);
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} title={title}>
      <ScrollView style={sheetStyles.scroll} contentContainerStyle={sheetStyles.body}>
        <Text style={t.sub}>{intro}</Text>
        <LevelChoiceList options={options} value={value} onPick={(l) => void pick(l)} saving={saving} disabled={!!saving} />
        {error ? <Text style={[t.sub, { color: c.danger }]}>{error}</Text> : null}
        <Text style={t.hint}>{LEAGUEMATES_NOTE}</Text>
        <Text style={t.hint}>{OTHERS_NOTE}</Text>
      </ScrollView>
    </BottomSheet>
  );
}

function HiddenFromSheet({
  visible,
  query,
  onClose,
}: {
  visible: boolean;
  query: ReturnType<typeof usePresenceHidden>;
  onClose: () => void;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const rows = query.data;

  async function show(p: PresenceHiddenPlayer) {
    setBusyId(p.user_id);
    try {
      await hidePresenceFrom(p.user_id, false);
      toast.success(`${p.full_name ?? 'They'} can see you at the courts again, as your setting allows.`);
    } catch (e) {
      // A player who is gone gets the hide-specific words (lib/refusals).
      toast.error(explainRefusal(e, "Couldn't change that. Try again.", { action: 'hide' }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Hidden from">
      <ScrollView style={sheetStyles.scroll} contentContainerStyle={sheetStyles.body}>
        <Text style={t.sub}>
          These players see "a player" instead of your name at the courts, whatever your setting. Hide yourself from
          someone with the ⋯ menu on their profile.
        </Text>
        {rows === undefined ? (
          query.error != null ? (
            <View style={sheetStyles.state}>
              <Text style={t.sub}>{explainRefusal(query.error, "Couldn't load this list. Try again.")}</Text>
              <Button title="Retry" size="sm" variant="outline" onPress={() => void query.refresh()} style={sheetStyles.hug} />
            </View>
          ) : (
            <ActivityIndicator color={c.primary} style={sheetStyles.state} />
          )
        ) : rows.length === 0 ? (
          <Text style={[t.hint, sheetStyles.state]}>No one right now.</Text>
        ) : (
          rows.map((p, i) => (
            <View key={p.user_id} style={[sheetStyles.player, i > 0 && { borderTopWidth: HAIRLINE, borderTopColor: c.border }]}>
              <View style={[sheetStyles.avatar, { backgroundColor: c.surfaceAlt }]}>
                <Text style={t.sub}>{p.avatar_emoji || '🙂'}</Text>
              </View>
              <Text style={[t.title, sheetStyles.flex]} numberOfLines={1}>
                {p.full_name ?? 'Player'}
              </Text>
              <Button
                title="Show"
                size="sm"
                variant="outline"
                loading={busyId === p.user_id}
                disabled={busyId != null}
                onPress={() => void show(p)}
              />
            </View>
          ))
        )}
      </ScrollView>
    </BottomSheet>
  );
}

type Styles = ReturnType<typeof makeStyles>;

// SettingsScreen's row metrics (its `row`, `rowLabel`, `rowDesc`, `chevron`
// and `divider`), so these rows match the ones above them.
function makeStyles(c: Colors) {
  const t = textStyles(c);
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.sm, paddingHorizontal: SPACE.md, minHeight: 44 },
    rowText: { flex: 1, minWidth: 0 },
    rowLabel: t.title,
    rowDesc: { ...t.sub, marginTop: SPACE.xxs },
    chevron: { fontSize: FONT.size.h2, color: c.textMuted },
    divider: { height: HAIRLINE, backgroundColor: c.border, marginHorizontal: SPACE.md },
  });
}

const AVATAR = 32;

const sheetStyles = StyleSheet.create({
  // Sizes to its content, shrinking (and scrolling) only under the sheet's cap.
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { gap: SPACE.sm },
  state: { paddingVertical: SPACE.md, gap: SPACE.sm },
  hug: { alignSelf: 'flex-start' },
  player: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 52, paddingVertical: SPACE.xs },
  avatar: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, minWidth: 0 },
});
