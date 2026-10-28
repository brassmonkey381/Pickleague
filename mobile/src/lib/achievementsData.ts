// Reads what lib/achievements.ts needs for one player's achievements page.
//
// Own page: the catalogue, every badge row (hidden ones too), account-wide
// progress (lib/unlockProgress), the login streak, the FTUE grants, the
// name-style rewards and the Shop collectibles.
// Another player's page: the catalogue, their badge rows that aren't hidden
// and their visible collectibles; nothing at all when badges_public is off.
//
// THROWS when a core read (catalogue, badge rows) fails, so the screen can
// offer a retry instead of drawing an empty page. The extras (progress,
// streak, grants, rewards) degrade to "not shown".
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { glyphForEmoji, type IconName } from '@just-messin-around/expo-foundation/icons';
import { supabase } from './supabase';
import { computeBadgeProgress } from './unlockProgress';
import {
  buildAchievements,
  progressByBadge,
  type BadgeAward,
  type BuiltAchievements,
  type CatalogBadge,
  type CollectibleInput,
  type FtueInput,
  type FtueStepKey,
  type StreakInput,
  STREAK_MILESTONES,
} from './achievements';

export type AchievementsLoad = BuiltAchievements & {
  /** Another player's badges are private (badges_public off). */
  private: boolean;
  /** Own page: the profile row the FTUE hook reads. */
  profile: any | null;
};

function emojiGlyph(e: string | null | undefined): IconName | undefined {
  return e ? glyphForEmoji(e) : undefined;
}

/** Resolves to null instead of throwing (for the optional reads). */
async function soft<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch { return null; }
}

export type LoadAchievementsOptions = {
  /** Counts only (Profile's row): skips the progress maths and the name-style rewards. */
  light?: boolean;
};

