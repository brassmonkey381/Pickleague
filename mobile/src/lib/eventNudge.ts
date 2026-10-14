import { supabase } from './supabase';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { EventSlot, LeagueEvent } from '../types';
import { calendarDayDiff } from './agenda';

/**
 * Follow-up nudges for the group an organiser invited by text.
 *
 * The app cannot send these itself. expo-sms (and the WhatsApp deep link) open
 * the composer from the user's OWN number and the user taps send — which is
 * also why they convert: a text from a friend beats a text from a shortcode.
 * See docs and migration_event_organizer_nudges.sql: the server's job is to
 * PROMPT the organiser at the right moment and hand them a finished message,
 * not to send it.
 *
 * Nothing here is live. A thread cannot show a poll that updates, on SMS or
 * WhatsApp — so the message carries a SNAPSHOT tally taken at send time, which
 * is the number that creates urgency anyway ("3 of 5, closes at 8").
 */

export type NudgeKind = 'vote' | 'tomorrow' | 'today';

const eventLink = (id: string) => `https://www.pickleague.club/events/${id}`;

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

/** Which nudge (if any) fits the event's current state. */
export function pickNudgeKind(
  event: Pick<LeagueEvent, 'status' | 'vote_ends_at'>,
  confirmedSlot: Pick<EventSlot, 'starts_at'> | null,
  now: number = Date.now(),
): NudgeKind | null {
  if (event.status === 'voting' && new Date(event.vote_ends_at).getTime() > now) return 'vote';
  if (event.status !== 'scheduled' || !confirmedSlot) return null;

  const start = new Date(confirmedSlot.starts_at);
  const startsIn = start.getTime() - now;
  if (startsIn <= 0) return null;
  // "Today" is the device's calendar day, not a count of hours: a 9 AM game
  // texted about at 8 PM the night before is tomorrow. The "locked in" copy
  // names the day, so it fits any start in the next two days.
  if (calendarDayDiff(start, new Date(now)) === 0) return 'today';
  return startsIn <= 48 * 3_600_000 ? 'tomorrow' : null;
}

export function buildNudgeMessage(input: {
  kind: NudgeKind;
  event: Pick<LeagueEvent, 'id' | 'title' | 'vote_ends_at' | 'min_players' | 'location_name'>;
  slots: EventSlot[];
  confirmedSlot: EventSlot | null;
  /** Distinct people who have voted for at least one slot. */
  voterCount: number;
  /** Names of players on the confirmed slot, for the "who's playing" line. */
  attendeeNames: string[];
}): string {
  const { kind, event, slots, confirmedSlot, voterCount, attendeeNames } = input;
  const link = eventLink(event.id);

  if (kind === 'vote') {
    const leader = [...slots].sort(
      (a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0)
        || new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
    )[0];

    const lines = [`⏰ Last call to vote on "${event.title}"`];
    if (leader && (leader.vote_count ?? 0) > 0) {
      lines.push(`Leading: ${dayLabel(leader.starts_at)} at ${timeLabel(leader.starts_at)} (${leader.vote_count} in)`);
    }
    lines.push(`${voterCount} ${voterCount === 1 ? 'person has' : 'people have'} voted so far.`);
    // The threshold is the honest reason to hurry, so say it plainly.
    if (event.min_players != null) {
      lines.push(`We need ${event.min_players} on the same time or it's off.`);
    }
    // With the day: a vote can close a day or two after the text goes out,
    // and a bare clock time reads as today.
    lines.push(`Voting closes ${dayLabel(event.vote_ends_at)} at ${timeLabel(event.vote_ends_at)} — lock in your times: ${link}`);
    return lines.join('\n');
  }

  const when = confirmedSlot ? `${timeLabel(confirmedSlot.starts_at)}` : '';
  const where = event.location_name ? ` at ${event.location_name}` : '';
  const who = attendeeNames.length
    ? `${attendeeNames.slice(0, 6).join(', ')}${attendeeNames.length > 6 ? ` +${attendeeNames.length - 6} more` : ''}`
    : '';

  if (kind === 'today') {
    return [
      `🥒 "${event.title}" is TODAY at ${when}${where}`,
      who ? `Playing: ${who}` : '',
      `Details: ${link}`,
    ].filter(Boolean).join('\n');
  }

  return [
    `📅 "${event.title}" is locked in — ${confirmedSlot ? dayLabel(confirmedSlot.starts_at) : 'soon'} at ${when}${where}`,
    who ? `Playing: ${who}` : '',
    `Add it to your calendar: ${link}`,
  ].filter(Boolean).join('\n');
}

/**
 * Phone numbers this event was already texted to, so a follow-up reaches the
 * same group rather than making the organiser rebuild it from their contacts.
 *
 * Readable only by the invite's creator (RLS: "Creator manages own guest
 * invites"), which is fine — nudging is a creator-only action. An empty result
 * is not an error: the composer still opens, just with an empty To field.
 */
export async function loadInvitedPhones(eventId: string): Promise<string[]> {
  try {
    const rows = await sbCall(() => supabase
      .from('guest_invites')
      .select('invited_phones')
      .eq('event_id', eventId)
      .eq('is_active', true)) as { invited_phones: string[] | null }[] | null;

    const all = (rows ?? []).flatMap(r => r.invited_phones ?? []);
    // Same person invited twice (two invite batches) must not be texted twice.
    return Array.from(new Set(all.map(p => p.trim()).filter(Boolean)));
  } catch {
    return [];
  }
}
