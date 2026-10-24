// A court's page (court discovery, Phase 1; state/court-discovery-plan.md):
// courts/<encoded venue id>. The one court screen (decision 6): Home's
// court card, Courts, a league's home court and Friends at the courts all open
// it. Laid out like Doggle's place page (DogPlaceDetailScreen): the header
// title is the court's name, then the facts, who's here, and the actions.
//
//   Lakeside Park                                                    ☆
//   1 Lakeside Dr, Oakland
//   1.2 mi · 6 courts
//   [Check in ▾] [Directions] [Share]        ([Check out] once checked in here)
//   6 playing now · mostly 3.5–4.0
//   [map: the court, its mapped outline drawn on it]
//   WHO'S HERE        (PlayersHereList)
//   ABOUT             (FactList: courts, surface, lights, hours, ...)
//   LEAGUES HERE      (the leagues the player can see)
//   Edit outline      (godmode only)
//
// "Check in ▾" is the feed court card's one control (the user, 2026-10-24:
// "A simple 'Check In' button covers all the bases"; components/feed/
// useCheckinOptions): Check in now, Check in and tell friends, On my way
// (friends to tell; every friend starts ticked), Plan a check-in for later
// (a day and a time: AppDateTimePicker, as Doggle's place page plans with a
// DateTimeField), Make this a routine (a starred court). It shows
// even far from the court, as Doggle's does: a check-in from too far says
// why, and the note under the buttons says to check in once there (no fix
// within the fence + 150 m or the outline: lib/courtDiscovery
// courtPrimaryAction). Check in now is this page's own flow
// (lib/useCourtCheckIn), so its notes show here. Every check-in starts the
// play session; the island switches its mode. Checked in here, the page
// offers Check out (it ends the session too), the plan line and, at a
// starred court, Make this a routine (Check in ▾ is gone then). An alias id
// opens its facility, and the URL moves to the facility's id. A court that
// is gone says so (refusals 'view').
//
// The map (Phase 2) is Doggle's place map: the foundation PlaceMap, interactive
// on every platform (lib/maps), with the court's outline (venues.boundary) as
// rings. It sits in an ErrorBoundary: a map that fails leaves the page whole.
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { setQueryData } from '@just-messin-around/expo-foundation/cache';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { openDirections } from '@just-messin-around/expo-foundation/platform/location';
import {
  Badge,
  ErrorBoundary,
  ErrorState,
  FactList,
  Panel,
  PlaceHeader,
  QueryState,
  SectionHeader,
  TextLink,
  type FactRow,
} from '@just-messin-around/expo-foundation/ui';
import { PlaceMap } from '@just-messin-around/expo-foundation/ui/maps';
import { SPACE, SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { track } from '../lib/analytics';
import { checkGodmode } from '../lib/godmode';
import { explainRefusal } from '../lib/refusalNotices';
import { checkinChanged, peekCurrentCheckin, type CurrentCheckin } from '../lib/courtCheckin';
import { useCourtCheckIn } from '../lib/useCourtCheckIn';
import { googleMapsKey, hasGoogleMaps, placeMapMode } from '../lib/maps';
import { COURT_STARS_ENABLED, FRIENDS_AT_COURTS_ENABLED, ROUTINES_ENABLED } from '../lib/features';
import {
  courtCrowdText,
  courtDistanceLabel,
  courtFactChips,
  courtOutlineRings,
  courtPrimaryAction,
  courtShareUrl,
  metersBetween,
  type CourtDetail,
} from '../lib/courtDiscovery';
import { courtKey, useCourt, useCourtCrowds } from '../data/courtDiscovery';
import { usePlayLocation } from '../components/play/usePlayLocation';
import CourtFavoriteStar from '../components/court/CourtFavoriteStar';
import CrowdLine, { useOpenToPlay } from '../components/court/CrowdLine';
import CheckinPlanLine from '../components/routines/CheckinPlanLine';
import { useCourtFavoriteIds } from '../data/courtFavorites';
import CourtCheckInNotes from '../components/court/CourtCheckInNotes';
import PlayersHereList from '../components/PlayersHereList';
import ShareLinkButton from '../components/ShareLinkButton';
import { useCheckinOptions } from '../components/feed/useCheckinOptions';
import EntityRow from '../components/EntityRow';
import type { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'CourtDetail'>;

export default function CourtDetailScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  const venueId = route.params.venueId;
  const q = useCourt(venueId);
  const court = q.data;

  useEffect(() => {
    if (court) navigation.setOptions({ title: court.name });
  }, [court, navigation]);

  // An alias (an old link, a league's old home court): the facility's page,
  // under its own id, so the URL and the cache agree.
  useEffect(() => {
    if (court && court.id !== venueId) {
      setQueryData(courtKey(court.id), court);
      navigation.setParams({ venueId: court.id });
    }
  }, [court, venueId, navigation]);

  useEffect(() => {
    if (court && court.id === venueId) {
      track('courts.view', { leagues: court.leagues.length, aliases: court.aliases.length, outline: court.has_boundary });
    }
    // Once per court shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [court?.id]);

  return (
    <View style={[S.fill, { backgroundColor: c.bg }]}>
      <QueryState
        query={q}
        loadingLabel="Loading the court…"
        renderError={(e, retry) => (
          // Not 'offline': a court that is gone fails here too (refusals 'view').
          <ErrorState
            iconName="pin"
            error={e}
            message={`Couldn't open this court. ${explainRefusal(e, 'Try again.', { action: 'view' })}`}
            onRetry={retry}
          />
        )}
      >
        {(data) => <CourtPage court={data} navigation={navigation} />}
      </QueryState>
    </View>
  );
}

function CourtPage({ court, navigation }: { court: CourtDetail; navigation: Props['navigation'] }) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const focused = useIsFocused();
  const { coords } = usePlayLocation();
  const [copied, setCopied] = useState(false);
  const [godmode, setGodmode] = useState(false);
  const [current, setCurrent] = useState<CurrentCheckin | null>(null);

  useEffect(() => {
    let on = true;
    void checkGodmode().then((g) => on && setGodmode(g));
    void peekCurrentCheckin().then((cur) => on && setCurrent(cur));
    return () => {
      on = false;
    };
  }, []);
  useSignal(checkinChanged, setCurrent);

  const flow = useCourtCheckIn({ onCheckedIn: setCurrent, onCurrent: setCurrent });
  const crowd = useCourtCrowds([court.id], focused);
  const crowdNow = crowd.data[court.id];
  const openNow = useOpenToPlay(court.id);
  const starredIds = useCourtFavoriteIds(ROUTINES_ENABLED);

  // The last fix this page knows: one the check-in just took, else the
  // device location Play already has (never a prompt).
  const fix = flow.lastFix.current ?? coords;
  const here = current != null && current.venueId === court.id;
  const primary = courtPrimaryAction(court, fix);
  const distance = fix ? courtDistanceLabel(metersBetween(fix, court)) : null;

  const checkIn = useCallback(() => {
    track('courts.checkin_tap', { primary });
    void flow.checkIn({ id: court.id, name: court.name });
  }, [flow, court.id, court.name, primary]);

  // The one "Check in ▾" (the feed court card's): Check in now, Check in and
  // tell friends, On my way, Plan a check-in for later, Make this a routine;
  // Check out once checked in here.
  const options = useCheckinOptions({
    from: 'court',
    // This page isn't one day's: "Plan a check-in for later" picks a day and a time.
    planPicker: 'datetime',
    checkIn,
    openRoutines: (ct) => navigation.navigate('Routines', { newVenue: { venueId: ct.venueId, venueName: ct.venueName } }),
    onTap: (option) => track('courts.checkin_option', { option, primary }),
  });
  const starred = starredIds.has(court.id);
  const directionsTo = Number.isFinite(court.lat) && Number.isFinite(court.lng) ? { lat: court.lat, lng: court.lng } : null;

  const facts: FactRow[] = [
    { key: 'courts', label: 'Courts', value: court.court_count },
    { key: 'surface', label: 'Surface', value: court.surface, display: court.surface ? cap(court.surface) : null },
    { key: 'indoor', label: 'Indoor', value: court.indoor },
    { key: 'lit', label: 'Lights', value: court.lit },
    { key: 'covered', label: 'Covered', value: court.covered },
    { key: 'access', label: 'Access', value: court.access, display: court.access ? accessLabel(court.access) : null },
    { key: 'fee', label: 'Cost', value: court.fee, display: court.fee == null ? null : court.fee ? 'Fee' : 'Free' },
    { key: 'hours', label: 'Hours', value: court.opening_hours },
    { key: 'website', label: 'Website', value: court.website },
    { key: 'phone', label: 'Phone', value: court.phone },
  ];
  const address = [court.address, court.address && court.city && court.address.includes(court.city) ? null : court.city]
    .filter(Boolean)
    .join(', ');
  const chips = courtFactChips(court);

  return (
    <ScrollView contentContainerStyle={S.content}>
      <Panel>
        <PlaceHeader
          title={court.name}
          subtitle={address || null}
          meta={[distance]}
          trailing={COURT_STARS_ENABLED ? <CourtFavoriteStar venueId={court.id} venueName={court.name} /> : undefined}
          badges={
            chips.length > 0 || court.unconfirmed ? (
              <View style={S.chips}>
                {chips.map((label) => (
                  <Badge key={label} label={label} iconName={label === 'Indoor' ? 'indoor' : undefined} />
                ))}
                {court.unconfirmed ? <Badge label="Unconfirmed" tone="warning" /> : null}
              </View>
            ) : undefined
          }
          // The page's main control first, then Directions and Share, all
          // in the slot: PlaceHeader puts its own Directions first and its
          // actions have no options chevron yet (FOUNDATION FOLLOW-UP:
          // PlaceHeaderAction `options` and a primary action before
          // Directions; then these go back to `actions` + `directions`).
          actionsSlot={
            <>
              {here ? (
                <Button
                  size="sm"
                  variant="outline"
                  iconName="logout"
                  title="Check out"
                  loading={options.busy === 'out'}
                  disabled={options.busy != null}
                  onPress={() => void options.checkOut(current)}
                  accessibilityLabel={`Check out of ${court.name}`}
                />
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  iconName="chevron-down"
                  iconPosition="trailing"
                  title="Check in"
                  loading={flow.busy === 'checkin'}
                  disabled={!!flow.busy}
                  onPress={() => {
                    track('courts.checkin_options', { primary });
                    options.openCheckin({ venueId: court.id, venueName: court.name, starred });
                  }}
                  accessibilityLabel={`Check in at ${court.name}: options`}
                />
              )}
              {directionsTo ? (
                <Button
                  size="sm"
                  variant="outline"
                  iconName="map"
                  title="Directions"
                  onPress={() => {
                    track('courts.directions', { primary });
                    void openDirections(directionsTo.lat, directionsTo.lng);
                  }}
                />
              ) : null}
              <ShareLinkButton
                url={courtShareUrl(court.id)}
                title={court.name}
                message={`${court.name} on Pickleague`}
                onCopied={() => setCopied(true)}
                onShare={() => track('courts.share', { aliases: court.aliases.length })}
                style={S.share}
              />
            </>
          }
        />
        {copied ? <Text style={[t.sub, S.gapXs]}>Link copied.</Text> : null}
        {primary === 'directions' && !here ? (
          <Text style={[t.sub, S.gapXs]}>You're not at this court. Check in once you get there.</Text>
        ) : null}
        <CourtCheckInNotes flow={flow} />
        {here && current ? (
          <CheckinPlanLine checkinId={current.queued ? null : current.id} venueName={court.name} style={S.gapXs} />
        ) : null}
        {courtCrowdText(crowdNow, { friendsEnabled: FRIENDS_AT_COURTS_ENABLED }) ? (
          <CrowdLine venueId={court.id} venueName={court.name} crowd={crowdNow} openNow={openNow} />
        ) : null}
        {/* Checked in here, Check out takes Check in ▾'s place: its "Make
            this a routine" stays a tap away (the likeliest moment to set one up). */}
        {here && ROUTINES_ENABLED && starred ? (
          <TextLink
            label="Make this a routine"
            iconName="calendar-event"
            size="sub"
            onPress={() => {
              track('courts.checkin_option', { option: 'makeRoutine', primary });
              navigation.navigate('Routines', { newVenue: { venueId: court.id, venueName: court.name } });
            }}
            accessibilityHint="Plan a weekly check-in at this court"
          />
        ) : null}
      </Panel>

      <CourtMap court={court} />

      <SectionHeader title="Who's here" />
      <Panel>
        <PlayersHereList venueId={court.id} venueName={court.name} />
      </Panel>

      <SectionHeader title="About" />
      <Panel>
        <FactList rows={facts} hideUnknown copy={{ empty: 'No details for this court yet.' }} />
        {court.attribution ? (
          <Text style={[t.hint, S.gapXs]} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            {court.attribution}
          </Text>
        ) : null}
      </Panel>

      {court.leagues.length > 0 ? (
        <>
          <SectionHeader title="Leagues here" count={String(court.leagues.length)} />
          <Panel padded={false}>
            {court.leagues.map((l, i) => (
              <EntityRow
                key={l.id}
                kind="league"
                layout="row"
                title={l.name}
                lastRow={i === court.leagues.length - 1}
                onPress={() => navigation.navigate('LeagueDetail', { leagueId: l.id, leagueName: l.name })}
              />
            ))}
          </Panel>
        </>
      ) : null}

      {godmode ? (
        <TextLink
          label="Edit outline"
          iconName="wrench"
          onPress={() => navigation.navigate('AdminBoundaryEditor', { venueId: court.id })}
        />
      ) : null}
      {/* Check in ▾'s sheet and On my way. */}
      {options.elements}
    </ScrollView>
  );
}

/** The court on a map, its outline drawn when it has one. Nothing if the map can't draw. */
function CourtMap({ court }: { court: CourtDetail }) {
  const mode = placeMapMode();
  const rings = React.useMemo(() => courtOutlineRings(court.boundary), [court.boundary]);
  // Interactive maps are free; only the static image needs a key (Doggle's rule).
  if (mode === 'static' && !hasGoogleMaps) return null;
  return (
    <ErrorBoundary fallback={() => null}>
      <PlaceMap
        lat={court.lat}
        lng={court.lng}
        apiKey={googleMapsKey}
        mode={mode}
        height={200}
        boundary={rings.length > 0 ? rings : undefined}
        interactive
      />
    </ErrorBoundary>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

function accessLabel(a: string): string {
  switch (a) {
    case 'yes':
    case 'public':
      return 'Public';
    case 'private':
      return 'Private';
    case 'customers':
      return 'Customers only';
    case 'members':
      return 'Members only';
    case 'permissive':
      return 'Open to the public';
    default:
      return cap(a);
  }
}

const S = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs },
  share: { alignSelf: 'center' },
  gapXs: { marginTop: SPACE.xs },
});
