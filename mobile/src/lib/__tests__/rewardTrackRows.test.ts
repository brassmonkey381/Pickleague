// lib/rewardTrackRows: the get_reward_track jsonb (migration_court_pass_xp.sql)
// mapped onto the kit's reward-track types. Ported from Doggle's
// scripts/tests/rewardTrackRows.test.mjs, plus Pickleague's item, not_earning
// and paid fields (docs/court-pass.md).
import { describe, it, expect } from 'vitest';
import { mapRewardTrack, unseenGrants } from '../rewardTrackRows';

// The shared contract's shape (docs/court-pass.md, get_reward_track).
const running = {
  cycle: {
    id: '2026-12',
    title: 'December Court Pass',
    starts_at: '2026-12-01T08:00:00+00:00',
    ends_at: '2027-01-01T08:00:00+00:00',
    premium_state: 'coming_soon',
  },
  next_starts_at: '2027-01-01T08:00:00+00:00',
  tiers: [
    { tier: 1, xp_required: 10 },
    { tier: 5, xp_required: 110 },
    { tier: 10, xp_required: 360 },
  ],
  rewards: [
    { tier: 1, lane: 'free', kind: 'pickles', amount: 40, item_key: null, title: '40 pickles', rarity: null, item: null },
    {
      tier: 5,
      lane: 'free',
      kind: 'shop_item',
      amount: null,
      item_key: 'cp2612-avatar-snowman',
      title: 'Snow Day',
      rarity: 'common',
      item: {
        id: '7d4e5b0e-0000-4000-8000-000000000001',
        category: 'avatar',
        slug: 'cp2612-avatar-snowman',
        icon: '⛄',
        payload: { emoji: '⛄', bgColor: '#dceefb' },
      },
    },
    {
      tier: 10,
      lane: 'free',
      kind: 'home_item',
      amount: null,
      item_key: 'cp2612_snow_globe',
      title: 'Court Snow Globe',
      rarity: 'common',
      item: { id: 'cp2612_snow_globe', slot_group: 'shelf_item', art_aspect: 1, icon: '❄️' },
    },
  ],
  // No daily cap (Brian, 2026-11-03): the server sends daily_cap null.
  me: { xp: 22, tier: 1, today_xp: 22, daily_cap: null, can_earn: true, not_earning: null },
  grants: [{ tier: 1, lane: 'free', granted_at: '2026-12-02T17:00:00+00:00', seen_at: null }],
  paid: { pickles: 40, grants: [{ cycle_id: '2026-12', tier: 1, kind: 'pickles', title: '40 pickles' }] },
};

