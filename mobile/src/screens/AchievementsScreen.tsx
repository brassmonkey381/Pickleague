// Achievements (Reddit-style): one shelf of round medals per group ("League ·
// 3 of 12 unlocked", View all), paged sideways, earned ones with their date,
// locked ones grey, in-progress ones with a bar ("21/30 days"). Tap a medal
// for the detail sheet (components/AchievementSheet).
//
// Own page (no userId, or mine): everything, with progress, the streak chip,
// the Getting started quests and the hide-from-profile toggles. It replaces
// UnlockProgress (that route now redirects here). `focus` (a badge name or an
// achievement id) opens that one's sheet on arrival: Me's "Next unlock" row.
// Another player's page: their earned achievements only, hidden ones left
// out, nothing when their badges are private.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  AchievementsScreenBody,
  type AchievementGroup,
} from '@just-messin-around/expo-foundation/achievements';
import { Panel, ErrorState, EmptyState, TextLink } from '@just-messin-around/expo-foundation/ui';
import { ProgressBar } from '@just-messin-around/expo-foundation/gamification';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { useAchievements } from '../lib/useAchievements';
import { useStatusMessage } from '../lib/useStatusMessage';
import {
  isHiddenFromProfile,
  overallSummary,
  type PickleagueAchievement,
  type PickleagueAchievementMeta,
} from '../lib/achievements';
import AchievementSheet from '../components/AchievementSheet';
import { useFtueChecklist } from '../components/FtueChecklistCard';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';

type Props = NativeStackScreenProps<RootStackParamList, 'Achievements'>;

/** Another player's summary: everything shown is earned, so "x of x" says nothing. */
const othersCopy = { summary: (earned: number) => `${earned} unlocked` };

export default function AchievementsScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const status = useStatusMessage();
  const userIdParam = route.params?.userId;
  const focus = route.params?.focus;
  const { loading, error, data, own, userId, reload, setHidden, setAllHidden } =
    useAchievements(userIdParam, msg => status.error(msg));
  const refresh = useRefresh(reload);
  const ftue = useFtueChecklist({ profile: own ? data?.profile ?? null : null, navigation });
  const [open, setOpen] = useState<{ a: PickleagueAchievement; g: AchievementGroup } | null>(null);

  useEffect(() => {
    const name = route.params?.userName;
    if (!own && name) navigation.setOptions({ title: `${name}'s achievements` });
  }, [own, route.params?.userName, navigation]);

  // `focus`: open that achievement's sheet once, when the data first lands.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !focus || !data) return;
    focused.current = true;
    const a = data.achievements.find(x => x.id === focus || x.id === `badge:${focus}`);
    const g = a && data.groups.find(x => x.id === a.groupId);
    if (a && g) setOpen({ a, g });
  }, [focus, data]);

  // Keep an open sheet in step with a reload (a hide toggle, a claim).
  const openLive = useMemo(() => {
    if (!open || !data) return open;
    const a = data.achievements.find(x => x.id === open.a.id);
    return a ? { a, g: open.g } : open;
  }, [open, data]);

  const summary = useMemo(() => overallSummary(data?.achievements ?? []), [data]);
  const shown = useMemo(() => {
    const earned = (data?.achievements ?? []).filter(a =>
      !!a.earnedAt && (a.meta?.kind === 'collectible' || (a.meta?.awards.length ?? 0) > 0));
    return { total: earned.length, visible: earned.filter(a => !isHiddenFromProfile(a.meta)).length };
  }, [data]);

  if (loading) return <View style={[styles.screen, { backgroundColor: c.bg }]}><SkeletonList rows={6} variant="row" /></View>;

  if (error && !data) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <ErrorState iconName="offline" error={error} message={`Couldn't load achievements. ${error}`} onRetry={() => void reload()} />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={styles.container}
      refreshControl={<AppRefreshControl {...refresh} />}
    >
      {own ? (
        <Panel style={styles.header}>
          <ProgressBar
            layout="inline"
            progress={summary.total ? summary.earned / summary.total : 0}
            minFill={0.02}
            height={6}
            trackColor={c.border}
            label={`${summary.earned} of ${summary.total} unlocked`}
            valueText={`${summary.total ? Math.round((summary.earned / summary.total) * 100) : 0}%`}
          />
          {shown.total > 0 ? (
            <View style={styles.shownRow}>
              <Text style={[t.meta, styles.flex]} numberOfLines={1} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                {profileVisibilityText(shown, data?.profile?.badges_public !== false)}
              </Text>
              {shown.visible < shown.total ? (
                <TextLink label="Show all" chevron={false} onPress={() => void setAllHidden(false)} accessibilityLabel="Show all badges on my profile" />
              ) : null}
              {shown.visible > 0 ? (
                <TextLink label="Hide all" chevron={false} onPress={() => void setAllHidden(true)} accessibilityLabel="Hide all badges from my profile" />
              ) : null}
            </View>
          ) : null}
        </Panel>
      ) : null}

      {data?.private ? (
        <EmptyState iconName="lock" title="Private" subtitle="This player keeps their achievements private." />
      ) : (
        <AchievementsScreenBody<PickleagueAchievementMeta>
          groups={data?.groups ?? []}
          achievements={data?.achievements ?? []}
          openDetail={false}
          onPressAchievement={(a, g) => setOpen({ a, g })}
          onViewAll={g => navigation.navigate('AchievementGroup', {
            groupId: g.id, title: g.title, userId: userIdParam, userName: route.params?.userName,
          })}
          copy={own ? undefined : othersCopy}
          emptyState={<EmptyState iconName="medal" title="No achievements yet" subtitle={own ? 'Play a match to earn your first.' : 'Nothing unlocked yet.'} />}
        />
      )}

      <AchievementSheet
        achievement={openLive?.a ?? null}
        group={openLive?.g ?? null}
        own={own}
        userId={userId}
        navigation={navigation}
        onClose={() => setOpen(null)}
        onSetHidden={(a, hidden) => void setHidden(a, hidden)}
        ftue={own ? ftue : null}
        onClaimed={() => void reload()}
      />
    </ScrollView>
  );
}

/** "Shown on your profile: 10 of 12" (or the private-profile note). */
export function profileVisibilityText(shown: { total: number; visible: number }, isPublic: boolean): string {
  if (!isPublic) return 'Your badges are private (Edit profile to change)';
  return `Shown on your profile: ${shown.visible} of ${shown.total}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { padding: SPACE.lg, paddingBottom: SPACE.xl, gap: SPACE.lg, flexGrow: 1 },
  header: { gap: SPACE.sm },
  shownRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 32 },
  flex: { flex: 1, minWidth: 0 },
});