export async function loadAchievements(userId: string, own: boolean, opts: LoadAchievementsOptions = {}): Promise<AchievementsLoad> {
  const profileP = sbCall(() => supabase.from('profiles').select(own ? '*' : 'id, badges_public').eq('id', userId).maybeSingle());
  const catalogP = sbCall(() => supabase.from('badges').select('id, name, description, icon, category').order('sort_order'));
  const awardsP = sbCall(() => {
    let q = supabase
      .from('player_badges')
      .select('id, earned_at, league_id, context, is_hidden, source_match_id, badge:badges(name), league:leagues(name)')
      .eq('user_id', userId);
    if (!own) q = q.eq('is_hidden', false);
    return q.order('earned_at', { ascending: false });
  });
  const purchasesP = soft(sbCall(() => {
    let q = supabase
      .from('player_shop_purchases')
      .select('id, shop_item_id, is_hidden, gifted_by_user_id, gift_message, purchased_at, item:shop_items(name, description, icon, category)')
      .eq('user_id', userId);
    if (!own) q = q.eq('is_hidden', false);
    return q.order('purchased_at', { ascending: false });
  }));

  const [profile, catalogRows, awardRows, purchaseRows] = await Promise.all([profileP, catalogP, awardsP, purchasesP]);
  const isPrivate = !own && (profile as any)?.badges_public === false;

  const catalog: CatalogBadge[] = ((catalogRows ?? []) as any[]).map(r => ({
    name: r.name, description: r.description ?? '', icon: r.icon ?? '', category: r.category ?? 'profile',
  }));
  const awards: BadgeAward[] = isPrivate ? [] : ((awardRows ?? []) as any[])
    .filter(r => r.badge?.name)
    .map(r => ({
      id: r.id,
      badgeName: r.badge.name,
      earnedAt: r.earned_at,
      leagueId: r.league_id ?? null,
      leagueName: r.league?.name ?? null,
      matchId: r.source_match_id ?? null,
      context: r.context ?? null,
      isHidden: !!r.is_hidden,
    }));
  const collectibles: CollectibleInput[] = isPrivate ? [] : ((purchaseRows ?? []) as any[])
    .filter(r => r.item?.category === 'cosmetic_badge')
    .map(r => ({
      id: r.id,
      shopItemId: r.shop_item_id,
      name: r.item.name,
      description: r.item.description ?? null,
      icon: r.item.icon ?? null,
      acquiredAt: r.purchased_at,
      isHidden: !!r.is_hidden,
      // The gift note itself is the sender's and recipient's alone.
      note: r.gifted_by_user_id ? 'A gift' : null,
    }));

  if (!own) {
    return {
      ...buildAchievements({ catalog, awards, collectibles, earnedOnly: true, glyphForEmoji: emojiGlyph }),
      private: isPrivate,
      profile: null,
    };
  }

  const [progressList, streakRow, rewardRows, grantRows, memberRows, styleRows] = await Promise.all([
    opts.light ? Promise.resolve(null) : soft(computeBadgeProgress(userId)),
    soft(sbCall(() => supabase.from('user_login_streaks').select('current_streak, longest_streak').eq('user_id', userId).maybeSingle())),
    // The streak badges paid (once each; backfilled from user_streak_rewards).
    soft(sbCall(() => supabase.from('login_streak_milestones').select('days, awarded_at').eq('user_id', userId))),
    soft(sbCall(() => supabase.from('ftue_grants').select('step, granted_at').eq('user_id', userId))),
    soft(sbCall(() => supabase.from('league_members').select('league_id').eq('user_id', userId).limit(1))),
    opts.light ? Promise.resolve(null) : soft(sbCall(() => supabase
      .from('shop_items')
      // Badge id -> name through the catalogue, not an embed: the FK's
      // generated name isn't guaranteed across environments (UnlockProgress).
      .select('name, unlock_badge_id')
      .not('unlock_badge_id', 'is', null)
      .eq('is_active', true)
      .in('category', ['list_name_style', 'profile_name_style']))),
  ]);

  let streak: StreakInput | null = null;
  if (streakRow || rewardRows) {
    const reachedOn: Record<number, string> = {};
    const milestoneDays = new Set(STREAK_MILESTONES.map(m => m.days));
    for (const r of ((rewardRows ?? []) as any[])) {
      const d = Number(r.days);
      if (milestoneDays.has(d) && r.awarded_at) reachedOn[d] = String(r.awarded_at);
    }
    streak = {
      current: Number((streakRow as any)?.current_streak ?? 0),
      longest: Number((streakRow as any)?.longest_streak ?? 0),
      reachedOn,
    };
  }

  const p = profile as any;
  const grants = new Map<string, string>(((grantRows ?? []) as any[]).map(r => [r.step, r.granted_at]));
  const complete: Record<FtueStepKey, boolean> = {
    join_league: ((memberRows ?? []) as any[]).length > 0,
    setup_profile: !!(p?.avatar_emoji || p?.tagline || (p?.selected_tags?.length ?? 0) > 0),
    first_match: (p?.total_matches_played ?? 0) > 0,
  };
  const ftue: FtueInput = {
    join_league: { complete: complete.join_league || grants.has('join_league'), claimedAt: grants.get('join_league') ?? null },
    setup_profile: { complete: complete.setup_profile || grants.has('setup_profile'), claimedAt: grants.get('setup_profile') ?? null },
    first_match: { complete: complete.first_match || grants.has('first_match'), claimedAt: grants.get('first_match') ?? null },
  };

  const nameStyles: Record<string, string> = {};
  const badgeNameById = new Map<string, string>(((catalogRows ?? []) as any[]).map(r => [r.id, r.name]));
  for (const r of ((styleRows ?? []) as any[])) {
    const badge = badgeNameById.get(r.unlock_badge_id);
    if (badge && !nameStyles[badge]) nameStyles[badge] = r.name;
  }

  return {
    ...buildAchievements({
      catalog,
      awards,
      collectibles,
      progress: progressList ? progressByBadge(progressList) : null,
      streak,
      ftue,
      nameStyles,
      glyphForEmoji: emojiGlyph,
    }),
    private: false,
    profile: p ?? null,
  };
}
