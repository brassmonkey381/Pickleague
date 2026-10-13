import { describe, it, expect } from 'vitest';
import { buildAgenda, needsYouCount } from '../agenda';
import {
  EMPTY_INBOX,
  NOTIFICATION_CHIPS,
  chipServerFilter,
  drillRequestItems,
  firstName,
  groupByDay,
  inboxAgendaItems,
  isRequestNotification,
  joinRequestItems,
  matchConfirmItems,
  matchesNotificationChip,
  missingTargetIds,
  notificationDayLabel,
  notificationTime,
  proposedSlotStarts,
  targetLookups,
  teamInviteItems,
  type MatchConfirmRow,
  type TeamInviteRow,
  type NotificationLite,
} from '../inboxRequests';

// A Tuesday afternoon in the device zone (same anchor as agenda.test.ts).
const NOW = new Date(2026, 9, 13, 14, 0, 0).getTime();
const H = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const ME = 'me';

function match(over: Partial<MatchConfirmRow> & { id: string }): MatchConfirmRow {
  return {
    status: 'pending',
    match_type: 'singles',
    player1_id: 'sam',
    partner1_id: null,
    player2_id: ME,
    partner2_id: null,
    player1_score: 11,
    player2_score: 7,
    team1_confirmed_by: 'sam',
    team2_confirmed_by: null,
    confirm_deadline: iso(45 * 60_000),
    created_at: iso(-15 * 60_000),
    league: { name: 'Dinks' },
    player1: { full_name: 'Sam Kim' },
    player2: { full_name: 'Me Myself' },
    ...over,
  };
}

describe('firstName', () => {
  it('takes the first word, or null', () => {
    expect(firstName('Sam Kim')).toBe('Sam');
    expect(firstName('  Ana  ')).toBe('Ana');
    expect(firstName('')).toBeNull();
    expect(firstName(null)).toBeNull();
  });
});

describe('matchConfirmItems', () => {
  it('a score my team still has to confirm: my score first, opponents named, opens MatchHistory at it', () => {
    const [m] = matchConfirmItems([match({ id: 'm1' })], ME, NOW);
    expect(m.title).toBe('Confirm 7–11 vs Sam');
    expect(m.kind).toBe('match_confirm');
    expect(m.leagueName).toBe('Dinks');
    expect(m.needsYou).toBe(true);
    expect(m.startsAt).toBeNull();
    expect(m.deadline).toBe(iso(45 * 60_000));
    // Never confirmed inline: the button only opens the screen at the match.
    expect(m.action).toMatchObject({ label: 'Review', slug: 'confirm_match' });
    expect(m.target).toEqual({
      screen: 'MatchHistory',
      params: { title: 'Match History', initialMyMatchesOnly: true, highlightMatchId: 'm1' },
    });
  });

  it('doubles: names both opponents; team 1 sees its own score first', () => {
    const [m] = matchConfirmItems([match({
      id: 'd',
      match_type: 'doubles',
      player1_id: ME,
      partner1_id: 'pat',
      player2_id: 'sam',
      partner2_id: 'kim',
      team1_confirmed_by: null,
      team2_confirmed_by: 'sam',
      player2: { full_name: 'Sam A' },
      partner2: [{ full_name: 'Kim B' }],
    })], ME, NOW);
    expect(m.title).toBe('Confirm 11–7 vs Sam & Kim');
  });

  it('skips: my team already confirmed, not my match, expired window, no longer pending', () => {
    const items = matchConfirmItems([
      match({ id: 'done', team2_confirmed_by: ME }),
      match({ id: 'other', player2_id: 'zed' }),
      match({ id: 'expired', confirm_deadline: iso(-60_000) }),
      match({ id: 'completed', status: 'completed' }),
      match({ id: 'ok' }),
    ], ME, NOW);
    expect(items.map((i) => i.key)).toEqual(['confirm-ok']);
  });

  it('no scores reads "Confirm match"; a null deadline still counts', () => {
    const [m] = matchConfirmItems([match({ id: 'x', player1_score: null, confirm_deadline: null, player1: null })], ME, NOW);
    expect(m.title).toBe('Confirm match');
    expect(m.deadline).toBeNull();
  });
});

