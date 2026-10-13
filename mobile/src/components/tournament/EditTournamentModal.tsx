import React from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, TextInput, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import AppDateTimePicker from '../AppDateTimePicker';
import { useTournamentDetailStyles } from './styles';
import type { TournamentDetailState } from './useTournamentDetail';

type Props = Pick<TournamentDetailState,
  | 'showEditModal' | 'setShowEditModal' | 'saveTournamentEdits' | 'editError' | 'savingEdit'
  | 'editName' | 'setEditName' | 'editDesc' | 'setEditDesc' | 'editLocation' | 'setEditLocation'
  | 'editMinPlayers' | 'setEditMinPlayers' | 'editMaxPlayers' | 'setEditMaxPlayers'
  | 'editStartTime' | 'setEditStartTime' | 'editLengthHours' | 'setEditLengthHours'
  | 'editAnte' | 'setEditAnte' | 'editPayout' | 'setEditPayout' | 'editPrizePool' | 'setEditPrizePool'
  | 'editSeeding' | 'setEditSeeding' | 'showStartPicker' | 'setShowStartPicker'>;

/**
 * Edit Tournament page sheet (admin). Form state lives in
 * useTournamentDetail (openEditModal seeds it from the tournament). Moved
 * from the screen in P5a; P5b swept its styles onto the tokens (44px inputs
 * and buttons, theme colours, FONT sizes). Opened from Manage > Edit and
 * from the identity row's "No date" / "No location" chips.
 */
