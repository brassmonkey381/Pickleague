import { describe, it, expect } from 'vitest';
import { optionVoteNotice, readOptionVoteData } from '@just-messin-around/expo-foundation/push/optionVote';
import { eventVote, optionNumbers } from '../eventVote';

describe('event vote kit', () => {
  it('matches the catalog (ids, order, no app-opening vote buttons)', () => {
    expect(eventVote.problems).toEqual([]);
  });

  it('2 and 3 times get the numbered sets; 1 and 4+ get none', () => {
    expect(eventVote.categoryFor(2)).toBe('event_vote_pick2');
    expect(eventVote.categoryFor(3)).toBe('event_vote_pick3');
    expect(eventVote.categoryFor(1)).toBeNull();
    expect(eventVote.categoryFor(4)).toBeNull();
  });

  it('parses presses into slot indexes', () => {
    expect(eventVote.parse('event_vote_2')).toEqual([1]);
    expect(eventVote.indexes(eventVote.parse('event_vote_all')!, 2)).toEqual([0, 1]);
    expect(eventVote.parse('event_decline')).toBeNull();
  });

  it('reads the option data send-push puts on the push', () => {
    const data = { optionIds: ['s1', 's2'], optionLabels: ['Sat Oct 18, 9 AM', 'Sun Oct 19, 10 AM'] };
    expect(readOptionVoteData(data)).toEqual({ ids: ['s1', 's2'], labels: data.optionLabels, count: 2 });
  });

  it('the confirmation re-offers the same set until every time is picked', () => {
    const labels = ['Sat Oct 18, 9 AM', 'Sat Oct 18, 2 PM', 'Sun Oct 19, 10 AM'];
    const one = optionVoteNotice(eventVote, { pick: [1], labels });
    expect(one.categoryId).toBe('event_vote_pick3');
    expect(one.body).toContain('2) Sat Oct 18, 2 PM ✓');
    const both = optionVoteNotice(eventVote, { pick: 'all', labels: labels.slice(0, 2) });
    expect(both.categoryId).toBeUndefined();
    expect(optionVoteNotice(eventVote, { pick: [0], labels, status: 'already' }).title).toBe('Already counted');
  });
});

describe('optionNumbers', () => {
  it('numbers slots by start time, ties by id (the push body order)', () => {
    const n = optionNumbers([
      { id: 'b', starts_at: '2026-10-19T17:00:00Z' },
      { id: 'z', starts_at: '2026-10-18T16:00:00Z' },
      { id: 'a', starts_at: '2026-10-18T16:00:00Z' },
    ]);
    expect([...n.entries()]).toEqual([['a', 1], ['z', 2], ['b', 3]]);
  });
});
