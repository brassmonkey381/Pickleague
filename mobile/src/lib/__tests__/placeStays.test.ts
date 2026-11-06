import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateSlots } from '@just-messin-around/expo-foundation/room/layout';
import { STAY_HOURS, STAY_PASS_BONUS, STAY_REWARD } from '@just-messin-around/expo-foundation/stays/rules';
import {
  awayLine,
  guestLine,
  NO_PLACE_STAYS,
  placeStayReturnsFromRpc,
  placeStaysFromRpc,
  returnMessage,
  STAY_BUTTON,
} from '../placeStays';
import { MY_PLACE_GUEST_SLOTS, MY_PLACE_SCENE_SLOTS, MY_PLACE_SLOTS } from '../myPlaceSlots';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sql = fs.readFileSync(path.join(root, 'supabase/migration_place_stays.sql'), 'utf8');

describe('the stay numbers match the SQL', () => {
  it(`${STAY_HOURS} hours, ${STAY_REWARD} pickles, ${STAY_PASS_BONUS} pickleballs`, () => {
    expect(sql).toContain(`now() + interval '${STAY_HOURS} hours'`);
    expect(sql).toContain(`least(${STAY_REWARD}, public._pl_play_cap_left(v_row.visitor_id))`);
    expect(sql).toContain(`'place_stay', v_row.id::text, ${STAY_PASS_BONUS}, null)`);
    expect(STAY_BUTTON).toBe(`Stay for ${STAY_HOURS} hours`);
  });
});

describe('placeStaysFromRpc', () => {
  it('reads away and guests, skipping broken rows', () => {
    const s = placeStaysFromRpc({
      away: { host_id: 'h', host_label: "Sam's place", ends_at: '2026-11-05T22:40:00Z' },
      guests: [
        { visitor_id: 'g1', name: 'Lee', ends_at: '2026-11-05T23:00:00Z', avatar_id: 3, avatar_emoji: null },
        { name: 'no id' },
        null,
      ],
    });
    expect(s.away).toEqual({ hostId: 'h', hostLabel: "Sam's place", endsAt: '2026-11-05T22:40:00Z' });
    expect(s.guests).toHaveLength(1);
    expect(s.guests[0]).toMatchObject({ visitorId: 'g1', name: 'Lee', avatar_id: 3, avatar_emoji: null, avatar_url: null });
  });

  it('nothing (a place I cannot visit, or garbage) reads as nobody', () => {
    expect(placeStaysFromRpc({ away: null, guests: [] })).toEqual(NO_PLACE_STAYS);
    expect(placeStaysFromRpc(null)).toEqual(NO_PLACE_STAYS);
  });
});

describe('placeStayReturnsFromRpc', () => {
  it('reads the claim rows, pickleballs included', () => {
    const rows = placeStayReturnsFromRpc([
      {
        stay_id: 's1', host_id: 'h', host_label: "Sam's place", souvenir: 'You napped.', pickles: 15, pickleballs: 5,
        returned_at: '2026-11-05T22:40:00Z', item_id: 'rug_ball', item_name: 'Pickleball Rug', item_rarity: 'rare',
      },
      { stay_id: 's2', pickles: 'x', item_rarity: 'mythic' },
      { no: 'id' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pickles: 15, pickleballs: 5, item_rarity: 'rare' });
    expect(rows[1]).toMatchObject({ pickles: 0, pickleballs: 0, item_rarity: null, host_label: "your friend's place" });
  });
});

describe('copy', () => {
  it('says where and until when, with no middle dots', () => {
    const away = awayLine({ hostId: 'h', hostLabel: "Sam's place", endsAt: '2026-11-05T22:40:00Z' });
    expect(away).toMatch(/^You're staying at Sam's place until .+\.$/);
    expect(guestLine({ name: 'Lee', endsAt: 'bad' })).toBe('Lee is visiting until later.');
    expect(returnMessage({ souvenir: null, host_label: "Sam's place" })).toBe("You had a great time at Sam's place.");
    expect(away).not.toContain('·');
  });
});

describe('guest spots', () => {
  it('are avatar slots the room can draw, kept out of the synced slot list', () => {
    expect(validateSlots(MY_PLACE_SCENE_SLOTS)).toEqual([]);
    expect(MY_PLACE_GUEST_SLOTS.every((s) => s.kind === 'avatar' && !!s.default)).toBe(true);
    expect(MY_PLACE_SLOTS.some((s) => s.id.startsWith('guest'))).toBe(false);
  });
});
