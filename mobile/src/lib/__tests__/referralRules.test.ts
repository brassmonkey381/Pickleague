import { describe, it, expect } from 'vitest';
import { getStateFromPath } from '@react-navigation/core';
// The kit's pure module, by path: the /referrals barrel also carries the UI.
import {
  inviteLink,
  normalizeReferralCode,
  referralCodeFromUrl,
} from '../../../node_modules/@just-messin-around/expo-foundation/src/referrals/codes';
import { parseStashedReferral } from '../../../node_modules/@just-messin-around/expo-foundation/src/referrals/stash';
import {
  INVITE_ORIGIN,
  INVITE_SHARE_MESSAGE,
  REFERRAL_REWARD_PICKLES,
  claimRainPickles,
  claimToastText,
  keepReferralForLater,
  nextMilestoneText,
  parseReferralStats,
} from '../referralRules';
import { REFERRALS_ENABLED } from '../features';
import { linking } from '../../navigation/linking';

describe('Pickleague invite links', () => {
  it('a code survives the round trip through its own link', () => {
    for (const code of ['a1b2c3d4e5', 'ABCDEF1234', 'x_y-z']) {
      const url = inviteLink(INVITE_ORIGIN, code);
      expect(url).toBe(`https://www.pickleague.club/invite/${code}`);
      expect(referralCodeFromUrl(url)).toBe(code);
    }
  });

  it('reads every link shape the app can be opened with', () => {
    expect(referralCodeFromUrl('https://pickleague.club/invite/abc123')).toBe('abc123');
    expect(referralCodeFromUrl('pickleague://invite/abc123')).toBe('abc123');
    expect(referralCodeFromUrl('https://www.pickleague.club/leagues/l1?ref=abc123')).toBe('abc123');
    expect(referralCodeFromUrl('https://www.pickleague.club/?utm_source=qr&ref=abc123#x')).toBe('abc123');
    expect(referralCodeFromUrl('https://www.pickleague.club/g/token123')).toBeNull();
    expect(referralCodeFromUrl('https://www.pickleague.club/invite/<script>')).toBeNull();
  });

  it('the register field accepts what the server does (1-64 of [A-Za-z0-9_-])', () => {
    expect(normalizeReferralCode(' a1b2c3d4e5 ')).toBe('a1b2c3d4e5');
    expect(normalizeReferralCode('a1b2 c3')).toBeNull();
    expect(normalizeReferralCode('x'.repeat(65))).toBeNull();
  });

  it('a stashed code reads back (JSON, or a bare legacy string)', () => {
    expect(parseStashedReferral(JSON.stringify({ code: 'abc', at: 5 }))).toEqual({ code: 'abc', at: 5 });
    expect(parseStashedReferral('abc')).toEqual({ code: 'abc', at: null });
    expect(parseStashedReferral('{"code":"bad code"}')).toBeNull();
    expect(parseStashedReferral(null)).toBeNull();
  });

  it('/invite/CODE resolves to InviteLanding only while the flag is on', () => {
    const s = getStateFromPath('invite/abc123', linking.config);
    const last = s?.routes[s.routes.length - 1];
    if (REFERRALS_ENABLED) {
      expect(last?.name).toBe('InviteLanding');
      expect(last?.params).toEqual({ code: 'abc123' });
    } else {
      expect(last?.name).not.toBe('InviteLanding');
    }
  });
});

describe('referral copy and rules', () => {
  it('share message is the agreed copy', () => {
    expect(INVITE_SHARE_MESSAGE).toBe('Join me on Pickleague — sign up with my link and we both get 2500 pickles');
    expect(REFERRAL_REWARD_PICKLES).toBe(2500);
  });

  it('claim toast: rewarded, pending confirmation, or silent', () => {
    expect(claimToastText({ linked: true, referrer_name: 'Alice', rewarded: false })).toBe(
      'Referred by Alice — confirm your email to get 2500 pickles',
    );
    expect(claimToastText({ linked: true, referrer_name: 'Alice', rewarded: true })).toBe(
      'Referred by Alice — you both got 2500 pickles!',
    );
    expect(claimToastText({ linked: true, referrer_name: ' ', rewarded: false })).toBe(
      'Referred by a friend — confirm your email to get 2500 pickles',
    );
    expect(claimToastText({ linked: false, reason: 'self' })).toBeNull();
    expect(claimToastText(null)).toBeNull();
  });

  it('only a guest refusal keeps the code for later', () => {
    expect(keepReferralForLater({ linked: false, reason: 'guest' })).toBe(true);
    for (const reason of ['self', 'already_referred', 'too_old', 'unknown_code', 'no_code']) {
      expect(keepReferralForLater({ linked: false, reason })).toBe(false);
    }
    expect(keepReferralForLater({ linked: true })).toBe(false);
  });

  it('next milestone line', () => {
    expect(nextMilestoneText(0)).toBe('5 more friends to the Squad Builder badge and +2500 bonus pickles');
    expect(nextMilestoneText(4)).toBe('1 more friend to the Squad Builder badge and +2500 bonus pickles');
    expect(nextMilestoneText(5)).toBe('5 more friends to the Club Builder badge and +5000 bonus pickles');
    expect(nextMilestoneText(10)).toBeNull();
  });

  it('stats parse defensively', () => {
    expect(parseReferralStats({ invited: 3, joined: 2, pending: 1, pickles_earned: 5000 })).toEqual({
      invited: 3, joined: 2, pending: 1, pickles_earned: 5000,
    });
    expect(parseReferralStats(null)).toEqual({ invited: 0, joined: 0, pending: 0, pickles_earned: 0 });
    expect(parseReferralStats({ invited: '4' }).invited).toBe(4);
  });
});

describe('claimRainPickles', () => {
  it('rains only for a claim that paid just now', () => {
    expect(claimRainPickles({ linked: true, rewarded: true })).toBe(REFERRAL_REWARD_PICKLES);
    expect(claimRainPickles({ linked: true, rewarded: true, already: true })).toBe(0);
    expect(claimRainPickles({ linked: true, rewarded: false })).toBe(0);
    expect(claimRainPickles({ linked: false, rewarded: true })).toBe(0);
    expect(claimRainPickles(null)).toBe(0);
  });
});
