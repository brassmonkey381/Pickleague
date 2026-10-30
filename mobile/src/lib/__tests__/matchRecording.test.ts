import { describe, it, expect } from 'vitest';
import { linkDroppedNote, matchRecordedNote, NOT_A_PLAYER_NOTE, scoreProblem } from '../matchRecording';
import { checkedInVisibilityLine, DEFAULT_PRESENCE_SETTINGS } from '../presencePrivacy';
import type { SessionValidity } from '../sessionValidity';

const T0 = Date.parse('2026-10-16T18:00:00.000Z');
const label = (d: Date) => d.toISOString().slice(11, 16);
const v = (x: Partial<SessionValidity>): SessionValidity => ({
  valid: false,
  reason: 'no_match_or_drill',
  needs: 'match_or_drill',
  window_ends_at: null,
  ...x,
});

describe('scoreProblem (matches_score_sanity_check, said before the send)', () => {
  it('takes what the server takes', () => {
    expect(scoreProblem(1, 11, 9)).toBeNull();
    expect(scoreProblem(1, 15, 13)).toBeNull();
    expect(scoreProblem(3, 27, 25)).toBeNull();
  });

  it('a single game: why, then what to do', () => {
    expect(scoreProblem(1, 11, 10)).toBe(
      'A game needs a winner with at least 11 points and a 2-point lead (like 11-9). Check the score, then record it.',
    );
    expect(scoreProblem(1, 7, 5)).toBe(scoreProblem(1, 11, 10));
    expect(scoreProblem(1, 52, 50)).toBe("A game score can't be over 50 points. Check the score, then record it.");
  });

  it('several games: the totals, and why that matters', () => {
    expect(scoreProblem(3, 57, 55)).toBe(
      "Pickleague adds the games' points together, and one side can't have more than 50 in total. Record fewer games, or just the deciding ones.",
    );
    expect(scoreProblem(2, 20, 19)).toContain('2-point lead in total');
  });
});

describe('matchRecordedNote (what the server stored)', () => {
  const deadline = new Date(T0 + 3_600_000);

  it('a player recorded it: the other team has until the deadline, or it is removed', () => {
    expect(matchRecordedNote({ confirmed: false, iPlayed: true, deadline, timeLabel: label })).toBe(
      'Match recorded. Ratings and pickles update once the other team confirms. They have until 19:00, or the match is removed.',
    );
  });

  it('a league member who did not play recorded it: both teams confirm', () => {
    expect(matchRecordedNote({ confirmed: false, iPlayed: false, deadline, timeLabel: label })).toBe(
      'Match recorded. Both teams need to confirm by 19:00, or the match is removed. Ratings and pickles update after that.',
    );
  });

  it('no deadline read back: within the hour; confirmed: says so', () => {
    expect(matchRecordedNote({ confirmed: false, iPlayed: true, deadline: null })).toContain('They have an hour');
    expect(matchRecordedNote({ confirmed: true, iPlayed: true, deadline: null })).toBe('Match recorded and confirmed. Ratings updated.');
  });

  it('no em dash anywhere', () => {
    for (const s of [
      matchRecordedNote({ confirmed: false, iPlayed: true, deadline }),
      matchRecordedNote({ confirmed: false, iPlayed: false, deadline }),
      NOT_A_PLAYER_NOTE,
    ]) {
      expect(s).not.toContain('—');
    }
  });
});

describe('linkDroppedNote (why a match recorded from a session does not count for it)', () => {
  const base = { sentLink: true, linkedBack: null, sessionId: 's1', startQueued: false, nowMs: T0 } as const;

  it('nothing to say when the link held, nothing was sent, or there is no answer', () => {
    expect(linkDroppedNote({ ...base, linkedBack: 's1', validity: v({}) })).toBeNull();
    expect(linkDroppedNote({ ...base, sentLink: false, validity: v({}) })).toBeNull();
    expect(linkDroppedNote({ ...base, linkedBack: undefined, validity: v({}) })).toBeNull();
    expect(linkDroppedNote({ ...base, validity: 'unknown' })).toBeNull();
  });

  it('the session ended over 7 days ago (window_ends_at is its end + 2 h)', () => {
    const endsAt = (endedAgoMs: number) => new Date(T0 - endedAgoMs + 2 * 3_600_000).toISOString();
    expect(linkDroppedNote({ ...base, validity: v({ window_ends_at: endsAt(7 * 86_400_000 + 60_000) }) })).toBe(
      "Match recorded, but it doesn't count for your play session: it was recorded more than 7 days after the session ended.",
    );
  });

  it('nothing to say for a session that ended under 7 days ago (the server keeps that link)', () => {
    const endsAt = new Date(T0 - 3 * 86_400_000 + 2 * 3_600_000).toISOString();
    expect(linkDroppedNote({ ...base, validity: v({ window_ends_at: endsAt }) })).toBeNull();
  });

  it('the session is not on the server: still queued, or never got there', () => {
    expect(linkDroppedNote({ ...base, validity: null, startQueued: true })).toBe(
      "Match recorded. Your play session was saved with no signal and hasn't reached Pickleague yet. The match counts for it once it does.",
    );
    expect(linkDroppedNote({ ...base, validity: null, startQueued: false })).toBe(
      "Match recorded, but your play session never reached Pickleague, so the match can't count for it.",
    );
  });
});

describe('checkedInVisibilityLine (the lock-screen "Checked in" notice)', () => {
  it('true to the player\'s own settings', () => {
    expect(checkedInVisibilityLine(DEFAULT_PRESENCE_SETTINGS, T0)).toBe(
      'Your friends and closed-league mates can see you are here.',
    );
    expect(checkedInVisibilityLine({ ...DEFAULT_PRESENCE_SETTINGS, checkins_level: 'everyone' }, T0)).toBe(
      'Other players can see you are here.',
    );
    expect(checkedInVisibilityLine({ ...DEFAULT_PRESENCE_SETTINGS, checkins_level: 'hidden' }, T0)).toBe(
      'Your name is hidden, so others see "a player" here.',
    );
    expect(
      checkedInVisibilityLine({ ...DEFAULT_PRESENCE_SETTINGS, paused_until: new Date(T0 + 3_600_000).toISOString() }, T0),
    ).toBe('Sharing is paused, so others see "a player" here.');
    // A pause that ran out is no pause.
    expect(
      checkedInVisibilityLine({ ...DEFAULT_PRESENCE_SETTINGS, checkins_level: 'friends', paused_until: new Date(T0 - 1).toISOString() }, T0),
    ).toBe('Your friends can see you are here.');
  });
});
