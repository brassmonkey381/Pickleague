import { describe, it, expect } from 'vitest';
import {
  isJoinedResult,
  isRequestOutstanding,
  parseRequestJoinResult,
  requestJoinCopy,
  requestSentMessage,
  shortDate,
} from '../leagueJoinResult';

describe('parseRequestJoinResult', () => {
  it('reads the plain results', () => {
    for (const k of ['sent', 'pending', 'joined', 'member'] as const) {
      expect(parseRequestJoinResult(k)).toEqual({ kind: k });
    }
  });

  it('reads a denial with its retry time', () => {
    const r = parseRequestJoinResult('denied:2026-10-21T18:00:00Z');
    expect(r?.kind).toBe('denied');
    expect(r && r.kind === 'denied' && r.retryAt?.toISOString()).toBe('2026-10-21T18:00:00.000Z');
  });

  it('a denial without a usable time still parses', () => {
    expect(parseRequestJoinResult('denied')).toEqual({ kind: 'denied', retryAt: null });
    expect(parseRequestJoinResult('denied:nope')).toEqual({ kind: 'denied', retryAt: null });
  });

  it('anything else is null', () => {
    expect(parseRequestJoinResult(null)).toBeNull();
    expect(parseRequestJoinResult(42)).toBeNull();
    expect(parseRequestJoinResult('approved')).toBeNull();
  });
});

describe('requestJoinCopy', () => {
  it("'sent' is the request-sent copy", () => {
    expect(requestJoinCopy({ kind: 'sent' }, 'Dinks')).toEqual({ tone: 'success', message: requestSentMessage('Dinks') });
  });

  it("'pending' says it's already with the admins", () => {
    expect(requestJoinCopy({ kind: 'pending' }, 'Dinks')).toEqual({
      tone: 'success',
      message: 'Your request is already with the admins.',
    });
  });

  it("'member' says you're already in", () => {
    expect(requestJoinCopy({ kind: 'member' }, 'Dinks').message).toBe("You're already in this league.");
  });

  it("'joined' reads as a join", () => {
    const c = requestJoinCopy({ kind: 'joined' }, 'Dinks');
    expect(c.tone).toBe('success');
    expect(c.message).toContain('Dinks');
  });

  it("'denied' names the moment you may ask again, on the device clock", () => {
    const retryAt = new Date(2026, 9, 21, 18, 30, 0); // local 6:30 PM, Wed Oct 21
    expect(requestJoinCopy({ kind: 'denied', retryAt }, 'Dinks')).toEqual({
      tone: 'error',
      message: 'An admin declined your request. You can ask again from Wed Oct 21, 6:30 PM.',
    });
    expect(requestJoinCopy({ kind: 'denied', retryAt: null }, 'Dinks').message).toBe('An admin declined your request.');
  });
});

describe('result predicates', () => {
  it('sent / pending are outstanding; joined / member are in', () => {
    expect(isRequestOutstanding({ kind: 'sent' })).toBe(true);
    expect(isRequestOutstanding({ kind: 'pending' })).toBe(true);
    expect(isRequestOutstanding({ kind: 'denied', retryAt: null })).toBe(false);
    expect(isJoinedResult({ kind: 'joined' })).toBe(true);
    expect(isJoinedResult({ kind: 'member' })).toBe(true);
    expect(isJoinedResult({ kind: 'sent' })).toBe(false);
  });

  it('shortDate is month + day in the device zone', () => {
    expect(shortDate(new Date(2026, 0, 5, 9))).toBe('Jan 5');
  });
});
