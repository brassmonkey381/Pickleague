import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Image, useWindowDimensions,
} from 'react-native';
import Svg, { Polyline, Line as SvgLine, Text as SvgText, Circle } from 'react-native-svg';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { useTour } from '../lib/TourContext';
import { Gender, Profile, PlayerLocationRating, ShopItem, RootStackParamList } from '../types';
import BadgeDisplay, { BadgeItem } from '../components/BadgeDisplay';
import FlairName from '../components/FlairName';
import PaddlePickerModal, { PaddleSelection } from '../components/PaddlePickerModal';
import AvatarPickerModal, { PremiumAvatar } from '../components/AvatarPickerModal';
import TagPickerModal from '../components/TagPickerModal';
import AvailabilityGrid from '../components/AvailabilityGrid';
import StatusBanner from '../components/StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { AVATARS, PLAY_TAGS, TAG_SLOT_UNLOCKS, computeMaxTagSlots } from '../data/profileCustomization';
import { TOTAL_CELLS } from '../lib/availability';
import { computeReliability } from '../lib/reliability';
import { formatPlupr, formatPluprShort } from '../lib/plupr';
import {
  computeAllPartnerChemistry, fmtDelta, chemistryColor,
  ChemistryResult, DoublesMatch,
} from '../lib/chemistry';
import { AVATARS as AVATAR_LIST } from '../data/profileCustomization';
import { BallIcon } from '../components/PickleIcons';
import FtueChecklistCard from '../components/FtueChecklistCard';
import { useRefresh } from '../lib/useRefresh';
import AppRefreshControl from '../components/AppRefreshControl';
import { SkeletonList } from '../components/Skeleton';

// Shared progress row used inside the Unlockable Rewards card
function UnlockProgressRow({
  prog,
}: {
  prog: { text: string; pct: number; showBar: boolean };
}) {
  const { colors: c } = useTheme();
  if (!prog.showBar) {
    return <Text style={{ fontSize: 11, color: c.textMuted, fontStyle: 'italic' }}>{prog.text}</Text>;
  }
  const filled = Math.max(prog.pct, 0.02);
  const empty  = 1 - filled;
  return (
    <>
      <View style={{ flexDirection: 'row', height: 5, borderRadius: 3, overflow: 'hidden', marginTop: 5, marginBottom: 3, backgroundColor: c.border }}>
        <View style={[{ backgroundColor: c.primary }, { flex: filled }]} />
        {empty > 0 && <View style={[{ backgroundColor: c.border }, { flex: empty }]} />}
      </View>
      <Text style={{ fontSize: 11, color: c.textSub, fontWeight: '600' }}>{prog.text}</Text>
    </>
  );
}

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

const FACET_COLORS = {
  overall:  '#4caf50', // green
  singles:  '#1976d2', // blue
  gendered: '#00897b', // teal
  mixed:    '#8e24aa', // purple
} as const;