describe('drillRequestItems', () => {
  // Thu Oct 15 2026: slot 36 = 6 PM, slot 0 = midnight.
  const slots = [{ date: '2026-10-15', slot: 36 }, { date: '2026-10-14', slot: 20 }, { date: '2026-10-12', slot: 20 }];

  it('proposedSlotStarts: device-zone times, sorted; malformed entries drop out', () => {
    const starts = proposedSlotStarts([...slots, { date: 'nope', slot: 1 }, { slot: 3 }, null]);
    expect(starts).toEqual([
      new Date(2026, 9, 12, 10, 0).getTime(),
      new Date(2026, 9, 14, 10, 0).getTime(),
      new Date(2026, 9, 15, 18, 0).getTime(),
    ]);
    expect(proposedSlotStarts('x')).toEqual([]);
  });

  it('proposedSlotStarts: wall-clock times on a DST-change day (a 25-hour day)', () => {
    // US fall-back is Sun Nov 1 2026. Midnight + 36 half-hours of ms would
    // land at 5 PM wherever the zone observes DST; the slot means 6 PM.
    const [start] = proposedSlotStarts([{ date: '2026-11-01', slot: 36 }]);
    expect(new Date(start).getHours()).toBe(18);
    expect(new Date(start).getMinutes()).toBe(0);
    const [spring] = proposedSlotStarts([{ date: '2026-03-08', slot: 37 }]);
    expect(new Date(spring).getHours()).toBe(18);
    expect(new Date(spring).getMinutes()).toBe(30);
  });

  it('due at the first time still ahead; counts only the times still ahead', () => {
    const [d] = drillRequestItems([{ id: 'r1', status: 'pending', proposed_slots: slots, created_at: iso(-H), from_profile: { full_name: 'Sam Kim' } }], NOW);
    expect(d.title).toBe('Drill request from Sam');
    expect(d.deadline).toBe(new Date(2026, 9, 14, 10, 0).toISOString());
    expect(d.status).toBe('2 times offered');
    expect(d.target).toEqual({ screen: 'DrillRequests', params: { focusId: 'r1' } });
    expect(d.action).toMatchObject({ label: 'Respond', slug: 'drill_request' });
  });

  it('drops a request whose every time has passed, and non-pending ones; keeps an undated one', () => {
    const items = drillRequestItems([
      { id: 'past', status: 'pending', proposed_slots: [{ date: '2026-10-12', slot: 20 }], created_at: null },
      { id: 'answered', status: 'accepted', proposed_slots: slots, created_at: null },
      { id: 'undated', status: 'pending', proposed_slots: [], created_at: iso(-3 * H), from_profile: null },
    ], NOW);
    expect(items.map((i) => i.key)).toEqual(['drill-request-undated']);
    expect(items[0]).toMatchObject({ title: 'Drill request from a player', deadline: null, status: null, requestedAt: iso(-3 * H) });
  });
});

describe('joinRequestItems', () => {
  const leagues = [{ id: 'l1', name: 'Dinks' }, { id: 'l2', name: 'Sean Leegue' }];

  it('one row per league I run; one request names the player, several are counted', () => {
    const items = joinRequestItems([
      { id: 'a', league_id: 'l1', user_id: 'u-ana', created_at: iso(-2 * H), requester: { full_name: 'Ana Lee' } },
      { id: 'b', league_id: 'l2', user_id: 'u-bo', created_at: iso(-5 * H), requester: { full_name: 'Bo' } },
      { id: 'c', league_id: 'l2', user_id: 'u-cy', created_at: iso(-1 * H), requester: { full_name: 'Cy' } },
      { id: 'x', league_id: 'not-mine', user_id: 'u-x', created_at: iso(-H) },
    ], leagues);
    expect(items.map((i) => [i.key, i.title, i.leagueName])).toEqual([
      ['join-l1', 'Ana wants to join', 'Dinks'],
      ['join-l2', '2 join requests', 'Sean Leegue'],
    ]);
    // Ordered by the oldest request (no deadline).
    expect(items[1].requestedAt).toBe(iso(-5 * H));
    expect(items[1].target).toEqual({ screen: 'LeagueMembers', params: { leagueId: 'l2', leagueName: 'Sean Leegue' } });
    expect(items[1].action).toMatchObject({ label: 'Review', slug: 'join_request' });
  });
});

