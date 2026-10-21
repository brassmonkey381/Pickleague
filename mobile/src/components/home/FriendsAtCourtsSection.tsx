// FRIENDS AT THE COURTS on Home (docs/play-sessions-presence.md, Phase 1 step
// 8): which friends are playing right now, and my courts with their crowd.
//
//   FRIENDS AT THE COURTS                                         Friends ›
//   📍 Lakeside                                                    4 here
//      Alex, Sam +2 · since 5:40 · til 7:30 PM
//   YOUR COURTS
//   📍 Lake Merritt                                                     ★
//      6 playing now · mostly 3.5–4.0 · 2 friends
//
// One friends_at_courts() read under its own cache key (FRIENDS_COURTS_KEY,
// TTL 30 s, kept a day), apart from Home's main payload so homeData.ts stays
// untouched; refreshed every minute while Home is focused and the app is in
// the foreground. No Realtime. Tapping a court shows who's there underneath
// (court_presence, with the anonymous rows), or, with COURT_DISCOVERY_ENABLED,
// opens the court's page (which has that roster too).
//
// Hidden when nothing is live and no courts are known, and while
// FRIENDS_AT_COURTS_ENABLED is off. Guests get an empty payload from the
// server, so it never shows for them.
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CommonActions, useIsFocused, useNavigation } from '@react-navigation/native';
import { useCachedQuery } from '@just-messin-around/expo-foundation/cache';
import { usePollWhileActive } from '@just-messin-around/expo-foundation/hooks';
import { Panel, SectionHeader } from '@just-messin-around/expo-foundation/ui';
import { SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { COURT_DISCOVERY_ENABLED, FRIENDS_AT_COURTS_ENABLED } from '../../lib/features';
import { useTheme } from '../../lib/ThemeContext';
import { trackHomeTap } from '../../lib/analytics';
import {
  friendsCourtRow,
  isFriendsAtCourtsEmpty,
  liveOnly,
  orderPeople,
  yourCourtSubtitle,
  type FriendsAtCourts,
} from '../../lib/friendsAtCourts';
import { FRIENDS_COURTS_KEY, getFriendsAtCourts } from '../../data/courtPresence';
import EntityRow from '../EntityRow';
import { PlayersHereRoster, usePlayersHere } from '../PlayersHereList';
import CourtFavoriteStar from '../court/CourtFavoriteStar';

const POLL_MS = 60_000;
/** Roster rows under a tapped court before "+N more". */
const ROSTER_MAX_ROWS = 6;

export default function FriendsAtCourtsSection() {
  return FRIENDS_AT_COURTS_ENABLED ? <FriendsAtCourtsBody /> : null;
}

function FriendsAtCourtsBody() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const navigation = useNavigation();
  const focused = useIsFocused();
  const query = useCachedQuery<FriendsAtCourts>(FRIENDS_COURTS_KEY, () => getFriendsAtCourts(), {
    ttlMs: 30_000,
    persistMs: 24 * 60 * 60 * 1000,
  });
  usePollWhileActive(query.refresh, POLL_MS, focused ? 'friends-courts' : null);
  // Venue whose roster is open (one at a time).
  const [openId, setOpenId] = useState<string | null>(null);

  // Re-filtered on each new payload; the minute poll keeps it close enough.
  const data = useMemo(() => (query.data ? liveOnly(query.data, Date.now()) : undefined), [query.data]);
  if (!data || isFriendsAtCourtsEmpty(data)) return null;

  const toggle = (venueId: string, target: string, position: number) => {
    trackHomeTap({ section: 'friends_courts', target, position });
    if (COURT_DISCOVERY_ENABLED) {
      // Registered by the court discovery screens (same flag); by name.
      navigation.dispatch(CommonActions.navigate({ name: 'CourtDetail', params: { venueId } }));
      return;
    }
    setOpenId((cur) => (cur === venueId ? null : venueId));
  };

  return (
    <View style={S.wrap}>
      <SectionHeader
        title="Friends at the courts"
        action={{
          label: 'Friends ›',
          a11yLabel: 'See your friends',
          onPress: () => {
            trackHomeTap({ section: 'friends_courts', target: 'header' });
            // Registered by the Friends screen (same flag); by name, not typed here.
            navigation.dispatch(CommonActions.navigate({ name: 'Friends' }));
          },
        }}
      />
      <Panel padded={false}>
        {data.now.length === 0 ? (
          <Text style={[t.sub, S.none]}>No friends checked in right now.</Text>
        ) : (
          data.now.map((g, i) => {
            const row = friendsCourtRow(g);
            const open = openId === g.venue_id;
            return (
              <React.Fragment key={g.venue_id}>
                <EntityRow
                  kind="court"
                  layout="row"
                  glyph={orderPeople(g.people)[0]?.avatar_emoji || undefined}
                  title={row.title}
                  subtitle={row.subtitle}
                  trailingText={row.trailing}
                  chevron={false}
                  lastRow={i === data.now.length - 1 && !open}
                  onPress={() => toggle(g.venue_id, 'row', i)}
                />
                {open ? <Roster venueId={g.venue_id} /> : null}
              </React.Fragment>
            );
          })
        )}
      </Panel>

      {data.courts.length > 0 ? (
        <>
          <SectionHeader title="Your courts" />
          <Panel padded={false}>
            {data.courts.map((court, i) => {
              const open = openId === court.venue_id;
              return (
                <React.Fragment key={court.venue_id}>
                  <EntityRow
                    kind="court"
                    layout="row"
                    title={court.venue_name}
                    subtitle={yourCourtSubtitle(court)}
                    action={<CourtFavoriteStar venueId={court.venue_id} venueName={court.venue_name} />}
                    lastRow={i === data.courts.length - 1 && !open}
                    // Nobody there: nothing to open (a court's page always has something).
                    onPress={
                      COURT_DISCOVERY_ENABLED || court.here_now > 0 ? () => toggle(court.venue_id, 'court_row', i) : undefined
                    }
                  />
                  {open ? <Roster venueId={court.venue_id} /> : null}
                </React.Fragment>
              );
            })}
          </Panel>
        </>
      ) : null}
    </View>
  );
}

/** Who's at one court (named and anonymous), under its row. */
function Roster({ venueId }: { venueId: string }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const { players, failed } = usePlayersHere(venueId);
  return (
    <View style={S.roster}>
      {players ? (
        <PlayersHereRoster players={players} maxRows={ROSTER_MAX_ROWS} />
      ) : (
        <Text style={t.sub}>{failed ? "Couldn't load who's here." : 'Loading…'}</Text>
      )}
    </View>
  );
}

const S = StyleSheet.create({
  wrap: { gap: SPACE.xs },
  none: { paddingHorizontal: SPACE.md, paddingVertical: SPACE.md },
  roster: { paddingHorizontal: SPACE.md, paddingBottom: SPACE.sm },
});
