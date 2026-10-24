// The centre ▶ Play's one tap (2026-10-24, "go merge play and check-in"): at
// the court the fix just found, check in and start the timer at once, with
// what the ▶ Play sheet would have picked (lib/playStartRules pickPlayChip:
// the routine due here, a drill or event around now, the chip used last) and
// its plan (how long, Closed group / Open play), sent once the Start lands
// (lib/playStartPlan). The Start carries the fix, so the server checks me in
// there (start_play_session's own check-in, or it adopts mine), on a server
// with or without supabase/migration_checkin_starts_session.sql. The sheet
// opens only when no court is found, or from the island's Switch mode.
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import type { TimeWindow } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { startPlay } from './playSession';
import { planAfterStart } from './playStartPlan';
import { PLAY_CHIP_KIND, pickPlayChip, windowsForChip, type ChipPick } from './playStartRules';
import { loadChipRoutine, loadChipSchedule, readLastChip, saveLastChip } from './playStartSchedule';
import { DEFAULT_PLAY_LENGTH_MIN, clockLabel, type PlayMode } from './courtRoutineRules';
import type { DeviceFix } from './courtCheckinRules';
import { track } from './analytics';

/** How long the one tap waits for my schedule before it starts open play anyway. */
const PICK_WAIT_MS = 1_500;

async function pickChip(venueId: string): Promise<ChipPick> {
  const now = Date.now();
  const fallback: ChipPick = { chip: 'open', why: 'default', hint: null };
  try {
    const [schedule, lastUsed, routine] = await withTimeout(
      Promise.all([loadChipSchedule(now), readLastChip(), loadChipRoutine(venueId, new Date(now))]),
      PICK_WAIT_MS,
    );
    return pickPlayChip({ nowMs: now, routine, schedule, lastUsed, clock: (iso) => clockLabel(iso) });
  } catch {
    return fallback;
  }
}

/** Check in at `court` and start the timer (the Start carries `fix`). Returns the session id. */
export async function quickPlayAt(court: { id: string; name: string }, fix: DeviceFix): Promise<string> {
  const pick = await pickChip(court.id);
  const lengthMin = pick.lengthMin ?? DEFAULT_PLAY_LENGTH_MIN;
  const windows: TimeWindow<PlayMode>[] = windowsForChip(pick.chip, lengthMin, pick).map((w) => ({
    startMin: w.startMin,
    endMin: w.endMin,
    mode: w.mode,
    hint: null,
    group: [],
  }));
  const id = startPlay({
    kind: PLAY_CHIP_KIND[pick.chip].kind,
    sourceId: null,
    venueId: court.id,
    venueName: court.name,
    fix,
  });
  saveLastChip(pick.chip);
  planAfterStart(id, { venueId: court.id, lengthMin, windows });
  track('play.quick_start', { chip: pick.chip, why: pick.why, length_min: lengthMin });
  return id;
}
