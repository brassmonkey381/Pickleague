// Court Pass: this month's reward track (docs/court-pass.md; kit RewardTrack
// 1.94), ported from Doggle's ParkPassScreen. Rows come from get_reward_track
// (data/rewardTrack, via lib/useCourtPass), the model from the kit's
// buildRewardTrack, the art from lib/courtArt (components/courtPass/CourtRewardArt).
//
//   - Header: the cycle's title, the intro, today's pickleballs ("Today: N
//     pickleballs." with no daily cap, the server's daily_cap null; today is
//     the Pacific day, so a viewer whose clock isn't on Pacific time sees
//     "This Court Pass: N pickleballs." instead), and
//     "How to earn pickleballs" (a sheet listing every way to earn
//     and its amount, lib/courtPassCopy PICKLEBALL_WAYS, pinned to the SQL by
//     lib/__tests__/courtPassCopy.test.ts). A guest or a test account earns
//     nothing, and a panel says why and what to do.
//   - Free lane: every tier pays on its own when reached (no claim button).
//     A new grant celebrates once (confetti + a sheet listing what landed,
//     with a button to wear it, use it or place it), then is marked seen.
//   - Premium lane: one collapsed "Premium track coming soon" row. Never a
//     price, a buy / upgrade / notify button or a date (lib/courtPassCopy).
//   - Between passes: "Next Court Pass starts <date>" in the viewer's zone.
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RewardTrack } from '@just-messin-around/expo-foundation/gamification';
import type { RewardTrackCell, TrackReward } from '@just-messin-around/expo-foundation/gamification/rewardTrack';
import { BottomSheet, EmptyState, ErrorState, Panel, QueryState, celebrate } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { invalidateQueries, peekQuery } from '@just-messin-around/expo-foundation/cache';
import { SPACE, RADIUS, HAIRLINE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { explainRefusal } from '../lib/refusalNotices';
import { useCourtPass } from '../lib/useCourtPass';
import {
  COURT_PASS_GUEST,
  COURT_PASS_INTRO,
  COURT_PASS_PREMIUM_HINT,
  COURT_PASS_PREMIUM_SHEET,
  COURT_PASS_PREMIUM_TITLE,
  COURT_PASS_TEST_ACCOUNT,
  NEW_REWARDS_BODY,
  PICKLEBALL_RULES,
  PICKLEBALL_WAYS,
  courtPassEarnedLine,
  viewerOnPacificTime,
  newRewardsTitle,
  nextCourtPassLine,
} from '../lib/courtPassCopy';
import { courtArtFor, isEquippableSpec, type CourtArtSpec } from '../lib/courtArt';
import { markTrackRewardsSeen, unseenGrants, type CourtTrackReward, type RewardTrackData } from '../data/rewardTrack';
import { useItemArt } from '../data/myPlace';
import { equipShopItem, type EquippableItem } from '../data/cosmetics';
import { HOME_KEY, type HomeData } from '../components/home/homeData';
import CourtRewardArt from '../components/courtPass/CourtRewardArt';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'CourtPass'>;

/** The kit's cells hold the reward object as given (rewardTrack.ts), so `item` survives. */
const asCourt = (r: TrackReward) => r as CourtTrackReward;

/** The Shop item an equippable spec puts on (null: no shop id to equip by). */
function equippableItem(reward: CourtTrackReward, spec: CourtArtSpec): EquippableItem | null {
  if (spec.kind === 'avatar') {
    if (!spec.shopItemId) return null;
    return { id: spec.shopItemId, category: 'avatar', slug: spec.slug, payload: { emoji: spec.emoji, bgColor: spec.bgColor } };
  }
  if (spec.kind === 'name_style') {
    if (!spec.shopItemId) return null;
    return {
      id: spec.shopItemId,
      category: spec.mode === 'list' ? 'list_name_style' : 'profile_name_style',
      slug: spec.slug,
      payload: reward.item?.payload ?? {},
    };
  }
  return null;
}

export default function CourtPassScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const { query, data, model } = useCourtPass();

  const [detail, setDetail] = React.useState<RewardTrackCell | null>(null);
  const [fresh, setFresh] = React.useState<CourtTrackReward[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [howTo, setHowTo] = React.useState(false);
  // Cycle id + tiers already celebrated on this screen, so a re-read before
  // mark_track_rewards_seen lands doesn't celebrate the same tier twice.
  const celebrated = React.useRef(new Set<string>());

  // The name a name style is shown on: mine, from Home's cached profile.
  const firstName = React.useMemo(
    () => peekQuery<HomeData>(HOME_KEY)?.profile?.full_name?.trim().split(/\s+/)[0] || null,
    [],
  );

  // Decor art (home_item_art), read for this pass's decor rewards only.
  const decorIds = React.useMemo(
    () =>
      (data?.rewards ?? [])
        .filter((r) => r.kind === 'home_item')
        .map((r) => r.item?.id ?? r.itemKey)
        .filter((id): id is string => !!id),
    [data?.rewards],
  );
  const art = useItemArt(decorIds);

  // Celebrate new grants once: confetti, then the sheet of what landed.
  React.useEffect(() => {
    if (!data?.cycle) return;
    const cycleId = data.cycle.id;
    const tiers = unseenGrants(data)
      .map((g) => g.tier)
      .filter((tier) => !celebrated.current.has(`${cycleId}:${tier}`));
    if (tiers.length === 0) return;
    tiers.forEach((tier) => celebrated.current.add(`${cycleId}:${tier}`));
    const landed = data.rewards.filter((r) => r.lane === 'free' && tiers.includes(r.tier));
    if (landed.length === 0) return;
    celebrate();
    setFresh((prev) => [...prev, ...landed]);
  }, [data]);

  const closeFresh = React.useCallback(() => {
    setFresh([]);
    const cycleId = data?.cycle?.id;
    // Best effort: if it fails, the rewards just celebrate again next open.
    if (cycleId) markTrackRewardsSeen(cycleId).catch(() => {});
  }, [data?.cycle?.id]);

  /** Owned for real (a paid grant row exists), so equip_shop_item will accept it. */
  const isGranted = React.useCallback(
    (reward: TrackReward) => !!data?.grants.some((g) => g.lane === reward.lane && g.tier === reward.tier),
    [data],
  );

  async function equip(reward: CourtTrackReward, spec: CourtArtSpec) {
    const item = equippableItem(reward, spec);
    if (!item) return;
    setBusy(`${reward.lane}:${reward.tier}`);
    try {
      await equipShopItem(item);
      // Home's greeting draws my avatar from its cached profile.
      invalidateQueries(HOME_KEY);
      toast.success(spec.kind === 'avatar' ? `You're wearing ${reward.title}.` : `Your name now shows ${reward.title}.`);
    } catch (e) {
      toast.error(explainRefusal(e, "Couldn't put that on just now. Try again, or open your Profile to do it there."));
    } finally {
      setBusy(null);
    }
  }

  const openMyPlace = React.useCallback(() => {
    setDetail(null);
    setFresh([]);
    navigation.navigate('MyPlace');
  }, [navigation]);

  const renderArt = React.useCallback(
    (reward: TrackReward, size: number) => {
      const r = asCourt(reward);
      const id = r.kind === 'home_item' ? r.item?.id ?? r.itemKey : null;
      return <CourtRewardArt reward={r} size={size} svg={id ? art[id] ?? null : null} name={firstName} />;
    },
    [art, firstName],
  );

  /** The action for an owned free item: wear it, use it, or open My Place to place it. Null otherwise. */
  function actionButton(reward: TrackReward, onDecor: () => void) {
    if (reward.lane !== 'free' || !isGranted(reward)) return null;
    const r = asCourt(reward);
    const spec = courtArtFor(r);
    if (spec.kind === 'decor') {
      return <Button title="Open My Place" variant="outline" size="sm" onPress={onDecor} style={styles.hug} />;
    }
    if (!isEquippableSpec(spec) || !equippableItem(r, spec)) return null;
    return (
      <Button
        title={spec.kind === 'avatar' ? 'Wear it' : 'Use this name style'}
        size="sm"
        loading={busy === `${reward.lane}:${reward.tier}`}
        disabled={busy != null}
        onPress={() => void equip(r, spec)}
        style={styles.hug}
      />
    );
  }

  return (
    <View style={[styles.page, { backgroundColor: c.bg }]}>
      <QueryState
        query={query}
        loadingLabel="Loading the Court Pass..."
        renderError={(e, retry) => (
          <ErrorState
            error={e}
            message={explainRefusal(e, "Couldn't load the Court Pass just now. Try again in a moment.")}
            onRetry={retry}
          />
        )}
      >
        {(d: RewardTrackData) =>
          !model || !d.cycle ? (
            <ScrollView contentContainerStyle={styles.emptyWrap}>
              <EmptyState
                iconName="pickleball"
                title={nextCourtPassLine(d.nextStartsAt)}
                subtitle={COURT_PASS_INTRO}
                actionLabel="Open My Place"
                onAction={() => navigation.navigate('MyPlace')}
              />
            </ScrollView>
          ) : (
            <RewardTrack
              model={model}
              renderRewardArt={renderArt}
              onPressReward={setDetail}
              premiumTitle={COURT_PASS_PREMIUM_TITLE}
              premiumHint={COURT_PASS_PREMIUM_HINT}
              testID="court-pass"
              header={
                <View style={styles.header}>
                  <Text style={t.h1}>{d.cycle.title}</Text>
                  <Text style={t.bodySub}>{COURT_PASS_INTRO}</Text>
                  <Text style={[t.meta, { color: c.textSub }]}>{courtPassEarnedLine(d.me, viewerOnPacificTime())}</Text>
                  <Button
                    title="How to earn pickleballs"
                    variant="outline"
                    size="sm"
                    iconName="pickleball"
                    onPress={() => setHowTo(true)}
                    style={styles.hug}
                  />
                  {d.me.notEarning === 'guest' ? (
                    <Panel style={styles.notice}>
                      <Text style={t.body}>{COURT_PASS_GUEST}</Text>
                      <Button
                        title="Finish signing up"
                        size="sm"
                        onPress={() => navigation.navigate('UpgradeAccount')}
                        style={styles.hug}
                      />
                    </Panel>
                  ) : d.me.notEarning === 'test_account' ? (
                    <Panel style={styles.notice}>
                      <Text style={t.body}>{COURT_PASS_TEST_ACCOUNT}</Text>
                    </Panel>
                  ) : null}
                </View>
              }
            />
          )
        }
      </QueryState>

      <BottomSheet visible={!!detail && fresh.length === 0} onClose={() => setDetail(null)} title={detail?.reward.title}>
        {detail ? <DetailBody cell={detail} renderArt={renderArt} action={actionButton(detail.reward, openMyPlace)} /> : null}
      </BottomSheet>

      <BottomSheet
        visible={howTo && !detail && fresh.length === 0}
        onClose={() => setHowTo(false)}
        title="How to earn pickleballs"
        titleIconName="pickleball"
      >
        <ScrollView style={styles.howScroll} contentContainerStyle={styles.sheetBody}>
          {PICKLEBALL_WAYS.map((w) => (
            <View key={w.title} style={[styles.row, { borderColor: c.border, backgroundColor: c.surface }]}>
              <View style={styles.rowText}>
                <Text style={[t.title, { color: c.text }]}>{w.title}</Text>
                <Text style={t.sub}>{w.detail}</Text>
              </View>
              <Text style={[t.title, { color: c.primary }]}>+{w.amount}</Text>
            </View>
          ))}
          <Text style={t.bodySub}>{PICKLEBALL_RULES}</Text>
          <Button title="Got it" onPress={() => setHowTo(false)} />
        </ScrollView>
      </BottomSheet>

      <BottomSheet visible={fresh.length > 0} onClose={closeFresh} title={newRewardsTitle(fresh.length)} titleIconName="celebrate">
        <ScrollView style={styles.howScroll} contentContainerStyle={styles.sheetBody}>
          <Text style={t.bodySub}>{NEW_REWARDS_BODY}</Text>
          {fresh.map((r) => (
            <View key={`${r.lane}:${r.tier}`} style={[styles.row, { borderColor: c.border, backgroundColor: c.surface }]}>
              {renderArt(r, 56)}
              <View style={styles.rowText}>
                <Text style={[t.title, { color: c.text }]}>{r.title}</Text>
                <Text style={t.meta}>Tier {r.tier}</Text>
                {actionButton(r, () => {
                  closeFresh();
                  openMyPlace();
                })}
              </View>
            </View>
          ))}
          <Button title="Nice!" onPress={closeFresh} />
        </ScrollView>
      </BottomSheet>
    </View>
  );
}

/** One reward up close: the art, its state, why, and what to do. Premium says "Coming soon" and nothing more. */
function DetailBody({
  cell,
  renderArt,
  action,
}: {
  cell: RewardTrackCell;
  renderArt: (reward: TrackReward, size: number) => React.ReactNode;
  action: React.ReactNode;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const premium = cell.state === 'premium_coming_soon';
  const rarity = cell.reward.rarity;
  const rarityTag =
    rarity === 'legendary'
      ? { label: 'Legendary', fg: c.rarityLegendary, bg: c.rarityLegendaryLight }
      : rarity === 'rare'
        ? { label: 'Rare', fg: c.rarityRare, bg: c.rarityRareLight }
        : null;
  return (
    <View style={styles.sheetBody}>
      <View style={styles.detailArt}>{renderArt(cell.reward, 112)}</View>
      <View style={styles.tags}>
        <Text
          style={[
            t.meta,
            styles.tag,
            { color: premium ? c.rarityRare : c.textSub, backgroundColor: premium ? c.rarityRareLight : c.surfaceAlt },
          ]}
        >
          {premium ? COURT_PASS_PREMIUM_SHEET : cell.statusLabel}
        </Text>
        {rarityTag ? (
          <Text style={[t.meta, styles.tag, { color: rarityTag.fg, backgroundColor: rarityTag.bg }]}>{rarityTag.label}</Text>
        ) : null}
        <Text style={[t.meta, styles.tag, { color: c.textSub, backgroundColor: c.surfaceAlt }]}>Tier {cell.reward.tier}</Text>
      </View>
      {premium ? null : (
        <>
          <Text style={[t.body, { color: c.text }]}>{cell.reason}</Text>
          {cell.nextStep ? <Text style={t.bodySub}>{cell.nextStep}</Text> : null}
          {action}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: { gap: SPACE.sm, marginBottom: SPACE.md },
  notice: { gap: SPACE.sm, marginTop: SPACE.xs },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', padding: SPACE.xl },
  sheetBody: { gap: SPACE.md, paddingBottom: SPACE.sm },
  detailArt: { alignItems: 'center' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs + 2 },
  tag: { paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xxs, borderRadius: RADIUS.sm, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.md,
    padding: SPACE.sm + 2,
    borderRadius: RADIUS.md,
    borderWidth: HAIRLINE,
  },
  rowText: { flex: 1, gap: SPACE.xxs },
  hug: { alignSelf: 'flex-start' },
  howScroll: { flexShrink: 1 },
});