describe('mapRewardTrack', () => {
  it('a running pass maps onto the kit types', () => {
    const d = mapRewardTrack(running);
    expect(d.cycle).toEqual({
      id: '2026-12',
      title: 'December Court Pass',
      startsAt: '2026-12-01T08:00:00+00:00',
      endsAt: '2027-01-01T08:00:00+00:00',
      premiumState: 'coming_soon',
    });
    expect(d.window).toEqual({ startsAt: d.cycle!.startsAt, endsAt: d.cycle!.endsAt, premiumState: 'coming_soon' });
    expect(d.tiers).toEqual([
      { tier: 1, xpRequired: 10 },
      { tier: 5, xpRequired: 110 },
      { tier: 10, xpRequired: 360 },
    ]);
    expect(d.rewards[0]).toEqual({
      tier: 1, lane: 'free', kind: 'pickles', amount: 40, itemKey: null, title: '40 pickles', rarity: null, item: null,
    });
    expect(d.me).toEqual({ xp: 22, tier: 1, todayXp: 22, dailyCap: null, canEarn: true, notEarning: null });
    expect(d.grants).toEqual([{ tier: 1, lane: 'free', grantedAt: '2026-12-02T17:00:00+00:00', seenAt: null }]);
    expect(d.nextStartsAt).toBe('2027-01-01T08:00:00+00:00');
  });

  it('maps the item behind a reward: shop items keep their payload, home items their slot and aspect', () => {
    const d = mapRewardTrack(running);
    expect(d.rewards[1].item).toEqual({
      id: '7d4e5b0e-0000-4000-8000-000000000001',
      category: 'avatar',
      slug: 'cp2612-avatar-snowman',
      slotGroup: null,
      aspect: null,
      icon: '⛄',
      payload: { emoji: '⛄', bgColor: '#dceefb' },
    });
    expect(d.rewards[2].item).toEqual({
      id: 'cp2612_snow_globe',
      category: null,
      slug: null,
      slotGroup: 'shelf_item',
      aspect: 1,
      icon: '❄️',
      payload: null,
    });
    // An item with no id is no item; a junk aspect is no aspect.
    const odd = mapRewardTrack({
      ...running,
      rewards: [
        { ...running.rewards[2], item: { slot_group: 'shelf_item' } },
        { ...running.rewards[2], tier: 11, item: { id: 'x', art_aspect: -1 } },
      ],
    });
    expect(odd.rewards[0].item).toBeNull();
    expect(odd.rewards[1].item?.aspect).toBeNull();
  });

  it('paid: the pickles and each tier this read paid, an earlier cycle included', () => {
    const d = mapRewardTrack({
      ...running,
      paid: {
        pickles: 100,
        grants: [
          { cycle_id: '2026-12', tier: 29, kind: 'pickles', title: '100 pickles' },
          { cycle_id: '2026-12', tier: 30, kind: 'shop_item', title: 'Snowfall' },
          { tier: 3 },
          null,
        ],
      },
    });
    expect(d.paid).toEqual({
      pickles: 100,
      grants: [
        { cycleId: '2026-12', tier: 29, kind: 'pickles', title: '100 pickles' },
        { cycleId: '2026-12', tier: 30, kind: 'shop_item', title: 'Snowfall' },
      ],
    });
    expect(mapRewardTrack({ ...running, paid: undefined }).paid).toEqual({ pickles: 0, grants: [] });
    expect(mapRewardTrack({ ...running, paid: { pickles: -5, grants: 'x' } }).paid).toEqual({ pickles: 0, grants: [] });
  });

  it('not_earning: a guest and a test account cannot earn, whatever can_earn says', () => {
    const guest = mapRewardTrack({ ...running, me: { ...running.me, can_earn: false, not_earning: 'guest' } });
    expect(guest.me.notEarning).toBe('guest');
    expect(guest.me.canEarn).toBe(false);
    const test = mapRewardTrack({ ...running, me: { ...running.me, can_earn: true, not_earning: 'test_account' } });
    expect(test.me.notEarning).toBe('test_account');
    expect(test.me.canEarn).toBe(false);
    // An unknown reason from a newer server reads as no reason.
    const odd = mapRewardTrack({ ...running, me: { ...running.me, not_earning: 'banned' } });
    expect(odd.me.notEarning).toBeNull();
    expect(odd.me.canEarn).toBe(true);
  });

  it('defaults: no daily cap, the Court Pass title, kind pickles, zeros', () => {
    const d = mapRewardTrack({
      cycle: { id: '2027-01', starts_at: '2027-01-01T08:00:00Z', ends_at: '2027-02-01T08:00:00Z', premium_state: 'off' },
      rewards: [{ tier: 1, lane: 'free', amount: 40 }],
    });
    expect(d.cycle?.title).toBe('Court Pass');
    expect(d.window?.premiumState).toBe('off');
    expect(d.rewards[0]).toMatchObject({ kind: 'pickles', title: '', itemKey: null, rarity: null, item: null });
    expect(d.me).toEqual({ xp: 0, tier: 0, todayXp: 0, dailyCap: null, canEarn: true, notEarning: null });
    expect(d.nextStartsAt).toBeNull();
  });

  it('the daily cap: null, missing or junk is no cap; a positive number (a pass capped in SQL) is kept', () => {
    const cap = (v: unknown) => mapRewardTrack({ ...running, me: { ...running.me, daily_cap: v } }).me.dailyCap;
    expect(cap(null)).toBeNull();
    expect(cap(undefined)).toBeNull();
    expect(cap('125')).toBeNull();
    expect(cap(0)).toBeNull();
    expect(cap(-5)).toBeNull();
    expect(cap(125)).toBe(125);
  });

  it('between passes: no cycle, no window, the next start and the payout kept', () => {
    const d = mapRewardTrack({
      cycle: null,
      next_starts_at: '2026-12-01T08:00:00+00:00',
      tiers: [],
      rewards: [],
      me: { xp: 0, tier: 0, today_xp: 0, daily_cap: null, can_earn: true, not_earning: null },
      grants: [],
      paid: { pickles: 250, grants: [{ cycle_id: '2027-01', tier: 30, kind: 'pickles', title: '250 pickles' }] },
    });
    expect(d.cycle).toBeNull();
    expect(d.window).toBeNull();
    expect(d.nextStartsAt).toBe('2026-12-01T08:00:00+00:00');
    expect(d.paid.pickles).toBe(250);
  });

  it('premium never maps to on sale in v1; off stays off', () => {
    const sale = mapRewardTrack({ ...running, cycle: { ...running.cycle, premium_state: 'on_sale' } });
    expect(sale.cycle?.premiumState).toBe('coming_soon');
    const off = mapRewardTrack({ ...running, cycle: { ...running.cycle, premium_state: 'off' } });
    expect(off.window?.premiumState).toBe('off');
  });

  it('junk rows are dropped, a junk body is an empty pass', () => {
    const d = mapRewardTrack({
      ...running,
      tiers: [{ tier: 'x', xp_required: 1 }, null, { tier: 3, xp_required: 60 }],
      rewards: [{ tier: 1, lane: 'gold', title: 'x' }, { tier: 3, lane: 'free', title: '40 pickles', kind: 'pickles', amount: 40 }],
      grants: [{ tier: 1, lane: 'free' }, { tier: 3, lane: 'free', granted_at: '2026-12-03T00:00:00Z', seen_at: '2026-12-03T00:01:00Z' }],
    });
    expect(d.tiers).toEqual([{ tier: 3, xpRequired: 60 }]);
    expect(d.rewards.map((r) => r.tier)).toEqual([3]);
    expect(d.grants.map((g) => g.tier)).toEqual([3]);
    for (const junk of [null, undefined, 'x', 42, [], { cycle: 'x' }]) {
      const e = mapRewardTrack(junk);
      expect(e.cycle).toBeNull();
      expect(e.tiers).toEqual([]);
      expect(e.rewards).toEqual([]);
      expect(e.grants).toEqual([]);
      expect(e.paid).toEqual({ pickles: 0, grants: [] });
    }
  });
});

describe('unseenGrants', () => {
  it('free lane, not seen yet', () => {
    expect(
      unseenGrants({
        grants: [
          { tier: 1, lane: 'free', grantedAt: 'a', seenAt: null },
          { tier: 2, lane: 'free', grantedAt: 'a', seenAt: 'b' },
          { tier: 5, lane: 'premium', grantedAt: 'a', seenAt: null },
          { tier: 3, lane: 'free', grantedAt: 'a' },
        ],
      }).map((g) => g.tier),
    ).toEqual([1, 3]);
  });
});
