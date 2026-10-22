// Your own profile (plan section 5, "Profile"): about 600px collapsed, down
// from 3,500-4,700px. The one section order every detail screen uses:
//   1. Identity    avatar 64 (opens the Edit sheet; tour 'profile/edit'), name,
//                  @username, tagline, pickle pill (-> Shop), tag chips (+N)
//   2. Quick row   [Edit profile] [Match history] [Calendar]
//   3. Status      "Next unlock: Ninja avatar 3/5 >" (tour 'profile/rewards';
//                  replaces the ~900px Unlockable Rewards card, whose rows all
//                  live on UnlockProgress)
//   4. Coming up   my leagues & live tournaments -> their detail screens
//   5. Reference   collapsed: Availability · Paddle · Badges · Inventory ·
//                  Doubles chemistry. Content mounts only when opened (the
//                  672px availability grid included).
// Every edit of who you are (avatar, name, username, tagline, gender, tags,
// badge privacy) goes through EditProfileSheet's single Save. Both tour anchors
// sit outside the collapsible sections, so collapsing never unmounts them.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
} from 'react-native';
import { CachedImage } from '@just-messin-around/expo-foundation/ui/CachedImage';
import { Panel, SectionHeader, CollapsibleSection, Chip } from '@just-messin-around/expo-foundation/ui';
import InviteEarnSection from '../components/referrals/InviteEarnSection';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { ProgressBar } from '@just-messin-around/expo-foundation/gamification';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import Svg, { Polyline, Line as SvgLine, Text as SvgText, Circle } from 'react-native-svg';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useTour } from '../lib/TourContext';
import { Profile, PlayerLocationRating, ShopItem, RootStackParamList } from '../types';
import BadgeDisplay, { BadgeItem } from '../components/BadgeDisplay';
import FlairName from '../components/FlairName';
import PaddlePickerModal, { PaddleSelection } from '../components/PaddlePickerModal';
import { PremiumAvatar } from '../components/AvatarPickerModal';
import EditProfileSheet, { EditProfileSaved, EditProfileValues } from '../components/EditProfileSheet';
import AvailabilityGrid from '../components/AvailabilityGrid';
import LeagueRow, { LeagueRowRole } from '../components/LeagueRow';
import TournamentRow from '../components/TournamentRow';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { AVATARS, PLAY_TAGS, computeMaxTagSlots } from '../data/profileCustomization';
import { TOTAL_CELLS } from '../lib/availability';
// Kept for the hidden PLUPR card (see the note in the render): restoring it is
// re-adding the block, not re-plumbing these.
import { computeReliability } from '../lib/reliability';
import { formatPlupr, formatPluprShort } from '../lib/plupr';
import {
  computeAllPartnerChemistry, fmtDelta,
  ChemistryResult, DoublesMatch,
} from '../lib/chemistry';
import { computeBadgeProgress } from '../lib/unlockProgress';
import { nextUnlockTeaser, NextUnlockResult } from '../lib/profileSummary';
import { availabilityShortSummary } from '@just-messin-around/expo-foundation/scheduling/availability';
import { trackSectionToggle } from '../lib/analytics';
import { BallIcon } from '../components/PickleIcons';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';
import FriendsLink from '../components/FriendsLink';
import { ROUTINES_ENABLED } from '../lib/features';
import { sbCall, currentUserId, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';

// ── PLUPR history chart ───────────────────────────────────────────────
// Reconstructs each PLUPR facet's trajectory by walking the user's match
// history chronologically and applying each match's delta (overall
// rating_after - rating_before) to the relevant facet:
//   singles match            → singles
//   doubles_category=gendered → doubles_gendered
//   doubles_category=mixed    → doubles_mixed
//   doubles_category=unspecified → no split impact
// Overall accumulates every match's delta. Period/season PLUPR resets are
// ignored — this shows a player's match-only skill trajectory, which
// reads more cleanly than the absolute PLUPR column (which periodically
// snaps back to 3.250+bonus).
type EloMatchRow = {
  played_at: string;
  match_type: 'singles' | 'doubles';
  doubles_category: 'gendered' | 'mixed' | 'unspecified' | null;
  player1_id: string; partner1_id: string | null;
  player2_id: string; partner2_id: string | null;
  player1_rating_before: number | null;
  player1_rating_after:  number | null;
  player2_rating_before: number | null;
  player2_rating_after:  number | null;
};

type Series = {
  points: { t: number; overall: number; singles: number; gendered: number; mixed: number }[];
};

function computeEloSeries(matches: EloMatchRow[], userId: string): Series {
  const points: Series['points'] = [];
  let overall = 3.25, singles = 3.25, gendered = 3.25, mixed = 3.25;

  // Seed at "before first match" if there's at least one match
  if (matches.length > 0) {
    const first = matches[0];
    const t0 = new Date(first.played_at).getTime();
    points.push({ t: t0 - 86_400_000, overall, singles, gendered, mixed });
  }

  for (const m of matches) {
    const onTeam1 = m.player1_id === userId || m.partner1_id === userId;
    const before  = onTeam1 ? m.player1_rating_before : m.player2_rating_before;
    const after   = onTeam1 ? m.player1_rating_after  : m.player2_rating_after;
    if (before == null || after == null) continue;
    const delta = after - before;

    overall += delta;
    if (m.match_type === 'singles') {
      singles += delta;
    } else if (m.doubles_category === 'gendered') {
      gendered += delta;
    } else if (m.doubles_category === 'mixed') {
      mixed += delta;
    }
    // unspecified → no split impact

    points.push({
      t: new Date(m.played_at).getTime(),
      overall, singles, gendered, mixed,
    });
  }
  return { points };
}

type Colors = ReturnType<typeof useTheme>['colors'];

// Facet line colours from the theme (were hex): overall = brand green,
// singles = info blue, gendered = success teal-green, mixed = rare purple.
function facetColors(c: Colors) {
  return { overall: c.primary, singles: c.info, gendered: c.success, mixed: c.rarityRare } as const;
}

// The chemistry badge's tone, from theme tokens. lib/chemistry's chemistryColor
// returns fixed light-mode hex (and a 3-digit '#888' for neutral, which turned
// into the invalid '#88822' once an alpha suffix was appended), so the badge
// maps the same thresholds onto tokens instead. Strong and mild positive share
// one tone; mild negative is a warning, strong negative a danger.
function chemTone(c: Colors, delta: number) {
  if (delta >= 0.03)  return { fg: c.success,   bg: c.successLight };
  if (delta <= -0.08) return { fg: c.danger,    bg: c.dangerLight };
  if (delta <= -0.03) return { fg: c.warning,   bg: c.warningLight };
  return { fg: c.textMuted, bg: c.surfaceAlt };
}

// Not rendered today (the PLUPR card is hidden — see the render). Kept whole
// so the card can be restored by re-adding the block.
function EloHistoryChart({
  matches, userId, colors: c,
}: {
  matches: EloMatchRow[];
  userId: string;
  colors: Colors;
}) {
  const FACET_COLORS = facetColors(c);
  const series = computeEloSeries(matches, userId);
  const n = series.points.length;
  if (n < 2) {
    return (
      <Text style={{ fontSize: 12, color: c.textMuted, textAlign: 'center', paddingVertical: 16 }}>
        Play a few matches to see your PLUPR trajectory.
      </Text>
    );
  }

  const W = 320;
  const H = 180;
  const PAD = { top: 12, right: 12, bottom: 30, left: 38 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const allValues = series.points.flatMap(p => [p.overall, p.singles, p.gendered, p.mixed]);
  let yMin = Math.min(...allValues);
  let yMax = Math.max(...allValues);
  // Pad y-range so lines aren't flush against the top/bottom
  const yPad = Math.max(0.1, (yMax - yMin) * 0.1);
  yMin = Math.floor((yMin - yPad) * 10) / 10;
  yMax = Math.ceil((yMax + yPad) * 10) / 10;
  const yRange = Math.max(yMax - yMin, 0.1);

  const xMin = series.points[0].t;
  const xMax = series.points[n - 1].t;
  const xRange = Math.max(xMax - xMin, 1);

  const xScale = (t: number) => PAD.left + ((t - xMin) / xRange) * innerW;
  const yScale = (v: number) => PAD.top  + (1 - (v - yMin) / yRange) * innerH;

  const polyline = (key: 'overall' | 'singles' | 'gendered' | 'mixed') =>
    series.points
      .map(p => `${xScale(p.t).toFixed(1)},${yScale(p[key]).toFixed(1)}`)
      .join(' ');

  // Y-axis tick values (3 ticks: min, mid, max — rounded to nearest 0.1)
  const yTicks = [yMin, Math.round((yMin + yMax) / 2 * 10) / 10, yMax];

  // X-axis ticks: first, middle, last date
  const xTickTimes = n >= 3
    ? [xMin, series.points[Math.floor(n / 2)].t, xMax]
    : [xMin, xMax];
  const fmtDate = (t: number) =>
    new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <View>
      {/* Legend */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'center', marginBottom: 4 }}>
        {[
          { key: 'overall',  label: 'Overall',          color: FACET_COLORS.overall  },
          { key: 'singles',  label: 'Singles',          color: FACET_COLORS.singles  },
          { key: 'gendered', label: 'Gendered Doubles', color: FACET_COLORS.gendered },
          { key: 'mixed',    label: 'Mixed Doubles',    color: FACET_COLORS.mixed    },
        ].map(item => (
          <View key={item.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 14, height: 3, backgroundColor: item.color, borderRadius: 2 }} />
            <Text style={{ fontSize: 11, color: c.textSub, fontWeight: '600' }}>{item.label}</Text>
          </View>
        ))}
      </View>

      <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Y grid lines + labels */}
        {yTicks.map(v => (
          <React.Fragment key={`y-${v}`}>
            <SvgLine
              x1={PAD.left} x2={W - PAD.right}
              y1={yScale(v)} y2={yScale(v)}
              stroke={c.border} strokeWidth={0.5} strokeDasharray="3,3"
            />
            <SvgText
              x={PAD.left - 4} y={yScale(v) + 3}
              fontSize="9" fill={c.textMuted} textAnchor="end"
            >
              {v.toFixed(2)}
            </SvgText>
          </React.Fragment>
        ))}

        {/* X tick labels */}
        {xTickTimes.map((t, i) => (
          <SvgText
            key={`x-${i}`}
            x={xScale(t)} y={H - PAD.bottom + 14}
            fontSize="9" fill={c.textMuted}
            textAnchor={i === 0 ? 'start' : i === xTickTimes.length - 1 ? 'end' : 'middle'}
          >
            {fmtDate(t)}
          </SvgText>
        ))}

        {/* Lines (overall last so it sits on top) */}
        <Polyline points={polyline('mixed')}    stroke={FACET_COLORS.mixed}    strokeWidth={1.8} fill="none" />
        <Polyline points={polyline('gendered')} stroke={FACET_COLORS.gendered} strokeWidth={1.8} fill="none" />
        <Polyline points={polyline('singles')}  stroke={FACET_COLORS.singles}  strokeWidth={1.8} fill="none" />
        <Polyline points={polyline('overall')}  stroke={FACET_COLORS.overall}  strokeWidth={2.4} fill="none" />

        {/* Endpoint markers on the overall line */}
        <Circle cx={xScale(series.points[n - 1].t)} cy={yScale(series.points[n - 1].overall)} r={3.5} fill={FACET_COLORS.overall} />
      </Svg>
    </View>
  );
}

