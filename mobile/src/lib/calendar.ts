// "Add to calendar" without a native module (no expo-calendar dependency, so no
// EAS rebuild). The implementation now lives in
// @just-messin-around/expo-foundation/scheduling/calendarLink; this adapter binds
// the Pickleague ICS identity (PRODID + UID domain) so consumers
// (`import { addToCalendar } from '../lib/calendar'`) are unchanged.
//
// Behavior is identical to the previous local implementation:
//   • web    → download a standard .ics file (opens into Apple/Google/Outlook)
//   • native → deep-link to a Google Calendar event template via the browser
import {
  addToCalendar as kitAddToCalendar,
  buildGoogleCalendarUrl as kitBuildGoogleCalendarUrl,
  buildIcs as kitBuildIcs,
  type IcsOptions,
} from '@just-messin-around/expo-foundation/scheduling/calendarLink';

// The event shape Pickleague call sites pass (API/DB payloads: ISO strings, and
// nullable end/location/description). A subset of the kit's CalendarEventInput.
export type CalendarEvent = {
  title: string;
  startsAt: string | Date;
  endsAt?: string | Date | null;
  location?: string | null;
  description?: string | null;
};

// Pickleague's ICS identity — keeps generated UIDs/PRODID stable with every
// .ics this app has already emitted.
const ICS_OPTS: IcsOptions = {
  prodId: '-//Pickleague//Events//EN',
  uidDomain: 'pickleague.club',
};

export function buildGoogleCalendarUrl(ev: CalendarEvent): string {
  return kitBuildGoogleCalendarUrl(ev);
}

export function buildIcs(ev: CalendarEvent): string {
  return kitBuildIcs(ev, ICS_OPTS);
}

/** Add an event to the user's calendar. Resolves once the handoff is triggered. */
export async function addToCalendar(ev: CalendarEvent): Promise<void> {
  await kitAddToCalendar(ev, ICS_OPTS);
}
