// What I've already committed to in the next 7 days, painted over the
// Availability grid (it was on the Drills screen's grid before Availability
// got its own page): upcoming drill sessions, and scheduled matches plus
// tournaments I'm approved into. Matches get 60 minutes (they have no length
// yet); a tournament covers its expected window, split per day.
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import type { AvailabilityOverlaySlot } from '@just-messin-around/expo-foundation/ui';
import { supabase } from '../lib/supabase';
import { isoDate, rollingDates, spanToDailyOverlays } from '../lib/drillTime';
import { drillCalledOff } from '../lib/agenda';
import { isLoggedDrill } from '../lib/sessionAdds';

export type Commitments = { drills: AvailabilityOverlaySlot[]; matches: AvailabilityOverlaySlot[] };

export async function loadCommitments(uid: string): Promise<Commitments> {
  const today = isoDate(new Date());
  const [sessions, matches, regs] = await Promise.all([
    sbCall(() => supabase
      .from('drill_sessions')
      .select('session_date, session_slot, length_minutes, player1_id, player2_id, drill_session_rsvps(user_id, status)')
      .or(`player1_id.eq.${uid},player2_id.eq.${uid}`)
      .gte('session_date', today)),
    sbCall(() => supabase
      .from('matches')
      .select('scheduled_at')
      .eq('status', 'scheduled')
      .gte('scheduled_at', new Date().toISOString())
      .or(`player1_id.eq.${uid},partner1_id.eq.${uid},player2_id.eq.${uid},partner2_id.eq.${uid}`)),
    sbCall(() => supabase
      .from('tournament_registrations')
      .select('tournament:tournaments(start_time, expected_length_hours, status)')
      .eq('user_id', uid)
      .eq('status', 'approved')),
  ]);

  // The grid shows one week: only dates inside the rolling next 7 days.
  const week = new Set(rollingDates());

  const drills = ((sessions ?? []) as any[])
    .filter(r => !isLoggedDrill(r) && !drillCalledOff(r.drill_session_rsvps) && week.has(r.session_date))
    .map(r => ({ date: r.session_date as string, slot: r.session_slot as number, length_minutes: r.length_minutes ?? 60 }));

  const matchSlots = ((matches ?? []) as { scheduled_at: string | null }[])
    .filter(m => m.scheduled_at != null)
    .map(m => {
      const d = new Date(m.scheduled_at as string);
      return { date: isoDate(d), slot: d.getHours() * 2 + (d.getMinutes() >= 30 ? 1 : 0), length_minutes: 60 };
    });
  const tournamentSlots = ((regs ?? []) as any[]).flatMap(r => {
    const t = r.tournament;
    if (!t || !t.start_time || t.expected_length_hours == null) return [];
    if (t.status === 'completed' || t.status === 'cancelled') return [];
    return spanToDailyOverlays(new Date(t.start_time), Number(t.expected_length_hours));
  });

  return { drills, matches: [...matchSlots, ...tournamentSlots].filter(s => week.has(s.date)) };
}