// One owned Shop item: icon · name (+ gift line) · show/hide · Equip.
// 56 tall; the eye toggle and the Equip button are real 44 boxes.
function InvRow({
  icon, bgColor, name, gift, message, isHidden,
  actionLabel, equipped, onAction, onToggleHidden, styles,
}: {
  icon: string; bgColor: string; name: string;
  gift: string | null; message: string | null;
  isHidden: boolean;
  /** Omit for items with nothing to equip (cosmetic badges). */
  actionLabel?: string;
  /** Already equipped: the action shows as a plain "Equipped" label. */
  equipped?: boolean;
  onAction?: () => void;
  onToggleHidden: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={[styles.invRow, isHidden && styles.invRowHidden]}>
      <View style={[styles.invIconBox, { backgroundColor: bgColor }]}>
        <Text style={styles.invIconEmoji}>{icon}</Text>
      </View>
      <View style={styles.flexText}>
        <Text style={[styles.rowTitle, isHidden && styles.textDim]} numberOfLines={1}>{name}</Text>
        {gift && (
          <Text style={styles.rowSub} numberOfLines={1}>
            🎁 Gift{message ? ` · "${message}"` : ''}
          </Text>
        )}
      </View>
      <TouchableOpacity
        onPress={onToggleHidden}
        style={styles.box44}
        accessibilityRole="button"
        accessibilityLabel={isHidden ? `Show ${name}` : `Hide ${name}`}
      >
        <Text style={styles.invHideText}>{isHidden ? '🙈' : '👁️'}</Text>
      </TouchableOpacity>
      {actionLabel ? (
        equipped ? (
          <View style={styles.box44}>
            <Text style={styles.equippedText} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>✓ {actionLabel}</Text>
          </View>
        ) : (
          <Button size="sm" title={actionLabel} onPress={onAction} />
        )
      ) : null}
    </View>
  );
}

type PurchaseWithItem = {
  id: string;                 // purchase row id
  shop_item_id: string;
  is_hidden: boolean;
  gifted_by_user_id: string | null;
  gift_message: string | null;
  cost_paid: number;
  purchased_at: string;
  item: ShopItem;
};

/** "Coming up": my active leagues and my live tournament registrations. */
type ComingLeague = {
  id: string; name: string; home_court: string | null; is_open: boolean | null; role: LeagueRowRole;
};
type ComingTournament = {
  id: string; name: string; location_name: string | null; status: string | null;
  start_time: string | null; leagueName: string | null; myStatus: string; invited: boolean;
};

/** Rows shown before "Show N more" (content rule 4: nothing is cut silently). */
const COMING_UP_CAP = 4;