describe('teamInviteItems', () => {
  const tour = (over: Record<string, unknown> = {}) => ({
    id: 't1', name: 'Fall Open', status: 'registration',
    registration_closes_at: iso(48 * H), start_time: iso(96 * H), ...over,
  });
  const row = (id: string, over: Partial<TeamInviteRow> = {}, team: Record<string, unknown> = {}, t: Record<string, unknown> = {}): TeamInviteRow => ({
    id, status: 'pending', created_at: iso(-H),
    team: { id: `p-${id}`, name: 'Dink Dynasty', status: 'forming', tournament: tour(t), ...team },
    ...over,
  });

  it('maps a pending invite to a needs-you row that opens the tournament', () => {
    const [p] = teamInviteItems([row('a')], 'pair', NOW);
    expect(p).toMatchObject({
      key: 'pair-invite-a',
      kind: 'team_invite',
      title: 'Partner invite · Fall Open',
      needsYou: true,
      deadline: iso(48 * H),
      status: 'from Dink Dynasty',
      requestedAt: iso(-H),
    });
    expect(p.target).toEqual({ screen: 'TournamentDetail', params: { tournamentId: 't1', tournamentName: 'Fall Open' } });
    expect(p.action).toMatchObject({ label: 'Respond', slug: 'pair_invite' });
    const [team] = teamInviteItems([row('b')], 'team', NOW);
    expect(team).toMatchObject({ key: 'team-invite-b', title: 'Team invite · Fall Open' });
    expect(team.action).toMatchObject({ slug: 'team_invite' });
  });

  it('due at registration close, else the start, else undated (still answerable while forming)', () => {
    expect(teamInviteItems([row('a', {}, {}, { registration_closes_at: iso(-H) })], 'pair', NOW)[0].deadline).toBe(iso(96 * H));
    expect(teamInviteItems([row('a', {}, {}, { registration_closes_at: null, start_time: iso(-H) })], 'pair', NOW)[0].deadline).toBeNull();
  });

  it('drops answered invites, locked pairs, finished or cancelled tournaments, and broken embeds', () => {
    const items = teamInviteItems([
      row('answered', { status: 'accepted' }),
      row('locked', {}, { status: 'locked' }),
      row('done', {}, {}, { status: 'completed' }),
      row('off', {}, {}, { status: 'cancelled' }),
      { id: 'no-team', status: 'pending', created_at: null, team: null },
      row('no-tour', {}, { tournament: null }),
      // PostgREST may hand a to-one embed back as a one-element array.
      { id: 'arr', status: 'pending', created_at: null, team: [{ id: 'p', name: null, status: 'forming', tournament: [tour()] }] },
    ], 'team', NOW);
    expect(items.map((i) => [i.key, i.status])).toEqual([['team-invite-arr', 'invited']]);
  });
});

describe('inboxAgendaItems + the bell', () => {
  it('maps every kind, they all need me, and a confirm (soonest deadline) sorts first', () => {
    const items = inboxAgendaItems({
      matches: [match({ id: 'm' })],
      drills: [{ id: 'r', status: 'pending', proposed_slots: [{ date: '2026-10-15', slot: 36 }], created_at: iso(-H) }],
      joins: [{ id: 'j', league_id: 'l1', user_id: 'u-j', created_at: iso(-H) }],
    }, ME, [{ id: 'l1', name: 'Dinks' }], NOW);
    expect(items).toHaveLength(3);
    expect(needsYouCount(items, NOW)).toBe(3);
    const rows = buildAgenda(items, NOW).rows;
    expect(rows.map((r) => r.bucket)).toEqual(['needsYou', 'needsYou', 'needsYou']);
    // Deadlines first (45m, then Thursday), the undated join request last.
    expect(rows.map((r) => r.key)).toEqual(['confirm-m', 'drill-request-r', 'join-l1']);
  });

  it('pair and team invites count toward the bell too', () => {
    const t = { id: 't1', name: 'Fall Open', status: 'registration', registration_closes_at: null, start_time: iso(96 * H) };
    const items = inboxAgendaItems({
      ...EMPTY_INBOX,
      pairInvites: [{ id: 'pi', status: 'pending', created_at: iso(-H), team: { id: 'p', name: 'A', status: 'forming', tournament: t } }],
      teamInvites: [{ id: 'ti', status: 'pending', created_at: iso(-H), team: { id: 'm', name: 'B', status: 'forming', tournament: t } }],
    }, ME, [], NOW);
    expect(items.map((i) => i.key)).toEqual(['pair-invite-pi', 'team-invite-ti']);
    expect(needsYouCount(items, NOW)).toBe(2);
  });

  it('no payload, an old payload without the field, or no user: nothing', () => {
    expect(inboxAgendaItems(null, ME, [], NOW)).toEqual([]);
    expect(inboxAgendaItems({}, ME, [], NOW)).toEqual([]);
    expect(inboxAgendaItems(EMPTY_INBOX, ME, [], NOW)).toEqual([]);
    expect(inboxAgendaItems({ matches: [match({ id: 'm' })] }, null, [], NOW)).toEqual([]);
  });
});

