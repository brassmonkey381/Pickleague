// Joining an event's or tournament's group session (lib/groupSessionRules for
// the rules, supabase/migration_group_sessions.sql for the server).
//
// Join goes through the normal "Play" sheet (openPlayStart with kind 'event'
// or 'tournament' and the source), so the court check-in works as for any
// session. "Let everyone know" waits for the Start to reach the server live:
// a queued Start that lands later doesn't tell anyone (it would be stale).
import { invalidateQueries } from '@just-messin-around/expo-foundation/cache';
import { notifyGroupSession } from '../data/playSessions';
import { track } from './analytics';
import { openPlayStart, playSession, playStartLanded } from './playSession';
import { groupSessionKey, type GroupKind } from './groupSessionRules';

/** Session ids whose Start should tell the group once it lands. */
const notifyOnLand = new Set<string>();
let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  playStartLanded.subscribe(({ id }) => {
    const meta = playSession.get().id === id ? playSession.get().meta : null;
    if (meta && (meta.kind === 'event' || meta.kind === 'tournament') && meta.sourceId) {
      // Whoever is looking at the group sees me at once.
      invalidateQueries(groupSessionKey(meta.kind, meta.sourceId));
    }
    if (!notifyOnLand.delete(id)) return;
    void notifyGroupSession(id)
      .then((n) => track('group_session.notified', { told: n }))
      .catch(() => {});
  });
}

/** Tell the group once this session's Start lands (the Play sheet calls it). */
export function notifyGroupWhenStarted(sessionId: string): void {
  listen();
  notifyOnLand.add(sessionId);
}

/** Keep the group list fresh after my own Start lands, even without "Let everyone know". */
export function watchGroupStarts(): void {
  listen();
}

/** Join: the Play sheet for this event or tournament (over a running session, it replaces it). */
export function joinGroupSession(p: { kind: GroupKind; id: string; title: string; notify: boolean }): void {
  listen();
  track('group_session.join_tap', { kind: p.kind, notify: p.notify });
  openPlayStart({
    kind: p.kind,
    sourceId: p.id,
    label: p.title,
    notifyGroup: p.notify,
    switching: playSession.get().status !== 'idle',
  });
}

/** Is the running session this group's? */
export function inThisGroup(kind: GroupKind, id: string): boolean {
  const s = playSession.get();
  return s.status !== 'idle' && !!s.meta && s.meta.kind === kind && s.meta.sourceId === id;
}
