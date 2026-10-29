// The ▶ Play sheet's chip (the user's decision 4, 2026-10-22): Open play ·
// Closed group · Drill, picked from what I have scheduled around now
// (lib/playStartRules pickPlayChip), and the lines the sheet and the end
// sheet say.
import { describe, it, expect } from 'vitest';
import {
  AROUND_NOW_MS,
  PLAY_CHIP_KIND,
  aroundNow,
  chipWindows,
  draftPlanLine,
  pickPlayChip,
  playCompleteLine,
  playedFor,
  routineWindowsFromNow,
  windowsForChip,
  type ChipRoutine,
  type ChipScheduleItem,
} from '../playStartRules';
import { scheduleFromAgenda } from '../playStartRules';
import type { AgendaItem } from '../agenda';

const NOW = Date.parse('2026-10-22T18:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
/** "18:30" from an ISO (UTC), so the hints are deterministic. */
const clock = (iso: string) => iso.slice(11, 16);

const base = { nowMs: NOW, routine: null, schedule: [] as ChipScheduleItem[], lastUsed: null, clock };

describe('pickPlayChip', () => {
  it('nothing scheduled, nothing used before: Open play, no hint', () => {
    expect(pickPlayChip(base)).toEqual({ chip: 'open', why: 'default', hint: null });
  });

  it('nothing scheduled: the chip I used last', () => {
    expect(pickPlayChip({ ...base, lastUsed: 'closed' })).toMatchObject({ chip: 'closed', why: 'last_used' });
    expect(pickPlayChip({ ...base, lastUsed: 'drill' })).toMatchObject({ chip: 'drill', why: 'last_used' });
  });

  it('a routine drilling now picks Drill, and its line says so', () => {
    const routine: ChipRoutine = {
      plannedAt: at(-15),
      plannedEndAt: at(105),
      lengthMin: 120,
      windows: [
        { startsAt: at(-15), endsAt: at(45), mode: 'drill' },
        { startsAt: at(45), endsAt: at(105), mode: 'open' },
      ],
    };
    const p = pickPlayChip({ ...base, routine });
    expect(p.chip).toBe('drill');
    expect(draftPlanLine(p.windows ?? [], p.lengthMin ?? 0, NOW, clock)).toBe('Drill until 18:45, then open play until 19:45');
  });

  it("a routine at this court now: its current window's mode, length and windows", () => {
    // 5:30 PM stop, closed until 6:30, then open until 7:30.
    const routine: ChipRoutine = {
      plannedAt: at(-30),
      plannedEndAt: at(90),
      lengthMin: 120,
      windows: [
        { startsAt: at(-30), endsAt: at(30), mode: 'closed' },
        { startsAt: at(30), endsAt: at(90), mode: 'open' },
      ],
    };
    const p = pickPlayChip({ ...base, routine, lastUsed: 'drill' });
    expect(p.chip).toBe('closed');
    expect(p.why).toBe('routine');
    expect(p.hint).toBe('From your 17:30 routine');
    expect(p.lengthMin).toBe(90);
    expect(p.windows).toEqual([
      { startMin: 0, endMin: 30, mode: 'closed' },
      { startMin: 30, endMin: 90, mode: 'open' },
    ]);
  });

  it('a routine in its open window picks Open play', () => {
    const routine: ChipRoutine = {
      plannedAt: at(-90),
      plannedEndAt: at(30),
      lengthMin: 120,
      windows: [
        { startsAt: at(-90), endsAt: at(-30), mode: 'closed' },
        { startsAt: at(-30), endsAt: at(30), mode: 'open' },
      ],
    };
    const p = pickPlayChip({ ...base, routine });
    expect(p.chip).toBe('open');
    // The past is cut away; a short remainder is still at least 30 minutes.
    expect(p.lengthMin).toBe(30);
    expect(p.windows).toEqual([{ startMin: 0, endMin: 30, mode: 'open' }]);
  });

  it('a routine with nothing said: Open play, its length', () => {
    const routine: ChipRoutine = { plannedAt: at(10), plannedEndAt: null, lengthMin: 120, windows: [] };
    const p = pickPlayChip({ ...base, routine });
    expect(p).toMatchObject({ chip: 'open', why: 'routine', lengthMin: 130, windows: [] });
  });

  it('the routine beats a drill and an event at the same time', () => {
    const routine: ChipRoutine = { plannedAt: at(0), plannedEndAt: at(120), lengthMin: 120, windows: [] };
    const schedule: ChipScheduleItem[] = [
      { kind: 'drill', startsAt: at(5), title: 'Drill session' },
      { kind: 'event', startsAt: at(0), endsAt: at(120), title: 'Ladder night' },
    ];
    expect(pickPlayChip({ ...base, routine, schedule }).why).toBe('routine');
  });

  it('a drill session within 60 minutes either side: Drill', () => {
    for (const offset of [-60, -10, 0, 45, 60]) {
      const p = pickPlayChip({ ...base, schedule: [{ kind: 'drill', startsAt: at(offset), title: 'Drill session' }] });
      expect(p.chip, `offset ${offset}`).toBe('drill');
      expect(p.hint).toBe(`From your ${clock(at(offset))} drill session`);
    }
  });

  it('a drill request around now: Drill', () => {
    const p = pickPlayChip({ ...base, schedule: [{ kind: 'drill_request', startsAt: at(20), title: 'Drill request' }] });
    expect(p).toMatchObject({ chip: 'drill', why: 'drill', hint: 'From your 18:20 drill request' });
  });

  it('a drill more than an hour away does not count', () => {
    const schedule: ChipScheduleItem[] = [
      { kind: 'drill', startsAt: at(61), title: 'Drill session' },
      { kind: 'drill', startsAt: at(-61), title: 'Drill session' },
    ];
    expect(pickPlayChip({ ...base, schedule, lastUsed: 'closed' })).toMatchObject({ chip: 'closed', why: 'last_used' });
  });

  it('a drill beats a league event', () => {
    const schedule: ChipScheduleItem[] = [
      { kind: 'event', startsAt: at(0), title: 'Ladder night' },
      { kind: 'drill', startsAt: at(30), title: 'Drill session' },
    ];
    expect(pickPlayChip({ ...base, schedule }).chip).toBe('drill');
  });

  it('a league event, a scheduled match or a tournament match around now: Open play, named', () => {
    expect(pickPlayChip({ ...base, lastUsed: 'drill', schedule: [{ kind: 'event', startsAt: at(15), title: 'Ladder night' }] })).toEqual({
      chip: 'open',
      why: 'event',
      hint: 'From Ladder night at 18:15',
    });
    expect(pickPlayChip({ ...base, schedule: [{ kind: 'match', startsAt: at(-20), title: 'your scheduled match' }] }).hint).toBe(
      'From your scheduled match at 17:40',
    );
    expect(pickPlayChip({ ...base, schedule: [{ kind: 'tournament', startsAt: at(40), title: 'Fall Classic' }] }).chip).toBe('open');
  });

  it('an event still running counts until its end, even past an hour after its start', () => {
    const schedule: ChipScheduleItem[] = [{ kind: 'event', startsAt: at(-150), endsAt: at(30), title: 'Ladder night' }];
    expect(pickPlayChip({ ...base, schedule, lastUsed: 'drill' }).why).toBe('event');
  });

  it('the nearest item wins inside a rule', () => {
    const schedule: ChipScheduleItem[] = [
      { kind: 'event', startsAt: at(-50), title: 'Early' },
      { kind: 'event', startsAt: at(10), title: 'Late' },
    ];
    expect(pickPlayChip({ ...base, schedule }).hint).toBe('From Late at 18:10');
  });
});

describe('aroundNow', () => {
  it('60 minutes either side of the start, or to its end', () => {
    expect(aroundNow({ startsAt: at(60) }, NOW)).toBe(true);
    expect(aroundNow({ startsAt: at(61) }, NOW)).toBe(false);
    expect(aroundNow({ startsAt: at(-60) }, NOW)).toBe(true);
    expect(aroundNow({ startsAt: at(-61) }, NOW)).toBe(false);
    expect(aroundNow({ startsAt: at(-200), endsAt: at(1) }, NOW)).toBe(true);
    expect(aroundNow({ startsAt: 'nope' }, NOW)).toBe(false);
    expect(AROUND_NOW_MS).toBe(3_600_000);
  });
});

describe('chips → what Start sends', () => {
  it('Open play and Closed group are open_play sessions; Drill is a drill', () => {
    expect(PLAY_CHIP_KIND.open).toEqual({ kind: 'open_play', mode: 'open' });
    expect(PLAY_CHIP_KIND.closed).toEqual({ kind: 'open_play', mode: 'closed' });
    expect(PLAY_CHIP_KIND.drill).toEqual({ kind: 'drill', mode: null });
  });

  it('one window the whole length in the chip mode; none for a drill', () => {
    expect(chipWindows('open', 120)).toEqual([{ startMin: 0, endMin: 120, mode: 'open' }]);
    expect(chipWindows('closed', 90)).toEqual([{ startMin: 0, endMin: 90, mode: 'closed' }]);
    expect(chipWindows('drill', 120)).toEqual([]);
  });

  it("a routine's split stays while its own chip is picked, and fits a new length", () => {
    const pick = {
      chip: 'closed' as const,
      why: 'routine' as const,
      hint: 'x',
      lengthMin: 90,
      windows: [
        { startMin: 0, endMin: 30, mode: 'closed' as const },
        { startMin: 30, endMin: 90, mode: 'open' as const },
      ],
    };
    expect(windowsForChip('closed', 90, pick)).toEqual(pick.windows);
    expect(windowsForChip('closed', 180, pick)).toEqual([
      { startMin: 0, endMin: 30, mode: 'closed' },
      { startMin: 30, endMin: 180, mode: 'open' },
    ]);
    expect(windowsForChip('closed', 20, pick)).toEqual([{ startMin: 0, endMin: 20, mode: 'closed' }]);
    // Another chip: one window.
    expect(windowsForChip('open', 90, pick)).toEqual([{ startMin: 0, endMin: 90, mode: 'open' }]);
    expect(windowsForChip('drill', 90, pick)).toEqual([]);
  });

  it('routineWindowsFromNow caps at 4 hours', () => {
    const r: ChipRoutine = { plannedAt: at(0), plannedEndAt: at(400), lengthMin: 400, windows: [{ startsAt: at(0), endsAt: at(400), mode: 'open' }] };
    expect(routineWindowsFromNow(r, NOW)).toEqual({ lengthMin: 240, windows: [{ startMin: 0, endMin: 240, mode: 'open' }] });
  });
});

describe('the lines', () => {
  it('the plan line reads the windows from now', () => {
    expect(draftPlanLine([{ startMin: 0, endMin: 90, mode: 'open' }], 90, NOW, clock)).toBe('Open play until 19:30');
    expect(
      draftPlanLine(
        [
          { startMin: 0, endMin: 30, mode: 'closed' },
          { startMin: 30, endMin: 90, mode: 'open' },
        ],
        90,
        NOW,
        clock,
      ),
    ).toBe('Closed group until 18:30, then open play until 19:30');
    expect(draftPlanLine([], 120, NOW, clock)).toBe('Until 20:00');
    // Same-mode neighbours read as one.
    expect(
      draftPlanLine(
        [
          { startMin: 0, endMin: 30, mode: 'open' },
          { startMin: 30, endMin: 60, mode: 'open' },
        ],
        60,
        NOW,
        clock,
      ),
    ).toBe('Open play until 19:00');
  });

  it('the end sheet: "Play complete · 1h 42m at Riverside"', () => {
    expect(playCompleteLine({ startedAtMs: NOW, endedAtMs: NOW + 102 * 60_000, venueName: 'Riverside' })).toBe(
      'Play complete · 1h 42m at Riverside',
    );
    expect(playCompleteLine({ startedAtMs: NOW, endedAtMs: NOW + 42 * 60_000 })).toBe('Play complete · 42m');
    expect(playedFor(60 * 60_000)).toBe('1h');
    expect(playedFor(-5)).toBe('0m');
  });
});

describe("Home's agenda as chip inputs", () => {
  const item = (p: Partial<AgendaItem>): AgendaItem =>
    ({
      key: 'k',
      kind: 'event',
      title: 'T',
      leagueName: null,
      startsAt: null,
      endsAt: null,
      needsYou: false,
      deadline: null,
      status: null,
      target: { screen: 'EventDetail', params: { eventId: 'e', title: 'T' } },
      action: null,
      ...p,
    }) as AgendaItem;

  it('maps events, tournaments, drills and drill requests; skips the rest', () => {
    const out = scheduleFromAgenda([
      item({ kind: 'event', title: 'Ladder night', startsAt: at(0), endsAt: at(120) }),
      item({ kind: 'tournament', title: 'Fall Classic', startsAt: at(30) }),
      item({ kind: 'drill', title: 'Drill with Ann', startsAt: at(10) }),
      item({ kind: 'drill_request', title: 'Drill request from Bo', deadline: at(20) }),
      item({ kind: 'drill_waiting', title: 'Waiting on Cy', startsAt: at(40) }),
      item({ kind: 'vote', title: 'Vote', deadline: at(5) }),
      item({ kind: 'event', title: 'No time' }),
    ]);
    expect(out.map((o) => [o.kind, o.title])).toEqual([
      ['event', 'Ladder night'],
      ['tournament', 'Fall Classic'],
      ['drill', 'Drill with Ann'],
      ['drill_request', 'Drill request from Bo'],
      ['drill_request', 'Waiting on Cy'],
    ]);
  });
});
