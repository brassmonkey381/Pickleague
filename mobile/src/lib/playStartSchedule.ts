// What the ▶ Play sheet reads to pick its chip (lib/playStartRules
// pickPlayChip): my routine stop due at the court, and what's on my calendar
// around now. Everything comes from what this phone already holds (Home's
// payload, my routines' copy) plus one bounded read of my scheduled matches,
// so the sheet never waits on it: the chip moves only until the player taps one.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { peekQuery } from '@just-messin-around/expo-foundation/cache';
import { withTimeout } from '@just-messin-around/expo-foundation/platform';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from './supabase';
import { drillAgendaItems, eventAgendaItems, tournamentAgendaItems, type AgendaItem } from './agenda';
import { inboxAgendaItems } from './inboxRequests';
import { routineOccurrenceAt, type CourtRoutine } from './courtRoutineRules';
import { scheduleFromAgenda, type ChipRoutine, type ChipScheduleItem, type PlayChip } from './playStartRules';
import { HOME_KEY, type HomeData } from '../components/home/homeData';
import { getMyCourtRoutinesOffline } from '../data/courtRoutines';
import { getMyUpcomingPlay } from '../data/playSessions';
import { ROUTINES_ENABLED } from './features';

const LAST_CHIP_KEY = 'pickleague_play_chip_v1';

/** My calendar around now, from Home's payload (instant) and my scheduled matches (bounded at 4 s). */
export async function loadChipSchedule(nowMs: number): Promise<ChipScheduleItem[]> {
  const home = peekQuery<HomeData>(HOME_KEY);
  const items: AgendaItem[] = home
    ? [
        ...eventAgendaItems(home.events ?? [], nowMs),
        ...tournamentAgendaItems(home.myTournaments ?? [], nowMs),
        ...drillAgendaItems(home.drills ?? home.drillsToday ?? [], nowMs),
        ...inboxAgendaItems(home.inbox, home.profile?.id ?? null, [], nowMs),
      ]
    : [];
  const out = scheduleFromAgenda(items);
  try {
    const uid = await currentUserId(supabase);
    if (uid) {
      const upcoming = await withTimeout(getMyUpcomingPlay(uid), 4_000);
      for (const u of upcoming) {
        if (u.kind === 'match') out.push({ kind: 'match', startsAt: u.startsAt, title: 'your scheduled match' });
        else if (!out.some((o) => o.kind === 'drill' && o.startsAt === u.startsAt)) {
          out.push({ kind: 'drill', startsAt: u.startsAt, title: u.title });
        }
      }
    }
  } catch {
    // Home's payload is enough.
  }
  return out;
}

/** The routine occurrence due at `venueId` now (this phone's copy), as a chip input. */
export async function loadChipRoutine(venueId: string | null, now: Date): Promise<ChipRoutine | null> {
  if (!ROUTINES_ENABLED || !venueId) return null;
  let routines: CourtRoutine[];
  try {
    routines = await withTimeout(getMyCourtRoutinesOffline(), 4_000);
  } catch {
    return null;
  }
  const hit = routineOccurrenceAt(routines, venueId, now);
  if (!hit) return null;
  return {
    plannedAt: hit.occurrence.plannedAt,
    plannedEndAt: hit.occurrence.plannedEndAt,
    lengthMin: hit.routine.lengthMin,
    windows: hit.occurrence.windows.map((w) => ({ startsAt: w.startsAt, endsAt: w.endsAt, mode: w.mode })),
  };
}

export async function readLastChip(): Promise<PlayChip | null> {
  try {
    const v = await AsyncStorage.getItem(LAST_CHIP_KEY);
    return v === 'open' || v === 'closed' || v === 'drill' ? v : null;
  } catch {
    return null;
  }
}

export function saveLastChip(chip: PlayChip): void {
  void AsyncStorage.setItem(LAST_CHIP_KEY, chip).catch(() => {});
}
