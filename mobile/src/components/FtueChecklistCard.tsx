import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { Profile } from '../types';

// TODO: smoke-test in browser — verify each row flips to ✓ once complete, the
// "Claim +N 🥒" button credits pickles (and bumps the home balance via
// onClaimed), claimed steps don't re-show the button. On Home the card hides
// once all three are claimed; in Profile (alwaysShow) it stays visible as a
// progress tracker, including for accounts that have everything done.

type Props = {
  profile: Profile | null;
  // The card only navigates, so accept any screen's nav prop (Home, Profile, …)
  // by typing just the method we use. Avoids route-param variance conflicts.
  navigation: { navigate: (...args: any[]) => void };
  onClaimed?: (newBalance: number) => void;
  // When true, the card stays visible even after all steps are claimed (used
  // in Profile → Unlockable Rewards so progress is always inspectable).
  alwaysShow?: boolean;
  // When true, drop the standalone card chrome so it nests inside another card.
  embedded?: boolean;
};

type StepId = 'join_league' | 'setup_profile' | 'first_match';

const REWARDS: Record<StepId, number> = {
  join_league: 500,
  setup_profile: 500,
  first_match: 1000,
};

type StepDef = {
  id: StepId;
  title: string;
  // Screen to send the user to when the step is incomplete.
  navTo: () => void;
};

export default function FtueChecklistCard({ profile, navigation, onClaimed, alwaysShow, embedded }: Props) {
  const { colors } = useTheme();
  const s = makeStyles(colors);

  const [loading, setLoading] = useState(true);
  const [inLeague, setInLeague] = useState(false);
  const [claimed, setClaimed] = useState<Set<StepId>>(new Set());
  // Steps mid-claim (disables the button, prevents double-tap double-grant).
  const [claiming, setClaiming] = useState<Set<StepId>>(new Set());

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    const [memberRes, grantsRes] = await Promise.all([
      supabase.from('league_members').select('league_id').eq('user_id', user.id).limit(1),
      supabase.from('ftue_grants').select('step').eq('user_id', user.id),
    ]);
    setInLeague((memberRes.data ?? []).length > 0);
    setClaimed(new Set(((grantsRes.data ?? []) as { step: StepId }[]).map(r => r.step)));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Completion is derived from server-truth fields. The RPC re-verifies before
  // granting, so these only gate the UI affordance.
  const profileSetUp = !!(
    profile?.avatar_emoji ||
    profile?.tagline ||
    (profile?.selected_tags?.length ?? 0) > 0
  );
  const hasMatch = (profile?.total_matches_played ?? 0) > 0;

  const isComplete: Record<StepId, boolean> = {
    join_league: inLeague,
    setup_profile: profileSetUp,
    first_match: hasMatch,
  };

  const steps: StepDef[] = [
    { id: 'join_league',   title: 'Join your league',        navTo: () => navigation.navigate('Leagues') },
    { id: 'setup_profile', title: 'Set up your profile',     navTo: () => navigation.navigate('Profile', {}) },
    { id: 'first_match',   title: 'Record your first match', navTo: () => navigation.navigate('Leagues') },
  ];

  async function claim(step: StepId) {
    if (claiming.has(step) || claimed.has(step)) return;
    setClaiming(prev => new Set(prev).add(step));
    const { data, error } = await supabase.rpc('claim_ftue_step', { p_step: step });
    setClaiming(prev => { const next = new Set(prev); next.delete(step); return next; });
    if (error) return;
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.success) {
      setClaimed(prev => new Set(prev).add(step));
      if (typeof row.new_balance === 'number') onClaimed?.(row.new_balance);
    } else if (row?.message === 'Already claimed') {
      // Server says it's already granted — reconcile local state.
      setClaimed(prev => new Set(prev).add(step));
    }
  }

  // While loading, show a placeholder (avoids flash). On Home the card hides
  // once all steps are claimed; in Profile (alwaysShow) it stays as a tracker.
  if (loading) {
    return (
      <View style={embedded ? s.embedded : s.card}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  const allClaimed = steps.every(st => claimed.has(st.id));
  if (allClaimed && !alwaysShow) return null;

  return (
    <View style={embedded ? s.embedded : s.card}>
      <Text style={s.title}>🚀 Get started</Text>
      {steps.map(st => {
        const complete = isComplete[st.id];
        const isClaimed = claimed.has(st.id);
        const canClaim = complete && !isClaimed;
        const busy = claiming.has(st.id);
        return (
          <TouchableOpacity
            key={st.id}
            style={s.row}
            activeOpacity={complete ? 1 : 0.7}
            disabled={complete}
            onPress={() => { if (!complete) st.navTo(); }}
          >
            <Text style={[s.check, complete && s.checkDone]}>{complete ? '✓' : '☐'}</Text>
            <Text style={[s.rowTitle, complete && s.rowTitleDone]} numberOfLines={1}>{st.title}</Text>
            {canClaim ? (
              <TouchableOpacity
                style={[s.claimBtn, busy && s.claimBtnBusy]}
                activeOpacity={0.8}
                disabled={busy}
                onPress={() => claim(st.id)}
              >
                <Text style={s.claimBtnText}>{busy ? '…' : `Claim +${REWARDS[st.id]} 🥒`}</Text>
              </TouchableOpacity>
            ) : isClaimed ? (
              <Text style={s.claimedLabel}>Claimed</Text>
            ) : (
              <Text style={s.goLabel}>Go →</Text>
            )}
          </TouchableOpacity>
        );
      })}
      {allClaimed && (
        <Text style={s.allDone}>🎉 All starter quests complete!</Text>
      )}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    card: {
      marginHorizontal: 16,
      marginTop: 12,
      padding: 14,
      borderRadius: 14,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    embedded: { marginTop: 4 },
    title: { fontSize: 15, fontWeight: '800', color: c.text, marginBottom: 10 },
    allDone: { fontSize: 12, fontWeight: '700', color: c.primary, marginTop: 10 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 9,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    check: { fontSize: 18, color: c.textMuted, width: 22, textAlign: 'center' },
    checkDone: { color: c.primary },
    rowTitle: { flex: 1, fontSize: 14, fontWeight: '600', color: c.text },
    rowTitleDone: { color: c.textMuted },
    claimBtn: { backgroundColor: c.primary, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10 },
    claimBtnBusy: { opacity: 0.6 },
    claimBtnText: { color: '#fff', fontSize: 12, fontWeight: '800' },
    claimedLabel: { fontSize: 12, fontWeight: '700', color: c.primary },
    goLabel: { fontSize: 13, fontWeight: '700', color: c.primary },
  });
}