// ── Notifications ──

const N = (over: Partial<NotificationLite> & { id: string }): NotificationLite => ({
  title: 'Hello',
  entity_type: null,
  entity_id: null,
  category: null,
  push_data: null,
  is_read: true,
  created_at: iso(-H),
  ...over,
});

describe('notification chips', () => {
  it('has the six chips, in order', () => {
    expect(NOTIFICATION_CHIPS.map((c) => c.label)).toEqual(['All', 'Requests', 'Unread', 'Leagues', 'Tournaments', 'Rewards']);
  });

  it('keys on entity_type, not type: a payout pickle notice (type tournament) is a Reward', () => {
    const pickles = { ...N({ id: 'p', entity_type: 'shop' }), type: 'tournament' };
    expect(matchesNotificationChip(pickles, 'rewards')).toBe(true);
    expect(matchesNotificationChip(pickles, 'tournaments')).toBe(false);
    for (const t of ['shop', 'shop_item', 'profile', 'plupr_history']) {
      expect(matchesNotificationChip(N({ id: t, entity_type: t }), 'rewards')).toBe(true);
    }
  });

  it('Leagues covers league and event notices; Tournaments only tournament ones', () => {
    expect(matchesNotificationChip(N({ id: 'l', entity_type: 'league' }), 'leagues')).toBe(true);
    expect(matchesNotificationChip(N({ id: 'e', entity_type: 'event' }), 'leagues')).toBe(true);
    expect(matchesNotificationChip(N({ id: 't', entity_type: 'tournament' }), 'tournaments')).toBe(true);
    expect(matchesNotificationChip(N({ id: 'm', entity_type: 'match' }), 'leagues')).toBe(false);
    expect(matchesNotificationChip(N({ id: 'm', entity_type: 'match' }), 'all')).toBe(true);
  });

  it('Unread is is_read = false', () => {
    expect(matchesNotificationChip(N({ id: 'u', is_read: false }), 'unread')).toBe(true);
    expect(matchesNotificationChip(N({ id: 'r', is_read: true }), 'unread')).toBe(false);
  });

  it('Requests: kind, category, and the legacy titles; the inviter replies are not requests', () => {
    expect(isRequestNotification(N({ id: '1', push_data: { kind: 'league_join_request' } }))).toBe(true);
    expect(isRequestNotification(N({ id: '2', push_data: { kind: 'drill_request' } }))).toBe(true);
    expect(isRequestNotification(N({ id: '3', category: 'notifyMatchConfirms' }))).toBe(true);
    expect(isRequestNotification(N({ id: '4', title: '🥒 Match needs your team to confirm' }))).toBe(true);
    expect(isRequestNotification(N({ id: '5', title: '🥒 Sam wants to drill' }))).toBe(true);
    expect(isRequestNotification(N({ id: '6', title: '🙋 Join request: Dinks' }))).toBe(true);
    expect(isRequestNotification(N({ id: '7', title: '🎟️ Tournament invite: Fall Open' }))).toBe(true);
    expect(isRequestNotification(N({ id: '8', title: 'Tournament invite' }))).toBe(true);
    expect(isRequestNotification(N({ id: '9', title: '🎟️ Invite: Dinks' }))).toBe(true);
    expect(isRequestNotification(N({ id: '10', title: 'Invite accepted' }))).toBe(false);
    expect(isRequestNotification(N({ id: '11', title: 'Invite declined' }))).toBe(false);
    // Replies with the word anywhere in the title, not only at the start.
    expect(isRequestNotification(N({ id: '11b', title: 'Partner invite accepted' }))).toBe(false);
    expect(isRequestNotification(N({ id: '11c', title: 'Join request accepted' }))).toBe(false);
    // ...while the real requests those generators send still match.
    expect(isRequestNotification(N({ id: '11d', title: 'Doubles partner invite' }))).toBe(true);
    expect(isRequestNotification(N({ id: '11e', title: 'MLP team invite' }))).toBe(true);
    expect(isRequestNotification(N({ id: '12', title: '🏆 New tournament: Fall Open', push_data: { kind: 'new_tournament' } }))).toBe(false);
    expect(isRequestNotification(N({ id: '13', title: '🥒 +50 pickles for earning X!' }))).toBe(false);
  });

  it('server filters: none / eq / in, and an or() over the request rules with quoted values', () => {
    expect(chipServerFilter('all')).toEqual({ kind: 'none' });
    expect(chipServerFilter('unread')).toEqual({ kind: 'eq', column: 'is_read', value: false });
    expect(chipServerFilter('rewards')).toEqual({ kind: 'in', column: 'entity_type', values: ['shop', 'shop_item', 'profile', 'plupr_history'] });
    const f = chipServerFilter('requests');
    expect(f.kind).toBe('or');
    if (f.kind !== 'or') return;
    expect(f.filter).toContain('push_data->>kind.in.(league_join_request,drill_request)');
    expect(f.filter).toContain('category.eq.notifyMatchConfirms');
    expect(f.filter).toContain('title.ilike."*to confirm*"');
    expect(f.filter).toContain('title.ilike."*invite*"');
  });
});

