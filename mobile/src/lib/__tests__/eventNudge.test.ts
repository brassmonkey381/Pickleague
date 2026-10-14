import { describe, it, expect, vi } from 'vitest';

// eventNudge also reads invited phones through the app's Supabase client.
// These tests cover only the pure parts, so neither client loads.
vi.mock('../supabase', () => ({ supabase: {} }));
vi.mock('@just-messin-around/expo-foundation/supabase', () => ({ sbCall: vi.fn() }));

import { buildNudgeMessage, pickNudgeKind } from '../eventNudge';

// Friday Oct 16 2026, 8 PM in the device zone.
const NOW = new Date(2026, 9, 16, 20, 0).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).toISOString();
const scheduled = { status: 'scheduled' as const, vote_ends_at: at(15, 19) };

describe('pickNudgeKind', () => {
  it('a 9 AM game texted about at 8 PM the night before is tomorrow, not today', () => {
    expect(pickNudgeKind(scheduled, { starts_at: at(17, 9) }, NOW)).toBe('tomorrow');
  });

  it('today is the same calendar day, however many hours ahead', () => {
    expect(pickNudgeKind(scheduled, { starts_at: at(16, 23, 30) }, NOW)).toBe('today');
    // 6:30 AM for a 9 PM game: 14.5 hours away, still today.
    expect(pickNudgeKind(scheduled, { starts_at: at(17, 21) }, new Date(2026, 9, 17, 6, 30).getTime())).toBe('today');
  });

  it('nothing once it has started, or when it is more than two days out', () => {
    expect(pickNudgeKind(scheduled, { starts_at: at(16, 19) }, NOW)).toBeNull();
    expect(pickNudgeKind(scheduled, { starts_at: at(19, 9) }, NOW)).toBeNull();
    expect(pickNudgeKind(scheduled, null, NOW)).toBeNull();
  });

  it('an open vote gets the vote nudge; a closed one gets none', () => {
    expect(pickNudgeKind({ status: 'voting', vote_ends_at: at(18, 19) }, null, NOW)).toBe('vote');
    expect(pickNudgeKind({ status: 'voting', vote_ends_at: at(16, 19) }, null, NOW)).toBeNull();
  });
});

describe('buildNudgeMessage', () => {
  it('the vote deadline names its day, not just a clock time', () => {
    const closes = at(20, 19);
    const msg = buildNudgeMessage({
      kind: 'vote',
      event: { id: 'e1', title: 'Mixer', vote_ends_at: closes, min_players: null, location_name: null },
      slots: [],
      confirmedSlot: null,
      voterCount: 3,
      attendeeNames: [],
    });
    const day = new Date(closes).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    const time = new Date(closes).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(msg.split('\n').pop()).toBe(
      `Voting closes ${day} at ${time} — lock in your times: https://www.pickleague.club/events/e1`,
    );
  });
});
