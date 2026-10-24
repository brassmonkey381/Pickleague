// A court's page (court discovery, Phase 1; state/court-discovery-plan.md):
// courts/<encoded venue id>. The one court screen (decision 6): Home's
// court card, Courts, a league's home court and Friends at the courts all open
// it. Laid out like Doggle's place page (DogPlaceDetailScreen): the header
// title is the court's name, then the facts, who's here, and the actions.
//
//   Lakeside Park                                                    ☆
//   1 Lakeside Dr, Oakland
//   1.2 mi · 6 courts
//   [Check in] [Directions] [Share]
//   6 playing now · mostly 3.5–4.0
//   [map: the court, its mapped outline drawn on it]
//   WHO'S HERE        (PlayersHereList)
//   ABOUT             (FactList: courts, surface, lights, hours, ...)
//   LEAGUES HERE      (the leagues the player can see)
//   Edit outline      (godmode only)
//
// Check in shows when there is no fix yet, or the last fix is within the
// fence + 150 m or inside the outline (lib/courtDiscovery courtPrimaryAction);
// otherwise Directions is the way there. It is the same flow as Home's card
// (lib/useCourtCheckIn). An alias id opens its facility, and the URL moves to
// the facility's id. A court that is gone says so (refusals 'view').
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
import { COURT_STARS_ENABLED, FRIENDS_AT_COURTS_ENABLED, PLAY_NAV_ENABLED, ROUTINES_ENABLED } from '../lib/features';
import { openPlayStart } from '../lib/playSession';
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
          directions={{ lat: court.lat, lng: court.lng }}
          onDirections={() => track('courts.directions', { primary })}
          actions={[
            // With the bottom bar (plan §7.6): "Play here" (play glyph) first, the
            // Play sheet with this court picked; Check in, Directions and Share follow.
            ...(PLAY_NAV_ENABLED
              ? [
                  {
                    key: 'play',
                    label: 'Play here',
                    iconName: 'play' as const,
                    variant: 'success' as const,
                    disabled: !!flow.busy,
                    onPress: () => {
                      track('courts.play_here', { primary, here });
                      openPlayStart({ venue: { id: court.id, name: court.name } });
                    },
                  },
                ]
              : []),
            ...(here
              ? [{ key: 'here', label: 'Checked in', iconName: 'check-mark' as const, onPress: () => {}, disabled: true, variant: PLAY_NAV_ENABLED ? ('outline' as const) : ('success' as const) }]
              : primary === 'check_in'
                ? [
                    {
                      key: 'checkin',
                      label: 'Check in',
                      iconName: 'pin' as const,
                      variant: PLAY_NAV_ENABLED ? ('outline' as const) : ('primary' as const),
                      loading: flow.busy === 'checkin',
                      disabled: !!flow.busy,
                      onPress: checkIn,
                    },
                  ]
                : []),
          ]}
          actionsSlot={
            <ShareLinkButton
              url={courtShareUrl(court.id)}
              title={court.name}
              message={`${court.name} on Pickleague`}
              onCopied={() => setCopied(true)}
              onShare={() => track('courts.share', { aliases: court.aliases.length })}
              style={S.share}
            />
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
        {ROUTINES_ENABLED && starredIds.has(court.id) ? (
          <TextLink
            label="Make it a routine"
            iconName="calendar"
            size="sub"
            onPress={() => navigation.navigate('Routines', { newVenue: { venueId: court.id, venueName: court.name } })}
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
