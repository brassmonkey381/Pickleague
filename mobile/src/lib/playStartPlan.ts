// The ▶ Play sheet's plan (how long, Closed group / Open play), sent once its
// Start lands (plan §7.3 step 2, C2): start_play_session checks me in at the
// court (its own 'session' check-in, or it adopts the one I had), then
// set_checkin_plan gives that check-in the sheet's planned end and windows,
// counted from the tap. Nothing is sent when the Start queued offline, had no
// court, or didn't check me in (the island already says why), or for a drill
// with nothing said. Best-effort and silent: if it fails, the check-in keeps
// its default 2 hours and the island's plan line shows what it has (its
// "Plan my play" sets it again).
import { normalizeWindows, windowsToAbsolute, type TimeWindow } from '@just-messin-around/expo-foundation/scheduling/timeWindows';
import { playStartLanded } from './playSession';
import { refreshCurrentCheckin } from './courtCheckin';
import { checkedInBySession } from './playStartRules';
import { PLAY_WINDOW_RULES, windowsSaySomething, type PlayMode } from './courtRoutineRules';
import { setCheckinPlan } from '../data/courtRoutines';
import { ROUTINES_ENABLED } from './features';

type Pending = { venueId: string; lengthMin: number; windows: TimeWindow<PlayMode>[] };
const pending = new Map<string, Pending>();
/** A Start that never lands live (it queued) is forgotten after this. */
const FORGET_MS = 2 * 60_000;

/** Send this plan for session `sessionId` once its Start lands. */
export function planAfterStart(sessionId: string, plan: Pending): void {
  if (!ROUTINES_ENABLED) return;
  pending.set(sessionId, plan);
  setTimeout(() => pending.delete(sessionId), FORGET_MS);
}

playStartLanded.subscribe(({ id, venueId, at }) => {
  const plan = pending.get(id);
  if (!plan) return;
  pending.delete(id);
  void (async () => {
    try {
      const cur = await refreshCurrentCheckin();
      if (!cur || !checkedInBySession(cur, id, [venueId, plan.venueId])) return;
      const list = normalizeWindows(plan.windows, plan.lengthMin, PLAY_WINDOW_RULES);
      const abs = windowsSaySomething(list) ? windowsToAbsolute(list, at) : [];
      await setCheckinPlan(cur.id, new Date(Date.parse(at) + plan.lengthMin * 60_000), abs);
    } catch {
      // The check-in keeps its 2 hours; "Plan my play" on the island changes it.
    }
  })();
});
