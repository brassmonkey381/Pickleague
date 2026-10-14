// "Play" hub: the Leagues and Tournaments lists as two tabs (plan section 4,
// decision 3: two tabs until there are about 20 tournaments).
//
//   <  Home               Play            [+]   native header; each list owns the "+"
//      Leagues 4      |    Tournaments          44 underline toggle (role=tab), a 0 count hidden
//
// The tab lives in route params (`initialTab`), not in a useState copy: a copy
// ignored a later navigate('Play', { initialTab }) while Play was already in
// the stack. Taps write it back with setParams, so web refresh and Back keep
// the tab and the linking config (play?initialTab=) is unchanged.
//
// Both lists stay mounted (visibility toggled) so each keeps its search,
// scroll and paging when you switch back and forth. Each list takes `active`
// so only the visible one owns the header "+" and the spotlight-tour anchors.
//
// Params passed through to the lists:
//   - prefillInviteCode (invite_code push / links): the Leagues body opens
//     Join-with-Code, exactly like the standalone 'Leagues' route.
//   - mine === true (Home's spotlight links, "All my leagues" / "My
//     tournaments"): turns the Mine chip on for this visit only. Strict
//     `=== true`: on web the param round-trips through the URL as the string
//     'true', and a refreshed page must not re-apply it.
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { SegmentedToggle } from '@just-messin-around/expo-foundation/ui';
import { RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import { onTourStart } from '../lib/TourContext';
import { trackPlayTab, type PlayList } from '../lib/analytics';
import LeaguesScreen from './LeaguesScreen';
import TournamentsScreen from './TournamentsScreen';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Play'>;
  route: RouteProp<RootStackParamList, 'Play'>;
};

const TAB_LABELS: Record<PlayList, string> = { leagues: 'Leagues', tournaments: 'Tournaments' };

function tabOf(p: unknown): PlayList {
  return p === 'tournaments' ? 'tournaments' : 'leagues';
}

export default function PlayScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const tab = tabOf(route.params?.initialTab);
  const prefillInviteCode = route.params?.prefillInviteCode;

  const [counts, setCounts] = useState<Record<PlayList, number>>({ leagues: 0, tournaments: 0 });
  const onLeaguesCount = useCallback((n: number) => setCounts((c) => (c.leagues === n ? c : { ...c, leagues: n })), []);
  const onTournamentsCount = useCallback((n: number) => setCounts((c) => (c.tournaments === n ? c : { ...c, tournaments: n })), []);

  const selectTab = useCallback((next: PlayList) => {
    navigation.setParams({ initialTab: next });
  }, [navigation]);

  // Home's spotlight links ("All my leagues" / "My tournaments"): consume the
  // param into a token the lists turn into an in-memory Mine chip, then drop
  // it so a later visit with the same param fires again and a web refresh
  // doesn't keep it.
  const [routeMineToken, setRouteMineToken] = useState(0);
  useEffect(() => {
    if (route.params?.mine !== true) return;
    setRouteMineToken((n) => n + 1);
    navigation.setParams({ mine: undefined });
  }, [route.params?.mine, navigation]);

  // An invite code arriving while Tournaments is showing: Join-with-Code
  // lives on the Leagues body, so bring it forward.
  useEffect(() => {
    if (prefillInviteCode && tab !== 'leagues') selectTab('leagues');
  }, [prefillInviteCode, tab, selectTab]);

  // The leagues tour (search -> join) runs on the Leagues body.
  useEffect(() => onTourStart((key) => { if (key === 'leagues') selectTab('leagues'); }), [selectTab]);

  // The embedded screens want navigation typed to their own route name; the
  // underlying stack navigator is the same object, so a cast is safe.
  const nav = navigation as unknown as NativeStackNavigationProp<RootStackParamList, 'Leagues'>;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SegmentedToggle<PlayList>
        variant="underline"
        options={(['leagues', 'tournaments'] as const).map((k) => ({ value: k, label: TAB_LABELS[k], count: counts[k] }))}
        value={tab}
        onChange={(next) => {
          if (next === tab) return;
          trackPlayTab(next);
          selectTab(next);
        }}
        style={{ backgroundColor: colors.surface }}
      />

      <View style={{ flex: 1, display: tab === 'leagues' ? 'flex' : 'none' }}>
        <LeaguesScreen
          navigation={nav}
          route={{ key: 'play-leagues', name: 'Leagues', params: prefillInviteCode ? { prefillInviteCode } : undefined } as RouteProp<RootStackParamList, 'Leagues'>}
          active={tab === 'leagues'}
          routeMineToken={routeMineToken}
          onCount={onLeaguesCount}
        />
      </View>
      <View style={{ flex: 1, display: tab === 'tournaments' ? 'flex' : 'none' }}>
        <TournamentsScreen
          navigation={nav as unknown as NativeStackNavigationProp<RootStackParamList, 'Tournaments'>}
          route={{ key: 'play-tournaments', name: 'Tournaments', params: {} } as RouteProp<RootStackParamList, 'Tournaments'>}
          active={tab === 'tournaments'}
          routeMineToken={routeMineToken}
          onCount={onTournamentsCount}
          onBrowseLeagues={() => selectTab('leagues')}
        />
      </View>
    </View>
  );
}
