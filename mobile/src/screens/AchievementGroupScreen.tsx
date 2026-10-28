// An achievements group's "View all": every medal of one group in a grid
// (foundation AchievementGrid), same detail sheet as the Achievements page.
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  AchievementGrid,
  summarizeGroup,
} from '@just-messin-around/expo-foundation/achievements';
import { ErrorState, EmptyState } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { RootStackParamList } from '../types';
import { useAchievements } from '../lib/useAchievements';
import { useStatusMessage } from '../lib/useStatusMessage';
import type { PickleagueAchievement, PickleagueAchievementMeta } from '../lib/achievements';
import AchievementSheet from '../components/AchievementSheet';
import { useFtueChecklist } from '../components/FtueChecklistCard';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';

type Props = NativeStackScreenProps<RootStackParamList, 'AchievementGroup'>;

export default function AchievementGroupScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const status = useStatusMessage();
  const { groupId, userId: userIdParam } = route.params;
  const { loading, error, data, own, userId, reload, setHidden } =
    useAchievements(userIdParam, msg => status.error(msg));
  const refresh = useRefresh(reload);
  const ftue = useFtueChecklist({ profile: own ? data?.profile ?? null : null, navigation });
  const [openId, setOpenId] = useState<string | null>(null);

  const group = data?.groups.find(g => g.id === groupId) ?? null;
  const list = useMemo(
    () => (data?.achievements ?? []).filter(a => a.groupId === groupId),
    [data, groupId],
  );
  const summary = useMemo(() => summarizeGroup(list), [list]);
  const open: PickleagueAchievement | null = openId ? list.find(a => a.id === openId) ?? null : null;

  useEffect(() => {
    const title = group?.title ?? route.params.title;
    if (title) navigation.setOptions({ title });
  }, [group?.title, route.params.title, navigation]);

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
      {group && summary.total > 0 ? (
        <>
          <Text style={t.sub}>{own ? summary.label : `${summary.earned} unlocked`}</Text>
          <AchievementGrid<PickleagueAchievementMeta>
            group={group}
            achievements={list}
            openDetail={false}
            onPressAchievement={a => setOpenId(a.id)}
          />
        </>
      ) : (
        <EmptyState iconName="medal" title="Nothing here yet" subtitle="Achievements in this group show here once there are any." />
      )}
      <AchievementSheet
        achievement={open}
        group={group}
        own={own}
        userId={userId}
        navigation={navigation}
        onClose={() => setOpenId(null)}
        onSetHidden={(a, hidden) => void setHidden(a, hidden)}
        ftue={own ? ftue : null}
        onClaimed={() => void reload()}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { padding: SPACE.lg, paddingBottom: SPACE.xl, gap: SPACE.md, flexGrow: 1 },
});
