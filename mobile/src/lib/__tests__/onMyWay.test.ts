import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ETA_MINUTES,
  ETA_OPTIONS,
  MAX_RECIPIENTS,
  agoLabel,
  defaultRecipients,
  etaLabel,
  normalizeOnMyWayResult,
  onMyWayMessage,
  parseStoredEta,
  sendBlockedReason,
  sendLabel,
  sentRecently,
  sortRecipients,
  validEta,
  windowStartMs,
  type OnMyWayFriend,
  type OnMyWayResult,
} from '../onMyWay';
import { REFUSAL_CODES } from '../refusals';
import { linkOf, pushRoutes } from '../pushLinks';

const T0 = Date.parse('2026-10-24T18:00:00.000Z');
const label = (d: Date) => d.toISOString().slice(11, 16);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const readRepo = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('ETA', () => {
  it('chips 5-60 with 15 the default', () => {
    expect([...ETA_OPTIONS]).toEqual([5, 10, 15, 20, 30, 45, 60]);
    expect(DEFAULT_ETA_MINUTES).toBe(15);
    expect(ETA_OPTIONS).toContain(DEFAULT_ETA_MINUTES);
  });

  it('labels like the server: min, hr, hr + min', () => {
    expect(etaLabel(5)).toBe('5 min');
    expect(etaLabel(15)).toBe('15 min');
    expect(etaLabel(60)).toBe('1 hr');
    expect(etaLabel(90)).toBe('1 hr 30 min');
    expect(etaLabel(120)).toBe('2 hr');
  });

  it('a remembered ETA falls back to 15 when missing, garbled or out of range', () => {
    expect(parseStoredEta('20')).toBe(20);
    expect(parseStoredEta(' 45 ')).toBe(45);
    expect(parseStoredEta(null)).toBe(15);
    expect(parseStoredEta(undefined)).toBe(15);
    expect(parseStoredEta('')).toBe(15);
    expect(parseStoredEta('abc')).toBe(15);
    expect(parseStoredEta('0')).toBe(15);
    expect(parseStoredEta('181')).toBe(15);
    expect(parseStoredEta('12.5')).toBe(15);
  });

  it('valid: whole minutes 1..180 (the server range)', () => {
    expect(validEta(1)).toBe(true);
    expect(validEta(180)).toBe(true);
    expect(validEta(0)).toBe(false);
    expect(validEta(181)).toBe(false);
    expect(validEta(2.5)).toBe(false);
    expect(validEta('15')).toBe(false);
  });
});

describe('the server answer', () => {
  it('normalizes a send', () => {
    const r = normalizeOnMyWayResult(
      { sent: true, count: 3, skipped_recent: 1, eta_minutes: 20, venue_id: 'v1', venue_name: 'Lakeside', sent_at: '2026-10-24T18:00:00Z' },
      20,
    );
    expect(r).toMatchObject({ sent: true, count: 3, skippedRecent: 1, reason: null, etaMinutes: 20, venueId: 'v1', venueName: 'Lakeside' });
  });

  it('an unknown "not sent" reads as nobody; the ETA sent stands in for a missing one', () => {
    const r = normalizeOnMyWayResult({ sent: false, reason: 'mystery' }, 30);
    expect(r.reason).toBe('nobody');
    expect(r.etaMinutes).toBe(30);
    expect(normalizeOnMyWayResult(null, 15)).toMatchObject({ sent: false, reason: 'nobody', count: 0 });
  });
});

