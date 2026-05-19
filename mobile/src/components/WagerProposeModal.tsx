import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal, Pressable, View, Text, TextInput, TouchableOpacity,
  ActivityIndicator, StyleSheet, Platform,
} from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { useEscapeKey } from '../lib/useEscapeKey';
import {
  WagerSubject, fetchOdds, placeWager, subjectLabel,
} from '../lib/wager';

type Props = {
  visible: boolean;
  subject: WagerSubject | null;
  onClose: () => void;
  onPlaced?: (result: { wager_id: string; odds: number; potential_payout: number; balance: number }) => void;
};

const QUICK_CHIPS = [10, 50, 100, 500] as const;

/**
 * Shared "Propose Wager" modal — fetches server odds on open, lets the user
 * pick a stake (numeric input + quick chips), shows projected payout, then
 * calls place_wager. Status is rendered inline.
 */
export default function WagerProposeModal({ visible, subject, onClose, onPlaced }: Props) {
  const { colors: c } = useTheme();
  const S = useMemo(() => makeStyles(c), [c]);

  const [odds, setOdds]             = useState<number | null>(null);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsError, setOddsError]   = useState<string | null>(null);
  const [stakeText, setStakeText]   = useState<string>('');
  const [placing, setPlacing]       = useState(false);
  const [errMsg, setErrMsg]         = useState<string | null>(null);
  const [okMsg, setOkMsg]           = useState<string | null>(null);

  useEscapeKey(() => { if (!placing) onClose(); }, visible);

  // Reset state every time the modal opens with a fresh subject.
  useEffect(() => {
    if (!visible || !subject) return;
    setOdds(null);
    setOddsError(null);
    setStakeText('');
    setErrMsg(null);
    setOkMsg(null);
    setOddsLoading(true);
    let cancelled = false;
    (async () => {
      const result = await fetchOdds(subject);
      if (cancelled) return;
      setOddsLoading(false);
      if (!result) {
        setOddsError("Couldn't calculate odds. Try again.");
      } else {
        setOdds(result.odds);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, subject]);

  const stake = useMemo(() => {
    const n = parseInt(stakeText, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [stakeText]);

  const projectedPayout = useMemo(() => {
    if (!odds || !stake) return 0;
    return Math.floor(stake * odds);
  }, [odds, stake]);

  const canPlace = !placing && !oddsLoading && stake > 0 && odds != null;

  const onPlace = useCallback(async () => {
    if (!subject || !canPlace) return;
    setErrMsg(null);
    setOkMsg(null);
    setPlacing(true);
    const result = await placeWager(subject, stake);
    setPlacing(false);
    if (!result.success) {
      setErrMsg(result.message || 'Could not place wager.');
      return;
    }
    setOkMsg(result.message || 'Wager placed.');
    onPlaced?.({
      wager_id: result.wager_id!,
      odds: result.odds ?? 0,
      potential_payout: result.potential_payout ?? 0,
      balance: result.balance ?? 0,
    });
    // Brief flash, then dismiss.
    setTimeout(() => onClose(), 700);
  }, [subject, canPlace, stake, onPlaced, onClose]);

  if (!subject) return null;

  const card = (
    <View style={S.card}>
      <Text style={S.title}>🎲 Propose Wager</Text>
      <Text style={S.subject}>{subjectLabel(subject)}</Text>

      <View style={S.oddsRow}>
        <Text style={S.oddsLabel}>Odds</Text>
        {oddsLoading
          ? <ActivityIndicator size="small" color={c.primary} />
          : odds != null
            ? <Text style={S.oddsValue}>{odds.toFixed(2)}×</Text>
            : <Text style={S.oddsError}>{oddsError ?? '—'}</Text>}
      </View>

      <Text style={S.fieldLabel}>Stake</Text>
      <TextInput
        style={S.stakeInput}
        value={stakeText}
        onChangeText={(t) => setStakeText(t.replace(/[^0-9]/g, ''))}
        placeholder="0"
        placeholderTextColor={c.textMuted}
        keyboardType="number-pad"
        editable={!placing}
        returnKeyType="done"
        maxLength={9}
      />

      <View style={S.chipsRow}>
        {QUICK_CHIPS.map((n) => (
          <TouchableOpacity
            key={n}
            style={[S.chip, stake === n && S.chipActive]}
            onPress={() => setStakeText(String(n))}
            disabled={placing}
          >
            <Text style={[S.chipText, stake === n && S.chipTextActive]}>{n}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={S.payoutBox}>
        <Text style={S.payoutLabel}>Potential win</Text>
        <Text style={S.payoutValue}>
          {projectedPayout > 0 ? `${projectedPayout.toLocaleString()} 🥒` : '— 🥒'}
        </Text>
      </View>

      {errMsg ? <Text style={S.errText}>{errMsg}</Text> : null}
      {okMsg  ? <Text style={S.okText}>{okMsg}</Text>   : null}

      <View style={S.btnRow}>
        <TouchableOpacity
          style={[S.btn, S.btnGhost]}
          onPress={onClose}
          disabled={placing}
        >
          <Text style={S.btnGhostText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[S.btn, S.btnPrimary, !canPlace && S.btnDim]}
          onPress={onPlace}
          disabled={!canPlace}
        >
          {placing
            ? <ActivityIndicator color="#fff" />
            : <Text style={S.btnPrimaryText}>Place wager</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );

  const isWeb = Platform.OS === 'web';
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => (placing ? null : onClose())}>
      {isWeb ? (
        <Pressable
          style={S.backdrop}
          onPress={(e: any) => {
            if (placing) return;
            if (e.target === e.currentTarget) onClose();
          }}
        >
          {card}
        </Pressable>
      ) : (
        <View style={S.backdrop}>{card}</View>
      )}
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    backdrop:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: 24 },
    card:          { width: '100%', maxWidth: 440, backgroundColor: c.surface, borderRadius: 14, padding: 22 },
    title:         { fontSize: 20, fontWeight: '900', color: c.text, marginBottom: 6 },
    subject:       { fontSize: 14, color: c.textSub, lineHeight: 20, marginBottom: 16 },
    oddsRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                     backgroundColor: c.primaryLight, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, marginBottom: 14 },
    oddsLabel:     { fontSize: 13, fontWeight: '700', color: c.primary, textTransform: 'uppercase', letterSpacing: 0.6 },
    oddsValue:     { fontSize: 22, fontWeight: '900', color: c.primary },
    oddsError:     { fontSize: 13, color: c.danger, fontWeight: '700' },
    fieldLabel:    { fontSize: 12, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
    stakeInput:    { borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12,
                     fontSize: 18, fontWeight: '700', color: c.text, backgroundColor: c.surfaceAlt },
    chipsRow:      { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 14 },
    chip:          { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceAlt },
    chipActive:    { backgroundColor: c.primary, borderColor: c.primary },
    chipText:      { color: c.textSub, fontWeight: '700' },
    chipTextActive:{ color: '#fff' },
    payoutBox:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                     paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, marginBottom: 10 },
    payoutLabel:   { fontSize: 13, fontWeight: '700', color: c.textSub },
    payoutValue:   { fontSize: 18, fontWeight: '900', color: c.text },
    errText:       { color: c.danger, fontWeight: '700', marginTop: 6, marginBottom: 4 },
    okText:        { color: c.primary, fontWeight: '700', marginTop: 6, marginBottom: 4 },
    btnRow:        { flexDirection: 'row', gap: 10, marginTop: 14 },
    btn:           { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    btnGhost:      { backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
    btnGhostText:  { color: c.textSub, fontWeight: '800' },
    btnPrimary:    { backgroundColor: c.primary },
    btnPrimaryText:{ color: '#fff', fontWeight: '800' },
    btnDim:        { opacity: 0.5 },
  });
}
