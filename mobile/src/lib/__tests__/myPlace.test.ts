import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  avatarLook,
  decorAction,
  decorRows,
  equippedFrom,
  filledCount,
  homeFromRpc,
  itemFromRow,
  parentEmptyNote,
  sceneItems,
  slotsTheServerKnows,
  tileGrid,
  visitBlock,
  visitBlockTitle,
  type HomeItemRow,
} from '../myPlace';
import { MY_PLACE_DECOR_SLOTS, MY_PLACE_SLOTS, myPlaceBackdrop, MY_PLACE_BASE_BACKDROP } from '../myPlaceSlots';
import { REFUSAL_CODES, refusalCopy, refusalMessage, refusalTitle } from '../refusals';
import { blockingParent } from '../myPlace';

const row = (o: Partial<HomeItemRow> & { id: string }): HomeItemRow => ({
  name: o.id,
  slot_group: 'couch',
  cost: 0,
  rarity: 'common',
  season: null,
  available_from: null,
  available_until: null,
  art_key: null,
  art_aspect: null,
  icon: null,
  sort: 0,
  is_starter: false,
  ...o,
});

const NOW = new Date('2026-10-29T12:00:00Z');
const slot = (id: string) => MY_PLACE_SLOTS.find((s) => s.id === id)!;

describe('itemFromRow', () => {
  it('maps slot_group, art, aspect, dates and rarity to the kit item', () => {
    const i = itemFromRow(
      row({ id: 'couch_comfy', name: 'Comfy', cost: 900, rarity: 'legendary', art_key: 'k', art_aspect: '2.5', available_until: '2026-11-01T00:00:00Z', sort: 30, is_starter: true }),
    );
    expect(i).toMatchObject({ id: 'couch_comfy', fits: 'couch', cost: 900, art: 'k', aspect: 2.5, rarity: 'legendary', availableUntil: '2026-11-01T00:00:00Z', sort: 30, isStarter: true, svg: null });
  });
  it('drops a bad aspect, an unknown rarity and a negative cost', () => {
    expect(itemFromRow(row({ id: 'x', art_aspect: 0, rarity: 'mythic', cost: -5 }))).toMatchObject({ aspect: null, rarity: 'common', cost: 0 });
  });
});

describe('homeFromRpc', () => {
  it('reads mine', () => {
    const h = homeFromRpc({ owner_id: 'u', is_me: true, visibility: 'only_me', equipped: { couch: 'c', bad: 3 }, item_ids: ['c'], owned: ['c', 'w'], starter_claimed: true, balance: 1200 });
    expect(h).toEqual({ ownerId: 'u', isMe: true, visibility: 'only_me', equipped: { couch: 'c' }, itemIds: ['c'], owned: ['c', 'w'], starterClaimed: true, balance: 1200 });
  });
  it("someone else's: no owned, no balance; junk reads as the defaults", () => {
    expect(homeFromRpc({ owner_id: 'v', is_me: false, visibility: 'weird', equipped: [] })).toEqual({
      ownerId: 'v', isMe: false, visibility: 'friends', equipped: {}, itemIds: [], owned: [], starterClaimed: false, balance: null,
    });
    expect(homeFromRpc(null).visibility).toBe('friends');
    expect(equippedFrom('x')).toEqual({});
  });
});

describe('the decor sheet', () => {
  const items = [
    itemFromRow(row({ id: 'cheap', cost: 900, sort: 2 })),
    itemFromRow(row({ id: 'pricey', cost: 5000, sort: 3 })),
    itemFromRow(row({ id: 'mine', cost: 1200, sort: 4 })),
    itemFromRow(row({ id: 'in', cost: 0, sort: 1 })),
    itemFromRow(row({ id: 'ended', cost: 900, available_until: '2026-10-01T00:00:00Z' })),
    itemFromRow(row({ id: 'ended_owned', cost: 900, available_until: '2026-10-01T00:00:00Z' })),
    itemFromRow(row({ id: 'soon', cost: 900, available_from: '2026-12-01T00:00:00Z' })),
    itemFromRow(row({ id: 'pillow', slot_group: 'couch_pillow', cost: 0 })),
  ];
  const ctx = { owned: ['mine', 'in', 'ended_owned'], equipped: { couch: 'in' }, balance: 1000, now: NOW };

  it('lists owned first (the one in the slot on top), then for sale by price; hides ended and not-yet items nobody owns', () => {
    const rows = decorRows(items, slot('couch'), ctx);
    expect(rows.map((r) => r.item.id)).toEqual(['in', 'ended_owned', 'mine', 'cheap', 'pricey']);
    expect(rows.map((r) => r.action.type)).toEqual(['remove', 'equip', 'equip', 'buy', 'locked']);
    expect(rows[4].action).toEqual({ type: 'locked', short: 4000 });
  });

  it('an owned item in another slot moves here; an unknown balance is locked with no number', () => {
    const accent = itemFromRow(row({ id: 'lamp', slot_group: 'accent', cost: 900 }));
    expect(decorAction(accent, 'accent2', { owned: ['lamp'], equipped: { accent: 'lamp' }, balance: 0, now: NOW })).toEqual({ type: 'equip', from: 'accent' });
    expect(decorAction(items[1], 'couch', { owned: [], equipped: {}, balance: null, now: NOW })).toEqual({ type: 'locked', short: null });
    expect(decorAction(items[6], 'couch', { owned: [], equipped: {}, balance: 9999, now: NOW })).toEqual({ type: 'unavailable', notYet: true });
    expect(decorAction(items[4], 'couch', { owned: [], equipped: {}, balance: 9999, now: NOW })).toEqual({ type: 'unavailable', notYet: false });
  });

  it('a pillow with no couch names the couch to fill first', () => {
    const p = blockingParent(MY_PLACE_SLOTS, 'couch_pillow', {});
    expect(p?.id).toBe('couch');
    expect(blockingParent(MY_PLACE_SLOTS, 'couch_pillow', { couch: 'in' })).toBeNull();
    expect(parentEmptyNote(slot('couch_pillow'), p!)).toBe(
      "Couch pillow sits on the Couch spot, which is empty, so anything here wouldn't show. Put something in Couch first.",
    );
  });

  it('scene items drop ids the catalog lacks; filled counts decor only', () => {
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(sceneItems({ couch: 'in', rug: 'gone' }, byId)).toEqual({ couch: byId.in, rug: null });
    expect(filledCount({ couch: 'in', avatar: 'x', rug: '' }, MY_PLACE_SLOTS)).toBe(1);
  });

  it('a slot the server does not know is not offered (an older server)', () => {
    expect(slotsTheServerKnows(MY_PLACE_DECOR_SLOTS, null)).toHaveLength(13);
    expect(slotsTheServerKnows(MY_PLACE_DECOR_SLOTS, ['couch', 'rug']).map((s) => s.id)).toEqual(['rug', 'couch']);
  });
});

