import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, TextInput, ScrollView,
  StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';

export type ScopeType = 'tournament' | 'season' | 'league';

export type PicklePotCardProps = {
  scopeType: ScopeType;
  scopeId: string;
  scopeLabel: string;        // 'Tournament' / 'Season' / 'League'
  pool: number;
  ante?: number;             // tournament-only (omit for others)
  structure: number[];       // e.g. [60, 25, 15]
  isAdmin: boolean;
  canDistribute: boolean;    // tournament: status==='completed'; season: has finals
  members: Array<{ id: string; full_name: string }>;
  myPickleBalance?: number;  // optional — shown in Contribute modal
  onChange: () => void;      // refetch parent state after RPC succeeds
};

export default function PicklePotCard(props: PicklePotCardProps) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const {
    scopeType, scopeId, scopeLabel, pool, ante, structure,
    isAdmin, canDistribute, members, myPickleBalance, onChange,
  } = props;

  const [showContribute, setShowContribute] = useState(false);
  const [showAward, setShowAward]           = useState(false);
  const [showDistribute, setShowDistribute] = useState(false);

  const ladder = ['🥇', '🥈', '🥉', '4th', '5th'];

  return (
    <View style={S.card}>
      <View style={S.header}>
        <Text style={S.title}>🥒 {scopeLabel} Pot</Text>
        <View style={S.poolPill}>
          <Text style={S.poolValue}>🥒 {pool}</Text>
        </View>
      </View>

      <View style={S.metaRow}>
        {ante != null && ante > 0 && (
          <View style={S.metaPill}>
            <Text style={S.metaText}>Ante: <Text style={S.metaBold}>{ante} 🥒</Text></Text>
          </View>
        )}
        <View style={S.metaPill}>
          <Text style={S.metaText}>
            Payout: <Text style={S.metaBold}>{structure.map((p, i) => `${ladder[i] ?? `#${i+1}`} ${p}%`).join(' · ')}</Text>
          </Text>
        </View>
      </View>

      {ante != null && ante > 0 && scopeType === 'tournament' && (
        <Text style={S.hint}>Ante is auto-charged when registration is approved and added to the pot.</Text>
      )}

      {isAdmin && (
        <View style={S.btnRow}>
          <TouchableOpacity style={[S.btn, S.btnPrimary]} onPress={() => setShowContribute(true)}>
            <Text style={S.btnPrimaryText}>+ Contribute</Text>
          </TouchableOpacity>
          {pool > 0 && (
            <TouchableOpacity style={[S.btn, S.btnSecondary]} onPress={() => setShowAward(true)}>
              <Text style={S.btnSecondaryText}>Award</Text>
            </TouchableOpacity>
          )}
          {canDistribute && pool > 0 && (
            <TouchableOpacity style={[S.btn, S.btnAccent]} onPress={() => setShowDistribute(true)}>
              <Text style={S.btnAccentText}>Distribute</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <ContributeModal
        visible={showContribute}
        onClose={() => setShowContribute(false)}
        scopeType={scopeType}
        scopeId={scopeId}
        scopeLabel={scopeLabel}
        myBalance={myPickleBalance}
        onDone={() => { setShowContribute(false); onChange(); }}
        S={S}
      />

      <AwardModal
        visible={showAward}
        onClose={() => setShowAward(false)}
        scopeType={scopeType}
        scopeId={scopeId}
        scopeLabel={scopeLabel}
        members={members}
        pool={pool}
        onDone={() => { setShowAward(false); onChange(); }}
        S={S}
      />

      <DistributeModal
        visible={showDistribute}
        onClose={() => setShowDistribute(false)}
        scopeType={scopeType}
        scopeId={scopeId}
        scopeLabel={scopeLabel}
        members={members}
        pool={pool}
        structure={structure}
        onDone={() => { setShowDistribute(false); onChange(); }}
        S={S}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Contribute modal — admin pays X 🥒, pool gets X * 1.25
// ─────────────────────────────────────────────────────────────────────

function ContributeModal({
  visible, onClose, scopeType, scopeId, scopeLabel, myBalance, onDone, S,
}: {
  visible: boolean; onClose: () => void;
  scopeType: ScopeType; scopeId: string; scopeLabel: string;
  myBalance?: number; onDone: () => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy]     = useState(false);

  const n = parseInt(amount, 10);
  const valid = Number.isFinite(n) && n > 0 && (myBalance == null || n <= myBalance);
  const bonus = Number.isFinite(n) && n > 0 ? Math.floor(n * 0.25) : 0;
  const added = (Number.isFinite(n) && n > 0 ? n : 0) + bonus;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    const { data, error } = await supabase.rpc('contribute_pickles_to_pool', {
      p_scope_type: scopeType,
      p_scope_id:   scopeId,
      p_amount:     n,
    });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) { Alert.alert('Could not contribute', row?.message ?? 'Unknown error'); return; }
    setAmount('');
    Alert.alert('Contributed', row.message ?? 'Done');
    onDone();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={S.modalBackdrop}>
        <View style={S.modalCard}>
          <Text style={S.modalTitle}>Contribute to {scopeLabel} Pot</Text>
          <Text style={S.modalBody}>
            The house adds a <Text style={S.modalBold}>+25% bonus</Text> on top of your contribution.
          </Text>
          {myBalance != null && (
            <Text style={S.modalSub}>Your balance: 🥒 {myBalance}</Text>
          )}

          <Text style={S.label}>Amount to contribute</Text>
          <TextInput
            style={S.input}
            keyboardType="number-pad"
            placeholder="100"
            value={amount}
            onChangeText={setAmount}
          />

          {Number.isFinite(n) && n > 0 && (
            <View style={S.previewBox}>
              <Text style={S.previewLine}>You pay:        🥒 {n}</Text>
              <Text style={S.previewLine}>House bonus:    🥒 +{bonus}</Text>
              <Text style={[S.previewLine, S.previewTotal]}>Pool gains:     🥒 {added}</Text>
            </View>
          )}

          {myBalance != null && Number.isFinite(n) && n > myBalance && (
            <Text style={S.errorText}>You only have {myBalance} 🥒.</Text>
          )}

          <View style={S.modalBtnRow}>
            <TouchableOpacity style={[S.modalBtn, S.btnSecondary]} onPress={onClose} disabled={busy}>
              <Text style={S.btnSecondaryText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.modalBtn, S.btnPrimary, !valid && S.btnDisabled]}
              onPress={submit}
              disabled={!valid || busy}
            >
              {busy
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={S.btnPrimaryText}>Contribute</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Award modal — admin grants ad-hoc reward to a single player
// ─────────────────────────────────────────────────────────────────────

function AwardModal({
  visible, onClose, scopeType, scopeId, scopeLabel, members, pool, onDone, S,
}: {
  visible: boolean; onClose: () => void;
  scopeType: ScopeType; scopeId: string; scopeLabel: string;
  members: Array<{ id: string; full_name: string }>;
  pool: number; onDone: () => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [amount, setAmount]           = useState('');
  const [reason, setReason]           = useState('');
  const [busy, setBusy]               = useState(false);

  const n = parseInt(amount, 10);
  const valid = !!recipientId && Number.isFinite(n) && n > 0 && n <= pool;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    const { data, error } = await supabase.rpc('award_pickles_from_pool', {
      p_scope_type: scopeType,
      p_scope_id:   scopeId,
      p_recipient:  recipientId,
      p_amount:     n,
      p_reason:     reason.trim() || `${scopeLabel} reward`,
    });
    setBusy(false);
    if (error) { Alert.alert('Error', error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) { Alert.alert('Could not award', row?.message ?? 'Unknown error'); return; }
    setRecipientId(null); setAmount(''); setReason('');
    Alert.alert('Awarded', `${n} 🥒 sent.`);
    onDone();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={S.modalBackdrop}>
        <View style={[S.modalCard, { maxHeight: '85%' }]}>
          <Text style={S.modalTitle}>Award from {scopeLabel} Pot</Text>
          <Text style={S.modalSub}>Pool balance: 🥒 {pool}</Text>

          <Text style={S.label}>Recipient</Text>
          <ScrollView style={S.memberList}>
            {members.map(m => {
              const sel = recipientId === m.id;
              return (
                <TouchableOpacity
                  key={m.id}
                  style={[S.memberRow, sel && S.memberRowSelected]}
                  onPress={() => setRecipientId(m.id)}
                >
                  <Text style={[S.memberName, sel && S.memberNameSelected]}>{m.full_name}</Text>
                  {sel && <Text style={S.memberCheck}>✓</Text>}
                </TouchableOpacity>
              );
            })}
            {members.length === 0 && (
              <Text style={S.emptyText}>No eligible members.</Text>
            )}
          </ScrollView>

          <Text style={S.label}>Amount (max {pool})</Text>
          <TextInput style={S.input} keyboardType="number-pad" placeholder="50" value={amount} onChangeText={setAmount} />

          <Text style={S.label}>Reason (optional)</Text>
          <TextInput style={S.input} placeholder="e.g. Period 2 winner" value={reason} onChangeText={setReason} />

          <View style={S.modalBtnRow}>
            <TouchableOpacity style={[S.modalBtn, S.btnSecondary]} onPress={onClose} disabled={busy}>
              <Text style={S.btnSecondaryText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.modalBtn, S.btnPrimary, !valid && S.btnDisabled]}
              onPress={submit}
              disabled={!valid || busy}
            >
              {busy
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={S.btnPrimaryText}>Award</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Distribute modal — admin selects winners by rank, RPC splits pool
// ─────────────────────────────────────────────────────────────────────

function DistributeModal({
  visible, onClose, scopeType, scopeId, scopeLabel, members, pool, structure, onDone, S,
}: {
  visible: boolean; onClose: () => void;
  scopeType: ScopeType; scopeId: string; scopeLabel: string;
  members: Array<{ id: string; full_name: string }>;
  pool: number; structure: number[]; onDone: () => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const [picks, setPicks] = useState<Array<string | null>>(() => structure.map(() => null));
  const [activeRank, setActiveRank] = useState<number | null>(null);
  const [busy, setBusy]   = useState(false);

  const ladder = ['1st 🥇', '2nd 🥈', '3rd 🥉', '4th', '5th'];

  async function submit() {
    setBusy(true);
    let result;
    if (scopeType === 'season') {
      // Seasons pull from season_final_standings server-side; ignore picks.
      result = await supabase.rpc('distribute_season_pool', { p_season_id: scopeId });
    } else {
      // Tournament: send picked uids in order
      result = await supabase.rpc('distribute_tournament_pool', {
        p_tournament_id: scopeId,
        p_winner_uids:   picks,
      });
    }
    setBusy(false);
    const { data, error } = result;
    if (error) { Alert.alert('Error', error.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.success) { Alert.alert('Could not distribute', row?.message ?? 'Unknown error'); return; }
    Alert.alert('Distributed', row.message ?? `${row.distributed} 🥒 paid out.`);
    onDone();
  }

  // Tournament: require all positions filled
  const canSubmit = scopeType === 'season' || picks.every(Boolean);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={S.modalBackdrop}>
        <View style={[S.modalCard, { maxHeight: '90%' }]}>
          <Text style={S.modalTitle}>Distribute {scopeLabel} Pot</Text>
          <Text style={S.modalSub}>Pool: 🥒 {pool} · structure {structure.join(' / ')}%</Text>

          {scopeType === 'season' ? (
            <Text style={S.modalBody}>
              Will pay top finishers from the locked-in <Text style={S.modalBold}>final standings</Text>
              {' '}using the configured payout structure. Make sure the season has been completed first.
            </Text>
          ) : (
            <>
              <Text style={S.modalBody}>Pick the top finishers — pool splits across them per the structure.</Text>
              {structure.map((pct, i) => {
                const pickedId = picks[i];
                const pickedName = members.find(m => m.id === pickedId)?.full_name;
                const share = Math.floor(pool * pct / 100);
                return (
                  <View key={i} style={S.distRow}>
                    <Text style={S.distLabel}>{ladder[i] ?? `#${i+1}`}</Text>
                    <TouchableOpacity
                      style={[S.distPickBtn, !pickedId && S.distPickBtnEmpty]}
                      onPress={() => setActiveRank(activeRank === i ? null : i)}
                    >
                      <Text style={[S.distPickText, !pickedId && S.distPickTextEmpty]}>
                        {pickedName ?? 'Pick player'}
                      </Text>
                    </TouchableOpacity>
                    <Text style={S.distShare}>🥒 {share}</Text>
                  </View>
                );
              })}

              {activeRank !== null && (
                <ScrollView style={S.memberList}>
                  {members
                    .filter(m => !picks.some((p, idx) => idx !== activeRank && p === m.id))
                    .map(m => (
                      <TouchableOpacity
                        key={m.id}
                        style={S.memberRow}
                        onPress={() => {
                          const next = [...picks];
                          next[activeRank] = m.id;
                          setPicks(next);
                          setActiveRank(null);
                        }}
                      >
                        <Text style={S.memberName}>{m.full_name}</Text>
                      </TouchableOpacity>
                    ))}
                </ScrollView>
              )}
            </>
          )}

          <View style={S.modalBtnRow}>
            <TouchableOpacity style={[S.modalBtn, S.btnSecondary]} onPress={onClose} disabled={busy}>
              <Text style={S.btnSecondaryText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.modalBtn, S.btnAccent, !canSubmit && S.btnDisabled]}
              onPress={submit}
              disabled={!canSubmit || busy}
            >
              {busy
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={S.btnAccentText}>Distribute</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────
function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    card: {
      backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 12,
      borderWidth: 1, borderColor: c.border,
      shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2,
    },
    header:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
    title:     { fontSize: 15, fontWeight: '800', color: c.text },
    poolPill:  { backgroundColor: c.primaryLight, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1.5, borderColor: c.primary },
    poolValue: { fontSize: 14, fontWeight: '900', color: c.primary },

    metaRow:   { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
    metaPill:  { backgroundColor: c.surfaceAlt, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: c.border },
    metaText:  { fontSize: 12, color: c.textSub },
    metaBold:  { fontWeight: '700', color: c.text },
    hint:      { fontSize: 11, color: c.textMuted, marginTop: 4, lineHeight: 16 },

    btnRow:    { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
    btn:       { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', minWidth: 90 },
    btnPrimary:        { backgroundColor: c.primary },
    btnPrimaryText:    { color: '#fff', fontWeight: '800', fontSize: 13 },
    btnSecondary:      { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    btnSecondaryText:  { color: c.textSub, fontWeight: '700', fontSize: 13 },
    btnAccent:         { backgroundColor: '#f57f17' },
    btnAccentText:     { color: '#fff', fontWeight: '800', fontSize: 13 },
    btnDisabled:       { opacity: 0.45 },

    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 16 },
    modalCard:     { backgroundColor: c.surface, borderRadius: 16, padding: 20, maxWidth: 480, width: '100%', alignSelf: 'center' },
    modalTitle:    { fontSize: 18, fontWeight: '900', color: c.text, marginBottom: 4 },
    modalBody:     { fontSize: 13, color: c.textSub, marginTop: 4, lineHeight: 19 },
    modalBold:     { fontWeight: '800', color: c.text },
    modalSub:      { fontSize: 12, color: c.textMuted, marginTop: 2, marginBottom: 6 },

    label:    { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.7, marginTop: 12, marginBottom: 5 },
    input:    { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, fontSize: 15, color: c.text, backgroundColor: c.surface },

    previewBox:    { backgroundColor: c.primaryLight, borderRadius: 10, padding: 12, marginTop: 12 },
    previewLine:   { fontSize: 13, color: c.textSub, marginVertical: 1 },
    previewTotal:  { fontSize: 14, fontWeight: '800', color: c.primary, marginTop: 4 },
    errorText:     { fontSize: 12, color: c.danger, marginTop: 8 },

    memberList:    { maxHeight: 200, marginTop: 6, borderWidth: 1, borderColor: c.border, borderRadius: 10 },
    memberRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderBottomWidth: 1, borderBottomColor: c.border },
    memberRowSelected: { backgroundColor: c.primaryLight },
    memberName:    { fontSize: 14, color: c.text },
    memberNameSelected: { fontWeight: '700', color: c.primary },
    memberCheck:   { fontSize: 16, color: c.primary, fontWeight: '700' },
    emptyText:     { padding: 14, fontSize: 13, color: c.textMuted, textAlign: 'center' },

    distRow:       { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 4 },
    distLabel:     { fontSize: 14, fontWeight: '800', color: c.text, width: 60 },
    distPickBtn:   { flex: 1, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1.5, borderColor: c.primary, backgroundColor: c.primaryLight },
    distPickBtnEmpty: { borderColor: c.border, backgroundColor: c.surfaceAlt, borderStyle: 'dashed' },
    distPickText:  { fontSize: 13, color: c.primary, fontWeight: '700' },
    distPickTextEmpty: { color: c.textMuted, fontWeight: '500' },
    distShare:     { fontSize: 12, color: c.textSub, fontWeight: '700', minWidth: 50, textAlign: 'right' },

    modalBtnRow:   { flexDirection: 'row', gap: 10, marginTop: 16 },
    modalBtn:      { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  });
}
