// Every actionable notification category and its buttons. THE single source of
// the identifier strings: the app registers them (notificationActions.ts),
// send-push attaches them (it reads the generated
// supabase/functions/send-push/catalog.json), and local reminders use them.
//
// IMPORT-FREE on purpose: scripts/gen-push-catalog.mjs loads this file in plain
// Node to regenerate catalog.json, and `node scripts/check-push-catalog.mjs`
// fails when the two drift. Renaming an id strands every notification already
// sitting in someone's shade, so don't.
//
// Android shows at most 3 buttons. Action ids are unique across categories
// except where the same button means the same write (event_decline).
export const CATALOG = {
  // During voting there are several proposed slots, so a single tap can't say
  // which time is meant: decline only. Picking a time needs the screen.
  event_vote: {
    actions: {
      event_decline: { buttonTitle: "Can't make it" },
    },
  },
  // A confirmed event has exactly one time, so "I'm in" is unambiguous.
  event_confirmed: {
    actions: {
      event_accept: { buttonTitle: "I'm in" },
      event_decline: { buttonTitle: "Can't make it" },
    },
  },
  // Confirm only: there is no reject RPC; letting it lapse is the decline.
  match_confirm: {
    actions: {
      match_confirm: { buttonTitle: 'Confirm' },
    },
  },
  // A request proposing exactly one slot (send-push decides).
  drill_request: {
    actions: {
      drill_accept: { buttonTitle: 'Accept' },
      drill_decline: { buttonTitle: 'Decline', destructive: true },
    },
  },
  // Several proposed slots: the time has to be picked in the app.
  drill_request_pick: {
    actions: {
      drill_decline: { buttonTitle: 'Decline', destructive: true },
    },
  },
  drill_reminder: {
    actions: {
      drill_on_my_way: { buttonTitle: 'On my way' },
      drill_cant_make_it: { buttonTitle: "Can't make it", destructive: true },
    },
  },
  tournament_invite: {
    actions: {
      tournament_accept: { buttonTitle: 'Accept' },
    },
  },
  // Local reminder 5 minutes before a court check-in expires.
  checkin_extend: {
    actions: {
      checkin_extend: { buttonTitle: 'Stay 1 more hour' },
      checkin_out: { buttonTitle: 'Check out' },
    },
  },
  // Local notice when the phone enters a fenced court. Never auto-checks in.
  court_checkin: {
    actions: {
      court_checkin: { buttonTitle: 'Check in' },
    },
  },
  // Local "starting now" for a scheduled drill session or match.
  play_start: {
    actions: {
      play_start: { buttonTitle: 'Start session', opensApp: true },
    },
  },
} as const;
