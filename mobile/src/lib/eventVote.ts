// Lock-screen time voting on league events: the foundation's numbered vote kit
// bound to this app's catalog.
//
// PURE (no react-native, no expo), so the tests and the handler share it.
//
// send-push attaches event_vote_pick2 (2 times) or event_vote_pick3 (3 times)
// to New vote / Vote closing soon, with the slot ids and the labels the body
// shows (migration_event_vote_buttons.sql). A press approves those slots
// through vote_event_slots; 4+ times get Can't make it only.
import { defineOptionVote } from '@just-messin-around/expo-foundation/push/optionVote';
import { CATALOG } from './notificationCatalog.data';

export const eventVote = defineOptionVote(
  { actionPrefix: 'event_vote_', pick2: 'event_vote_pick2', pick3: 'event_vote_pick3' },
  CATALOG,
);

/** "Option 1", "Option 2"... in button order (by start time, ties by id), as EventDetail labels them. */
export function optionNumbers<T extends { id: string; starts_at: string }>(slots: readonly T[]): Map<string, number> {
  const sorted = [...slots].sort((a, b) => {
    const d = Date.parse(a.starts_at) - Date.parse(b.starts_at);
    if (d) return Number.isFinite(d) ? d : 0;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return new Map(sorted.map((s, i) => [s.id, i + 1]));
}