describe('deleted targets', () => {
  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const rows: NotificationLite[] = [
    N({ id: 'live-league', entity_type: 'league', entity_id: U(1) }),
    N({ id: 'dead-league', entity_type: 'league', entity_id: U(2) }),
    N({ id: 'dead-match', entity_type: 'match', entity_id: U(3) }),
    N({ id: 'drill-session', entity_type: 'drill', entity_id: U(4) }),
    N({ id: 'dead-drill', entity_type: 'drill', entity_id: U(5) }),
    N({ id: 'shop', entity_type: 'shop', entity_id: U(6) }),
    N({ id: 'no-id', entity_type: 'tournament', entity_id: null }),
    N({ id: 'bad-id', entity_type: 'event', entity_id: 'not-a-uuid' }),
  ];

  it('looks up per table, deduped, skipping unchecked types and non-uuid ids', () => {
    const l = targetLookups([...rows, N({ id: 'dup', entity_type: 'league', entity_id: U(1) })]);
    expect(Object.fromEntries(l)).toEqual({
      leagues: [U(1), U(2)],
      matches: [U(3)],
      drill_requests: [U(4), U(5)],
      drill_sessions: [U(4), U(5)],
    });
  });

  it('missing = checked and not found; a drill is gone only when in neither table', () => {
    const found = new Map<string, Set<string>>([
      ['leagues', new Set([U(1)])],
      ['matches', new Set()],
      ['drill_requests', new Set()],
      ['drill_sessions', new Set([U(4)])],
    ]);
    expect([...missingTargetIds(rows, found)].sort()).toEqual(['dead-drill', 'dead-league', 'dead-match']);
  });

  it('a table whose lookup failed marks nothing (unknown is not gone)', () => {
    const found = new Map<string, Set<string>>([['leagues', new Set([U(1)])]]);
    expect([...missingTargetIds(rows, found)]).toEqual(['dead-league']);
  });
});

describe('day groups', () => {
  const at = (days: number, hour: number) => new Date(2026, 9, 13 + days, hour, 0, 0).toISOString();

  it('labels: Today, Yesterday, a weekday this week, then dates (with the year when it differs)', () => {
    expect(notificationDayLabel(at(0, 9), NOW)).toBe('Today');
    expect(notificationDayLabel(at(-1, 23), NOW)).toBe('Yesterday');
    expect(notificationDayLabel(at(-3, 9), NOW)).toBe('Saturday');
    expect(notificationDayLabel(at(-7, 9), NOW)).toBe('Oct 6');
    expect(notificationDayLabel(new Date(2025, 11, 30, 9).toISOString(), NOW)).toBe('Dec 30, 2025');
    expect(notificationDayLabel(null, NOW)).toBe('Earlier');
  });

  it('puts a header before each new day', () => {
    const items = groupByDay([
      { id: 'a', created_at: at(0, 13) },
      { id: 'b', created_at: at(0, 9) },
      { id: 'c', created_at: at(-1, 20) },
    ], NOW);
    expect(items.map((i) => (i.kind === 'header' ? `# ${i.label}` : i.key))).toEqual(['# Today', 'a', 'b', '# Yesterday', 'c']);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it('row time: relative today, clock time on older days', () => {
    expect(notificationTime(iso(-20_000), NOW)).toBe('Just now');
    expect(notificationTime(iso(-5 * 60_000), NOW)).toBe('5m ago');
    expect(notificationTime(iso(-3 * H), NOW)).toBe('3h ago');
    expect(notificationTime(at(-1, 18), NOW)).toBe('6 PM');
  });
});
