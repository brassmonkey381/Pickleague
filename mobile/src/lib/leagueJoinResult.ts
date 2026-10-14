// What request_league_join (supabase/migration_league_join_resolution.sql)
// answered, parsed and turned into the copy every Join surface shows.
//
// PURE (no React, no Supabase client): useLeagueJoin calls the RPC, these
// functions decide what it meant. The RPC returns text:
//   'sent' | 'pending' | 'joined' | 'member' | 'denied:<ISO UTC timestamp>'
// ('denied:<iso>' = when the requester may ask again, 7 days after the denial).

export type RequestJoinResult =
  | { kind: 'sent' }
  | { kind: 'pending' }
  | { kind: 'joined' }
  | { kind: 'member' }
  | { kind: 'denied'; retryAt: Date | null };

/** Parse the RPC's text. Anything unrecognised is null (the caller shows a generic error). */
export function parseRequestJoinResult(raw: unknown): RequestJoinResult | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v === 'sent' || v === 'pending' || v === 'joined' || v === 'member') return { kind: v };
  if (v === 'denied' || v.startsWith('denied:')) {
    const iso = v.slice('denied:'.length);
    const d = iso ? new Date(iso) : null;
    return { kind: 'denied', retryAt: d && !Number.isNaN(d.getTime()) ? d : null };
  }
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 21" in the device zone. */
export function shortDate(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** The request-sent copy, shared so every surface says the same thing. */
export function requestSentMessage(leagueName: string): string {
  return `Request sent. The admins of "${leagueName}" have been notified.`;
}

export type JoinCopy = { tone: 'success' | 'error'; message: string };

/**
 * The copy for a request result. 'joined' (the league turned open) reads as a
 * join; the caller also runs its onJoined reload for it.
 */
export function requestJoinCopy(result: RequestJoinResult, leagueName: string): JoinCopy {
  switch (result.kind) {
    case 'sent':
      return { tone: 'success', message: requestSentMessage(leagueName) };
    case 'pending':
      return { tone: 'success', message: 'Your request is already with the admins.' };
    case 'joined':
      return { tone: 'success', message: `Joined! You're in "${leagueName}".` };
    case 'member':
      return { tone: 'success', message: "You're already in this league." };
    case 'denied':
      return {
        tone: 'error',
        message: result.retryAt
          ? `An admin declined your request. You can ask again after ${shortDate(result.retryAt)}.`
          : 'An admin declined your request.',
      };
  }
}

/** The request now sits with the admins ("Requested" from here on). */
export function isRequestOutstanding(result: RequestJoinResult): boolean {
  return result.kind === 'sent' || result.kind === 'pending';
}

/** The viewer is in the league now. */
export function isJoinedResult(result: RequestJoinResult): boolean {
  return result.kind === 'joined' || result.kind === 'member';
}
