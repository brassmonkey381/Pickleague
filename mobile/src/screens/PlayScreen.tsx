import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../types';
import { useTheme } from '../lib/ThemeContext';
import LeaguesScreen from './LeaguesScreen';
import TournamentsScreen from './TournamentsScreen';

// "Play" hub: the Leagues and Tournaments lists as two selectable tabs. Each tab
// renders the existing screen unchanged — those screens only read optional
// route.params and use the shared stack `navigation` (no header setOptions), so
// they embed cleanly. Both stay mounted (visibility toggled) so each tab keeps
// its own filters/scroll when you switch back and forth.

type Tab = 'leagues' | 'tournaments';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Play'>;
  route: RouteProp<RootStackParamList, 'Play'>;
};

const TABS: { key: Tab; label: string }[] = [
  { key: 'leagues',     label: '🏆 Leagues' },
  { key: 'tournaments', label: '🎾 Tournaments' },
];

export default function PlayScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const [tab, setTab] = useState<Tab>(route.params?.initialTab ?? 'leagues');

  // The embedded screens want navigation typed to their own route name; the
  // underlying stack navigator is the same object, so a cast is safe.
  const nav = navigation as unknown as NativeStackNavigationProp<RootStackParamList, 'Leagues'>;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={S.tabBar}>
        {TABS.map(({ key, label }) => {
          const active = tab === key;
          return (
            <TouchableOpacity
              key={key}
              style={[S.tab, active && { borderBottomColor: colors.primary }]}
              onPress={() => setTab(key)}
              activeOpacity={0.8}
            >
              <Text style={[S.tabText, { color: active ? colors.primary : colors.textMuted }]}>
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={{ flex: 1, display: tab === 'leagues' ? 'flex' : 'none' }}>
        <LeaguesScreen
          navigation={nav}
          route={{ key: 'play-leagues', name: 'Leagues', params: undefined } as RouteProp<RootStackParamList, 'Leagues'>}
        />
      </View>
      <View style={{ flex: 1, display: tab === 'tournaments' ? 'flex' : 'none' }}>
        <TournamentsScreen
          navigation={nav as unknown as NativeStackNavigationProp<RootStackParamList, 'Tournaments'>}
          route={{ key: 'play-tournaments', name: 'Tournaments', params: {} } as RouteProp<RootStackParamList, 'Tournaments'>}
        />
      </View>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    tabBar: {
      flexDirection: 'row', backgroundColor: c.surface,
      borderBottomWidth: 1, borderBottomColor: c.border,
      paddingHorizontal: 12, gap: 8,
    },
    tab: {
      flex: 1, paddingVertical: 12, alignItems: 'center',
      borderBottomWidth: 2, borderBottomColor: 'transparent',
    },
    tabText: { fontSize: 14, fontWeight: '700' },
  });
}