describe('visiting', () => {
  const err = (code: string, detail?: object) => ({ code: 'P0001', message: 'server text', hint: `pl:${code}`, details: detail ? JSON.stringify(detail) : undefined });
  it('maps each get_home refusal to a friendly state, anything else to a retry', () => {
    expect(visitBlock(err('home.private', { name: 'Sam' }))).toBe('private');
    expect(visitBlock(err('home.friends_only', { name: 'Sam' }))).toBe('friends_only');
    expect(visitBlock(err('home.unavailable'))).toBe('unavailable');
    expect(visitBlock(err('player.gone'))).toBe('gone');
    expect(visitBlock(err('home.guest'))).toBe('guest');
    expect(visitBlock({ message: 'Failed to fetch' })).toBeNull();
    expect(visitBlockTitle('private', 'Sam')).toBe("Sam's place is private");
    expect(visitBlockTitle('unavailable', 'Sam')).toBe('This place is unavailable');
  });
  it('the copy names the player and the next step; a block is never singled out', () => {
    expect(refusalMessage(err('home.friends_only', { name: 'Sam' }))).toBe(
      'Sam shares My Place with friends only. Send them a friend request; once they accept, you can visit.',
    );
    expect(refusalMessage(err('home.private', { name: 'Sam' }))).toBe(
      "Sam keeps My Place to themselves right now, so it can't be visited. Visit a friend's place instead.",
    );
    expect(refusalMessage(err('home.unavailable'))).not.toMatch(/block/i);
    expect(refusalMessage(err('player.gone'), { action: 'visit_place' })).toBe(
      "That account isn't in Pickleague any more, so there's no My Place to visit. Go back and pick someone else.",
    );
  });
});

describe('buying refusals', () => {
  it('not enough says the price and how many more', () => {
    expect(refusalCopy('home.not_enough', {}, { item: 'Ball Chandelier', cost: 5000, balance: 1200, short: 3800 })).toBe(
      'Ball Chandelier costs 5,000 pickles. You need 3,800 more: play matches and log in daily to earn them, then come back.',
    );
    expect(refusalTitle('home.not_enough')).toBe('Not enough pickles');
  });
  it('a bad layout names the spot and the reason, once', () => {
    expect(refusalCopy('home.layout_bad', {}, { slot: 'couch', reason: '"w" must be above 0 and at most 4.' })).toBe(
      'The layout wasn\'t saved: the couch spot has a problem ("w" must be above 0 and at most 4). Fix it, then save again.',
    );
  });
});

describe('the server raises only codes the app words', () => {
  it('every pl: hint in migration_my_place.sql is a known refusal code', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const sql = fs.readFileSync(path.join(root, 'supabase/migration_my_place.sql'), 'utf8');
    const codes = new Set([...sql.matchAll(/'pl:([a-z_.]+)'/g)].map((m) => m[1]));
    expect(codes.size).toBeGreaterThan(10);
    for (const code of codes) expect(REFUSAL_CODES, code).toContain(code);
  });
});

describe('looks', () => {
  const cartoons = [
    { id: 1, emoji: '🐻', bgColor: '#c8a97e' },
    { id: 3, emoji: '🐸', bgColor: '#a5d6a7' },
  ];
  it("the app's order: photo, else premium, else cartoon", () => {
    expect(avatarLook({ avatar_id: 3 }, cartoons)).toEqual({ photoUrl: null, emoji: '🐸', bgColor: '#a5d6a7' });
    expect(avatarLook({ avatar_id: 3, avatar_emoji: '🦄', avatar_bg_color: '#fff000' }, cartoons)).toMatchObject({ emoji: '🦄', bgColor: '#fff000' });
    expect(avatarLook({ avatar_url: 'https://x/y.png' }, cartoons).photoUrl).toBe('https://x/y.png');
    expect(avatarLook(null, cartoons).emoji).toBe('🐻');
  });
  it('backdrop colours follow the wall and floor items; unknown ones use the base', () => {
    expect(myPlaceBackdrop('wall_night_court', 'floor_court_blue')).toMatchObject({ wallTop: '#24334f', floorFill: '#5b8fd4', floorPattern: 'plain' });
    expect(myPlaceBackdrop('nope', null)).toEqual(MY_PLACE_BASE_BACKDROP);
  });
  it('tiles cover the band', () => {
    expect(tileGrid(400, 178.6, 100, 1)).toEqual({ w: 100, h: 100, cols: 4, rows: 2 });
    expect(tileGrid(400, 109.4, 100, 2)).toEqual({ w: 100, h: 50, cols: 4, rows: 3 });
  });
});
