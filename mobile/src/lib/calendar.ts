// "Add to calendar" without a native module (no expo-calendar dependency, so no
// EAS rebuild). Cross-platform + web-safe:
//   • web    → download a standard .ics file (opens into Apple/Google/Outlook)
//   • native → deep-link to a Google Calendar event template via the browser
// A future enhancement could write straight to the device calendar with
// expo-calendar (requires adding the native module + a rebuild).
import { Platform, Linking } from 'react-native';

export type CalendarEvent = {
  title: string;
  startsAt: string | Date;
  endsAt?: string | Date | null;
  location?: string | null;
  description?: string | null;
};

// Compact UTC stamp used by both ICS and Google: YYYYMMDDTHHMMSSZ.
function toCalUtc(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) + 'T' +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) + 'Z'
  );
}

// Default to a 1-hour block when no end time is supplied.
function resolveTimes(ev: CalendarEvent): { start: Date; end: Date } {
  const start = new Date(ev.startsAt);
  const end = ev.endsAt ? new Date(ev.endsAt) : new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

export function buildGoogleCalendarUrl(ev: CalendarEvent): string {
  const { start, end } = resolveTimes(ev);
  const q: string[] = [
    'action=TEMPLATE',
    `text=${encodeURIComponent(ev.title)}`,
    `dates=${toCalUtc(start)}/${toCalUtc(end)}`,
  ];
  if (ev.description) q.push(`details=${encodeURIComponent(ev.description)}`);
  if (ev.location) q.push(`location=${encodeURIComponent(ev.location)}`);
  return `https://calendar.google.com/calendar/render?${q.join('&')}`;
}

// RFC-5545 text escaping: backslash, semicolon, comma, and newlines.
function escapeIcs(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

export function buildIcs(ev: CalendarEvent): string {
  const { start, end } = resolveTimes(ev);
  const uid = `${toCalUtc(start)}-${encodeURIComponent(ev.title).slice(0, 24)}@pickleague.club`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pickleague//Events//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toCalUtc(new Date())}`,
    `DTSTART:${toCalUtc(start)}`,
    `DTEND:${toCalUtc(end)}`,
    `SUMMARY:${escapeIcs(ev.title)}`,
  ];
  if (ev.description) lines.push(`DESCRIPTION:${escapeIcs(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeIcs(ev.location)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

// Web only: stream the .ics as a download so the OS opens it in the default
// calendar app. Guarded so it's a no-op if DOM APIs aren't present.
function downloadIcs(ev: CalendarEvent): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([buildIcs(ev)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(ev.title || 'event').replace(/[^\w]+/g, '-').toLowerCase()}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Add an event to the user's calendar. Resolves once the handoff is triggered. */
export async function addToCalendar(ev: CalendarEvent): Promise<void> {
  if (Platform.OS === 'web') {
    downloadIcs(ev);
    return;
  }
  await Linking.openURL(buildGoogleCalendarUrl(ev));
}
