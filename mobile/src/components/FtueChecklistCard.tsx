import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { ListCard } from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useToast } from '../lib/useToast';
import { useTheme } from '../lib/ThemeContext';
import { useTour } from '../lib/TourContext';
import { discoverTarget } from '../lib/discoverNav';
import { Profile } from '../types';

// The three starter quests (join a league, set up your profile, record a
// match), each worth pickles once (claim_ftue_step).
//
// Two surfaces share this file:
//   - UnlockProgress → Getting started (UnlockProgressScreen) renders the
//     default export (alwaysShow + embedded), a progress tracker that stays
//     visible when everything is done. Profile links there from its status strip.
//   - Home's Get started panel (components/home/GetStartedPanel) uses
//     useFtueChecklist + FtueStepRow, so the steps sit as rows in one Panel next
//     to the guest / DUPR offers (plan section 3).
//
// Home passes `inLeague` from its own loadHome (one membership query, not two)
// and the hook re-reads the grants on every focus, so after a Join (on Home or
// in Leagues) the step flips to "Claim +500" as soon as the user is back.
// No double claim: the RPC is idempotent ("Already claimed"), and a synchronous
// in-flight ref stops a double tap from even sending the second request.

export type FtueStepId = 'join_league' | 'setup_profile' | 'first_match';

export const FTUE_REWARDS: Record<FtueStepId, number> = {
  join_league: 500,
  setup_profile: 500,
  first_match: 1000,
};

export type FtueStep = {
  id: FtueStepId;
  title: string;
  reward: number;
  complete: boolean;
  claimed: boolean;
  /** Complete and not yet claimed. */
  canClaim: boolean;
  busy: boolean;
  /** Screen to send the user to when the step is incomplete. */
  navTo: () => void;
};

type Nav = { navigate: (...args: any[]) => void };

export type UseFtueChecklistOpts = {
  profile: Profile | null;
  // The card only navigates, so accept any screen's nav prop (Home, Profile, …)
  // by typing just the method we use. Avoids route-param variance conflicts.
  navigation: Nav;
  onClaimed?: (newBalance: number) => void;
  /** Membership from the caller's own load (Home). Omitted: the hook queries it. */
  inLeague?: boolean;
};

export type FtueChecklist = {
  loading: boolean;
  steps: FtueStep[];
  /** Steps whose task is done (claimed or not): "1 of 3". */
  completeCount: number;
  /** Pickles waiting on a Claim button. */
  claimableTotal: number;
  allClaimed: boolean;
  claim: (step: FtueStepId) => Promise<void>;
  reload: () => Promise<void>;
};

