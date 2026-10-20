// QR wallet: save the QR code a club asks for at the front desk, tied to its
// court. With "Show these codes when I arrive" on (this phone; on unless
// turned off) and location set to "Always", walking up to that court posts a
// notice whose tap opens the code full screen (QrPass). Saving a code is one
// of the moments Pickleague asks for "Always" (decision D2). Codes stay on
// this phone (lib/qrWallet). My invite link sits on top as a built-in code.
import React, { useCallback, useState } from 'react';
import { View, Text, Image, ScrollView, Pressable, StyleSheet, Platform } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { Panel, SectionHeader, ConfirmModal, QrCode, SettingSwitchRow } from '@just-messin-around/expo-foundation/ui';
import { Button, TextField } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { RootStackParamList } from '../types';
import EmptyState from '../components/EmptyState';
import CourtPicker, { type CourtResult } from '../components/CourtPicker';
import { addPass, getPassImage, INVITE_PASS_ID, inviteUrl, listPasses, removePass, type WalletPass } from '../lib/qrWallet';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import {
  getWalletArrivalCodesOn,
  setWalletArrivalCodesOn,
  syncCourtGeofences,
  type CourtGeofenceSyncResult,
} from '../lib/courtGeofence';
import { ALWAYS_LABEL, arrivalSyncMessage, askForArrivalLocation, backgroundLocationAllowed } from '../lib/courtArrivalAsk';
import { courtArrivalResync } from '../data/courtArrival';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'QrWallet'> };

const NATIVE = Platform.OS !== 'web';

/** What saving a code came to, said in one toast: where it shows up, or why not yet. */
function savedMessage(courtName: string, r: CourtGeofenceSyncResult | null): { ok: boolean; message: string } {
  if (!r) return { ok: true, message: 'Saved. Open it here at the desk.' };
  if (r.reason === 'ok') return { ok: true, message: `Saved. It pops up when you arrive at ${courtName}.` };
  return { ok: false, message: `Saved. ${arrivalSyncMessage(r).message}` };
}

export default function QrWalletScreen({ navigation }: Props) {
  const { colors: c } = useTheme();
  const toast = useToast();
  const [passes, setPasses] = useState<WalletPass[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  // "Show these codes when I arrive" (this phone), and whether the OS lets it
  // (null: not known yet, or web).
  const [codesOn, setCodesOn] = useState(true);
  const [alwaysAllowed, setAlwaysAllowed] = useState<boolean | null>(null);
  const [codesBusy, setCodesBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('Front desk check-in');
  const [court, setCourt] = useState<CourtResult | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<WalletPass | null>(null);

  async function load() {
    setMeId(await currentUserId(supabase).catch(() => null));
    const list = await listPasses();
    setPasses(list);
    const pairs = await Promise.all(list.map(async (p) => [p.id, await getPassImage(p.id)] as const));
    setThumbs(Object.fromEntries(pairs.filter((x): x is readonly [string, string] => !!x[1])));
    if (NATIVE) {
      setCodesOn(await getWalletArrivalCodesOn());
      setAlwaysAllowed(await backgroundLocationAllowed());
    }
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

  // The switch is this phone's choice and stays as set; turning it on also
  // asks for "Always" when it's missing, and says so if the OS still says no.
  async function toggleCodes(on: boolean) {
    setCodesBusy(true);
    try {
      const r = await setWalletArrivalCodesOn(on, { interactive: on });
      setCodesOn(on);
      setAlwaysAllowed(await backgroundLocationAllowed());
      if (!on) {
        toast.success("These codes won't pop up when you arrive.");
        return;
      }
      if (r.reason === 'ok') toast.success('These codes pop up when you arrive.');
      else toast.error(arrivalSyncMessage(r).message);
    } finally {
      setCodesBusy(false);
    }
  }

  // "Always" is missing: the OS sheets (if it still shows them), then the
  // watched courts again.
  async function allowAlways() {
    setCodesBusy(true);
    try {
      const m = arrivalSyncMessage(await askForArrivalLocation());
      setAlwaysAllowed(await backgroundLocationAllowed());
      if (m.ok) toast.success('These codes pop up when you arrive.');
      else toast.error(m.message);
    } finally {
      setCodesBusy(false);
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
      // Watch the new code's court, asking for "Always" if it's missing. With
      // the switch off (or on web) it just waits here for the desk.
      const r = NATIVE && codesOn ? await syncCourtGeofences({ interactive: true }) : null;
      const m = savedMessage(court.name, r);
      if (m.ok) toast.success(m.message);
      else toast.error(m.message);
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
    // Stop watching its court (CourtArrivalHost re-picks, no permission sheet).
    if (NATIVE && codesOn) courtArrivalResync.emit();
    await load();
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={styles.content}>
      <Text style={[styles.intro, { color: c.textSub }]}>
        Save the QR code your club scans at the front desk. When you arrive, tap the notification and the code opens full
        screen. Codes stay on this phone.
      </Text>

      {NATIVE && passes.length > 0 ? (
        <Panel padded={false}>
          <SettingSwitchRow
            label="Show these codes when I arrive"
            hint="A notification at the court opens its code. On this phone only."
            value={codesOn}
            onChange={(on) => void toggleCodes(on)}
            disabled={codesBusy}
          />
          {codesOn && alwaysAllowed === false ? (
            // On, but the OS won't wake Pickleague at the court: say so, and
            // offer the sheets again (they show only if never answered).
            <View style={styles.allowBox}>
              <Text style={[styles.body, { color: c.textSub }]}>
                They pop up only with location set to "{ALWAYS_LABEL}". Change it in your phone's Settings for Pickleague.
              </Text>
              <Button title="Allow" onPress={() => void allowAlways()} loading={codesBusy} size="sm" style={styles.start} />
            </View>
          ) : null}
        </Panel>
      ) : null}

      <Pressable
        onPress={() => navigation.navigate('QrPass', { passId: INVITE_PASS_ID })}
        style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}
        accessibilityRole="button"
        accessibilityLabel="My Pickleague invite. Open the code"
      >
        <View style={[styles.thumb, styles.inviteThumb]}>
          <QrCode value={inviteUrl(meId)} size={42} color="#000" backgroundColor="#fff" />
        </View>
        <View style={styles.flex}>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>My Pickleague invite</Text>
          <Text style={[styles.sub, { color: c.textSub }]} numberOfLines={1}>Scan to see my profile and join</Text>
        </View>
      </Pressable>

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
  allowBox: { paddingHorizontal: SPACE.md, paddingBottom: SPACE.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  thumb: { width: 48, height: 48, borderRadius: 6, backgroundColor: '#fff' },
  inviteThumb: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  title: { fontSize: 15, fontWeight: FONT.weight.semibold },
  sub: { fontSize: 13, marginTop: 2 },
  remove: { fontSize: 13 },
  step: { fontSize: 14, fontWeight: FONT.weight.semibold, marginTop: SPACE.md, marginBottom: SPACE.sm },
  preview: { width: '100%', height: 220, backgroundColor: '#fff', borderRadius: RADIUS.md },
  actions: { flexDirection: 'row', gap: SPACE.md, marginTop: SPACE.md },
});
