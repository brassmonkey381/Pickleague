// "Edit league" (Manage > Edit league details): name, description, privacy and
// home court. Moved out of LeagueDetailScreen unchanged in behaviour: the same
// leagues update, the same relabel_league_home_court RPC when the court
// changes (matches has no RLS UPDATE policy, so the old per-row client updates
// silently matched zero rows), and the same validation copy. Restyled onto the
// foundation TextField / Button and the token scales.
//
// A court picked from our catalog is also stored as leagues.home_venue_id, so
// check-in alerts and the court chip use that court instead of guessing one
// from the coordinates. A pin or a pasted spot stores none.
import React, { useEffect, useState } from 'react';
import { ScrollView, View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { Button, TextField } from '@just-messin-around/expo-foundation/forms';
import { StatusBanner } from '@just-messin-around/expo-foundation/ui';
import { HAIRLINE, RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { useStatusMessage } from '../../lib/useStatusMessage';
import { supabase } from '../../lib/supabase';
import { useTheme } from '../../lib/ThemeContext';
import CourtPicker, { type CourtResult } from '../CourtPicker';
import type { League } from '../../types';

export type LeagueEditSheetProps = {
  visible: boolean;
  league: League;
  onClose: () => void;
  /** After a save: the re-read league row (null if the re-read failed). */
  onSaved: (league: League | null) => void;
};

export default function LeagueEditSheet({ visible, league, onClose, onSaved }: LeagueEditSheetProps) {
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const status = useStatusMessage();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [isOpen, setIsOpen] = useState(true);
  const [court, setCourt] = useState<CourtResult | null>(null);
  const [saving, setSaving] = useState(false);

  // Seed the form each time the sheet opens (the old openEdit()).
  useEffect(() => {
    if (!visible) return;
    setName(league.name);
    setDesc(league.description ?? '');
    setIsOpen(league.is_open);
    setCourt(
      league.home_court
        ? {
            name: league.home_court,
            address: '',
            lat: league.home_court_lat ?? 0,
            lng: league.home_court_lng ?? 0,
            placeId: '',
            // Unchanged on save unless another court is picked.
            catalogId: league.home_venue_id ?? undefined,
          }
        : null,
    );
    status.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  async function save() {
    status.clear();
    const trimmedName = name.trim();
    if (!trimmedName) { status.error('League name is required.'); return; }

    setSaving(true);
    const newCourtName = court?.name ?? null;
    const homeCourtChanged = newCourtName !== league.home_court;

    const { error } = await supabase.from('leagues').update({
      name:           trimmedName,
      description:    desc.trim() || null,
      is_open:        isOpen,
      home_court:     newCourtName,
      home_court_lat: court?.lat ?? null,
      home_court_lng: court?.lng ?? null,
      home_venue_id:  court?.catalogId ?? null,
    }).eq('id', league.id);
    if (error) { status.error(error.message); setSaving(false); return; }

    // Re-derive is_home_court on existing matches only if the home court changed.
    if (homeCourtChanged) {
      const { error: relabelErr } = await supabase.rpc('relabel_league_home_court', { p_league_id: league.id });
      if (relabelErr) status.error(`Home court saved, but match relabeling failed: ${relabelErr.message}`);
    }

    setSaving(false);
    onClose();
    const { data } = await supabase.from('leagues').select('*').eq('id', league.id).single();
    onSaved((data as League) ?? null);
  }

  const option = (open: boolean, title: string, sub: string) => {
    const active = isOpen === open;
    return (
      <TouchableOpacity
        style={[
          styles.option,
          { borderColor: active ? c.primary : c.border, backgroundColor: active ? c.primaryLight : c.bg },
        ]}
        onPress={() => setIsOpen(open)}
        activeOpacity={0.8}
        accessibilityRole="radio"
        accessibilityState={{ selected: active }}
      >
        <Text style={[t.title, { color: active ? c.primary : c.textSub }]}>{title}</Text>
        <Text style={t.meta}>{sub}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView
        contentContainerStyle={[styles.sheet, { backgroundColor: c.surface }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[t.h2, styles.title]} accessibilityRole="header">Edit League</Text>
        <StatusBanner status={status.value} />

        <TextField label="Name" value={name} onChangeText={setName} placeholder="League name" maxLength={80} />
        <TextField
          label="Description"
          value={desc}
          onChangeText={setDesc}
          placeholder="What's this league about?"
          multiline
          numberOfLines={4}
          maxLength={500}
          style={styles.multiline}
        />

        <Text style={[t.fieldLabel, styles.label]}>Privacy</Text>
        <View style={styles.optionRow}>
          {option(true, '🌐 Public', 'Anyone can join freely')}
          {option(false, '🔒 Private', 'Invite or request only')}
        </View>

        <Text style={[t.fieldLabel, styles.label]}>Home Court</Text>
        <Text style={[t.hint, styles.hint]}>
          Changing the home court updates the home/away status of all past matches in this league.
        </Text>
        <CourtPicker value={court} onSelect={setCourt} active={visible} showNoneOption placeholder="Search for the home court…" />
        {!court ? (
          <View style={[styles.warning, { backgroundColor: c.warningLight, borderColor: c.warning }]}>
            <Text style={[t.sub, { color: c.warning }]}>⚠️ Without a home court every match entry requires a location.</Text>
          </View>
        ) : null}

        <Button title={saving ? 'Saving…' : 'Save Changes'} onPress={save} loading={saving} style={styles.save} />
        <TouchableOpacity style={styles.cancel} onPress={onClose} accessibilityRole="button">
          <Text style={[t.sub, { color: c.textMuted }]}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Plan section 6: the lg gutter on the sides, xl only at the top and bottom.
  sheet: { paddingHorizontal: SPACE.lg, paddingVertical: SPACE.xl, flexGrow: 1, gap: SPACE.sm },
  title: { marginBottom: SPACE.xs },
  label: { marginTop: SPACE.md },
  hint: { marginBottom: SPACE.xs },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
  optionRow: { flexDirection: 'row', gap: SPACE.sm },
  option: { flex: 1, minHeight: 44, borderWidth: HAIRLINE * 1.5, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xxs },
  warning: { borderRadius: RADIUS.md, padding: SPACE.md, borderWidth: HAIRLINE },
  save: { marginTop: SPACE.xl },
  cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});