export function useFtueChecklist({ profile, navigation, onClaimed, inLeague: inLeagueProp }: UseFtueChecklistOpts): FtueChecklist {
  const { armTour } = useTour();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [inLeagueOwn, setInLeagueOwn] = useState(false);
  const [claimed, setClaimed] = useState<Set<FtueStepId>>(new Set());
  // Steps mid-claim (disables the button). The ref is the synchronous guard:
  // state lands a render late, so two quick taps would both reach the RPC.
  const [claiming, setClaiming] = useState<Set<FtueStepId>>(new Set());
  const inFlight = useRef(new Set<FtueStepId>());
  const ownMembership = inLeagueProp === undefined;

  const load = useCallback(async () => {
    // LOCAL session read (getUser() is a network call that fails offline).
    const uid = await currentUserId(supabase);
    if (!uid) { setLoading(false); return; }
    try {
      const [memberRows, grantRows] = await Promise.all([
        ownMembership
          ? sbCall(() => supabase.from('league_members').select('league_id').eq('user_id', uid).limit(1))
          : Promise.resolve(null),
        sbCall(() => supabase.from('ftue_grants').select('step').eq('user_id', uid)),
      ]);
      if (ownMembership) setInLeagueOwn(((memberRows ?? []) as unknown[]).length > 0);
      setClaimed(new Set(((grantRows ?? []) as { step: FtueStepId }[]).map(r => r.step)));
    } catch {
      // A failed read would otherwise re-show already-claimed steps as
      // claimable; leave the last known state and let the next load correct it.
    } finally {
      setLoading(false);
    }
  }, [ownMembership]);

  useEffect(() => { void load(); }, [load]);
  // Back from Leagues / MatchEntry / Profile: re-read, so a step finished
  // elsewhere shows its Claim button without a pull-to-refresh.
  const focusCount = useRef(0);
  useFocusEffect(useCallback(() => {
    focusCount.current += 1;
    if (focusCount.current > 1) void load(); // the mount effect covers the first
  }, [load]));

  const inLeague = inLeagueProp ?? inLeagueOwn;
  // Completion is derived from server-truth fields. The RPC re-verifies before
  // granting, so these only gate the UI affordance.
  const profileSetUp = !!(
    profile?.avatar_emoji ||
    profile?.tagline ||
    (profile?.selected_tags?.length ?? 0) > 0
  );
  const hasMatch = (profile?.total_matches_played ?? 0) > 0;
  const isComplete: Record<FtueStepId, boolean> = {
    join_league: inLeague,
    setup_profile: profileSetUp,
    first_match: hasMatch,
  };

  // Arm the matching spotlight tour BEFORE navigating so it starts once the
  // destination screen's first anchor mounts (no-op if already seen). The
  // leagues tour runs on Discover's Leagues tab, which registers its anchors
  // only while it is the tab showing (plan C5), so it is opened on that tab.
  const openLeagues = () => {
    const target = discoverTarget({ tab: 'leagues' });
    if (target) navigation.navigate(target[0], target[1]);
  };
  const defs: { id: FtueStepId; title: string; navTo: () => void }[] = [
    { id: 'join_league',   title: 'Join a league',           navTo: () => { armTour('leagues'); openLeagues(); } },
    { id: 'setup_profile', title: 'Set up your profile',     navTo: () => { armTour('profile'); navigation.navigate('Profile', {}); } },
    { id: 'first_match',   title: 'Record your first match', navTo: () => { armTour('leagues'); openLeagues(); } },
  ];

  const steps: FtueStep[] = defs.map(d => {
    const complete = isComplete[d.id];
    const isClaimed = claimed.has(d.id);
    return {
      ...d,
      reward: FTUE_REWARDS[d.id],
      complete,
      claimed: isClaimed,
      canClaim: complete && !isClaimed,
      busy: claiming.has(d.id),
    };
  });

  async function claim(step: FtueStepId) {
    if (inFlight.current.has(step) || claimed.has(step)) return;
    inFlight.current.add(step);
    setClaiming(prev => new Set(prev).add(step));
    try {
      // The RPC is idempotent ("Already claimed"), so retrying a dropped
      // request can't double-grant pickles.
      const data = await sbCall(() => supabase.rpc('claim_ftue_step', { p_step: step }));
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.success) {
        setClaimed(prev => new Set(prev).add(step));
        if (typeof row.new_balance === 'number') onClaimed?.(row.new_balance);
      } else if (row?.message === 'Already claimed') {
        // Server says it's already granted — reconcile local state.
        setClaimed(prev => new Set(prev).add(step));
      }
    } catch (e) {
      // Tapping "Claim" and seeing nothing at all reads as the reward being
      // taken; say what happened so the user knows to try again.
      toast.error(friendlySbMessage(e, "Couldn't claim that just now."));
    } finally {
      inFlight.current.delete(step);
      setClaiming(prev => { const next = new Set(prev); next.delete(step); return next; });
    }
  }

  return {
    loading,
    steps,
    completeCount: steps.filter(st => st.complete).length,
    claimableTotal: steps.filter(st => st.canClaim).reduce((sum, st) => sum + st.reward, 0),
    allClaimed: steps.every(st => st.claimed),
    claim,
    reload: load,
  };
}

