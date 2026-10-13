// The vote buttons' notices name the event (foundation 1.39.0 `subject`).
// notificationActions.ts can't load under vitest (Supabase + RN), so this pins
// the two halves it joins: pushSubject() reads the event out of the vote push's
// title, and the foundation's optionVoteNotice puts it in the title.
import { describe, it, expect } from 'vitest';
import { optionVoteNotice, noticeTitleWith } from '@just-messin-around/expo-foundation/push/optionVote';
import { eventVote } from '../eventVote';
import { pushSubject } from '../pushSubject';

const labels = ['Sat Oct 18, 9 AM', 'Sun Oct 19, 10 AM'];

describe('vote notices name the event', () => {
  it('a vote push title yields the event as the subject', () => {
    expect(pushSubject('🗳️ New vote: Thu play day')).toBe('Thu play day');
    expect(pushSubject('Vote closing soon: Thu play day')).toBe('Thu play day');
  });

  it('"Voted 1st" / "Already counted" carry the subject', () => {
    const subject = pushSubject('🗳️ New vote: Thu play day');
    const voted = optionVoteNotice(eventVote, { pick: [0], labels, subject });
    expect(voted.title).toContain('Thu play day');
    expect(voted.title.startsWith('Voted')).toBe(true);
    const already = optionVoteNotice(eventVote, { pick: [0], labels, status: 'already', subject });
    expect(already.title).toBe('Already counted: Thu play day');
  });

  it('an unknown title shape keeps the generic titles (1.38 behaviour)', () => {
    const subject = pushSubject('Something else entirely');
    expect(subject).toBeNull();
    expect(optionVoteNotice(eventVote, { pick: [0], labels, status: 'already', subject }).title).toBe('Already counted');
  });

  it('timed-out / failure titles get the same suffix', () => {
    expect(noticeTitleWith("That didn't save", 'Thu play day')).toBe("That didn't save: Thu play day");
  });
});