export default function EditTournamentModal({
  showEditModal, setShowEditModal, saveTournamentEdits, editError, savingEdit,
  editName, setEditName, editDesc, setEditDesc, editLocation, setEditLocation,
  editMinPlayers, setEditMinPlayers, editMaxPlayers, setEditMaxPlayers,
  editStartTime, setEditStartTime, editLengthHours, setEditLengthHours,
  editAnte, setEditAnte, editPayout, setEditPayout, editPrizePool, setEditPrizePool,
  editSeeding, setEditSeeding, showStartPicker, setShowStartPicker,
}: Props) {
  const { S, c } = useTournamentDetailStyles();
  // Android draws this Modal under the status bar (edge-to-edge is on, which
  // forces the dialog translucent), so its top clears the inset there. An iOS
  // page sheet and the web need only the sheet's own SPACE.xl.
  const insets = useSafeAreaInsets();
  const topPad = SPACE.xl + (Platform.OS === 'android' ? insets.top : 0);
  return (
    <Modal visible={showEditModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowEditModal(false)}>
      <ScrollView contentContainerStyle={[S.editModal, { paddingTop: topPad }]} keyboardShouldPersistTaps="handled">
        <Text style={S.editModalTitle}>Edit Tournament</Text>

        <Text style={S.editFieldLabel}>Name</Text>
        <TextInput
          style={S.editInput}
          value={editName}
          onChangeText={setEditName}
          placeholder="Tournament name"
          placeholderTextColor={c.textMuted}
          maxLength={80}
        />

        <Text style={S.editFieldLabel}>Description</Text>
        <TextInput
          style={[S.editInput, S.editInputMultiline]}
          value={editDesc}
          onChangeText={setEditDesc}
          placeholder="What's this tournament about?"
          placeholderTextColor={c.textMuted}
          multiline
          numberOfLines={4}
          maxLength={500}
        />

        <Text style={S.editFieldLabel}>Start time</Text>
        <TouchableOpacity
          style={[S.editInput, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
          onPress={() => setShowStartPicker(true)}
          activeOpacity={0.7}
        >
          <Text style={editStartTime ? S.editDateText : S.editDatePlaceholder}>
            {editStartTime
              ? editStartTime.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
              : 'Tap to set'}
          </Text>
          <View style={{ paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.sm, backgroundColor: c.primaryLight }}>
            <Text style={S.editInlineActionText}>
              📅 {editStartTime ? 'Change' : 'Pick'}
            </Text>
          </View>
        </TouchableOpacity>
        {editStartTime && (
          <TouchableOpacity onPress={() => setEditStartTime(null)} style={S.editInlineAction}>
            <Text style={S.editInlineDanger}>Clear start time</Text>
          </TouchableOpacity>
        )}

        <Text style={S.editFieldLabel}>Expected length (hours)</Text>
        <TextInput
          style={S.editInput}
          value={editLengthHours}
          onChangeText={setEditLengthHours}
          placeholder="e.g. 3, 4.5"
          placeholderTextColor={c.textMuted}
          keyboardType="decimal-pad"
          maxLength={6}
        />

        <Text style={S.editFieldLabel}>Location</Text>
        <TextInput
          style={S.editInput}
          value={editLocation}
          onChangeText={setEditLocation}
          placeholder="Where is it being held?"
          placeholderTextColor={c.textMuted}
          maxLength={200}
        />

        <Text style={S.editFieldLabel}>Min players</Text>
        <TextInput
          style={S.editInput}
          value={editMinPlayers}
          onChangeText={setEditMinPlayers}
          placeholder="No minimum"
          placeholderTextColor={c.textMuted}
          keyboardType="number-pad"
          maxLength={4}
        />

        <Text style={S.editFieldLabel}>Max players (raising it promotes the waitlist)</Text>
        <TextInput
          style={S.editInput}
          value={editMaxPlayers}
          onChangeText={setEditMaxPlayers}
          placeholder="No cap"
          placeholderTextColor={c.textMuted}
          keyboardType="number-pad"
          maxLength={4}
        />

        <Text style={S.editFieldLabel}>Entry ante (🥒)</Text>
        <TextInput
          style={S.editInput}
          value={editAnte}
          onChangeText={setEditAnte}
          placeholder="0"
          placeholderTextColor={c.textMuted}
          keyboardType="number-pad"
          maxLength={7}
        />

        <Text style={S.editFieldLabel}>Payout structure (% per place, sum 100)</Text>
        <TextInput
          style={S.editInput}
          value={editPayout}
          onChangeText={setEditPayout}
          placeholder="60,25,15"
          placeholderTextColor={c.textMuted}
          maxLength={40}
        />

        <Text style={S.editFieldLabel}>Prize pool override (🥒)</Text>
        <TextInput
          style={S.editInput}
          value={editPrizePool}
          onChangeText={setEditPrizePool}
          placeholder="Leave blank to keep current pool"
          placeholderTextColor={c.textMuted}
          keyboardType="number-pad"
          maxLength={9}
        />

        <Text style={S.editFieldLabel}>Seeding mode</Text>
        <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
          <TouchableOpacity
            style={[S.editInput, { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: editSeeding === 'random' ? c.primaryLight : c.surface }]}
            onPress={() => setEditSeeding('random')}
          >
            <Text style={{ color: editSeeding === 'random' ? c.primary : c.textSub, fontWeight: FONT.weight.bold }}>🎲 Random</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[S.editInput, { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: editSeeding === 'elo' ? c.primaryLight : c.surface }]}
            onPress={() => setEditSeeding('elo')}
          >
            <Text style={{ color: editSeeding === 'elo' ? c.primary : c.textSub, fontWeight: FONT.weight.bold }}>📊 PLUPR-based</Text>
          </TouchableOpacity>
        </View>

        {editError && (
          <Text style={S.editErrorText}>{editError}</Text>
        )}

        <TouchableOpacity
          style={[S.editSaveBtn, savingEdit && S.editSaveBtnDisabled]}
          onPress={saveTournamentEdits}
          disabled={savingEdit}
        >
          <Text style={S.editSaveBtnText}>{savingEdit ? 'Saving…' : 'Save Changes'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={S.editCancelBtn} onPress={() => setShowEditModal(false)}>
          <Text style={S.editCancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Datetime picker MUST live inside the edit Modal so its position:fixed
          overlay shares the same stacking context. Otherwise on web the page-
          sheet Modal renders above the picker and it appears hidden until
          the edit modal closes. */}
      <AppDateTimePicker
        visible={showStartPicker}
        value={editStartTime ?? new Date()}
        onChange={d => { setEditStartTime(d); setShowStartPicker(false); }}
        onClose={() => setShowStartPicker(false)}
      />
    </Modal>
  );
}