/** One starter quest as a row (ListCard variant='row'): ✓ / ○, the title, and
 *  Claim +N / Claimed / Go ›. Incomplete rows open the screen that finishes it. */
export function FtueStepRow({
  step,
  onClaim,
  onGo,
  lastRow,
}: {
  step: FtueStep;
  onClaim: () => void;
  onGo: () => void;
  lastRow?: boolean;
}) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const s = makeStyles(c);
  const trailing = step.canClaim ? (
    <Button
      size="sm"
      title={step.busy ? 'Claiming' : `Claim +${step.reward} 🥒`}
      loading={step.busy}
      disabled={step.busy}
      onPress={onClaim}
    />
  ) : step.claimed ? (
    <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Claimed</Text>
  ) : step.complete ? null : (
    <Text style={[t.meta, { color: c.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Go ›</Text>
  );
  return (
    <ListCard
      variant="row"
      lastRow={lastRow}
      leading={
        <View style={s.checkBox}>
          <Text style={[t.title, { color: step.complete ? c.primary : c.textMuted }]}>{step.complete ? '✓' : '○'}</Text>
        </View>
      }
      title={
        <Text style={[t.title, step.complete && { color: c.textMuted }]} numberOfLines={1}>
          {step.title}
        </Text>
      }
      trailing={trailing ?? undefined}
      // Done steps aren't buttons; an incomplete one goes where it's finished.
      onPress={step.complete ? undefined : onGo}
      style={step.canClaim ? s.actionRow : undefined}
    />
  );
}

type Props = {
  profile: Profile | null;
  navigation: Nav;
  onClaimed?: (newBalance: number) => void;
  // When true, the card stays visible even after all steps are claimed (used
  // in Profile → Unlockable Rewards so progress is always inspectable).
  alwaysShow?: boolean;
  // When true, drop the standalone card chrome so it nests inside another card.
  embedded?: boolean;
};

/** The standalone checklist (Profile → Unlockable Rewards). */
export default function FtueChecklistCard({ profile, navigation, onClaimed, alwaysShow, embedded }: Props) {
  const { colors } = useTheme();
  const t = textStyles(colors);
  const s = makeStyles(colors);
  const ftue = useFtueChecklist({ profile, navigation, onClaimed });

  // While loading, show a placeholder (avoids flash). Without alwaysShow the
  // card hides once all steps are claimed; in Profile it stays as a tracker.
  if (ftue.loading) {
    return (
      <View style={embedded ? s.embedded : s.card}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (ftue.allClaimed && !alwaysShow) return null;

  return (
    <View style={embedded ? s.embedded : s.card}>
      {embedded ? null : <Text style={[t.title, s.title]}>🚀 Get started</Text>}
      {ftue.steps.map((st, i) => (
        <FtueStepRow
          key={st.id}
          step={st}
          onClaim={() => { void ftue.claim(st.id); }}
          onGo={st.navTo}
          lastRow={i === ftue.steps.length - 1 && !ftue.allClaimed}
        />
      ))}
      {ftue.allClaimed && (
        <Text style={[t.meta, s.allDone, { color: colors.primary }]}>🎉 All starter quests complete!</Text>
      )}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    card: {
      marginHorizontal: SPACE.lg,
      marginTop: SPACE.md,
      paddingVertical: SPACE.sm,
      borderRadius: RADIUS.lg,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    embedded: { marginTop: SPACE.xs },
    title: { paddingHorizontal: SPACE.md, paddingTop: SPACE.xs },
    allDone: { paddingHorizontal: SPACE.md, paddingTop: SPACE.sm },
    // A 24-wide column so the titles line up whatever the glyph.
    checkBox: { width: 24, alignItems: 'center' },
    // A 44 Claim box plus ListCard's 10/10 padding would make a 64 row; 4px
    // keeps it 52 (the box stays inside the row, which Android needs to
    // deliver the touch).
    actionRow: { paddingVertical: SPACE.xs },
  });
}
