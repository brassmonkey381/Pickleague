// Your own profile (plan section 5, "Profile"): about 600px collapsed, down
// from 3,500-4,700px. The one section order every detail screen uses:
//   1. Identity    avatar 64 (opens the Edit sheet; tour 'profile/edit'), name,
//                  @username, tagline, pickle balance (-> Shop), tag chips (+N)
//   2. Quick row   [Edit profile] [Match history] [Calendar]
//   3. Status      "Next unlock: Ninja avatar 3/5 >" (tour 'profile/rewards';
//                  replaces the ~900px Unlockable Rewards card, whose rows all
//                  live on Achievements; the row opens it on that badge),
//                  then "Achievements · 3 of 42 unlocked" (the page)
//   4. Coming up   my leagues & live tournaments -> their detail screens
//   5. Reference   collapsed: Availability · Paddle · Inventory ·
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
import { Panel, SectionHeader, CollapsibleSection, Chip, ListCard, TextLink } from '@just-messin-around/expo-foundation/ui';
import { Icon, IconValue, EmojiGlyph } from '@just-messin-around/expo-foundation/icons';
import InviteEarnSection from '../components/referrals/InviteEarnSection';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { ProgressBar } from '@just-messin-around/expo-foundation/gamification';
import { SPACE, RADIUS, HAIRLINE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { PickleBalance } from '../components/PickleAmount';
import Svg, { Polyline, Line as SvgLine, Text as SvgText, Circle } from 'react-native-svg';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { withGiftNotes } from '../data/giftMessages';
import { equipShopItem, unequipCosmetic, type CosmeticCategory, type EquippableItem } from '../data/cosmetics';
import { explainRefusal } from '../lib/refusalNotices';
import { useTheme } from '../lib/ThemeContext';
import { useTour } from '../lib/TourContext';
import { Profile, PlayerLocationRating, ShopItem, RootStackParamList, BadgeItem } from '../types';
import { loadAchievements } from '../lib/achievementsData';
import { overallSummary } from '../lib/achievements';
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
  computeAllPartnerChemistry, fmtDelta, chemistryTone,
  ChemistryResult, DoublesMatch,
} from '../lib/chemistry';
import { computeBadgeProgress } from '../lib/unlockProgress';
import { nextUnlockTeaser, NextUnlockResult } from '../lib/profileSummary';
import { availabilityShortSummary } from '@just-messin-around/expo-foundation/scheduling/availability';
import { trackSectionToggle } from '../lib/analytics';
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
      <Text style={[textStyles(c).meta, { textAlign: 'center', paddingVertical: SPACE.lg }]}>
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
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.md, justifyContent: 'center', marginBottom: SPACE.xs }}>
        {[
          { key: 'overall',  label: 'Overall',          color: FACET_COLORS.overall  },
          { key: 'singles',  label: 'Singles',          color: FACET_COLORS.singles  },
          { key: 'gendered', label: 'Gendered Doubles', color: FACET_COLORS.gendered },
          { key: 'mixed',    label: 'Mixed Doubles',    color: FACET_COLORS.mixed    },
        ].map(item => (
          <View key={item.key} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.xs }}>
            <View style={{ width: 14, height: 3, backgroundColor: item.color, borderRadius: RADIUS.pill }} />
            <Text style={{ fontSize: FONT.size.xs, color: c.textSub, fontWeight: FONT.weight.semibold }}>{item.label}</Text>
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
  icon, glyphify, bgColor, name, gift, message, isHidden,
  actionLabel, equipped, onAction, onToggleHidden, styles,
}: {
  icon: string; bgColor: string; name: string;
  /** Cosmetic badges: their stored emoji draws as our glyph when one maps.
   *  Avatars, flairs and name styles keep the emoji the player bought. */
  glyphify?: boolean;
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
  const { colors: c } = useTheme();
  return (
    <View style={[styles.invRow, isHidden && styles.invRowHidden]}>
      <View style={[styles.invIconBox, { backgroundColor: bgColor }]}>
        {glyphify
          ? <EmojiGlyph emoji={icon} size={20} style={styles.invIconEmoji} />
          : <Text style={styles.invIconEmoji}>{icon}</Text>}
      </View>
      <View style={styles.flexText}>
        <Text style={[styles.rowTitle, isHidden && styles.textDim]} numberOfLines={1}>{name}</Text>
        {gift && (
          <View style={styles.inlineRow}>
            <Icon name="gift" size={14} color={c.textSub} />
            <Text style={[styles.rowSub, styles.flexText]} numberOfLines={1}>
              Gift{message ? ` · "${message}"` : ''}
            </Text>
          </View>
        )}
      </View>
      <TouchableOpacity
        onPress={onToggleHidden}
        style={styles.box44}
        accessibilityRole="button"
        accessibilityLabel={isHidden ? `Show ${name}` : `Hide ${name}`}
      >
        <Icon name={isHidden ? 'eye-off' : 'eye'} size={18} color={c.textSub} />
      </TouchableOpacity>
      {actionLabel ? (
        equipped ? (
          <View style={[styles.box44, styles.inlineRow]}>
            <Icon name="check-mark" size={12} color={c.success} />
            <Text style={styles.equippedText} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>{actionLabel}</Text>
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
  // The Achievements row's "12 of 40 unlocked"; null until known.
  const [achCount, setAchCount] = useState<{ earned: number; total: number } | null>(null);
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
  //     Achievements now, and the pill opens the Shop, whose Buy & Equip
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
    loadAchievementCount(user.id);
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

    const rows = ((data ?? []) as any[]).filter(r => r.item) as PurchaseWithItem[];
    setShopPurchases(rows);
    // A gift's note is the sender's and recipient's alone (its own table); fill
    // it in after the list shows, so a slow read never holds the list back.
    const withNotes = await withGiftNotes(rows);
    if (withNotes !== rows) setShopPurchases(withNotes);
  }

  // The status strip reads the same progress math as Achievements and Home
  // (lib/unlockProgress), so the three never disagree.
  async function loadNextUnlock(uid: string) {
    try {
      setUnlock(nextUnlockTeaser(await computeBadgeProgress(uid)));
    } catch {
      // computeBadgeProgress throws rather than reporting zero progress; keep
      // the strip's neutral "Unlockable rewards" instead of a wrong number.
    }
  }

  // The Achievements row's count, from the same build the page uses (light:
  // no progress maths), so the two never disagree.
  async function loadAchievementCount(uid: string) {
    try {
      setAchCount(overallSummary((await loadAchievements(uid, true, { light: true })).achievements));
    } catch {
      // The row still opens the page; it just shows no count.
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

  // Only the profile columns other screens write (Getting started claims on Achievements, Shop
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
    void loadAchievementCount(uid);
  };

  // Inventory Equip / Revert. The server checks the player owns the item
  // (equip_shop_item, migration_cosmetic_equip_owned.sql) and answers with the
  // equipped columns, merged here; a refusal says why and what to do.
  async function equipItem(item: EquippableItem & { name?: string }) {
    if (!userId) return;
    try {
      const cols = await equipShopItem(item);
      setProfile(p => p ? { ...p, ...cols } : p);
    } catch (e) {
      status.error(explainRefusal(e, `Couldn't equip ${item.name ?? 'that'}. Try again.`));
    }
  }

  async function unequip(category: CosmeticCategory) {
    if (!userId) return;
    try {
      const cols = await unequipCosmetic(category);
      setProfile(p => p ? { ...p, ...cols } : p);
    } catch (e) {
      status.error(explainRefusal(e, "Couldn't change it back just now. Try again."));
    }
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
      itemId: p.item.id,
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
    ? `Next unlock: ${unlock.reward}, ${unlock.a11yValue}. Open achievements`
    : `${unlockText}. Open achievements`;

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
            <Icon name="edit" size={14} color={colors.textSub} />
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
        {/* Pickle balance, drawn as on Home (glyph + number); the 44 box is
            the tap target. */}
        <TouchableOpacity
          style={styles.box44}
          onPress={() => navigation.navigate('Shop')}
          accessibilityRole="button"
          accessibilityLabel={`${(profile?.pickles ?? 0).toLocaleString()} pickles. Open the Pickle Shop`}
        >
          <PickleBalance balance={profile ? profile.pickles ?? 0 : null} preset="title" decorative />
        </TouchableOpacity>
        {tagsShown.map(label => (
          <Chip key={label} label={label} tone="brand" size="sm" align="center" maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE} />
        ))}
        {tagOverflow > 0 ? (
          <Chip
            label={tagsExpanded ? 'Show less' : `+${tagOverflow}`}
            tone="neutral"
            size="sm"
            align="center"
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
        <ListCard
          density="compact"
          minHeight={STRIP_HEIGHT}
          style={styles.block}
          leading={<Icon name="lock-open" size={18} color={colors.primary} />}
          title={unlock?.kind === 'next' ? (
            <ProgressBar
              layout="inline"
              progress={unlock.pct}
              minFill={0.02}
              height={6}
              trackColor={colors.border}
              label={`Next unlock: ${unlock.reward}`}
              labelStyle={styles.stripLabel}
              valueText={unlock.valueText}
            />
          ) : <Text style={styles.stripLabel} numberOfLines={1}>{unlockText}</Text>}
          chevron
          // Opens Achievements on the badge it names (its detail sheet).
          onPress={() => navigation.navigate('Achievements', unlock?.kind === 'next' ? { focus: unlock.badge } : undefined)}
          accessibilityRole="button"
          accessibilityLabel={unlockA11y}
        />
      </View>

      {/* Achievements: one strip row to the page, under the next unlock it
          belongs with (was the Badges grid in Reference; the page has the
          medals, progress, and the hide-from-profile toggles). */}
      <ListCard
        density="compact"
        minHeight={STRIP_HEIGHT}
        style={styles.block}
        leading={<Icon name="medal" size={18} color={colors.primary} />}
        // The count sits in the title: a ListCard `trailing` replaces the chevron
        // the strips above and below keep.
        title={(
          <Text style={styles.stripLabel} numberOfLines={1}>
            Achievements
            {achCount ? <Text style={styles.stripCount}> · {achCount.earned} of {achCount.total} unlocked</Text> : null}
          </Text>
        )}
        chevron
        onPress={() => navigation.navigate('Achievements')}
        accessibilityRole="button"
        accessibilityLabel={achCount ? `Achievements, ${achCount.earned} of ${achCount.total} unlocked` : 'Achievements'}
      />

      {/* Friends (renders nothing while FRIENDS_AT_COURTS_ENABLED is off). */}
      <FriendsLink style={styles.block} />

      {/* My Place (docs/my-place.md): my decoratable room. */}
      <ListCard
        density="compact"
        minHeight={STRIP_HEIGHT}
        style={styles.block}
        leading={<Icon name="home" size={18} color={colors.primary} />}
        title={<Text style={styles.stripLabel} numberOfLines={1}>My Place</Text>}
        chevron
        onPress={() => navigation.navigate('MyPlace')}
        accessibilityRole="button"
        accessibilityLabel="My Place, your room"
      />

      {/* My routine (Doggle's Profile button; ROUTINES_ENABLED): the same
          strip row as Friends and the next unlock. */}
      {ROUTINES_ENABLED ? (
        <ListCard
          density="compact"
          minHeight={STRIP_HEIGHT}
          style={styles.block}
          leading={<Icon name="calendar-event" size={18} color={colors.primary} />}
          title={<Text style={styles.stripLabel} numberOfLines={1}>My routine</Text>}
          chevron
          onPress={() => navigation.navigate('Routines')}
          accessibilityRole="button"
          accessibilityLabel="My routine"
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
          iconName="clock"
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
            {avSaveStatus === 'saved' && (
              <View style={styles.inlineRow}>
                <Icon name="check-mark" size={12} color={colors.success} />
                <Text style={[t.meta, { color: colors.success }]}>Saved</Text>
              </View>
            )}
            {avSaveStatus === 'error' && (
              <View style={styles.inlineRow}>
                <Icon name="warning" size={12} color={colors.warning} />
                <Text style={[t.meta, { color: colors.warning }]}>Save failed</Text>
              </View>
            )}
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
          iconName="paddle"
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

        {shopPurchases.length > 0 && (
          <CollapsibleSection
            compact
            iconName="bag"
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
                      onAction={() => equipItem(p.item)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.avatar_emoji && (
                  <TextLink iconName="undo" tone="sub" chevron={false} label="Revert to cartoon avatar" onPress={() => unequip('avatar')} />
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
                      onAction={() => equipItem(p.item)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.name_color && (
                  <TextLink iconName="undo" tone="sub" chevron={false} label="Revert to default name color" onPress={() => unequip('flair')} />
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
                      onAction={() => equipItem(p.item)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.list_name_style_id && (
                  <TextLink iconName="undo" tone="sub" chevron={false} label="Revert to default list name style" onPress={() => unequip('list_name_style')} />
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
                      onAction={() => equipItem(p.item)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.profile_name_style_id && (
                  <TextLink iconName="undo" tone="sub" chevron={false} label="Revert to default profile name style" onPress={() => unequip('profile_name_style')} />
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
                    glyphify
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
            iconName="handshake"
            title="Doubles chemistry"
            count={chemRows.length}
            summary={bestChem ? `Best: ${partnerNames[bestChem.partnerId]?.full_name} ${fmtDelta(bestChem.overallDelta)}` : undefined}
            onToggle={onSectionToggle('chemistry')}
          >
            <Text style={t.sub} numberOfLines={2}>Win-rate boost vs your baseline when playing with each partner</Text>
            {chemRows.map(r => {
              const partner = partnerNames[r.partnerId];
              const av = AVATARS.find(a => a.id === (partner.avatar_id ?? 1)) ?? AVATARS[0];
              const tone = chemistryTone(r.overallDelta, colors);
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
                  <IconValue
                    iconName="pickleball"
                    value={r.matchesTogether}
                    preset="meta"
                    iconColor={colors.textMuted}
                    maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
                    accessibilityLabel={`${r.matchesTogether} ${r.matchesTogether === 1 ? 'match' : 'matches'} together`}
                  />
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
        onPartialSaved={saved => setProfile(p => (p ? { ...p, ...saved } : p))}
      />
    )}
    </>
  );
}

const AVATAR = 64;
/** The one-line strip rows (next unlock, Friends, My routine): ListCard
 *  compact, kept at the 48 they were rather than the 56 two-line default. */
const STRIP_HEIGHT = 48;

function makeStyles(c: Colors) {
  return StyleSheet.create({
    container: { padding: SPACE.lg, paddingBottom: SPACE.xl, backgroundColor: c.bg, flexGrow: 1 },
    flexText:  { flex: 1, minWidth: 0 },
    box44:     { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    // A glyph beside a short text (gift line, Equipped, Saved).
    inlineRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    block:     { marginBottom: SPACE.md },

    // 1. Identity: avatar 64 beside name / @username / tagline.
    identity:        { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
    identityText:    { flex: 1, minWidth: 0, gap: SPACE.xxs },
    avatar:          { width: AVATAR, height: AVATAR, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
    avatarEmoji:     { fontSize: 34 },
    avatarEditBadge: {
      position: 'absolute', bottom: -SPACE.xxs, right: -SPACE.xxs, width: 24, height: 24, borderRadius: RADIUS.pill,
      backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center',
      borderWidth: HAIRLINE, borderColor: c.border,
    },
    fullName:        { fontSize: FONT.size.h2, fontWeight: FONT.weight.bold, color: c.text },
    tagline:         { fontStyle: 'italic' },
    chipRow:         { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE.sm, marginBottom: SPACE.xs },

    // 2. Quick row: three sm buttons sized to their labels, sharing the spare width.
    quickRow:  { flexDirection: 'row', gap: SPACE.sm, marginBottom: SPACE.sm },
    quickBtn:  { flexGrow: 1 },

    // 3. The strip rows (next unlock, Friends, My routine) share one 13/600
    // label: the unlock label shares its row with a bar and a count, so the
    // reward name keeps more of its width.
    stripLabel: { fontSize: FONT.size.base, fontWeight: FONT.weight.semibold, color: c.text },
    stripCount: { fontWeight: FONT.weight.regular, color: c.textSub },

    // 4. Coming up
    moreRow: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderTopWidth: HAIRLINE, borderTopColor: c.border },

    // 5. Reference
    reference:  {},
    groupLabel: { marginTop: SPACE.xs },
    // The title preset (15/700); InvRow gets styles but not `t`.
    rowTitle:   textStyles(c).title,
    rowSub:     textStyles(c).sub,
    textDim:    { color: c.textMuted },

    availHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
    paddleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },


    invRow:       { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 56 },
    invRowHidden: { opacity: 0.55 },
    invIconBox:   { width: 36, height: 36, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
    invIconEmoji: { fontSize: FONT.size.xl },
    equippedText: { fontSize: FONT.size.sm, fontWeight: FONT.weight.semibold, color: c.textSub },

    chemRow:         { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
    chemAvatar:      { width: 32, height: 32, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
    chemAvatarEmoji: { fontSize: FONT.size.xl },
    chemBadge:       { paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.md, borderWidth: HAIRLINE },
  });
}