function EloHistoryChart({
  matches, userId, colors: c,
}: {
  matches: EloMatchRow[];
  userId: string;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
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
          { key: 'overall',  label: 'Overall',      color: FACET_COLORS.overall  },
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

function InvRow({
  icon, bgColor, name, gift, message, isHidden,
  actionLabel, actionDisabled, onAction, onToggleHidden, styles,
}: {
  icon: string; bgColor: string; name: string;
  gift: string | null; message: string | null;
  isHidden: boolean;
  actionLabel?: string; actionDisabled?: boolean; onAction?: () => void;
  onToggleHidden: () => void;
  styles: any;
}) {
  return (
    <View style={[styles.invRow, isHidden && styles.invRowHidden]}>
      <View style={[styles.invIconBox, { backgroundColor: bgColor }]}>
        <Text style={styles.invIconEmoji}>{icon}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.invName, isHidden && styles.invNameDim]} numberOfLines={1}>{name}</Text>
        {gift && (
          <Text style={styles.invGiftLabel} numberOfLines={1}>
            🎁 Gift{message ? ` · "${message}"` : ''}
          </Text>
        )}
      </View>
      <TouchableOpacity
        onPress={onToggleHidden}
        style={styles.invHideBtn}
        accessibilityRole="button"
        accessibilityLabel={isHidden ? `Show ${name}` : `Hide ${name}`}
      >
        <Text style={styles.invHideText}>{isHidden ? '🙈' : '👁️'}</Text>
      </TouchableOpacity>
      {actionLabel && (
        <TouchableOpacity
          style={[styles.invActionBtn, actionDisabled && styles.invActionBtnDim]}
          onPress={onAction}
          disabled={actionDisabled}
        >
          <Text style={[styles.invActionText, actionDisabled && styles.invActionTextDim]}>
            {actionLabel}
          </Text>
        </TouchableOpacity>
      )}
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

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Profile'> };

export default function ProfileScreen({ navigation }: Props) {
  const { colors } = useTheme();
  // container padding 24×2 + card padding 16×2 = 80; 3 gaps × 6 = 18.
  // useWindowDimensions() recomputes on window resize so the layout stays
  // aligned on web when the user resizes their browser. Native unaffected.
  const { width: windowWidth } = useWindowDimensions();
  const locPillW = Math.floor((windowWidth - 80 - 18) / 4);
  const styles = useMemo(() => makeStyles(colors, locPillW), [colors, locPillW]);
  const GREEN = colors.primary;
  const status = useStatusMessage();
  const [profile, setProfile]             = useState<Profile | null>(null);
  const [locationRatings, setLocationRatings] = useState<PlayerLocationRating[]>([]);
  const [badges, setBadges]               = useState<BadgeItem[]>([]);
  const [username, setUsername]           = useState('');
  const [tagline, setTagline]             = useState('');
  const [gender, setGender]               = useState<Gender | null>(null);
  const [selectedTags, setSelectedTags]   = useState<string[]>([]);
  const [avatarId, setAvatarId]           = useState(1);
  const [photoUrl, setPhotoUrl]           = useState<string | null>(null);
  const [badgesPublic, setBadgesPublic]   = useState(true);
  const [defaultPaddle, setDefaultPaddle] = useState<(PaddleSelection & { paddleId: string }) | null>(null);
  const [availability, setAvailability]   = useState<boolean[]>(Array(TOTAL_CELLS).fill(false));
  const [avSaveStatus, setAvSaveStatus]   = useState<'idle' | 'saving' | 'saved' | 'error' | 'needs-migration'>('idle');
  const avSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [chemistryResults, setChemistryResults] = useState<ChemistryResult[]>([]);
  const [eloHistory, setEloHistory] = useState<EloMatchRow[]>([]);
  const [premiumAvatars, setPremiumAvatars]   = useState<PremiumAvatar[]>([]);
  const [cosmeticBadges, setCosmeticBadges]   = useState<ShopItem[]>([]);
  const [equippedPremium, setEquippedPremium] = useState<PremiumAvatar | null>(null);
  const [shopPurchases, setShopPurchases]     = useState<PurchaseWithItem[]>([]);
  const [partnerNames, setPartnerNames] = useState<Record<string, { full_name: string; avatar_id: number; avatar_url: string | null }>>({});
  // badgeProgress: keyed by badge name, value is { text, pct, showBar }
  const [badgeProgress, setBadgeProgress] = useState<Record<string, { text: string; pct: number; showBar: boolean }>>({});
  const [showPaddlePicker, setShowPaddlePicker]   = useState(false);
  const [showAvatarPicker, setShowAvatarPicker]   = useState(false);
  const [showTagPicker, setShowTagPicker]         = useState(false);
  const [gridScrollLocked, setGridScrollLocked]   = useState(false);
  const [loading, setLoading]             = useState(true);
  const [saving, setSaving]               = useState(false);
  const [userId, setUserId]               = useState<string | null>(null);

  // Spotlight-tour anchors for the 'profile' tour: the avatar edit control
  // ('edit') and the Unlockable Rewards card ('rewards'). Registering an
  // anchor the tour may never reach is harmless.
  // TODO: smoke-test in browser — from FTUE "Set up your profile", the profile
  // tour should highlight the avatar edit control then the Unlockable Rewards
  // card, once per user (clear AsyncStorage to re-trigger).
  const { registerAnchor } = useTour();
  const editAnchor = useRef<any>(null);
  const rewardsAnchor = useRef<any>(null);

  const refresh = useRefresh(loadProfile);

  useEffect(() => { loadProfile(); }, []);

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

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
      setUsername(d.username);
      setBadgesPublic(d.badges_public ?? true);
      setAvatarId(d.avatar_id ?? 1);
      setPhotoUrl(d.avatar_url ?? null);
      setTagline(d.tagline ?? '');
      setGender(d.gender ?? null);
      setSelectedTags(d.selected_tags ?? []);
      // Equipped premium avatar (driven by avatar_emoji + avatar_bg_color)
      if (d.avatar_emoji && d.avatar_bg_color) {
        setEquippedPremium({ slug: 'equipped', name: 'Premium', emoji: d.avatar_emoji, bgColor: d.avatar_bg_color });
      } else {
        setEquippedPremium(null);
      }
      const av = d.availability;
      setAvailability(Array.isArray(av) && av.length === TOTAL_CELLS ? av : Array(TOTAL_CELLS).fill(false));
    }
    setLocationRatings((locRes.data ?? []) as PlayerLocationRating[]);
    setBadges((badgesRes.data ?? []) as BadgeItem[]);
    setLoading(false);

    // Load chemistry + badge progress + PLUPR history + shop purchases (non-blocking)
    loadChemistry(user.id);
    loadBadgeProgress(user.id, profileRes.data);
    loadEloHistory(user.id);
    loadShopPurchases(user.id);
  }

  async function loadShopPurchases(uid: string) {
    const { data } = await supabase
      .from('player_shop_purchases')
      .select('id, shop_item_id, is_hidden, gifted_by_user_id, gift_message, cost_paid, purchased_at, item:shop_items(*)')
      .eq('user_id', uid)
      .order('purchased_at', { ascending: false });

    const purchases = ((data ?? []) as any[]).filter(r => r.item) as PurchaseWithItem[];
    setShopPurchases(purchases);

    const items = purchases.map(p => p.item);
    setPremiumAvatars(
      items
        .filter(i => i.category === 'avatar')
        .map(i => ({
          slug: i.slug,
          name: i.name,
          emoji: i.payload?.emoji ?? i.icon,
          bgColor: i.payload?.bgColor ?? '#eeeeee',
        }))
    );
    setCosmeticBadges(items.filter(i => i.category === 'cosmetic_badge'));
  }

  async function equipAvatar(emoji: string | null, bgColor: string | null) {
    if (!userId) return;
    const { error } = await supabase
      .from('profiles')
      .update({ avatar_emoji: emoji, avatar_bg_color: bgColor })
      .eq('id', userId);
    if (error) { status.error(error.message); return; }
    setEquippedPremium(emoji && bgColor ? { slug: 'equipped', name: 'Premium', emoji, bgColor } : null);
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
      .or(`player1_id.eq.${uid},partner1_id.eq.${uid},player2_id.eq.${uid},partner2_id.eq.${uid}`)
      .order('played_at', { ascending: true })
      .limit(500);
    setEloHistory((data ?? []) as EloMatchRow[]);
  }

  async function loadBadgeProgress(uid: string, prof: any) {
    if (!prof) return;

    // One query covers win streak, location variety, and match type counts
    const { data: matches } = await supabase
      .from('matches')
      .select('match_type, player1_id, partner1_id, player2_id, partner2_id, winner_team, location_name')
      .or(`player1_id.eq.${uid},partner1_id.eq.${uid},player2_id.eq.${uid},partner2_id.eq.${uid}`)
      .order('played_at', { ascending: false })
      .limit(200);

    const mx = matches ?? [];

    const didWin = (m: any) => {
      const t1 = m.player1_id === uid || m.partner1_id === uid;
      return (t1 && m.winner_team === 'team1') || (!t1 && m.winner_team === 'team2');
    };

    // Current win streak (matches are newest-first)
    let streak = 0;
    for (const m of mx) {
      if (didWin(m)) streak++;
      else break;
    }

    // Distinct courts played
    const courts = new Set(mx.map((m: any) => m.location_name).filter(Boolean)).size;

    // Doubles and singles counts
    const doublesPlayed = mx.filter((m: any) => m.match_type === 'doubles').length;
    const singlesPlayed = mx.filter((m: any) => m.match_type === 'singles').length;

    // Account age in days
    const memberDays = Math.floor(
      (Date.now() - new Date(prof.created_at).getTime()) / 86_400_000,
    );

    const elo = prof.rating ?? 3.25;

    const entry = (
      current: number,
      target: number,
      label: (c: number, t: number) => string,
    ) => ({
      text:    label(current, target),
      pct:     Math.min(current / target, 1),
      showBar: true,
    });

    const league = () => ({
      text:    'Progress tracked per-league',
      pct:     0,
      showBar: false,
    });

    setBadgeProgress({
      'Hot Streak':        entry(streak,       5,    (c, t) => `${c} / ${t} wins in a row`),
      // Show progress as a percentage rather than the raw PLUPR value — PLUPR is
      // being kept contained within a league rather than surfaced on the profile.
      'Top Rated':         entry(elo,          4.0,  (c, t) => `${Math.round(Math.min(c / t, 1) * 100)}% to top tier`),
      'Veteran':           entry(memberDays,   30,   (c, t) => `${c} / ${t} days as member`),
      'Court Hopper':      entry(courts,       5,    (c, t) => `${c} / ${t} courts played`),
      'Doubles Dynamo':    entry(doublesPlayed, 20,  (c, t) => `${c} / ${t} doubles matches`),
      'Singles Specialist':entry(singlesPlayed, 25,  (c, t) => `${c} / ${t} singles matches`),
      'First Rally':       entry(Math.min(mx.length, prof.total_matches_played ?? mx.length), 1, (c) => `${c} match${c === 1 ? '' : 'es'} played`),
      // League-specific — no numeric global progress available
      'League Leader':     league(),
      'Hat Trick':         league(),
      'Home Court Hero':   league(),
      'League Regular':    league(),
      'Dominant':          league(),
      'Iron Player':       league(),
      'Comeback King':     league(),
    });
  }

  async function loadChemistry(uid: string) {
    const { data } = await supabase
      .from('matches')
      .select('player1_id, partner1_id, player2_id, partner2_id, winner_team, player1_rating_before, player2_rating_before')
      .eq('match_type', 'doubles')
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

  async function saveProfile() {
    if (!userId) return;
    setSaving(true);

    const fullPayload = {
      username,
      badges_public:   badgesPublic,
      avatar_url:      photoUrl,
      avatar_id:       avatarId,
      avatar_emoji:    equippedPremium?.emoji    ?? null,
      avatar_bg_color: equippedPremium?.bgColor  ?? null,
      tagline:         tagline.trim() || null,
      gender:          gender,
      selected_tags:   selectedTags,
      availability,
    };

    const { data, error } = await supabase
      .from('profiles')
      .update(fullPayload)
      .eq('id', userId)
      .select('id')
      .single();

    if (!error && data) {
      status.success('Saved!');
      setSaving(false);
      return;
    }

    // If the migration hasn't been run yet, PostgREST returns PGRST204 for missing
    // columns and the entire update is rejected — including username.  Fall back to
    // saving only the columns that always exist so at least the core fields save.
    const isMissingColumn =
      error?.code === 'PGRST204' ||
      error?.message?.toLowerCase().includes('column') ||
      error?.message?.toLowerCase().includes('schema cache');

    if (isMissingColumn) {
      const { error: fallbackErr } = await supabase
        .from('profiles')
        .update({ username, badges_public: badgesPublic, avatar_url: photoUrl })
        .eq('id', userId);

      if (fallbackErr) {
        status.error(fallbackErr.message);
      } else {
        status.error(
          'Partially saved. Username and photo saved. Run migration_add_profile_customization.sql and migration_add_availability.sql in your Supabase SQL Editor to unlock all features.',
        );
      }
    } else if (!data && !error) {
      // Update ran but matched 0 rows — session / RLS mismatch
      status.error('Not saved. Your session may have expired. Please log out and back in.');
    } else {
      status.error(error?.message ?? 'Unknown error');
    }

    setSaving(false);
  }

  // Auto-saves availability immediately whenever the grid changes.
  // Fires once per drag-release or preset tap — no debounce needed.
  async function handleAvailabilityChange(newAv: boolean[]) {
    setAvailability(newAv);
    if (!userId) return;

    setAvSaveStatus('saving');
    if (avSaveTimer.current) clearTimeout(avSaveTimer.current);

    const { error } = await supabase
      .from('profiles')
      .update({ availability: newAv })
      .eq('id', userId);

    if (!error) {
      setAvSaveStatus('saved');
      avSaveTimer.current = setTimeout(() => setAvSaveStatus('idle'), 2500);
    } else if (error.code === 'PGRST204' || error.message?.toLowerCase().includes('column')) {
      setAvSaveStatus('needs-migration');
    } else {
      setAvSaveStatus('error');
      avSaveTimer.current = setTimeout(() => setAvSaveStatus('idle'), 4000);
    }
  }

  function handleAvatarSave(id: number, url: string | null, premium: PremiumAvatar | null) {
    setAvatarId(id);
    setPhotoUrl(url);
    setEquippedPremium(premium);
    setShowAvatarPicker(false);
  }

  async function saveDefaultPaddle(sel: PaddleSelection) {
    if (!userId) return;
    setShowPaddlePicker(false);
    await supabase.from('player_paddles').update({ is_default: false }).eq('user_id', userId);
    const { data, error } = await supabase.from('player_paddles').upsert({
      user_id:      userId,
      brand_id:     sel.brandId,
      model_name:   sel.modelName,
      thickness_mm: sel.thicknessMm,
      is_default:   true,
    }, { onConflict: 'user_id,brand_id,model_name' }).select('id').single();
    if (error) { status.error(error.message); return; }
    setDefaultPaddle({ ...sel, paddleId: data.id });
  }

  async function removePaddle() {
    if (!userId || !defaultPaddle) return;
    await supabase.from('player_paddles').update({ is_default: false }).eq('id', defaultPaddle.paddleId);
    setDefaultPaddle(null);
  }

  async function toggleBadgeVisibility(playerBadgeIds: string[], hidden: boolean) {
    if (playerBadgeIds.length === 0) return;
    // IDs can come from either player_badges (earned badges) or
    // player_shop_purchases (cosmetic badges). Split and route accordingly.
    const purchaseIdSet = new Set(shopPurchases.map(p => p.id));
    const earnedIds   = playerBadgeIds.filter(id => !purchaseIdSet.has(id));
    const cosmeticIds = playerBadgeIds.filter(id =>  purchaseIdSet.has(id));

    if (earnedIds.length > 0) {
      await supabase.from('player_badges').update({ is_hidden: hidden }).in('id', earnedIds);
      const idSet = new Set(earnedIds);
      setBadges(prev => prev.map(b => idSet.has(b.id) ? { ...b, is_hidden: hidden } : b));
    }
    if (cosmeticIds.length > 0) {
      await Promise.all(cosmeticIds.map(id =>
        supabase.rpc('set_purchase_hidden', { p_purchase_id: id, p_hidden: hidden })
      ));
      const idSet = new Set(cosmeticIds);
      setShopPurchases(prev => prev.map(p => idSet.has(p.id) ? { ...p, is_hidden: hidden } : p));
    }
  }

  async function setAllBadgesHidden(hidden: boolean) {
    if (!userId) return;
    await supabase.from('player_badges').update({ is_hidden: hidden }).eq('user_id', userId);
    setBadges(prev => prev.map(b => ({ ...b, is_hidden: hidden })));
    const cosmetics = shopPurchases.filter(p => p.item.category === 'cosmetic_badge');
    if (cosmetics.length > 0) {
      await Promise.all(cosmetics.map(p =>
        supabase.rpc('set_purchase_hidden', { p_purchase_id: p.id, p_hidden: hidden })
      ));
      const idSet = new Set(cosmetics.map(p => p.id));
      setShopPurchases(prev => prev.map(p => idSet.has(p.id) ? { ...p, is_hidden: hidden } : p));
    }
  }

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg }}><SkeletonList rows={6} /></View>;

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

  const profileBadgeGroups  = groupBadges(badges.filter(b => b.badge.category === 'profile'));
  const leagueBadgeGroups   = groupBadges(badges.filter(b => b.badge.category === 'league'));
  const cosmeticBadgeGroups = groupBadges(cosmeticBadgeItems);
  const visibleBadgeCount   =
    badges.filter(b => !b.is_hidden).length +
    cosmeticBadgeItems.filter(b => !b.is_hidden).length;
  const totalBadgeCount     = badges.length + cosmeticBadgeItems.length;
  const maxTagSlots = computeMaxTagSlots(earnedBadgeNames);
  const cartoonAvatar = AVATARS.find(a => a.id === avatarId) ?? AVATARS[0];
  const displayAvatar = equippedPremium
    ? { emoji: equippedPremium.emoji, bgColor: equippedPremium.bgColor }
    : { emoji: cartoonAvatar.emoji, bgColor: cartoonAvatar.bgColor };

  const singlesRating      = profile?.singles_rating       ?? profile?.rating ?? 3.25;
  const doublesRating      = profile?.doubles_rating       ?? profile?.rating ?? 3.25;
  const mixedDoublesRating = profile?.mixed_doubles_rating ?? profile?.rating ?? 3.25;

  // Unlocks progress helpers
  const lockedAvatars   = AVATARS.filter(a => !!a.unlock);
  const lockedTagsCount = PLAY_TAGS.filter(t => !!t.unlock).length;

  return (
    <>
    <ScrollView contentContainerStyle={styles.container} scrollEnabled={!gridScrollLocked} refreshControl={<AppRefreshControl {...refresh} />}>

      <StatusBanner status={status.value} />

      {/* ── Avatar / photo ─────────────────────────────────────── */}
      <View style={styles.avatarSection}>
        <TouchableOpacity
          ref={editAnchor}
          onLayout={() => registerAnchor('profile', 'edit', editAnchor)}
          onPress={() => setShowAvatarPicker(true)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Edit profile photo"
        >
          {photoUrl ? (
            <Image source={{ uri: photoUrl }} style={styles.avatarPhoto} />
          ) : (
            <View style={[styles.avatarCircle, { backgroundColor: displayAvatar.bgColor }]}>
              <Text style={styles.avatarEmoji}>{displayAvatar.emoji}</Text>
            </View>
          )}
          <View style={styles.avatarEditBadge}>
            <Text style={styles.avatarEditBadgeText}>✏️</Text>
          </View>
        </TouchableOpacity>
        {/* TODO: smoke-test in browser — hero name renders with profile_name_style_id */}
        <FlairName
          style={styles.fullName}
          nameColor={profile?.name_color}
          styleId={profile?.profile_name_style_id}
          mode="hero"
          name={profile?.full_name ?? ''}
        />
        {tagline ? <Text style={styles.taglineDisplay}>{tagline}</Text> : null}

        {/* Pickle balance pill — tap to visit Shop */}
        <TouchableOpacity style={styles.pickleBalancePill} onPress={() => navigation.navigate('Shop')}>
          <Text style={styles.pickleBalanceEmoji}>🥒</Text>
          <Text style={styles.pickleBalanceValue}>{profile?.pickles ?? 0}</Text>
          <Text style={styles.pickleBalanceLabel}>pickles · tap to shop</Text>
        </TouchableOpacity>

        {/* Selected tags display under name */}
        {selectedTags.length > 0 && (
          <View style={styles.tagsDisplayRow}>
            {selectedTags.map(slug => {
              const tag = PLAY_TAGS.find(t => t.slug === slug);
              return tag ? (
                <View key={slug} style={styles.tagDisplayChip}>
                  <Text style={styles.tagDisplayText}>{tag.label}</Text>
                </View>
              ) : null;
            })}
          </View>
        )}
      </View>

      {/* ── PLUPR ratings (hidden) ──────────────────────────────────
          The global PLUPR card — overall/singles/doubles/mixed values,
          reliability pill, and the trajectory chart — is intentionally not
          rendered. PLUPR is being kept contained within a league rather than
          surfaced on the profile. The EloHistoryChart component, eloHistory
          loader, reliability helper, and formatPlupr import are left intact
          so this card can be restored by re-adding the block. */}

      {/* ── Pickle Shop Inventory ─────────────────────────────── */}
      {shopPurchases.length > 0 && (() => {
        const avatars    = shopPurchases.filter(p => p.item.category === 'avatar');
        const flairs     = shopPurchases.filter(p => p.item.category === 'flair');
        const listStyles = shopPurchases.filter(p => p.item.category === 'list_name_style');
        const profileStyles = shopPurchases.filter(p => p.item.category === 'profile_name_style');
        const badges     = shopPurchases.filter(p => p.item.category === 'cosmetic_badge');
        return (
          <View style={styles.locationCard}>
            <Text style={styles.cardTitle}>🥒 Pickle Shop Inventory</Text>

            {/* Avatars */}
            {avatars.length > 0 && (
              <View style={styles.invSection}>
                <Text style={styles.invSectionTitle}>Avatars</Text>
                {avatars.map(p => {
                  const equipped = profile?.avatar_emoji === p.item.payload?.emoji
                                && profile?.avatar_bg_color === p.item.payload?.bgColor;
                  return (
                    <InvRow
                      key={p.id}
                      icon={p.item.icon}
                      bgColor={p.item.payload?.bgColor ?? '#eee'}
                      name={p.item.name}
                      gift={p.gifted_by_user_id}
                      message={p.gift_message}
                      isHidden={p.is_hidden}
                      onToggleHidden={() => togglePurchaseHidden(p.id, p.is_hidden)}
                      actionLabel={equipped ? '✓ Equipped' : 'Equip'}
                      actionDisabled={equipped}
                      onAction={() => equipAvatar(p.item.payload?.emoji ?? null, p.item.payload?.bgColor ?? null)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.avatar_emoji && (
                  <TouchableOpacity style={styles.invUnequipBtn} onPress={() => equipAvatar(null, null)}>
                    <Text style={styles.invUnequipText}>↺ Revert to cartoon avatar</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Flair */}
            {flairs.length > 0 && (
              <View style={styles.invSection}>
                <Text style={styles.invSectionTitle}>Name Color Flair</Text>
                {flairs.map(p => {
                  const value    = p.item.payload?.value as string | undefined;
                  const equipped = !!value && profile?.name_color === value;
                  return (
                    <InvRow
                      key={p.id}
                      icon={p.item.icon}
                      bgColor={value ?? '#eee'}
                      name={p.item.name}
                      gift={p.gifted_by_user_id}
                      message={p.gift_message}
                      isHidden={p.is_hidden}
                      onToggleHidden={() => togglePurchaseHidden(p.id, p.is_hidden)}
                      actionLabel={equipped ? '✓ Active' : 'Apply'}
                      actionDisabled={equipped}
                      onAction={() => applyFlair(value ?? null)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.name_color && (
                  <TouchableOpacity style={styles.invUnequipBtn} onPress={() => applyFlair(null)}>
                    <Text style={styles.invUnequipText}>↺ Revert to default name color</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* List Name Styles */}
            {listStyles.length > 0 && (
              <View style={styles.invSection}>
                <Text style={styles.invSectionTitle}>List Name Styles</Text>
                {listStyles.map(p => {
                  const slug     = p.item.slug;
                  const equipped = profile?.list_name_style_id === slug;
                  return (
                    <InvRow
                      key={p.id}
                      icon={p.item.icon}
                      bgColor={p.item.payload?.bgColor ?? '#eef2ff'}
                      name={p.item.name}
                      gift={p.gifted_by_user_id}
                      message={p.gift_message}
                      isHidden={p.is_hidden}
                      onToggleHidden={() => togglePurchaseHidden(p.id, p.is_hidden)}
                      actionLabel={equipped ? '✓ Equipped' : 'Equip'}
                      actionDisabled={equipped}
                      onAction={() => applyListNameStyle(slug)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.list_name_style_id && (
                  <TouchableOpacity style={styles.invUnequipBtn} onPress={() => applyListNameStyle(null)}>
                    <Text style={styles.invUnequipText}>↺ Revert to default list name style</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Profile Name Styles */}
            {profileStyles.length > 0 && (
              <View style={styles.invSection}>
                <Text style={styles.invSectionTitle}>Profile Name Styles</Text>
                {profileStyles.map(p => {
                  const slug     = p.item.slug;
                  const equipped = profile?.profile_name_style_id === slug;
                  return (
                    <InvRow
                      key={p.id}
                      icon={p.item.icon}
                      bgColor={p.item.payload?.bgColor ?? '#fdf4ff'}
                      name={p.item.name}
                      gift={p.gifted_by_user_id}
                      message={p.gift_message}
                      isHidden={p.is_hidden}
                      onToggleHidden={() => togglePurchaseHidden(p.id, p.is_hidden)}
                      actionLabel={equipped ? '✓ Equipped' : 'Equip'}
                      actionDisabled={equipped}
                      onAction={() => applyProfileNameStyle(slug)}
                      styles={styles}
                    />
                  );
                })}
                {profile?.profile_name_style_id && (
                  <TouchableOpacity style={styles.invUnequipBtn} onPress={() => applyProfileNameStyle(null)}>
                    <Text style={styles.invUnequipText}>↺ Revert to default profile name style</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Cosmetic Badges */}
            {badges.length > 0 && (
              <View style={styles.invSection}>
                <Text style={styles.invSectionTitle}>Cosmetic Badges</Text>
                {badges.map(p => (
                  <InvRow
                    key={p.id}
                    icon={p.item.icon}
                    bgColor={p.item.payload?.bgColor ?? '#fff8e1'}
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
          </View>
        );
      })()}

      {/* ── Court ratings (hidden) ───────────────────────────────────
          Per-court PLUPR ratings are intentionally not rendered — PLUPR is
          being kept contained within a league. The locationRatings state and
          its loader query are left intact so this card can be restored by
          re-adding the block. */}

      {/* ── Partner Chemistry ────────────────────────────────────── */}
      {chemistryResults.length > 0 && (
        <View style={styles.chemCard}>
          <Text style={styles.cardTitle}>🤝 Doubles Chemistry</Text>
          <Text style={styles.chemSubtitle}>Win-rate boost vs your baseline when playing with each partner</Text>
          {chemistryResults.map(r => {
            const partner = partnerNames[r.partnerId];
            if (!partner) return null;
            const av = AVATAR_LIST.find(a => a.id === (partner.avatar_id ?? 1)) ?? AVATAR_LIST[0];
            const color = chemistryColor(r.overallDelta);
            const deltaStr = fmtDelta(r.overallDelta);
            return (
              <View key={r.partnerId} style={styles.chemRow}>
                <View style={[styles.chemAvatar, { backgroundColor: av.bgColor }]}>
                  <Text style={styles.chemAvatarEmoji}>{av.emoji}</Text>
                </View>
                <View style={styles.chemInfo}>
                  <Text style={styles.chemName} numberOfLines={1}>{partner.full_name}</Text>
                  {r.insights[0] ? (
                    <Text style={styles.chemInsight} numberOfLines={1}>{r.insights[0]}</Text>
                  ) : (
                    <Text style={styles.chemInsight}>{r.matchesTogether} match{r.matchesTogether !== 1 ? 'es' : ''} together</Text>
                  )}
                </View>
                <View style={[styles.chemMatchCount, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
                  <Text style={styles.chemMatchCountText}>{r.matchesTogether}</Text>
                  <BallIcon size={14} />
                </View>
                <View style={[styles.chemBadge, { backgroundColor: color + '22', borderColor: color + '55' }]}>
                  <Text style={[styles.chemBadgeText, { color }]}>{deltaStr}</Text>
                </View>
              </View>
            );
          })}
          {!chemistryResults.some(r => r.significant) && (
            <Text style={styles.chemHint}>Play 5+ doubles matches with a partner to unlock deeper insights</Text>
          )}
        </View>
      )}

      {/* ── Default Paddle ───────────────────────────────────────── */}
      <View style={styles.paddleCard}>
        <View style={styles.paddleHeader}>
          <Text style={styles.paddleTitle}>🎽 Default Paddle</Text>
          {defaultPaddle && (
            <TouchableOpacity onPress={removePaddle}>
              <Text style={styles.paddleRemove}>Remove</Text>
            </TouchableOpacity>
          )}
        </View>
        {defaultPaddle ? (
          <TouchableOpacity style={styles.paddleSelected} onPress={() => setShowPaddlePicker(true)}>
            <View style={styles.paddleInfo}>
              <Text style={styles.paddleBrand}>{defaultPaddle.brandName}</Text>
              <Text style={styles.paddleModel}>{defaultPaddle.modelName}</Text>
              {defaultPaddle.thicknessMm != null && (
                <Text style={styles.paddleThickness}>{defaultPaddle.thicknessMm} mm core</Text>
              )}
            </View>
            <Text style={styles.paddleEdit}>Change</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.paddleEmpty} onPress={() => setShowPaddlePicker(true)}>
            <Text style={styles.paddleEmptyText}>+ Set your default paddle</Text>
            <Text style={styles.paddleEmptyHint}>Auto-filled when recording matches. Editable within 72 hours.</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Availability ─────────────────────────────────────────── */}
      <View style={styles.availCard}>
        <View style={styles.availHeader}>
          <View style={styles.availTitleRow}>
            <Text style={styles.availTitle}>📅 Weekly Availability</Text>
            {avSaveStatus === 'saving' && (
              <Text style={styles.avStatusSaving}>Saving…</Text>
            )}
            {avSaveStatus === 'saved' && (
              <Text style={styles.avStatusSaved}>✓ Saved</Text>
            )}
            {avSaveStatus === 'error' && (
              <Text style={styles.avStatusError}>⚠ Save failed</Text>
            )}
            {avSaveStatus === 'needs-migration' && (
              <Text style={styles.avStatusError}>Run migration_add_availability.sql</Text>
            )}
          </View>
          <Text style={styles.availSubtitle}>
            Auto-saved · used for event filters and player matching
          </Text>
        </View>
        <AvailabilityGrid
          availability={availability}
          onChange={handleAvailabilityChange}
          onScrollLock={setGridScrollLocked}
        />
      </View>

      {/* ── Badges ──────────────────────────────────────────────── */}
      {totalBadgeCount > 0 && (
        <View style={styles.badgeCard}>
          <View style={styles.badgeHeader}>
            <Text style={styles.badgeSectionTitle}>
              Badges ({visibleBadgeCount} shown)
            </Text>
            <View style={styles.badgeActions}>
              <TouchableOpacity onPress={() => setAllBadgesHidden(false)}>
                <Text style={styles.badgeActionText}>Show All</Text>
              </TouchableOpacity>
              <Text style={styles.badgeSep}>·</Text>
              <TouchableOpacity onPress={() => setAllBadgesHidden(true)}>
                <Text style={styles.badgeActionText}>Hide All</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={styles.badgeHint}>Tap a badge to see why you earned it.</Text>
          {profileBadgeGroups.length > 0 && (
            <>
              <Text style={styles.badgeCatLabel}>Profile</Text>
              <View style={styles.badgeGrid}>
                {profileBadgeGroups.map(g => (
                  <BadgeDisplay
                    key={g.rep.id}
                    badge={g.rep}
                    stack={g.stack}
                    isOwner
                    onToggleHide={toggleBadgeVisibility}
                  />
                ))}
              </View>
            </>
          )}
          {leagueBadgeGroups.length > 0 && (
            <>
              <Text style={styles.badgeCatLabel}>League</Text>
              <View style={styles.badgeGrid}>
                {leagueBadgeGroups.map(g => (
                  <BadgeDisplay
                    key={g.rep.id}
                    badge={g.rep}
                    stack={g.stack}
                    isOwner
                    onToggleHide={toggleBadgeVisibility}
                  />
                ))}
              </View>
            </>
          )}
          {cosmeticBadgeGroups.length > 0 && (
            <>
              <Text style={styles.badgeCatLabel}>Cosmetic</Text>
              <View style={styles.badgeGrid}>
                {cosmeticBadgeGroups.map(g => (
                  <BadgeDisplay
                    key={g.rep.id}
                    badge={g.rep}
                    stack={g.stack}
                    isOwner
                    onToggleHide={toggleBadgeVisibility}
                  />
                ))}
              </View>
            </>
          )}
          <View style={styles.privacyRow}>
            <Text style={styles.privacyLabel}>Show badges on my public profile</Text>
            <TouchableOpacity
              style={[styles.privacyToggle, badgesPublic && styles.privacyToggleOn]}
              onPress={() => setBadgesPublic(v => !v)}
            >
              <Text style={[styles.privacyToggleText, badgesPublic && styles.privacyToggleTextOn]}>
                {badgesPublic ? 'Public' : 'Private'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Edit section ─────────────────────────────────────────── */}
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Username</Text>
        <TextInput
          style={styles.input}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="your handle"
        />
        <Text style={styles.fieldHint}>This is how you appear in league standings.</Text>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Tagline</Text>
        <TextInput
          style={styles.input}
          value={tagline}
          onChangeText={t => setTagline(t.slice(0, 50))}
          placeholder="Describe yourself in 50 chars…"
          maxLength={50}
        />
        <Text style={[styles.fieldHint, tagline.length > 44 && styles.fieldHintWarn]}>
          {tagline.length}/50 characters
        </Text>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Gender</Text>
        <Text style={styles.fieldHint}>
          Used to classify doubles matches as Gendered Doubles or Mixed Doubles.
          Until set, your doubles matches won't be counted as Gendered or Mixed Doubles.
        </Text>
        <View style={styles.genderRow}>
          {([
            { v: 'male',              label: 'Male' },
            { v: 'female',            label: 'Female' },
            { v: 'other',             label: 'Other' },
            { v: 'prefer-not-to-say', label: 'Prefer not to say' },
          ] as { v: Gender; label: string }[]).map(({ v, label }) => (
            <TouchableOpacity
              key={v}
              style={[styles.genderPill, gender === v && styles.genderPillActive]}
              onPress={() => setGender(v)}
            >
              <Text style={[styles.genderPillText, gender === v && styles.genderPillTextActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Play style tags editor */}
      <View style={styles.tagsCard}>
        <View style={styles.tagsHeader}>
          <Text style={styles.fieldLabel}>Play Style Tags</Text>
          <TouchableOpacity onPress={() => setShowTagPicker(true)}>
            <Text style={styles.tagsEditBtn}>{selectedTags.length === 0 ? '+ Add Tags' : 'Edit'}</Text>
          </TouchableOpacity>
        </View>
        {selectedTags.length === 0 ? (
          <TouchableOpacity onPress={() => setShowTagPicker(true)}>
            <Text style={styles.tagsEmpty}>Tap to pick up to {maxTagSlots} tags that describe your game</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.tagsRow}>
            {selectedTags.map(slug => {
              const tag = PLAY_TAGS.find(t => t.slug === slug);
              return tag ? (
                <View key={slug} style={styles.tagChip}>
                  <Text style={styles.tagChipText}>{tag.label}</Text>
                </View>
              ) : null;
            })}
          </View>
        )}
        <Text style={styles.tagsSlotHint}>{selectedTags.length}/{maxTagSlots} tag slots used</Text>
      </View>

      <TouchableOpacity style={styles.button} onPress={saveProfile} disabled={saving}>
        <Text style={styles.buttonText}>{saving ? 'Saving…' : 'Save Changes'}</Text>
      </TouchableOpacity>

      {/* ── Unlocks progress ─────────────────────────────────────── */}
      <View
        ref={rewardsAnchor}
        onLayout={() => registerAnchor('profile', 'rewards', rewardsAnchor)}
        style={styles.unlocksCard}
      >
        <Text style={styles.unlocksSectionTitle}>🔓 Unlockable Rewards</Text>
        <Text style={styles.unlocksSubtitle}>Earn badges to unlock special avatars, tags, and tag slots.</Text>

        {/* Getting Started checklist — always visible here as a progress tracker */}
        <Text style={styles.unlockCatLabel}>Getting Started</Text>
        <FtueChecklistCard
          profile={profile}
          navigation={navigation}
          alwaysShow
          embedded
          onClaimed={(bal) => setProfile(p => (p ? { ...p, pickles: bal } : p))}
        />

        {/* Avatar unlocks */}
        <Text style={styles.unlockCatLabel}>Special Avatars</Text>
        {lockedAvatars.map(av => {
          const earned = earnedBadgeNames.includes(av.unlock!.badge);
          const prog   = badgeProgress[av.unlock!.badge];
          return (
            <View key={av.id} style={styles.unlockRow}>
              <View style={[styles.unlockAvatarCircle, { backgroundColor: earned ? av.bgColor : '#eeeeee' }]}>
                <Text style={[styles.unlockAvatarEmoji, !earned && { opacity: 0.4 }]}>{av.emoji}</Text>
              </View>
              <View style={styles.unlockInfo}>
                <View style={styles.unlockNameRow}>
                  <Text style={styles.unlockName}>{av.name} Avatar</Text>
                  {earned && <Text style={styles.earnedCheckText}>✓ Unlocked</Text>}
                </View>
                <Text style={styles.unlockBadgeName}>{av.unlock!.badge}</Text>
                {!earned && prog ? (
                  <UnlockProgressRow prog={prog} />
                ) : (
                  <Text style={styles.unlockReq}>{av.unlock!.description}</Text>
                )}
              </View>
            </View>
          );
        })}

        {/* Tag slot unlocks */}
        <Text style={styles.unlockCatLabel}>Extra Tag Slots</Text>
        {TAG_SLOT_UNLOCKS.map(u => {
          const earned = earnedBadgeNames.includes(u.badge);
          const prog   = badgeProgress[u.badge];
          return (
            <View key={u.badge} style={styles.unlockRow}>
              <View style={[styles.unlockAvatarCircle, { backgroundColor: earned ? '#e8f5e9' : '#eeeeee' }]}>
                <Text style={[styles.unlockAvatarEmoji, !earned && { opacity: 0.4 }]}>🏷️</Text>
              </View>
              <View style={styles.unlockInfo}>
                <View style={styles.unlockNameRow}>
                  <Text style={styles.unlockName}>+1 Tag Slot</Text>
                  {earned && <Text style={styles.earnedCheckText}>✓ Unlocked</Text>}
                </View>
                <Text style={styles.unlockBadgeName}>{u.badge}</Text>
                {!earned && prog ? (
                  <UnlockProgressRow prog={prog} />
                ) : (
                  <Text style={styles.unlockReq}>{u.description}</Text>
                )}
              </View>
            </View>
          );
        })}

        {/* Locked tags summary with earned count */}
        {(() => {
          const earnedTagUnlocks = PLAY_TAGS
            .filter(t => t.unlock)
            .filter(t => earnedBadgeNames.includes(t.unlock!.badge)).length;
          return (
            <View style={styles.unlockTagsRow}>
              <Text style={styles.unlockAvatarEmoji}>🏷️</Text>
              <View style={styles.unlockInfo}>
                <View style={styles.unlockNameRow}>
                  <Text style={styles.unlockName}>Exclusive Tags</Text>
                  <Text style={[styles.earnedCheckText, earnedTagUnlocks === 0 && { color: '#bbb' }]}>
                    {earnedTagUnlocks}/{lockedTagsCount} earned
                  </Text>
                </View>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { flex: Math.max(earnedTagUnlocks / lockedTagsCount, 0.02) }]} />
                  {earnedTagUnlocks < lockedTagsCount && (
                    <View style={[styles.progressEmpty, { flex: 1 - earnedTagUnlocks / lockedTagsCount }]} />
                  )}
                </View>
                <Text style={styles.unlockReq}>
                  Earn badges like Hot Streak, Dominant, Veteran, and more to wear exclusive tags.
                </Text>
              </View>
            </View>
          );
        })()}

        <TouchableOpacity onPress={() => navigation.navigate('UnlockProgress')} style={styles.viewUnlockProgressBtn}>
          <Text style={styles.badgeActionText}>🔓 View Unlock Progress</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.divider} />

      <TouchableOpacity style={styles.secondaryCard} onPress={() => userId && navigation.navigate('MatchHistory', { userId, title: 'My Match History' })}>
        <Text style={styles.secondaryIcon}>📜</Text>
        <View>
          <Text style={styles.secondaryLabel}>Match History</Text>
          <Text style={styles.secondarySub}>All your match results with dates</Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity style={styles.secondaryCard} onPress={() => userId && navigation.navigate('CalendarAnalytics', { userId, title: 'My Calendar' })}>
        <Text style={styles.secondaryIcon}>🗓️</Text>
        <View>
          <Text style={styles.secondaryLabel}>Calendar Analytics</Text>
          <Text style={styles.secondarySub}>Win-loss record by day</Text>
        </View>
      </TouchableOpacity>

    </ScrollView>

    <PaddlePickerModal
      visible={showPaddlePicker}
      initial={defaultPaddle}
      onSelect={saveDefaultPaddle}
      onClose={() => setShowPaddlePicker(false)}
    />

    {userId && (
      <AvatarPickerModal
        visible={showAvatarPicker}
        currentAvatarId={avatarId}
        currentPhotoUrl={photoUrl}
        currentPremium={equippedPremium}
        earnedBadgeNames={earnedBadgeNames}
        userId={userId}
        purchasedAvatars={premiumAvatars}
        onSave={handleAvatarSave}
        onClose={() => setShowAvatarPicker(false)}
      />
    )}

    <TagPickerModal
      visible={showTagPicker}
      selectedTags={selectedTags}
      maxSlots={maxTagSlots}
      earnedBadgeNames={earnedBadgeNames}
      onSave={tags => { setSelectedTags(tags); setShowTagPicker(false); }}
      onClose={() => setShowTagPicker(false)}
    />
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors'], locPillW: number) {
  const GREEN = c.primary;
  return StyleSheet.create({
  container:  { padding: 24, backgroundColor: c.bg, flexGrow: 1 },

  // Avatar section
  avatarSection:    { alignItems: 'center', marginBottom: 20 },
  pickleBalancePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 16, backgroundColor: c.primaryLight,
    borderWidth: 1, borderColor: c.primary,
    marginTop: 8,
  },
  pickleBalanceEmoji: { fontSize: 14 },
  pickleBalanceValue: { fontSize: 14, fontWeight: '800', color: c.primary },
  pickleBalanceLabel: { fontSize: 11, color: c.primary, opacity: 0.85 },
  avatarCircle:     { width: 90, height: 90, borderRadius: 45, alignItems: 'center', justifyContent: 'center', marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.14, shadowRadius: 4, elevation: 4 },
  avatarPhoto:      { width: 90, height: 90, borderRadius: 45, marginBottom: 12 },
  avatarEmoji:      { fontSize: 48 },
  avatarEditBadge:  { position: 'absolute', bottom: 10, right: -4, width: 26, height: 26, borderRadius: 13, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 2 },
  avatarEditBadgeText: { fontSize: 12 },
  fullName:         { fontSize: 24, fontWeight: '700', color: c.text, marginBottom: 4 },
  taglineDisplay:   { fontSize: 14, color: c.textSub, fontStyle: 'italic', marginBottom: 8 },
  tagsDisplayRow:   { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginTop: 4 },
  tagDisplayChip:   { backgroundColor: c.primaryLight, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  tagDisplayText:   { fontSize: 12, color: GREEN, fontWeight: '600' },

  // Shared card title
  cardTitle:  { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },

  // PLUPR + reliability
  eloCard:            { backgroundColor: c.surface, borderRadius: 14, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: c.border, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  eloCardHeader:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  reliabilityPill:    { flexDirection: 'row', alignItems: 'center', gap: 5 },
  reliabilityDots:    { flexDirection: 'row', gap: 3 },
  reliabilityDot:     { width: 7, height: 7, borderRadius: 4, backgroundColor: c.border },
  reliabilityLabel:   { fontSize: 11, fontWeight: '700' },
  reliabilityDetail:  { fontSize: 11, color: c.textMuted, marginBottom: 10 },
  eloRow:             { flexDirection: 'row', alignItems: 'center' },
  eloItem:            { flex: 1, alignItems: 'center' },
  eloValue:           { fontSize: 26, fontWeight: '800', color: GREEN },
  eloLabel:           { fontSize: 12, color: c.textMuted, marginTop: 2 },
  eloDivider:         { width: 1, height: 36, backgroundColor: c.border },
  eloChartContainer:  { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border },
  eloChartTitle:      { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6, textAlign: 'center' },

  // Chemistry
  chemCard:           { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: c.border, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  chemSubtitle:       { fontSize: 11, color: c.textMuted, marginBottom: 10 },
  chemRow:            { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  chemAvatar:         { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  chemAvatarEmoji:    { fontSize: 19 },
  chemInfo:           { flex: 1 },
  chemName:           { fontSize: 14, fontWeight: '700', color: c.text },
  chemInsight:        { fontSize: 11, color: c.textMuted, marginTop: 1 },
  chemMatchCount:     { paddingHorizontal: 6 },
  chemMatchCountText: { fontSize: 11, color: c.textMuted },
  chemBadge:          { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 10, borderWidth: 1 },
  chemBadgeText:      { fontSize: 13, fontWeight: '800' },
  chemHint:           { fontSize: 11, color: c.textMuted, marginTop: 4 },

  // Location
  locationCard:   { backgroundColor: c.surface, borderRadius: 14, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: c.border, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  locationGrid:   { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  shopBadgeGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  shopBadgeCard:  { width: '30%', alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 4, borderWidth: 1, borderColor: c.border },
  shopBadgeIcon:  { fontSize: 28, marginBottom: 4 },
  shopBadgeName:  { fontSize: 11, fontWeight: '700', color: c.text, textAlign: 'center' },

  // Inventory rows
  invSection:        { marginTop: 10 },
  invSectionTitle:   { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 8 },
  invRow:            { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  invRowHidden:      { opacity: 0.55 },
  invIconBox:        { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  invIconEmoji:      { fontSize: 18 },
  invName:           { fontSize: 14, fontWeight: '700', color: c.text },
  invNameDim:        { color: c.textMuted },
  invGiftLabel:      { fontSize: 11, color: c.textSub, marginTop: 1 },
  invHideBtn:        { paddingHorizontal: 6, paddingVertical: 4 },
  invHideText:       { fontSize: 16 },
  invActionBtn:      { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: c.primary },
  invActionBtnDim:   { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  invActionText:     { fontSize: 12, color: '#fff', fontWeight: '700' },
  invActionTextDim:  { color: c.textMuted },
  invUnequipBtn:     { paddingVertical: 8, paddingHorizontal: 4, marginTop: 2 },
  invUnequipText:    { fontSize: 12, color: c.textMuted, fontWeight: '600' },
  locPill:        { width: locPillW, backgroundColor: c.primaryLight, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 4, alignItems: 'center' },
  locPillDoubles: { backgroundColor: '#e3f2fd' },
  locPillMixed:   { backgroundColor: '#f3e5f5' },
  locPillCourt:   { fontSize: 9, color: c.textMuted, width: '100%', textAlign: 'center', marginBottom: 2 },
  locPillRating:  { fontSize: 18, fontWeight: '800', color: c.text, lineHeight: 22 },
  locPillType:    { fontSize: 9, color: c.textSub, textTransform: 'uppercase' as const, letterSpacing: 0.4, marginTop: 1 },
  locPillRecord:  { fontSize: 10, color: c.textSub, marginTop: 2 },

  // Paddle
  paddleCard:      { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: c.border, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  paddleHeader:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  paddleTitle:     { fontSize: 15, fontWeight: '700', color: c.text },
  paddleRemove:    { fontSize: 13, color: c.danger },
  paddleSelected:  { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: c.border },
  paddleInfo:      { flex: 1 },
  paddleBrand:     { fontSize: 12, color: c.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  paddleModel:     { fontSize: 15, fontWeight: '700', color: c.text, marginTop: 1 },
  paddleThickness: { fontSize: 12, color: GREEN, marginTop: 2, fontWeight: '500' },
  paddleEdit:      { fontSize: 13, color: GREEN, fontWeight: '600' },
  paddleEmpty:     { borderWidth: 1.5, borderColor: c.border, borderRadius: 10, padding: 14, alignItems: 'center', borderStyle: 'dashed' },
  paddleEmptyText: { fontSize: 15, color: GREEN, fontWeight: '600', marginBottom: 4 },
  paddleEmptyHint: { fontSize: 12, color: c.textMuted, textAlign: 'center' },

  // Availability
  availCard:        { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: c.border, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  availHeader:      { marginBottom: 10 },
  availTitleRow:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  availTitle:       { fontSize: 15, fontWeight: '700', color: c.text },
  availSubtitle:    { fontSize: 12, color: c.textMuted },
  avStatusSaving:   { fontSize: 12, color: c.textMuted },
  avStatusSaved:    { fontSize: 12, color: GREEN, fontWeight: '600' },
  avStatusError:    { fontSize: 12, color: '#e65100', fontWeight: '600', flexShrink: 1 },

  // Badges
  badgeCard:        { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: c.border, shadowColor: '#000', shadowOpacity: 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  badgeHeader:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  badgeSectionTitle:{ fontSize: 13, fontWeight: '700', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.8 },
  badgeActions:     { flexDirection: 'row', alignItems: 'center', gap: 4 },
  badgeActionText:  { fontSize: 12, color: GREEN, fontWeight: '600' },
  badgeSep:         { fontSize: 12, color: c.textMuted },
  badgeHint:        { fontSize: 11, color: c.textMuted, marginBottom: 10 },
  badgeCatLabel:    { fontSize: 11, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 6, marginBottom: 4 },
  badgeGrid:        { flexDirection: 'row', flexWrap: 'wrap', margin: -4, marginBottom: 4 },
  privacyRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border },
  privacyLabel:     { fontSize: 13, color: c.textSub, flex: 1 },
  privacyToggle:    { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surfaceAlt },
  privacyToggleOn:  { borderColor: GREEN, backgroundColor: c.primaryLight },
  privacyToggleText:{ fontSize: 13, fontWeight: '600', color: c.textMuted },
  privacyToggleTextOn: { color: GREEN },

  // Edit fields
  fieldGroup:    { marginBottom: 14, marginTop: 4 },
  fieldLabel:    { fontSize: 13, fontWeight: '700', color: c.textSub, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 },
  input:         { borderWidth: 1.5, borderColor: c.border, borderRadius: 10, padding: 14, fontSize: 16, color: c.text, backgroundColor: c.surface },
  fieldHint:     { fontSize: 12, color: c.textMuted, marginTop: 5 },
  fieldHintWarn: { color: '#e65100' },

  // Gender picker
  genderRow:           { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  genderPill:          { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surface },
  genderPillActive:    { borderColor: GREEN, backgroundColor: c.primaryLight },
  genderPillText:      { fontSize: 14, color: c.textSub, fontWeight: '600' },
  genderPillTextActive:{ color: GREEN, fontWeight: '700' },

  // Tags editor
  tagsCard:      { marginBottom: 14 },
  tagsHeader:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  tagsEditBtn:   { fontSize: 13, color: GREEN, fontWeight: '700' },
  tagsEmpty:     { fontSize: 14, color: c.textMuted, fontStyle: 'italic', paddingVertical: 8 },
  tagsRow:       { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
  tagChip:       { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: c.primaryLight, borderWidth: 1.5, borderColor: GREEN },
  tagChipText:   { fontSize: 13, color: GREEN, fontWeight: '700' },
  tagsSlotHint:  { fontSize: 12, color: c.textMuted, marginTop: 4 },

  button:        { backgroundColor: GREEN, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 8, marginBottom: 24 },
  buttonText:    { color: '#fff', fontSize: 16, fontWeight: '700' },

  // Unlocks progress
  unlocksCard:       { backgroundColor: c.surfaceAlt, borderRadius: 14, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: c.border },
  unlocksSectionTitle:{ fontSize: 16, fontWeight: '800', color: c.text, marginBottom: 4 },
  unlocksSubtitle:   { fontSize: 13, color: c.textMuted, marginBottom: 14 },
  unlockCatLabel:    { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8, marginTop: 4 },
  viewUnlockProgressBtn: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border, alignItems: 'center' },
  unlockRow:          { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12, backgroundColor: c.surface, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: c.border },
  unlockTagsRow:      { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 4, backgroundColor: c.surface, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: c.border },
  unlockAvatarCircle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  unlockAvatarEmoji:  { fontSize: 24 },
  unlockInfo:         { flex: 1 },
  unlockNameRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 1 },
  unlockName:         { fontSize: 14, fontWeight: '700', color: c.text, flex: 1 },
  earnedCheckText:    { fontSize: 11, color: GREEN, fontWeight: '700' },
  unlockBadgeName:    { fontSize: 11, color: GREEN, fontWeight: '600', textTransform: 'uppercase' as const, letterSpacing: 0.4, marginBottom: 2 },
  unlockReq:          { fontSize: 12, color: c.textMuted },
  progressTrack:      { flexDirection: 'row', height: 5, borderRadius: 3, overflow: 'hidden', marginTop: 5, marginBottom: 3, backgroundColor: c.border },
  progressFill:       { backgroundColor: GREEN },
  progressEmpty:      { backgroundColor: c.border },

  divider:       { height: 1, backgroundColor: c.border, marginVertical: 8, marginBottom: 20 },
  secondaryCard: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: c.surface, borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: c.border },
  secondaryIcon: { fontSize: 28 },
  secondaryLabel:{ fontSize: 16, fontWeight: '700', color: c.text },
  secondarySub:  { fontSize: 13, color: c.textSub, marginTop: 2 },
  });
}
