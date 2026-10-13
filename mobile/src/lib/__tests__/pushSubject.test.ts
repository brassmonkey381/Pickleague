import { describe, it, expect } from 'vitest';
import { NOTICE_TITLE_MAX, pushSubject, titleWith, truncate } from '../pushSubject';

describe('pushSubject', () => {
  it('reads the name out of the labelled titles the generators write', () => {
    expect(pushSubject('🗳️ New vote: Saturday Ladder Social')).toBe('Saturday Ladder Social');
    expect(pushSubject('🗳️ Vote closing soon: Pickleball Reunion')).toBe('Pickleball Reunion');
    expect(pushSubject('📣 Voting closes soon: Sean and Brian pickle')).toBe('Sean and Brian pickle');
    expect(pushSubject('📅 Event scheduled: Wednesday Night Doubles RR')).toBe('Wednesday Night Doubles RR');
    expect(pushSubject('📅 Event reminder: Saturday Ladder Social')).toBe('Saturday Ladder Social');
    expect(pushSubject('❌ Event cancelled: Pickleball RR')).toBe('Pickleball RR');
    expect(pushSubject('🏆 New tournament: Summer Smash MLP')).toBe('Summer Smash MLP');
    expect(pushSubject('🏆 Tournament starting soon: Summer Smash MLP')).toBe('Summer Smash MLP');
    expect(pushSubject('⏳ Registration closing soon: Fall Classic')).toBe('Fall Classic');
    expect(pushSubject('🎟️ Tournament invite: Fall Classic')).toBe('Fall Classic');
    expect(pushSubject('🎟️ Invite: The League')).toBe('The League');
    expect(pushSubject('🙋 Join request: The League')).toBe('The League');
  });

  it('reads trailing and bracket shapes', () => {
    expect(pushSubject('📣 [SIM] Friday Night Round Robin is today')).toBe('[SIM] Friday Night Round Robin');
    expect(pushSubject('📣 Pickleball Reunion is tomorrow')).toBe('Pickleball Reunion');
    expect(pushSubject('🏆 Bracket Set — HUB Men’s 4.5 League')).toBe('HUB Men’s 4.5 League');
  });

  it('reads the other player out of drill titles', () => {
    expect(pushSubject('🥒 Sam Himmelstein wants to drill')).toBe('Sam Himmelstein');
    expect(pushSubject('💬 Sam Himmelstein replied')).toBe('Sam Himmelstein');
    expect(pushSubject('✅ Sam Himmelstein accepted!')).toBe('Sam Himmelstein');
    expect(pushSubject('🥒 Sam is on the way')).toBe('Sam');
    expect(pushSubject("🥒 Sam can't make it")).toBe('Sam');
  });

  it('gives null for the generators\' no-name fallbacks', () => {
    expect(pushSubject('🥒 Someone wants to drill')).toBeNull();
    expect(pushSubject('🥒 Your partner is on the way')).toBeNull();
    expect(pushSubject('Your drill partner declined')).toBeNull();
    expect(pushSubject('Invite accepted')).toBeNull();
    expect(pushSubject('Invite declined')).toBeNull();
  });

  it('gives null for titles that name nothing', () => {
    expect(pushSubject('🥒 Match needs your team to confirm')).toBeNull();
    expect(pushSubject('📝 How did it go? Record your results')).toBeNull();
    expect(pushSubject('🥒 Drill session coming up')).toBeNull();
    expect(pushSubject('🥒 Pot refunded')).toBeNull();
  });

  it('handles missing, empty and odd input', () => {
    expect(pushSubject(undefined)).toBeNull();
    expect(pushSubject(null)).toBeNull();
    expect(pushSubject(42)).toBeNull();
    expect(pushSubject('')).toBeNull();
    expect(pushSubject('   ')).toBeNull();
    expect(pushSubject('🗳️')).toBeNull();
    expect(pushSubject('🗳️ New vote: ')).toBeNull();
  });

  it('tolerates emoji variants and extra whitespace', () => {
    expect(pushSubject('🗳 New vote: Tuesday Doubles')).toBe('Tuesday Doubles'); // no variation selector
    expect(pushSubject('New vote: Tuesday Doubles')).toBe('Tuesday Doubles'); // no emoji
    expect(pushSubject('👨‍👩‍👧 New vote:   Tuesday   Doubles  ')).toBe('Tuesday Doubles'); // ZWJ sequence
    expect(pushSubject('✅  Sam accepted!')).toBe('Sam');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('Tuesday Doubles', 20)).toBe('Tuesday Doubles');
  });
  it('cuts with an ellipsis within the limit', () => {
    const out = truncate('Organized Pickle Play Activities Pool Play', 20);
    expect(Array.from(out).length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });
  it('never splits an emoji', () => {
    expect(truncate('ab😀😀😀', 4)).toBe('ab😀…');
  });
});

describe('titleWith', () => {
  it('appends the subject', () => {
    expect(titleWith("You're in", 'Tuesday Doubles')).toBe("You're in: Tuesday Doubles");
  });
  it('falls back to the prefix with no subject', () => {
    expect(titleWith("You're in", null)).toBe("You're in");
    expect(titleWith("You're in", undefined)).toBe("You're in");
    expect(titleWith("You're in", '  ')).toBe("You're in");
  });
  it('truncates an overlong subject to fit the title limit', () => {
    const out = titleWith("Can't make it", 'Organized Pickle Play Activities Pool Play, Doubles');
    expect(Array.from(out).length).toBeLessThanOrEqual(NOTICE_TITLE_MAX);
    expect(out.startsWith("Can't make it: Organized")).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });
  it('drops the subject when the prefix leaves no room', () => {
    expect(titleWith('A very long prefix that fills the line', 'Tuesday')).toBe('A very long prefix that fills the line');
  });
});
