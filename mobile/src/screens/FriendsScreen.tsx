// Friends (docs/play-sessions-presence.md, Phase 1 step 5): mutual friends,
// the people who see you at the courts.
//
// Its body moved to Discover › Players (components/discover/PlayersPanel.tsx,
// state/feed-discover-play-plan.md §4). While Discover is on, the Friends
// route is an alias that replaces itself with Discover { tab: 'players' }
// (screens/DiscoverAliases.tsx), so this screen renders only with Discover
// off: the same panel, full screen. route.params.tab picks the view (a
// friend-request push says 'requests'); it is consumed once.
// Registered only while FRIENDS_AT_COURTS_ENABLED is on (AppNavigator).
import React from 'react';
import { View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { useTheme } from '../lib/ThemeContext';
import PlayersPanel from '../components/discover/PlayersPanel';
import type { RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Friends'>;
  route: RouteProp<RootStackParamList, 'Friends'>;
};

export default function FriendsScreen({ navigation, route }: Props) {
  const { colors: c } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <PlayersPanel
        navigation={navigation}
        view={route.params?.tab}
        onViewConsumed={() => navigation.setParams({ tab: undefined })}
      />
    </View>
  );
}