describe('messages say why and what to do', () => {
  const ctx = { venueName: 'Lakeside', nowMs: T0, timeLabel: label };
  const base = normalizeOnMyWayResult({}, 15);

  it('sent: who, how far, where', () => {
    expect(onMyWayMessage({ ...base, sent: true, reason: null, count: 1 }, ctx)).toBe(
      "Told 1 friend you're about 15 min from Lakeside.",
    );
    expect(onMyWayMessage({ ...base, sent: true, reason: null, count: 3, etaMinutes: 60 }, ctx)).toBe(
      "Told 3 friends you're about 1 hr from Lakeside.",
    );
  });

  it('sent, some skipped as told recently', () => {
    expect(onMyWayMessage({ ...base, sent: true, reason: null, count: 2, skippedRecent: 1 }, ctx)).toBe(
      "Told 2 friends you're about 15 min from Lakeside. 1 friend you told in the last 30 minutes wasn't told again.",
    );
  });

  it('recent: when, and when it can go again', () => {
    const r = {
      ...base,
      reason: 'recent' as const,
      sentAt: new Date(T0 - 8 * 60_000).toISOString(),
      retryAt: new Date(T0 + 22 * 60_000).toISOString(),
    };
    expect(onMyWayMessage(r, ctx)).toBe(
      "You already told your friends you're on the way to Lakeside 8 min ago, so nobody was told again. You can send another after 18:22.",
    );
  });

  it('recent_friends: pick others or wait', () => {
    const r = { ...base, reason: 'recent_friends' as const, retryAt: new Date(T0 + 20 * 60_000).toISOString() };
    expect(onMyWayMessage(r, ctx)).toBe(
      "You told those friends you were on the way less than 30 minutes ago, so they weren't told again. Pick other friends, or try again after 18:20.",
    );
  });

  it('nobody: picked vs the all-friends default', () => {
    expect(onMyWayMessage({ ...base, reason: 'nobody' }, ctx)).toMatch(/no longer on your friends list\. Pick other friends\.$/);
    expect(onMyWayMessage({ ...base, reason: 'nobody' }, { ...ctx, picked: false })).toBe(
      "You don't have any friends to tell yet. Add friends from a player's profile, then try again.",
    );
  });

  it('recent_friends with the default: "your friends", never "close friends"', () => {
    const r = { ...base, reason: 'recent_friends' as const, retryAt: null };
    expect(onMyWayMessage(r, { ...ctx, picked: false })).toMatch(/^You told your friends you were on the way/);
  });

  it('the server court name wins (an alias opens its facility)', () => {
    expect(onMyWayMessage({ ...base, sent: true, reason: null, count: 1, venueName: 'Lakeside Park' }, ctx)).toContain('Lakeside Park');
  });

  it('ago labels', () => {
    expect(agoLabel(new Date(T0 - 20_000).toISOString(), T0)).toBe('just now');
    expect(agoLabel(new Date(T0 - 60 * 60_000).toISOString(), T0)).toBe('1 hr ago');
    expect(agoLabel(null, T0)).toBeNull();
    expect(agoLabel('nope', T0)).toBeNull();
  });
});