/** "Sat 9 AM" within the coming week, else "Nov 2". */
function shortWhen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = (d.getTime() - Date.now()) / 86_400_000;
  if (days > -1 && days < 6) {
    const day = d.toLocaleDateString(undefined, { weekday: 'short' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
    return `${day} ${time}`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Tag chips shown under the name before collapsing the rest into "+N". */
const TAG_CHIPS_SHOWN = 2;

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Profile'> };

export default function ProfileScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const t = textStyles(colors);
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const status = useStatusMessage();
  const [profile, setProfile]             = useState<Profile | null>(null);
  // "+N" on the tag row expands it to every tag; "Show less" folds it back.
  const [tagsExpanded, setTagsExpanded]   = useState(false);
  const [locationRatings, setLocationRatings] = useState<PlayerLocationRating[]>([]);
  const [badges, setBadges]               = useState<BadgeItem[]>([]);
  const [defaultPaddle, setDefaultPaddle] = useState<(PaddleSelection & { paddleId: string }) | null>(null);
  const [availability, setAvailability]   = useState<boolean[]>(Array(TOTAL_CELLS).fill(false));
  const [avSaveStatus, setAvSaveStatus]   = useState<'idle' | 'saving' | 'saved' | 'error' | 'needs-migration'>('idle');
  const avSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Serialises the paddle writes: they read-modify-write the same is_default
  // flag across rows, so two overlapping saves can leave zero (or two) defaults.
  const paddleSaving = useRef(false);
  const [chemistryResults, setChemistryResults] = useState<ChemistryResult[]>([]);
  const [eloHistory, setEloHistory] = useState<EloMatchRow[]>([]);
  const [shopPurchases, setShopPurchases]     = useState<PurchaseWithItem[]>([]);
  const [partnerNames, setPartnerNames] = useState<Record<string, { full_name: string; avatar_id: number; avatar_url: string | null }>>({});
  // undefined = not known yet (loading, or the read failed). The strip renders
  // in every case so its tour anchor exists.
  const [unlock, setUnlock] = useState<NextUnlockResult | undefined>(undefined);
  const [comingLeagues, setComingLeagues] = useState<ComingLeague[]>([]);
  const [comingTournaments, setComingTournaments] = useState<ComingTournament[]>([]);
  const [showAllComing, setShowAllComing] = useState(false);
  const [showPaddlePicker, setShowPaddlePicker]   = useState(false);
  const [editOpen, setEditOpen]                   = useState(false);
  const [gridScrollLocked, setGridScrollLocked]   = useState(false);
  const [loading, setLoading]             = useState(true);
  const [userId, setUserId]               = useState<string | null>(null);

  // Spotlight-tour anchors for the 'profile' tour: the avatar ('edit', which
  // opens the Edit sheet) and the next-unlock strip ('rewards'). Both live
  // outside every collapsible section, so collapsing one never unmounts them.
  // TODO: smoke-test in browser — from FTUE "Set up your profile", the profile
  // tour should highlight the avatar, then the next-unlock strip, once per
  // user (clear AsyncStorage to re-trigger).
  // Held only while Profile is focused (same as LeagueDetail's 'record'): a
  // Profile left mounted under the stack still measures on native, so blur or
  // unmount drops both anchors (identity-guarded) and the steps can't
  // spotlight a hidden element or start an armed tour behind another screen.
  const { registerAnchor, unregisterAnchor } = useTour();
  const editAnchor = useRef<any>(null);
  const rewardsAnchor = useRef<any>(null);
  const isFocused = useIsFocused();
  const focusedRef = useRef(isFocused);
  focusedRef.current = isFocused;
  const anchorOnLayout = (stepKey: 'edit' | 'rewards', ref: typeof editAnchor) => () => {
    if (focusedRef.current) registerAnchor('profile', stepKey, ref);
  };
  // Coming back on top re-claims the steps; onLayout does not fire again.
  useEffect(() => {
    if (!isFocused) return;
    if (editAnchor.current) registerAnchor('profile', 'edit', editAnchor);
    if (rewardsAnchor.current) registerAnchor('profile', 'rewards', rewardsAnchor);
    return () => {
      unregisterAnchor('profile', 'edit', editAnchor);
      unregisterAnchor('profile', 'rewards', rewardsAnchor);
    };
  }, [isFocused, registerAnchor, unregisterAnchor]);

  const refresh = useRefresh(loadProfile);

  useEffect(() => { loadProfile(); }, []);
  useEffect(() => () => { if (avSaveTimer.current) clearTimeout(avSaveTimer.current); }, []);

  // What changes on screens reached from here re-reads on every return:
  //   - Coming up (join a league, get approved into a tournament);
  //   - the pickle pill, avatar and name styles (FTUE Claim buttons live on
  //     UnlockProgress now, and the pill opens the Shop, whose Buy & Equip
  //     spends pickles and equips an avatar);
  //   - Inventory (a Shop purchase) and the next-unlock strip.
  // The mount load covers the first focus. Refs: the callback is stable.
  const uidRef = useRef<string | null>(null);
  uidRef.current = userId;
  const refocusRef = useRef<(uid: string) => void>(() => {});
  const focusCount = useRef(0);
  useFocusEffect(useCallback(() => {
    focusCount.current += 1;
    if (focusCount.current > 1 && uidRef.current) refocusRef.current(uidRef.current);
  }, []));

  async function loadProfile() {
    // Local session read. getUser() is a round trip that resolves null offline,
    // and this function then returned early — so the whole Profile screen
    // rendered blank on bad WiFi with no error and no retry.
    const uid = await currentUserId(supabase);
    if (!uid) return;
    setUserId(uid);
    const user = { id: uid };

    const [profileRes, locRes, badgesRes, paddleRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('player_location_ratings')
        .select('*').eq('user_id', user.id).order('rating', { ascending: false }),
      supabase.from('player_badges')
        .select('*, badge:badges(*), league:leagues(name)')
        .eq('user_id', user.id).order('earned_at'),
      supabase.from('player_paddles')
        .select('*, brand:paddle_brands(id, name)')
        .eq('user_id', user.id).eq('is_default', true).maybeSingle(),
    ]);

    if (paddleRes.data) {
      const p = paddleRes.data;
      setDefaultPaddle({ paddleId: p.id, brandId: p.brand.id, brandName: p.brand.name, modelName: p.model_name, thicknessMm: p.thickness_mm });
    }
    if (profileRes.data) {
      const d = profileRes.data;
      setProfile(d);
      const av = d.availability;
      setAvailability(Array.isArray(av) && av.length === TOTAL_CELLS ? av : Array(TOTAL_CELLS).fill(false));
    }
    setLocationRatings((locRes.data ?? []) as PlayerLocationRating[]);
    setBadges((badgesRes.data ?? []) as BadgeItem[]);
    setLoading(false);

    // Non-blocking: chemistry, next unlock, PLUPR history, shop purchases, coming up.
    loadChemistry(user.id);
    loadNextUnlock(user.id);
    loadEloHistory(user.id);
    loadShopPurchases(user.id);
    loadComingUp(user.id);
  }

  async function loadShopPurchases(uid: string) {
    const { data } = await supabase
      .from('player_shop_purchases')
      .select('id, shop_item_id, is_hidden, gifted_by_user_id, gift_message, cost_paid, purchased_at, item:shop_items(*)')
      .eq('user_id', uid)
      .order('purchased_at', { ascending: false });

    setShopPurchases(((data ?? []) as any[]).filter(r => r.item) as PurchaseWithItem[]);
  }

  // The status strip reads the same progress math as UnlockProgress and Home
  // (lib/unlockProgress), so the three never disagree.
  async function loadNextUnlock(uid: string) {
    try {
      setUnlock(nextUnlockTeaser(await computeBadgeProgress(uid)));
    } catch {
      // computeBadgeProgress throws rather than reporting zero progress; keep
      // the strip's neutral "Unlockable rewards" instead of a wrong number.
    }
  }

  async function loadComingUp(uid: string) {
    try {
      const [memberRows, regRows] = await Promise.all([
        sbCall(() => supabase
          .from('league_members')
          .select('role, league:leagues(id, name, home_court, is_open, is_active)')
          .eq('user_id', uid)),
        sbCall(() => supabase
          .from('tournament_registrations')
          .select('status, invited_by, tournament:tournaments(id, name, location_name, start_time, status, league:leagues(name))')
          .eq('user_id', uid)
          .in('status', ['approved', 'pending', 'waitlisted'])),
      ]);

      const leagues: ComingLeague[] = [];
      for (const r of (memberRows ?? []) as any[]) {
        const l = r.league;
        if (!l || l.is_active === false) continue;
        leagues.push({ id: l.id, name: l.name, home_court: l.home_court ?? null, is_open: l.is_open ?? null, role: r.role ?? 'member' });
      }
      leagues.sort((a, b) => a.name.localeCompare(b.name));

      const tournaments: ComingTournament[] = [];
      for (const r of (regRows ?? []) as any[]) {
        const tn = r.tournament;
        // Only what's still ahead or running (completed / cancelled are history).
        if (!tn || tn.status === 'completed' || tn.status === 'cancelled') continue;
        tournaments.push({
          id: tn.id, name: tn.name, location_name: tn.location_name ?? null, status: tn.status ?? null,
          start_time: tn.start_time ?? null, leagueName: tn.league?.name ?? null,
          myStatus: r.status, invited: r.status === 'pending' && r.invited_by != null,
        });
      }
      tournaments.sort((a, b) => {
        const am = a.start_time ? new Date(a.start_time).getTime() : Number.MAX_SAFE_INTEGER;
        const bm = b.start_time ? new Date(b.start_time).getTime() : Number.MAX_SAFE_INTEGER;
        return am - bm;
      });

      setComingLeagues(leagues);
      setComingTournaments(tournaments);
    } catch {
      // Best-effort section: on a failed read keep whatever is already shown
      // (an empty section simply doesn't render).
    }
  }

  // Only the profile columns other screens write (UnlockProgress claims, Shop
  // purchases and equips), merged into the current row. Never touches
  // `availability` or `loading`, so an open grid keeps its state and Back
  // doesn't flash the skeleton.
  async function loadVolatileProfile(uid: string) {
    const { data } = await supabase
      .from('profiles')
      .select('pickles, avatar_emoji, avatar_bg_color, name_color, list_name_style_id, profile_name_style_id')
      .eq('id', uid)
      .maybeSingle();
    if (data) setProfile(p => (p ? { ...p, ...(data as Partial<Profile>) } : p));
  }

  refocusRef.current = (uid: string) => {
    void loadComingUp(uid);
    void loadVolatileProfile(uid);
    void loadShopPurchases(uid);
    void loadNextUnlock(uid);
  };

  async function equipAvatar(emoji: string | null, bgColor: string | null) {
    if (!userId) return;
    const { error } = await supabase
      .from('profiles')
      .update({ avatar_emoji: emoji, avatar_bg_color: bgColor })
      .eq('id', userId);
    if (error) { status.error(error.message); return; }
    setProfile(p => p ? { ...p, avatar_emoji: emoji, avatar_bg_color: bgColor } : p);
  }

  async function applyFlair(value: string | null) {
    if (!userId) return;
    const { error } = await supabase
      .from('profiles')
      .update({ name_color: value })
      .eq('id', userId);
    if (error) { status.error(error.message); return; }
    setProfile(p => p ? { ...p, name_color: value } : p);
  }

  // Equip / unequip name styles (list or hero). Slug is the shop_items.slug
  // (which doubles as the FK in profiles.{list,hero}_name_style_id).
  async function applyListNameStyle(slug: string | null) {
    if (!userId) return;
    const { error } = await supabase
      .from('profiles')
      .update({ list_name_style_id: slug })
      .eq('id', userId);
    if (error) { status.error(error.message); return; }
    setProfile(p => p ? { ...p, list_name_style_id: slug } : p);
  }

  async function applyProfileNameStyle(slug: string | null) {
    if (!userId) return;
    const { error } = await supabase
      .from('profiles')
      .update({ profile_name_style_id: slug })
      .eq('id', userId);
    if (error) { status.error(error.message); return; }
    setProfile(p => p ? { ...p, profile_name_style_id: slug } : p);
  }

  async function togglePurchaseHidden(purchaseId: string, currentlyHidden: boolean) {
    const { error } = await supabase.rpc('set_purchase_hidden', {
      p_purchase_id: purchaseId,
      p_hidden:      !currentlyHidden,
    });
    if (error) { status.error(error.message); return; }
    setShopPurchases(prev => prev.map(p =>
      p.id === purchaseId ? { ...p, is_hidden: !currentlyHidden } : p,
    ));
  }

  async function loadEloHistory(uid: string) {
    const { data } = await supabase
      .from('matches')
      .select('played_at, match_type, doubles_category, player1_id, partner1_id, player2_id, partner2_id, player1_rating_before, player1_rating_after, player2_rating_before, player2_rating_after')
      .eq('status', 'completed')
      .or(`player1_id.eq.${uid},partner1_id.eq.${uid},player2_id.eq.${uid},partner2_id.eq.${uid}`)
      .order('played_at', { ascending: true })
      .limit(500);
    setEloHistory((data ?? []) as EloMatchRow[]);
  }

  async function loadChemistry(uid: string) {
    const { data } = await supabase
      .from('matches')
      .select('player1_id, partner1_id, player2_id, partner2_id, winner_team, player1_rating_before, player2_rating_before')
      .eq('match_type', 'doubles')
      .eq('status', 'completed')
      .or(`player1_id.eq.${uid},partner1_id.eq.${uid},player2_id.eq.${uid},partner2_id.eq.${uid}`)
      .limit(500);
    if (!data || data.length === 0) return;

    const results = computeAllPartnerChemistry(uid, data as DoublesMatch[]);
    setChemistryResults(results.slice(0, 6));

    if (results.length > 0) {
      const ids = results.slice(0, 6).map(r => r.partnerId);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, avatar_id, avatar_url')
        .in('id', ids);
      const map: Record<string, { full_name: string; avatar_id: number; avatar_url: string | null }> = {};
      for (const p of (profiles ?? []) as any[]) map[p.id] = p;
      setPartnerNames(map);
    }
  }

  // Auto-saves availability immediately whenever the grid changes.
  // Fires once per drag-release or preset tap — no debounce needed.
  async function handleAvailabilityChange(newAv: boolean[]) {
    setAvailability(newAv);
    if (!userId) return;

    setAvSaveStatus('saving');
    if (avSaveTimer.current) clearTimeout(avSaveTimer.current);

    // sbCall so a hung socket becomes a timeout instead of pinning the status on
    // 'saving' indefinitely, and so a throw can't skip the status reset.
    try {
      await sbCall(() =>
        supabase.from('profiles').update({ availability: newAv }).eq('id', userId),
      );
      setAvSaveStatus('saved');
      avSaveTimer.current = setTimeout(() => setAvSaveStatus('idle'), 2500);
    } catch (e: any) {
      if (e?.code === 'PGRST204' || String(e?.message ?? '').toLowerCase().includes('column')) {
        setAvSaveStatus('needs-migration');
      } else {
        setAvSaveStatus('error');
        avSaveTimer.current = setTimeout(() => setAvSaveStatus('idle'), 4000);
      }
    }
  }

  async function saveDefaultPaddle(sel: PaddleSelection) {
    if (paddleSaving.current) return;
    if (!userId) return;
    paddleSaving.current = true;
    setShowPaddlePicker(false);
    try {
      // Claim the new default FIRST, then demote the others. The old order
      // cleared is_default on every paddle before the upsert and ignored its
      // result, so a failed upsert left the user with no default at all while
      // the UI still showed the old one.
      const row = await sbCall(() => supabase.from('player_paddles').upsert({
        user_id:      userId,
        brand_id:     sel.brandId,
        model_name:   sel.modelName,
        thickness_mm: sel.thicknessMm,
        is_default:   true,
      }, { onConflict: 'user_id,brand_id,model_name' }).select('id').single()) as { id: string };
      setDefaultPaddle({ ...sel, paddleId: row.id });

      // Worst case here is two paddles flagged default — recoverable, and the
      // next save fixes it — so it can't take the success above down with it.
      await sbCall(() => supabase.from('player_paddles')
        .update({ is_default: false })
        .eq('user_id', userId)
        .neq('id', row.id));
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not save your default paddle.'));
    } finally {
      paddleSaving.current = false;
    }
  }

  async function removePaddle() {
    if (paddleSaving.current) return;
    if (!userId || !defaultPaddle) return;
    paddleSaving.current = true;
    try {
      await sbCall(() => supabase.from('player_paddles').update({ is_default: false }).eq('id', defaultPaddle.paddleId));
      setDefaultPaddle(null);
    } catch (e) {
      // Only clear the local copy once the row actually changed, or the paddle
      // silently reappears on the next load.
      status.error(friendlySbMessage(e, 'Could not remove your default paddle.'));
    } finally {
      paddleSaving.current = false;
    }
  }

  async function toggleBadgeVisibility(playerBadgeIds: string[], hidden: boolean) {
    if (playerBadgeIds.length === 0) return;
    // IDs can come from either player_badges (earned badges) or
    // player_shop_purchases (cosmetic badges). Split and route accordingly.
    const purchaseIdSet = new Set(shopPurchases.map(p => p.id));
    const earnedIds   = playerBadgeIds.filter(id => !purchaseIdSet.has(id));
    const cosmeticIds = playerBadgeIds.filter(id =>  purchaseIdSet.has(id));

    // Local state is updated only after the write lands. Previously both halves
    // discarded their result and repainted regardless, so on bad WiFi a badge
    // looked hidden while the server still showed it — and the lie survived
    // until the next reload, by which point the user had moved on.
    try {
      if (earnedIds.length > 0) {
        await sbCall(() =>
          supabase.from('player_badges').update({ is_hidden: hidden }).in('id', earnedIds),
        );
        const idSet = new Set(earnedIds);
        setBadges(prev => prev.map(b => idSet.has(b.id) ? { ...b, is_hidden: hidden } : b));
      }
      if (cosmeticIds.length > 0) {
        await Promise.all(cosmeticIds.map(id =>
          sbCall(() => supabase.rpc('set_purchase_hidden', { p_purchase_id: id, p_hidden: hidden })),
        ));
        const idSet = new Set(cosmeticIds);
        setShopPurchases(prev => prev.map(p => idSet.has(p.id) ? { ...p, is_hidden: hidden } : p));
      }
    } catch (e) {
      status.error(friendlySbMessage(e, `Could not ${hidden ? 'hide' : 'show'} that badge.`));
    }
  }

  async function setAllBadgesHidden(hidden: boolean) {
    if (!userId) return;
    try {
      await sbCall(() =>
        supabase.from('player_badges').update({ is_hidden: hidden }).eq('user_id', userId),
      );
      setBadges(prev => prev.map(b => ({ ...b, is_hidden: hidden })));
      const cosmetics = shopPurchases.filter(p => p.item.category === 'cosmetic_badge');
      if (cosmetics.length > 0) {
        await Promise.all(cosmetics.map(p =>
          sbCall(() => supabase.rpc('set_purchase_hidden', { p_purchase_id: p.id, p_hidden: hidden })),
        ));
        const idSet = new Set(cosmetics.map(p => p.id));
        setShopPurchases(prev => prev.map(p => idSet.has(p.id) ? { ...p, is_hidden: hidden } : p));
      }
    } catch (e) {
      status.error(friendlySbMessage(e, `Could not ${hidden ? 'hide' : 'show'} your badges.`));
    }
  }

  function handleEditSaved(saved: EditProfileSaved) {
    setProfile(p => (p ? { ...p, ...saved } : p));
    setEditOpen(false);
    status.success('Profile saved.');
  }

  // Analytics for user toggles of the reference sections (never page.view).
  const onSectionToggle = (section: string) => (open: boolean) =>
    trackSectionToggle({ screen: 'Profile', section, open });

  // Shop avatars the player owns, for the Edit sheet's avatar page.
  const premiumAvatars: PremiumAvatar[] = useMemo(() => shopPurchases
    .filter(p => p.item.category === 'avatar')
    .map(p => ({
      slug: p.item.slug,
      name: p.item.name,
      emoji: p.item.payload?.emoji ?? p.item.icon,
      bgColor: p.item.payload?.bgColor ?? colors.surfaceAlt,
    })), [shopPurchases, colors.surfaceAlt]);

  // Equipped premium avatar (driven by avatar_emoji + avatar_bg_color).
  const equippedPremium: PremiumAvatar | null = profile?.avatar_emoji && profile?.avatar_bg_color
    ? { slug: 'equipped', name: 'Premium', emoji: profile.avatar_emoji, bgColor: profile.avatar_bg_color }
    : null;

  // What the Edit sheet opens with; it reads this only at open.
  const editInitial: EditProfileValues = {
    fullName:     profile?.full_name ?? '',
    username:     profile?.username ?? '',
    tagline:      profile?.tagline ?? '',
    gender:       profile?.gender ?? null,
    selectedTags: profile?.selected_tags ?? [],
    avatarId:     profile?.avatar_id ?? 1,
    photoUrl:     profile?.avatar_url ?? null,
    premium:      equippedPremium,
    badgesPublic: profile?.badges_public ?? true,
  };

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} variant="row" /></View>;

  const earnedBadgeNames = Array.from(new Set(badges.map(b => b.badge.name)));

  // Group badges by name (+ league_id for league badges) so duplicates
  // collapse into a single tile with a ×N count. Keying on the badge's
  // display name (which is always populated via the join) avoids any
  // edge cases where badge_id might shift between rows of the same
  // award type. Newest instance is the representative item used for the
  // tile's emoji/name.
  function groupBadges(list: BadgeItem[]) {
    const groups = new Map<string, BadgeItem[]>();
    for (const b of list) {
      const key = `${b.badge.name}::${b.league_id ?? ''}`;
      const existing = groups.get(key);
      if (existing) existing.push(b);
      else groups.set(key, [b]);
    }
    return Array.from(groups.values())
      .map(stack => {
        const sorted = [...stack].sort((a, b) =>
          new Date(b.earned_at).getTime() - new Date(a.earned_at).getTime()
        );
        return { rep: sorted[0], stack: sorted };
      })
      .sort((a, b) =>
        new Date(b.rep.earned_at).getTime() - new Date(a.rep.earned_at).getTime()
      );
  }
  // Cosmetic badges purchased from the Pickle Shop appear in the same
  // section. We mint a BadgeItem on the fly per purchase; the toggle in
  // toggleBadgeVisibility routes by ID to the right table.
  const cosmeticBadgeItems: BadgeItem[] = shopPurchases
    .filter(p => p.item.category === 'cosmetic_badge')
    .map(p => ({
      id:         p.id,
      badge_id:   `cosmetic:${p.shop_item_id}`,
      is_hidden:  p.is_hidden,
      earned_at:  p.purchased_at,
      context:    p.gift_message ?? (p.gifted_by_user_id ? 'A gift' : null),
      league_id:  null,
      badge: {
        name:        p.item.name,
        description: p.item.description,
        icon:        p.item.icon,
        category:    'cosmetic',
      },
      league: null,
    }));

  const badgeGroups = [
    { label: 'Profile',  groups: groupBadges(badges.filter(b => b.badge.category === 'profile')) },
    { label: 'League',   groups: groupBadges(badges.filter(b => b.badge.category === 'league')) },
    { label: 'Cosmetic', groups: groupBadges(cosmeticBadgeItems) },
  ].filter(g => g.groups.length > 0);
  const visibleBadgeCount =
    badges.filter(b => !b.is_hidden).length +
    cosmeticBadgeItems.filter(b => !b.is_hidden).length;
  const totalBadgeCount = badges.length + cosmeticBadgeItems.length;
  const maxTagSlots = computeMaxTagSlots(earnedBadgeNames);

  const photoUrl = profile?.avatar_url ?? null;
  const cartoonAvatar = AVATARS.find(a => a.id === (profile?.avatar_id ?? 1)) ?? AVATARS[0];
  const displayAvatar = equippedPremium
    ? { emoji: equippedPremium.emoji, bgColor: equippedPremium.bgColor }
    : { emoji: cartoonAvatar.emoji, bgColor: cartoonAvatar.bgColor };

  const tagLabels = (profile?.selected_tags ?? [])
    .map(slug => PLAY_TAGS.find(tg => tg.slug === slug)?.label)
    .filter((l): l is string => !!l);
  const tagOverflow = tagLabels.length - TAG_CHIPS_SHOWN;
  const tagsShown = tagsExpanded ? tagLabels : tagLabels.slice(0, TAG_CHIPS_SHOWN);

  // Coming up: tournaments first (they have a date), then leagues.
  const comingCount = comingTournaments.length + comingLeagues.length;
  const comingLimit = showAllComing ? comingCount : COMING_UP_CAP;
  const shownTournaments = comingTournaments.slice(0, comingLimit);
  const shownLeagues = comingLeagues.slice(0, Math.max(0, comingLimit - shownTournaments.length));
  const comingHidden = comingCount - shownTournaments.length - shownLeagues.length;

  // Reference-section summaries (one line each, shown while collapsed).
  const availSummary = availabilityShortSummary(availability) ?? 'Not set';
  const paddleSummary = defaultPaddle ? `${defaultPaddle.brandName} ${defaultPaddle.modelName}` : 'Not set';
  const chemRows = chemistryResults.filter(r => partnerNames[r.partnerId]);
  const bestChem = chemRows.length > 0
    ? chemRows.reduce((best, r) => (r.overallDelta > best.overallDelta ? r : best), chemRows[0])
    : null;

  // Inventory, by category.
  const inv = {
    avatars:       shopPurchases.filter(p => p.item.category === 'avatar'),
    flairs:        shopPurchases.filter(p => p.item.category === 'flair'),
    listStyles:    shopPurchases.filter(p => p.item.category === 'list_name_style'),
    profileStyles: shopPurchases.filter(p => p.item.category === 'profile_name_style'),
    badges:        shopPurchases.filter(p => p.item.category === 'cosmetic_badge'),
  };

  // The strip's text when there is no measurable badge to show a bar for.
  // League-only badges still gate rewards, so they never read "all earned".
  const unlockText =
    unlock?.kind === 'league_only' ? `${unlock.remaining} more to earn in league play`
    : unlock?.kind === 'all_earned' ? 'Every unlock earned'
    : 'Unlockable rewards';
  const unlockA11y = unlock?.kind === 'next'
    ? `Next unlock: ${unlock.reward}, ${unlock.a11yValue}. Open unlock progress`
    : `${unlockText}. Open unlock progress`;

  return (
    <>
    <ScrollView contentContainerStyle={styles.container} scrollEnabled={!gridScrollLocked} refreshControl={<AppRefreshControl {...refresh} />}>

      <StatusBanner status={status.value} />

      {/* ── 1. Identity ─────────────────────────────────────────── */}
      <View style={styles.identity}>
        <TouchableOpacity
          ref={editAnchor}
          onLayout={anchorOnLayout('edit', editAnchor)}
          onPress={() => setEditOpen(true)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Edit profile"
        >
          {photoUrl ? (
            <CachedImage source={{ uri: photoUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, { backgroundColor: displayAvatar.bgColor }]}>
              <Text style={styles.avatarEmoji}>{displayAvatar.emoji}</Text>
            </View>
          )}
          <View style={styles.avatarEditBadge}>
            <Text style={styles.avatarEditBadgeText}>✏️</Text>
          </View>
        </TouchableOpacity>
        <View style={styles.identityText}>
          {/* TODO: smoke-test in browser — hero name renders with profile_name_style_id */}
          <FlairName
            style={styles.fullName}
            nameColor={profile?.name_color}
            styleId={profile?.profile_name_style_id}
            mode="hero"
            name={profile?.full_name ?? ''}
            numberOfLines={1}
          />
          {profile?.username ? <Text style={t.sub} numberOfLines={1}>@{profile.username}</Text> : null}
          {profile?.tagline ? <Text style={[t.sub, styles.tagline]} numberOfLines={1}>{profile.tagline}</Text> : null}
        </View>
      </View>

      <View style={styles.chipRow}>
        {/* Pickle balance: the pill is the visual, the 44 box the tap target. */}
        <TouchableOpacity
          style={styles.box44}
          onPress={() => navigation.navigate('Shop')}
          accessibilityRole="button"
          accessibilityLabel={`${profile?.pickles ?? 0} pickles. Open the Pickle Shop`}
        >
          <View style={styles.picklePill}>
            <Text style={styles.pickleText} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
              🥒 {profile?.pickles ?? 0} ›
            </Text>
          </View>
        </TouchableOpacity>
        {tagsShown.map(label => (
          <Chip key={label} label={label} tone="brand" size="sm" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
        ))}
        {tagOverflow > 0 ? (
          <Chip
            label={tagsExpanded ? 'Show less' : `+${tagOverflow}`}
            tone="neutral"
            size="sm"
            hitBox
            onPress={() => setTagsExpanded(v => !v)}
            accessibilityRole="button"
            accessibilityLabel={tagsExpanded ? 'Show fewer tags' : `Show ${tagOverflow} more tags`}
            maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
          />
        ) : null}
      </View>

      {/* ── PLUPR ratings (hidden) ──────────────────────────────────
          The global PLUPR card — overall/singles/doubles/mixed values,
          reliability pill, and the trajectory chart — is intentionally not
          rendered. PLUPR is being kept contained within a league rather than
          surfaced on the profile. The EloHistoryChart component, eloHistory
          loader, reliability helper, and formatPlupr import are left intact
          so this card can be restored by re-adding the block.
          ── Court ratings (hidden) ──────────────────────────────────
          Per-court PLUPR ratings are intentionally not rendered — PLUPR is
          being kept contained within a league. The locationRatings state and
          its loader query are left intact so this card can be restored by
          re-adding the block. */}

      {/* ── 2. Quick row ────────────────────────────────────────── */}
      <View style={styles.quickRow}>
        <Button size="sm" title="Edit profile" onPress={() => setEditOpen(true)} style={styles.quickBtn} />
        <Button
          size="sm"
          variant="outline"
          title="Match history"
          onPress={() => userId && navigation.navigate('MatchHistory', { userId, title: 'My Match History' })}
          style={styles.quickBtn}
        />
        <Button
          size="sm"
          variant="outline"
          title="Calendar"
          onPress={() => userId && navigation.navigate('CalendarAnalytics', { userId, title: 'My Calendar' })}
          style={styles.quickBtn}
        />
      </View>

      {/* ── 3. Status strip: next unlock (tour 'profile/rewards') ─── */}
      <View
        ref={rewardsAnchor}
        collapsable={false}
        onLayout={anchorOnLayout('rewards', rewardsAnchor)}
      >
        <TouchableOpacity
          style={styles.strip}
          onPress={() => navigation.navigate('UnlockProgress')}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={unlockA11y}
        >
          <Text style={styles.stripGlyph}>🔓</Text>
          {unlock?.kind === 'next' ? (
            <ProgressBar
              layout="inline"
              progress={unlock.pct}
              minFill={0.02}
              height={6}
              trackColor={colors.border}
              label={`Next unlock: ${unlock.reward}`}
              labelStyle={styles.stripLabel}
              valueText={unlock.valueText}
              containerStyle={styles.flexText}
            />
          ) : (
            <Text style={[styles.stripLabel, styles.flexText]} numberOfLines={1}>
              {unlockText}
            </Text>
          )}
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
      </View>

      {/* Friends (renders nothing while FRIENDS_AT_COURTS_ENABLED is off). */}
      <FriendsLink style={styles.block} />

      {/* My routine (Doggle's Profile button; ROUTINES_ENABLED). */}
      {ROUTINES_ENABLED ? (
        <Button
          size="sm"
          variant="outline"
          title="📅 My routine"
          onPress={() => navigation.navigate('Routines')}
          style={[styles.block, { alignSelf: 'flex-start' }]}
        />
      ) : null}

      {/* ── 4. Coming up ────────────────────────────────────────── */}
      {comingCount > 0 && (
        <View style={styles.block}>
          <SectionHeader title="Coming up" count={comingCount} />
          <Panel padded={false}>
            {shownTournaments.map((tn, i) => (
              <TournamentRow
                key={`t-${tn.id}`}
                layout="row"
                tournament={{ id: tn.id, name: tn.name, location_name: tn.location_name, status: tn.status }}
                leagueName={tn.leagueName}
                myStatus={tn.myStatus}
                invited={tn.invited}
                trailingText={shortWhen(tn.start_time)}
                onPress={() => navigation.navigate('TournamentDetail', { tournamentId: tn.id, tournamentName: tn.name })}
                lastRow={comingHidden === 0 && shownLeagues.length === 0 && i === shownTournaments.length - 1}
              />
            ))}
            {shownLeagues.map((l, i) => (
              <LeagueRow
                key={`l-${l.id}`}
                layout="row"
                league={{ id: l.id, name: l.name, home_court: l.home_court, is_open: l.is_open }}
                role={l.role}
                onPress={() => navigation.navigate('LeagueDetail', { leagueId: l.id, leagueName: l.name })}
                lastRow={comingHidden === 0 && i === shownLeagues.length - 1}
              />
            ))}
            {comingHidden > 0 && (
              <TouchableOpacity
                style={styles.moreRow}
                onPress={() => setShowAllComing(true)}
                accessibilityRole="button"
              >
                <Text style={[t.meta, { color: colors.primary }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                  Show {comingHidden} more
                </Text>
              </TouchableOpacity>
            )}
          </Panel>
        </View>
      )}

      {/* ── 5. Reference (collapsed; content mounts on open) ──────── */}
      <View style={styles.reference}>
        {/* Renders nothing while REFERRALS_ENABLED is off, and for guests. */}
        <InviteEarnSection onToggle={onSectionToggle('invite')} />

        <CollapsibleSection
          compact
          title="Availability"
          summary={availSummary}
          // The grid unmounts on collapse; it releases the page scroll lock
          // itself if that happens mid-Edit.
          onToggle={onSectionToggle('availability')}
        >
          <View style={styles.availHead}>
            <Text style={[t.sub, styles.flexText]} numberOfLines={2}>
              Auto-saved · used for event filters and player matching
            </Text>
            {avSaveStatus === 'saving' && <Text style={t.meta}>Saving…</Text>}
            {avSaveStatus === 'saved' && <Text style={[t.meta, { color: colors.primary }]}>✓ Saved</Text>}
            {avSaveStatus === 'error' && <Text style={[t.meta, { color: colors.warning }]}>⚠ Save failed</Text>}
            {avSaveStatus === 'needs-migration' && (
              <Text style={[t.meta, { color: colors.warning }]}>Run migration_add_availability.sql</Text>
            )}
          </View>
          <AvailabilityGrid
            availability={availability}
            onChange={handleAvailabilityChange}
            onScrollLock={setGridScrollLocked}
          />
        </CollapsibleSection>

        <CollapsibleSection
          compact
          title="Paddle"
          summary={paddleSummary}
          onToggle={onSectionToggle('paddle')}
        >
          {defaultPaddle ? (
            <View style={styles.paddleRow}>
              <View style={styles.flexText}>
                <Text style={t.meta} numberOfLines={1}>{defaultPaddle.brandName}</Text>
                <Text style={t.title} numberOfLines={1}>{defaultPaddle.modelName}</Text>
                {defaultPaddle.thicknessMm != null && (
                  <Text style={t.sub}>{defaultPaddle.thicknessMm} mm core</Text>
                )}
              </View>
              <Button size="sm" variant="outline" title="Change" onPress={() => setShowPaddlePicker(true)} />
              <Button size="sm" variant="danger" title="Remove" onPress={removePaddle} />
            </View>
          ) : (
            <View style={styles.paddleRow}>
              <Text style={[t.sub, styles.flexText]} numberOfLines={2}>
                Auto-filled when recording matches. Editable within 72 hours.
              </Text>
              <Button size="sm" title="Set paddle" onPress={() => setShowPaddlePicker(true)} />
            </View>
          )}
        </CollapsibleSection>

        {totalBadgeCount > 0 && (
          <CollapsibleSection
            compact
            title="Badges"
            count={totalBadgeCount}
            summary={`${visibleBadgeCount} shown${profile?.badges_public === false ? ' · private profile' : ''}`}
            onToggle={onSectionToggle('badges')}
          >
            <View style={styles.badgeActions}>
              <Text style={[t.sub, styles.flexText]} numberOfLines={1}>Tap a badge to see why you earned it.</Text>
              <TouchableOpacity style={styles.textBtn} onPress={() => setAllBadgesHidden(false)} accessibilityRole="button">
                <Text style={styles.linkText} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Show all</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.textBtn} onPress={() => setAllBadgesHidden(true)} accessibilityRole="button">
                <Text style={styles.linkText} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Hide all</Text>
              </TouchableOpacity>
            </View>
            {badgeGroups.map(g => (
              <View key={g.label}>
                <Text style={[t.fieldLabel, styles.groupLabel]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{g.label}</Text>
                <View style={styles.badgeGrid}>
                  {g.groups.map(bg => (
                    <BadgeDisplay
                      key={bg.rep.id}
                      badge={bg.rep}
                      stack={bg.stack}
                      isOwner
                      onToggleHide={toggleBadgeVisibility}
                    />
                  ))}
                </View>
              </View>
            ))}
          </CollapsibleSection>
        )}

        {shopPurchases.length > 0 && (
          <CollapsibleSection
            compact
            title="Inventory"
            count={shopPurchases.length}
            summary="Tap to equip"
            onToggle={onSectionToggle('inventory')}
          >
            {inv.avatars.length > 0 && (
              <View>
                <Text style={[t.fieldLabel, styles.groupLabel]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Avatars</Text>
                {inv.avatars.map(p => {
                  const equipped = profile?.avatar_emoji === p.item.payload?.emoji
                                && profile?.avatar_bg_color === p.item.payload?.bgColor;
                  return (
                    <InvRow
                      key={p.id}
                      icon={p.item.icon}
                      bgColor={p.item.payload?.bgColor ?? colors.surfaceAlt}
                      name={p.item.name}
                      gift={p.gifted_by_user_id}
                      message={p.gift_message}
                      isHidden={p.is_hidden}
                      onToggleHidden={() => togglePurchaseHidden(p.id, p.is_hidden)}
                      actionLabel={equipped ? 'Equipped' : 'Equip'}
                      equipped={equipped}
                      onAction={() => equipAvatar(p.item.payload?.emoji ?? null, p.item.payload?.bgColor ?? null)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.avatar_emoji && (
                  <TouchableOpacity style={styles.revertRow} onPress={() => equipAvatar(null, null)} accessibilityRole="button">
                    <Text style={styles.revertText}>↺ Revert to cartoon avatar</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {inv.flairs.length > 0 && (
              <View>
                <Text style={[t.fieldLabel, styles.groupLabel]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Name color flair</Text>
                {inv.flairs.map(p => {
                  const value    = p.item.payload?.value as string | undefined;
                  const equipped = !!value && profile?.name_color === value;
                  return (
                    <InvRow
                      key={p.id}
                      icon={p.item.icon}
                      bgColor={value ?? colors.surfaceAlt}
                      name={p.item.name}
                      gift={p.gifted_by_user_id}
                      message={p.gift_message}
                      isHidden={p.is_hidden}
                      onToggleHidden={() => togglePurchaseHidden(p.id, p.is_hidden)}
                      actionLabel={equipped ? 'Active' : 'Apply'}
                      equipped={equipped}
                      onAction={() => applyFlair(value ?? null)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.name_color && (
                  <TouchableOpacity style={styles.revertRow} onPress={() => applyFlair(null)} accessibilityRole="button">
                    <Text style={styles.revertText}>↺ Revert to default name color</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {inv.listStyles.length > 0 && (
              <View>
                <Text style={[t.fieldLabel, styles.groupLabel]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>List name styles</Text>
                {inv.listStyles.map(p => {
                  const slug     = p.item.slug;
                  const equipped = profile?.list_name_style_id === slug;
                  return (
                    <InvRow
                      key={p.id}
                      icon={p.item.icon}
                      bgColor={p.item.payload?.bgColor ?? colors.surfaceAlt}
                      name={p.item.name}
                      gift={p.gifted_by_user_id}
                      message={p.gift_message}
                      isHidden={p.is_hidden}
                      onToggleHidden={() => togglePurchaseHidden(p.id, p.is_hidden)}
                      actionLabel={equipped ? 'Equipped' : 'Equip'}
                      equipped={equipped}
                      onAction={() => applyListNameStyle(slug)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.list_name_style_id && (
                  <TouchableOpacity style={styles.revertRow} onPress={() => applyListNameStyle(null)} accessibilityRole="button">
                    <Text style={styles.revertText}>↺ Revert to default list name style</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {inv.profileStyles.length > 0 && (
              <View>
                <Text style={[t.fieldLabel, styles.groupLabel]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Profile name styles</Text>
                {inv.profileStyles.map(p => {
                  const slug     = p.item.slug;
                  const equipped = profile?.profile_name_style_id === slug;
                  return (
                    <InvRow
                      key={p.id}
                      icon={p.item.icon}
                      bgColor={p.item.payload?.bgColor ?? colors.surfaceAlt}
                      name={p.item.name}
                      gift={p.gifted_by_user_id}
                      message={p.gift_message}
                      isHidden={p.is_hidden}
                      onToggleHidden={() => togglePurchaseHidden(p.id, p.is_hidden)}
                      actionLabel={equipped ? 'Equipped' : 'Equip'}
                      equipped={equipped}
                      onAction={() => applyProfileNameStyle(slug)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.profile_name_style_id && (
                  <TouchableOpacity style={styles.revertRow} onPress={() => applyProfileNameStyle(null)} accessibilityRole="button">
                    <Text style={styles.revertText}>↺ Revert to default profile name style</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {inv.badges.length > 0 && (
              <View>
                <Text style={[t.fieldLabel, styles.groupLabel]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>Cosmetic badges</Text>
                {inv.badges.map(p => (
                  <InvRow
                    key={p.id}
                    icon={p.item.icon}
                    bgColor={p.item.payload?.bgColor ?? colors.surfaceAlt}
                    name={p.item.name}
                    gift={p.gifted_by_user_id}
                    message={p.gift_message}
                    isHidden={p.is_hidden}
                    onToggleHidden={() => togglePurchaseHidden(p.id, p.is_hidden)}
                    styles={styles}
                  />
                ))}
              </View>
            )}
          </CollapsibleSection>
        )}

        {chemRows.length > 0 && (
          <CollapsibleSection
            compact
            title="Doubles chemistry"
            count={chemRows.length}
            summary={bestChem ? `Best: ${partnerNames[bestChem.partnerId]?.full_name} ${fmtDelta(bestChem.overallDelta)}` : undefined}
            onToggle={onSectionToggle('chemistry')}
          >
            <Text style={t.sub} numberOfLines={2}>Win-rate boost vs your baseline when playing with each partner</Text>
            {chemRows.map(r => {
              const partner = partnerNames[r.partnerId];
              const av = AVATARS.find(a => a.id === (partner.avatar_id ?? 1)) ?? AVATARS[0];
              const tone = chemTone(colors, r.overallDelta);
              return (
                <View key={r.partnerId} style={styles.chemRow}>
                  <View style={[styles.chemAvatar, { backgroundColor: av.bgColor }]}>
                    <Text style={styles.chemAvatarEmoji}>{av.emoji}</Text>
                  </View>
                  <View style={styles.flexText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{partner.full_name}</Text>
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {r.insights[0] ?? `${r.matchesTogether} match${r.matchesTogether !== 1 ? 'es' : ''} together`}
                    </Text>
                  </View>
                  <View style={styles.chemCount}>
                    <Text style={t.meta} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{r.matchesTogether}</Text>
                    <BallIcon size={14} />
                  </View>
                  <View style={[styles.chemBadge, { backgroundColor: tone.bg, borderColor: tone.fg }]}>
                    <Text style={[t.meta, { color: tone.fg }]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
                      {fmtDelta(r.overallDelta)}
                    </Text>
                  </View>
                </View>
              );
            })}
            {!chemRows.some(r => r.significant) && (
              <Text style={t.meta}>Play 5+ doubles matches with a partner to unlock deeper insights</Text>
            )}
          </CollapsibleSection>
        )}
      </View>

    </ScrollView>

    <PaddlePickerModal
      visible={showPaddlePicker}
      initial={defaultPaddle}
      onSelect={saveDefaultPaddle}
      onClose={() => setShowPaddlePicker(false)}
    />

    {userId && (
      <EditProfileSheet
        visible={editOpen}
        userId={userId}
        initial={editInitial}
        earnedBadgeNames={earnedBadgeNames}
        purchasedAvatars={premiumAvatars}
        maxTagSlots={maxTagSlots}
        onClose={() => setEditOpen(false)}
        onSaved={handleEditSaved}
      />
    )}
    </>
  );
}

const AVATAR = 64;

function makeStyles(c: Colors) {
  return StyleSheet.create({
    container: { padding: SPACE.lg, paddingBottom: SPACE.xl, backgroundColor: c.bg, flexGrow: 1 },
    flexText:  { flex: 1, minWidth: 0 },
    box44:     { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    chevron:   { fontSize: FONT.size.h2, fontWeight: '700', color: c.textMuted },
    block:     { marginBottom: SPACE.md },

    // 1. Identity: avatar 64 beside name / @username / tagline.
    identity:        { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
    identityText:    { flex: 1, minWidth: 0, gap: SPACE.xxs },
    avatar:          { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji:     { fontSize: 34 },
    avatarEditBadge: {
      position: 'absolute', bottom: -2, right: -2, width: 24, height: 24, borderRadius: 12,
      backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center',
      borderWidth: HAIRLINE, borderColor: c.border,
    },
    avatarEditBadgeText: { fontSize: FONT.size.xs },
    fullName:        { fontSize: FONT.size.h2, fontWeight: '700', color: c.text },
    tagline:         { fontStyle: 'italic' },
    chipRow:         { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE.sm, marginBottom: SPACE.xs },
    picklePill: {
      flexDirection: 'row', alignItems: 'center', minHeight: 28,
      paddingHorizontal: SPACE.md, borderRadius: RADIUS.pill,
      backgroundColor: c.primaryLight, borderWidth: HAIRLINE, borderColor: c.primary,
    },
    pickleText:      { fontSize: FONT.size.sm, fontWeight: '700', color: c.primary },

    // 2. Quick row: three sm buttons sized to their labels, sharing the spare width.
    quickRow:  { flexDirection: 'row', gap: SPACE.sm, marginBottom: SPACE.sm },
    quickBtn:  { flexGrow: 1 },

    // 3. Status strip
    strip: {
      flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
      minHeight: 48, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs,
      borderRadius: RADIUS.lg, borderWidth: HAIRLINE, borderColor: c.border,
      backgroundColor: c.surface, marginBottom: SPACE.md,
    },
    stripGlyph: { fontSize: FONT.size.lg },
    stripLabel: { fontSize: FONT.size.base, fontWeight: '600', color: c.text },

    // 4. Coming up
    moreRow: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderTopWidth: HAIRLINE, borderTopColor: c.border },

    // 5. Reference
    reference:  {},
    groupLabel: { marginTop: SPACE.xs },
    // The title preset (15/700); InvRow gets styles but not `t`.
    rowTitle:   textStyles(c).title,
    rowSub:     textStyles(c).sub,
    textDim:    { color: c.textMuted },
    textBtn:    { minHeight: 44, minWidth: 44, paddingHorizontal: SPACE.xs, alignItems: 'center', justifyContent: 'center' },
    linkText:   { fontSize: FONT.size.sm, fontWeight: '600', color: c.primary },

    availHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    paddleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },

    badgeActions: { flexDirection: 'row', alignItems: 'center' },
    badgeGrid:    { flexDirection: 'row', flexWrap: 'wrap', margin: -SPACE.xs },

    invRow:       { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 56 },
    invRowHidden: { opacity: 0.55 },
    invIconBox:   { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
    invIconEmoji: { fontSize: FONT.size.xl },
    invHideText:  { fontSize: FONT.size.lg },
    equippedText: { fontSize: FONT.size.sm, fontWeight: '600', color: c.textMuted, paddingHorizontal: SPACE.xs },
    revertRow:    { minHeight: 44, justifyContent: 'center' },
    revertText:   { fontSize: FONT.size.sm, color: c.textMuted, fontWeight: '600' },

    chemRow:         { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
    chemAvatar:      { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
    chemAvatarEmoji: { fontSize: FONT.size.xl },
    chemCount:       { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    chemBadge:       { paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.md, borderWidth: HAIRLINE },
  });
}
