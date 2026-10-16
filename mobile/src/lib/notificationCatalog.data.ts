// Every actionable notification category and its buttons. THE single source of
// the identifier strings: the app registers them (notificationActions.ts),
// send-push attaches them (it reads the generated
// supabase/functions/send-push/catalog.json), and local reminders use them.
//
// IMPORT-FREE on purpose: scripts/push-catalog.mjs loads this file in plain
// Node to regenerate catalog.json, and `node scripts/push-catalog.mjs --check`
// fails when the two drift. Renaming an id strands every notification already
// sitting in someone's shade, so don't.
//
// Android shows at most 3 buttons. Action ids are unique across categories
// except where the same button means the same write (event_decline,
// event_vote_1 / event_vote_2, drill_accept, drill_decline, drill_reply) or the
// same link (event_text_group).
//
// `link: true` buttons navigate like a tap and write nothing (lib/pushLinks.ts
// says where); they must be `opensApp: true`. Anything irreversible, that
// costs pickles or that notifies a crowd opens the app instead of acting.
export const CATALOG = {
  // Voting with 4+ times (or a push that lost its times): decline only.
  // Picking a time needs the screen.
  event_vote: {
    actions: {
      event_decline: { buttonTitle: "Can't make it" },
    },
  },
  // New vote / Vote closing soon with 2 or 3 times. The body lists the times,
  // numbered by start time; each press approves one (Both work approves both)
  // through vote_event_slots, and the confirmation notice offers the same set
  // again. 4+ times stay on event_vote: buttons for only the first times would
  // push lock-screen votes toward them. lib/eventVote.ts (the foundation vote
  // kit) checks these ids and their order.
  event_vote_pick2: {
    actions: {
      event_vote_1: { buttonTitle: '1st time' },
      event_vote_2: { buttonTitle: '2nd time' },
      event_vote_all: { buttonTitle: 'Both work' },
    },
  },
  event_vote_pick3: {
    actions: {
      event_vote_1: { buttonTitle: '1st time' },
      event_vote_2: { buttonTitle: '2nd time' },
      event_vote_3: { buttonTitle: '3rd time' },
    },
  },
  // A confirmed event has exactly one time, so "I'm in" is unambiguous.
  event_confirmed: {
    actions: {
      event_accept: { buttonTitle: "I'm in" },
      event_decline: { buttonTitle: "Can't make it" },
    },
  },
  // Confirmed event, and you already voted for its time (scheduled push,
  // start reminders): "I'm in" would be a no-op.
  event_reminder: {
    actions: {
      event_decline: { buttonTitle: "Can't make it" },
    },
  },
  // "How did it go?" after the event: never I'm in / Can't make it here (a
  // decline would delete the vote for the time that was played).
  event_record: {
    actions: {
      event_record_result: { buttonTitle: 'Record result', opensApp: true, link: true },
    },
  },
  // The organizer while voting closes soon. Close vote opens the event and its
  // confirm dialog: closing can cancel the event and pushes every member.
  event_organizer_vote: {
    actions: {
      event_text_group: { buttonTitle: 'Text group', opensApp: true, link: true },
      event_close_vote: { buttonTitle: 'Close vote', opensApp: true, link: true },
    },
  },
  // The organizer the day before / the day of. The app can't send the text
  // itself (it goes from their own number), so this opens the composer.
  event_organizer: {
    actions: {
      event_text_group: { buttonTitle: 'Text group', opensApp: true, link: true },
    },
  },
  // The organizer, when the vote cancelled the event (not enough players).
  event_cancelled_organizer: {
    actions: {
      event_pick_new_times: { buttonTitle: 'Pick new times', opensApp: true, link: true },
    },
  },
  // Confirm only: there is no reject RPC; letting it lapse is the decline.
  // Needs unlock: it settles a score and moves ratings. The score is in the body.
  match_confirm: {
    actions: {
      match_confirm: { buttonTitle: 'Confirm', authenticationRequired: true },
    },
  },
  // A request proposing exactly one slot (send-push decides).
  drill_request: {
    actions: {
      drill_accept: { buttonTitle: 'Accept' },
      drill_decline: { buttonTitle: 'Decline', destructive: true },
    },
  },
  // Two or three proposed slots, listed and numbered (by time) in the body.
  drill_request_pick2: {
    actions: {
      drill_slot_1: { buttonTitle: '1st time' },
      drill_slot_2: { buttonTitle: '2nd time' },
      drill_decline: { buttonTitle: 'Decline', destructive: true },
    },
  },
  drill_request_pick3: {
    actions: {
      drill_slot_1: { buttonTitle: '1st time' },
      drill_slot_2: { buttonTitle: '2nd time' },
      drill_slot_3: { buttonTitle: '3rd time' },
    },
  },
  // Four or more slots: the time has to be picked in the app.
  drill_request_pick: {
    actions: {
      drill_decline: { buttonTitle: 'Decline', destructive: true },
    },
  },
  drill_reminder: {
    actions: {
      drill_on_my_way: { buttonTitle: 'Confirm' },
      drill_cant_make_it: { buttonTitle: "Can't make it", destructive: true },
    },
  },
  // Drill chat. A chat push and the request it belongs to share the entity
  // drill/<request id>; push_data.kind tells them apart.
  drill_chat: {
    actions: {
      drill_reply: { buttonTitle: 'Reply', textInput: { submitButtonTitle: 'Send', placeholder: 'Message' } },
    },
  },
  // Chat on a pending one-slot request, to the invitee.
  drill_chat_pending: {
    actions: {
      drill_accept: { buttonTitle: 'Accept' },
      drill_decline: { buttonTitle: 'Decline', destructive: true },
      drill_reply: { buttonTitle: 'Reply', textInput: { submitButtonTitle: 'Send', placeholder: 'Message' } },
    },
  },
  // Chat on a pending request with several slots (the times aren't in a chat body).
  drill_chat_pick: {
    actions: {
      drill_decline: { buttonTitle: 'Decline', destructive: true },
      drill_reply: { buttonTitle: 'Reply', textInput: { submitButtonTitle: 'Send', placeholder: 'Message' } },
    },
  },
  // To the requester: accepted (sort out where to play) / declined.
  drill_accepted: {
    actions: {
      drill_open_chat: { buttonTitle: 'Open chat', opensApp: true, link: true },
    },
  },
  drill_declined: {
    actions: {
      drill_find_partner: { buttonTitle: 'Find another partner', opensApp: true, link: true },
    },
  },
  // "Your partner can't make it": find a new time with them.
  drill_partner_out: {
    actions: {
      drill_find_time: { buttonTitle: 'Find a new time', opensApp: true, link: true },
    },
  },
  // Accept approves the registration, which charges the entry fee (shown in
  // the body when there is one), so it needs unlock.
  tournament_invite: {
    actions: {
      tournament_accept: { buttonTitle: 'Accept', authenticationRequired: true },
      tournament_decline: { buttonTitle: 'Decline', destructive: true },
    },
  },
  // New tournament / registration closing, to someone not registered. A
  // request is reviewed by the admin; the fee is charged only on approval.
  tournament_request: {
    actions: {
      tournament_request_join: { buttonTitle: 'Request to join', authenticationRequired: true },
    },
  },
  // A league invite code. Joining makes you visible to the league.
  league_invite: {
    actions: {
      league_join: { buttonTitle: 'Join', authenticationRequired: true },
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
  // "🤝 Sam wants to be friends", while the request is still pending
  // (lib/friendActions.ts). Accept needs unlock: it lets the requester see
  // you at the courts. "Sam accepted your friend request" (friend_accepted)
  // has no buttons, so no category: one without actions is a catalog problem.
  friend_request: {
    actions: {
      friend_accept: { buttonTitle: 'Accept', authenticationRequired: true },
      friend_decline: { buttonTitle: 'Decline', destructive: true },
    },
  },
} as const;
