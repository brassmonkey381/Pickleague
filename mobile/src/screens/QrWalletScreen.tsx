// QR wallet: save the QR code a club asks for at the front desk, tied to its
// court. With court arrival alerts on, walking up to that court posts a
// notice whose tap opens the code full screen (QrPass). Codes stay on this
// phone (lib/qrWallet).
import React, { useCallback, useState } from 'react';
import { View, Text, Image, ScrollView, Pressable, StyleSheet, Platform } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { Panel, SectionHeader, ConfirmModal } from '@just-messin-around/expo-foundation/ui';
import { Button, TextField } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { RootStackParamList } from '../types';
import EmptyState from '../components/EmptyState';
import CourtPicker, { type CourtResult } from '../components/CourtPicker';
import { addPass, getPassImage, listPasses, removePass, type WalletPass } from '../lib/qrWallet';
import { getCourtAlertsEnabled, setCourtAlertsEnabled, syncCourtGeofences } from '../lib/courtGeofence';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'QrWallet'> };

const NATIVE = Platform.OS !== 'web';
const ALWAYS_LABEL = Platform.OS === 'android' ? 'Allow all the time' : 'Always';

export default function QrWalletScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const toast = useToast();
  const [passes, setPasses] = useState<WalletPass[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [alertsOn, setAlertsOn] = useState(false);
  const [alertsBusy, setAlertsBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('Front desk check-in');
  const [court, setCourt] = useState<CourtResult | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<WalletPass | null>(null);

  async function load() {
    const list = await listPasses();
    setPasses(list);
    const pairs = await Promise.all(list.map(async (p) => [p.id, await getPassImage(p.id)] as const));
    setThumbs(Object.fromEntries(pairs.filter((x): x is readonly [string, string] => !!x[1])));
    if (NATIVE) setAlertsOn(await getCourtAlertsEnabled());
  }

  useFocusEffect(useCallback(() => { void load(); }, []));

  async function pickImage() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      // Crop to the code: smaller to store, and nothing else on screen at the desk.
      allowsEditing: true,
      quality: 0.7,
      base64: true,
    });
    if (result.canceled) return;
    const a = result.assets[0];
    // Web hands back a data URI as the uri; native gives base64.
    const uri = a.base64 ? `data:${a.mimeType ?? 'image/jpeg'};base64,${a.base64}` : a.uri;
    if (!uri.startsWith('data:')) {
      toast.error("Couldn't read that image. Try another.");
      return;
    }
    setImage(uri);
  }

  async function turnOnAlerts(): Promise<boolean> {
    setAlertsBusy(true);
    try {
      const n = await setCourtAlertsEnabled(true);
      if (n === 0) {
        await setCourtAlertsEnabled(false);
        toast.error(`Arrival alerts need location set to "${ALWAYS_LABEL}". Change it in your phone's Settings for Pickleague.`);
        return false;
      }
      setAlertsOn(true);
      return true;
    } catch {
      await setCourtAlertsEnabled(false).catch(() => 0);
      toast.error("Couldn't turn on arrival alerts. Try again in Settings > Court Arrival Alerts.");
      return false;
    } finally {
      setAlertsBusy(false);
    }
  }

  async function save() {
    if (!court || !image) return;
    setSaving(true);
    try {
      await addPass(
        {
          label: label.trim() || 'QR code',
          venueId: court.catalogId ?? null,
          venueName: court.name,
          lat: court.lat,
          lng: court.lng,
        },
        image,
      );
      setAdding(false);
      setCourt(null);
      setImage(null);
      setLabel('Front desk check-in');
      if (NATIVE) {
        if (alertsOn) await syncCourtGeofences();
        else await turnOnAlerts();
      }
      toast.success(`Saved. ${NATIVE ? `It pops up when you arrive at ${court.name}.` : 'Open it here at the desk.'}`);
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Couldn't save the QR code.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmRemove() {
    const p = removing;
    setRemoving(null);
    if (!p) return;
    await removePass(p.id);
    if (NATIVE && alertsOn) await syncCourtGeofences();
    await load();
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={styles.content}>
      <Text style={[styles.intro, { color: c.textSub }]}>
        Save the QR code your club scans at the front desk. When you arrive, tap the notification and the code opens full
        screen. Codes stay on this phone.
      </Text>

      {NATIVE && !alertsOn && passes.length > 0 ? (
        <Panel>
          <Text style={[styles.body, { color: c.text }]}>
            Arrival alerts are off, so these codes won't pop up when you get to the court.
          </Text>
          <Button title="Turn on arrival alerts" onPress={() => void turnOnAlerts()} loading={alertsBusy} size="sm" style={styles.start} />
        </Panel>
      ) : null}

      {passes.length === 0 && !adding ? (
        <EmptyState
          icon="🎟️"
          title="No QR codes yet"
          subtitle="Add the code your club asks for, and pick its court."
          actionLabel="Add a QR code"
          onAction={() => setAdding(true)}
        />
      ) : null}

      {passes.length > 0 ? (
        <>
          <SectionHeader title="Your codes" />
          {passes.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => navigation.navigate('QrPass', { passId: p.id })}
              onLongPress={() => setRemoving(p)}
              style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}
              accessibilityRole="button"
              accessibilityLabel={`${p.label} at ${p.venueName}. Open the code`}
            >
              {thumbs[p.id] ? <Image source={{ uri: thumbs[p.id] }} style={styles.thumb} /> : <View style={styles.thumb} />}
              <View style={styles.flex}>
                <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>{p.venueName}</Text>
                <Text style={[styles.sub, { color: c.textSub }]} numberOfLines={1}>{p.label}</Text>
              </View>
              <Pressable onPress={() => setRemoving(p)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${p.label}`}>
                <Text style={[styles.remove, { color: c.textSub }]}>Remove</Text>
              </Pressable>
            </Pressable>
          ))}
        </>
      ) : null}

      {adding ? (
        <Panel>
          <SectionHeader title="Add a QR code" />
          <Text style={[styles.step, { color: c.text }]}>1. The court</Text>
          <CourtPicker value={court} onSelect={setCourt} active={adding} placeholder="Search for your club or court..." />
          <Text style={[styles.step, { color: c.text }]}>2. The code</Text>
          {image ? (
            <Pressable onPress={() => void pickImage()} accessibilityRole="button" accessibilityLabel="Pick a different image">
              <Image source={{ uri: image }} style={styles.preview} resizeMode="contain" />
            </Pressable>
          ) : (
            <Button title="Choose from photos" variant="outline" onPress={() => void pickImage()} />
          )}
          <TextField label="What it's for" value={label} onChangeText={setLabel} maxLength={60} />
          <View style={styles.actions}>
            <Button title="Cancel" variant="outline" onPress={() => setAdding(false)} style={styles.flex} />
            <Button title="Save" onPress={() => void save()} loading={saving} disabled={!court || !image} style={styles.flex} />
          </View>
        </Panel>
      ) : passes.length > 0 ? (
        <Button title="Add another QR code" variant="outline" onPress={() => setAdding(true)} />
      ) : null}

      <ConfirmModal
        visible={!!removing}
        title="Remove this QR code?"
        body={removing ? `${removing.label} at ${removing.venueName} is deleted from this phone.` : ''}
        primaryLabel="Remove"
        variant="danger"
        onConfirm={() => void confirmRemove()}
        onClose={() => setRemoving(null)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl * 2 },
  intro: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 14, lineHeight: 20 },
  start: { alignSelf: 'flex-start', marginTop: SPACE.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  thumb: { width: 48, height: 48, borderRadius: 6, backgroundColor: '#fff' },
  flex: { flex: 1 },
  title: { fontSize: 15, fontWeight: FONT.weight.semibold },
  sub: { fontSize: 13, marginTop: 2 },
  remove: { fontSize: 13 },
  step: { fontSize: 14, fontWeight: FONT.weight.semibold, marginTop: SPACE.md, marginBottom: SPACE.sm },
  preview: { width: '100%', height: 220, backgroundColor: '#fff', borderRadius: RADIUS.md },
  actions: { flexDirection: 'row', gap: SPACE.md, marginTop: SPACE.md },
});
