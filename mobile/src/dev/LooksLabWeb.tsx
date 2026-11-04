// Dev-only web page of the shared parts in the current look, for visual QA of
// the redesign: buttons, chips, filter pills, switches, section headers, cards,
// grouped rows, a headline number, an empty state, a toast and a sheet. Reached
// only on a dev web server at /?lookslab (index.ts checks __DEV__ first). The
// look and mode come from the saved settings (Settings, Look), so set
// localStorage 'pickleague_theme_mode_skin' and 'pickleague_theme_mode' to
// switch. Query: sheet=1 opens the sheet, toast=1 shows a success toast.
import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import {
  AppTopBar,
  BrandBand,
  FloatingNavBar,
  BottomSheet,
  Chip,
  EmptyState,
  FilterPill,
  HeadlineStat,
  ListGroup,
  Panel,
  SectionHeader,
  SegmentedToggle,
  SkinPicker,
} from '@just-messin-around/expo-foundation/ui';
import { Button } from '@just-messin-around/expo-foundation/forms';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { ThemeProvider, useTheme } from '../lib/ThemeContext';
import ToastProvider, { useToast } from '../lib/ToastProvider';
import { useBootLook } from '../lib/fonts';
import { DayBands, dayBandDate, dayBandTile } from '@just-messin-around/expo-foundation/ui/feed';
import HomeGreeting from '../components/home/HomeGreeting';
import QuickRow from '../components/home/QuickRow';
import type { Profile } from '../types';

const PEOPLE = [
  ['Sam Ortiz', 'Alameda Ladder', '4.12'],
  ['Priya Nair', 'Alameda Ladder', '3.98'],
  ['Leo Park', 'Thursday Doubles', '3.75'],
];

function Lab() {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const toast = useToast();
  const [seg, setSeg] = useState('league');
  const [sheet] = useState(() => new URLSearchParams(window.location.search).get('sheet') === '1');
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('toast') === '1') toast.success('Match recorded, +120 pickles');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 120 }}>
      <BrandBand>
        <AppTopBar
          title={<Text style={[t.h3, { color: c.headerText }]}>Pickleague</Text>}
          style={{ backgroundColor: 'transparent' }}
          iconSize={24}
          iconColor={c.headerText}
          actions={[
            { key: 'bell', icon: 'bell', a11yLabel: 'Notifications', badge: 2, onPress: () => {} },
            { key: 'gear', icon: 'gear', a11yLabel: 'Settings', onPress: () => {} },
          ]}
        />
        <HomeGreeting
          variant="band"
          profile={{ full_name: 'Brian Lab', pickles: 53601 } as unknown as Profile}
          streak={11}
          onProfile={() => {}}
          onBalance={() => {}}
          onStreak={() => {}}
        />
      </BrandBand>
      <View style={{ padding: 16, gap: 14 }}>
      <QuickRow showRecord onPress={() => {}} />
      <Panel>
        <DayBands
          bands={(['today', 'tomorrow', 'later'] as const).map((k) => ({
            key: k,
            title: k === 'today' ? 'Today' : k === 'tomorrow' ? 'Tomorrow' : 'Later this week',
            date: dayBandDate(k, Date.now()),
            tile: dayBandTile(k, Date.now()),
            count: k === 'later' ? 1 : 0,
            children: <Text style={t.sub}>The Hub Sports Club, nothing planned</Text>,
          }))}
        />
      </Panel>
      <Text style={t.h1}>Looks lab</Text>
      <SkinPicker />
      <SectionHeader title="Buttons" />
      <Button title="Record match" iconName="check" onPress={() => {}} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button title="Invite" variant="outline" size="sm" onPress={() => {}} style={{ alignSelf: 'flex-start' }} />
        <Button title="Join" size="sm" onPress={() => {}} style={{ alignSelf: 'flex-start' }} />
        <Button title="Leave" variant="danger" size="sm" onPress={() => {}} style={{ alignSelf: 'flex-start' }} />
      </View>
      <SectionHeader title="Your leagues" size="title" action={{ label: 'See all', onPress: () => {} }} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Chip label="Singles" selected onPress={() => {}} />
        <Chip label="Doubles" onPress={() => {}} />
        <Chip label="Going" tone="success" />
        <Chip label="Full" tone="danger" variant="solid" />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        <FilterPill label="This week" active onPress={() => {}} />
        <FilterPill label="Alameda" count={4} onPress={() => {}} />
      </View>
      <SegmentedToggle
        options={[{ label: 'League', value: 'league' }, { label: 'Overall', value: 'overall' }, { label: 'Singles', value: 'singles' }]}
        value={seg}
        onChange={setSeg}
        fullWidth
      />
      <Panel>
        <HeadlineStat label="PLUPR" value="4.18" delta="+0.15" sub="23 wins, 11 losses" />
      </Panel>
      <ListGroup>
        {PEOPLE.map(([n, l, r]) => (
          <View key={n} style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={t.title}>{n}</Text>
              <Text style={t.sub}>{l}</Text>
            </View>
            <Text style={[t.h3]}>{r}</Text>
          </View>
        ))}
      </ListGroup>
      <Panel padded={false}>
        <EmptyState title="No matches yet" subtitle="Record your first match to get a PLUPR." actionLabel="Record match" onAction={() => {}} />
      </Panel>
      <BottomSheet visible={sheet} onClose={() => {}} title="Check in at The Hub">
        <Text style={t.body}>Friends see you're here for about 2 hours.</Text>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          <Button title="Cancel" variant="outline" onPress={() => {}} style={{ flex: 1 }} />
          <Button title="Check in" onPress={() => {}} style={{ flex: 1 }} />
        </View>
      </BottomSheet>
      </View>
    </ScrollView>
    <FloatingNavBar
      items={[
        { key: 'home', label: 'Home', icon: 'home', active: true, onPress: () => {} },
        { key: 'saved', label: 'Saved', icon: 'bookmark', onPress: () => {} },
        { key: 'discover', label: 'Discover', icon: 'search', onPress: () => {} },
        { key: 'me', label: 'Me', icon: 'account', onPress: () => {} },
      ]}
      centre={{ key: 'play', label: 'Play', icon: 'play', onPress: () => {} }}
      publishInset={false}
    />
    </View>
  );
}

export default function LooksLabWeb() {
  const ready = useBootLook();
  if (!ready) return null;
  return (
    <ThemeProvider>
      <ToastProvider>
        <Lab />
      </ToastProvider>
    </ThemeProvider>
  );
}