describe('recipients', () => {
  const f = (userId: string, name: string, isCloseFriend = false, note: string | null = null): OnMyWayFriend => ({
    userId,
    name,
    isCloseFriend,
    note,
  });
  const friends = [f('c', 'Cal'), f('b', 'Ben', true), f('a', 'Ann', false, 'Here now'), f('d', 'Dee', true, 'Playing now')];

  it('every friend starts ticked, in list order', () => {
    expect(defaultRecipients(friends)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('no close friends and nobody at the court: still everyone, so one tap sends', () => {
    const plain = [f('x', 'Xan'), f('y', 'Yul')];
    expect(defaultRecipients(plain)).toEqual(['x', 'y']);
    expect(sendBlockedReason(defaultRecipients(plain).length)).toBeNull();
  });

  it('never more than the server cap: the ones left out are last in the list', () => {
    const many = [
      ...Array.from({ length: 60 }, (_, i) => f(`p${i}`, `P${String(i).padStart(2, '0')}`)),
      ...Array.from({ length: 5 }, (_, i) => f(`s${i}`, `Z${i}`, true)),
    ];
    const ticked = defaultRecipients(many);
    expect(ticked).toHaveLength(MAX_RECIPIENTS);
    expect(ticked.slice(0, 5)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(ticked).not.toContain('p59');
  });

  it('the list: at the court, close friends, then by name', () => {
    expect(sortRecipients(friends).map((x) => x.name)).toEqual(['Ann', 'Dee', 'Ben', 'Cal']);
  });

  it('the button and why it is off', () => {
    expect(sendLabel(0, 15)).toBe('Pick friends to tell');
    expect(sendLabel(1, 15)).toBe('Tell 1 friend · about 15 min');
    expect(sendLabel(3, 60)).toBe('Tell 3 friends · about 1 hr');
    expect(sendBlockedReason(0)).toBe('Pick at least one friend to tell.');
    expect(sendBlockedReason(3)).toBeNull();
    expect(sendBlockedReason(52)).toBe('You can tell up to 50 friends at once. Untick 2 to send.');
  });

  it("the pill's window: a send starts it now, a 'recent' refusal keeps the server's last send", () => {
    const res: OnMyWayResult = {
      sent: false,
      count: 0,
      skippedRecent: 0,
      reason: null,
      etaMinutes: 15,
      venueId: 'v',
      venueName: 'V',
      sentAt: null,
      retryAt: null,
    };
    expect(windowStartMs({ ...res, sent: true }, T0)).toBe(T0);
    const recent = { ...res, reason: 'recent' as const, sentAt: new Date(T0 - 25 * 60_000).toISOString() };
    expect(windowStartMs(recent, T0)).toBe(T0 - 25 * 60_000);
    // So the pill ends with the server's window (5 minutes on), not 30 after the re-tap.
    expect(sentRecently(windowStartMs(recent, T0)!, T0 + 5 * 60_000)).toBe(false);
    // A server clock ahead of the phone never stamps the future; no sent_at reads as now.
    expect(windowStartMs({ ...recent, sentAt: new Date(T0 + 60_000).toISOString() }, T0)).toBe(T0);
    expect(windowStartMs({ ...recent, sentAt: null }, T0)).toBe(T0);
    expect(windowStartMs({ ...res, reason: 'recent_friends' }, T0)).toBeNull();
    expect(windowStartMs({ ...res, reason: 'nobody' }, T0)).toBeNull();
  });

  it('the feed pill: told friends for 30 minutes', () => {
    expect(sentRecently(undefined, T0)).toBe(false);
    expect(sentRecently(T0, T0 + 29 * 60_000)).toBe(true);
    expect(sentRecently(T0, T0 + 30 * 60_000)).toBe(false);
    // The feed's minute clock may read just before the send.
    expect(sentRecently(T0, T0 - 30_000)).toBe(true);
  });
});

describe('the push tap opens the court', () => {
  it("'court/<id>' opens CourtDetail, a slash in the id included", () => {
    const routes = pushRoutes({ wagersEnabled: false, courtsEnabled: true });
    expect(routes['court/']('ven-1', '')).toEqual(['CourtDetail', { venueId: 'ven-1' }]);
    expect(routes['court/']('osm:way', '123')).toEqual(['CourtDetail', { venueId: 'osm:way/123' }]);
    expect(routes['court/']('-', '')).toBeNull();
  });

  it("the push's home/- link plus kind on_my_way + venue_id opens the court in this build", () => {
    expect(linkOf({ deepLink: 'home/-', kind: 'on_my_way', venue_id: 'osm:way/123' })).toBe('court/osm:way/123');
    expect(linkOf({ kind: 'on_my_way', venue_id: 'ven-1' })).toBe('court/ven-1');
    // Without a venue it stays Home; other home/- pushes are untouched.
    expect(linkOf({ deepLink: 'home/-', kind: 'on_my_way' })).toBe('home/-');
    expect(linkOf({ deepLink: 'home/-', kind: 'checkin_prompt', venue_id: 'ven-1' })).toBe('home/-');
  });

  it('without the court pages: Home, where the court cards are', () => {
    const routes = pushRoutes({ wagersEnabled: false });
    expect(routes['court/']('ven-1', '')).toEqual(['Home']);
  });
});

describe('the server and the app agree', () => {
  const sql = readRepo('supabase/migration_on_my_way.sql');

  it('every pl: code the migration raises has app copy', () => {
    const codes = [...sql.matchAll(/hint = 'pl:([a-z_.]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(0);
    for (const c of codes) expect(REFUSAL_CODES as readonly string[]).toContain(c);
  });

  it('the push category is a known pref key, on by default', () => {
    expect(sql).toContain("'notifyFriendsOnTheWay'");
    expect(readRepo('supabase/functions/send-push/index.ts')).toContain("'notifyFriendsOnTheWay'");
    // lib/userPreferences imports react-native, so read its defaults as text.
    expect(readRepo('mobile/src/lib/userPreferences.ts')).toMatch(/notifyFriendsOnTheWay:\s+true,/);
  });

  it('the RPC is on the hardening allowlist and its link is routed', () => {
    expect(readRepo('supabase/migration_rls_hardening_2026q3.sql')).toContain("'send_on_my_way'");
    // home/- for older bundles; linkOf turns it into court/<venue> in this one.
    expect(sql).toContain("'notifyFriendsOnTheWay', v_title, v_body, 'home/-'");
    expect(sql).toContain("'kind', 'on_my_way', 'venue_id', v_venue");
    expect(readRepo('supabase/functions/send-push/index.ts')).toMatch(/PASS_KEYS = \[[^\]]*'kind'[^\]]*'venue_id'/);
  });

  it('the server range matches the app', () => {
    expect(sql).toMatch(/v_eta < 1 or v_eta > 180/);
    expect(sql).toMatch(/coalesce\(p_eta_minutes, 15\)/);
    expect(sql).toMatch(/> 50 then/);
  });
});
