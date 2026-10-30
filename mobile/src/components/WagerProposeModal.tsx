import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, Pressable, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform,
} from 'react-native';
import { useTheme } from '../lib/ThemeContext';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { Button, KeyboardTextInput, keyboardDismissTap } from '@just-messin-around/expo-foundation/forms';
import { SPACE, RADIUS, HAIRLINE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT, textStyles } from '@just-messin-around/expo-foundation/typography';
import { PickleAmount } from './PickleAmount';
import {
  WagerSubject, fetchOdds, placeWager, subjectLabel,
} from '../lib/wager';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';

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
  // A wager stakes real pickles and the dismiss is deferred 700ms, so the
  // button is live after the stake is already gone. Latched until the modal
  // reopens with a fresh subject.
  const [placed, setPlaced]         = useState(false);
  const inFlight                    = useRef(false);
  const dismissTimer                = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (dismissTimer.current) clearTimeout(dismissTimer.current); }, []);

  // Reset state every time the modal opens with a fresh subject.
  useEffect(() => {
    if (!visible || !subject) return;
    setOdds(null);
    setOddsError(null);
    setStakeText('');
    setErrMsg(null);
    setOkMsg(null);
    setPlaced(false);
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

  const canPlace = !placing && !placed && !oddsLoading && stake > 0 && odds != null;

  const onPlace = useCallback(async () => {
    if (inFlight.current) return;
    if (!subject || !canPlace) return;
    inFlight.current = true;
    setErrMsg(null);
    setOkMsg(null);
    setPlacing(true);
    try {
      const result = await placeWager(subject, stake);
      if (!result.success) {
        // placeWager hands back the raw library string on a transport failure;
        // route it through the same classifier so "Failed to fetch" reads as
        // "no connection" instead of leaking fetch internals to the user.
        setErrMsg(friendlySbMessage(new Error(result.message || ''), 'Could not place wager.'));
        return;
      }
      setPlaced(true);
      setOkMsg(result.message || 'Wager placed.');
      onPlaced?.({
        wager_id: result.wager_id!,
        odds: result.odds ?? 0,
        potential_payout: result.potential_payout ?? 0,
        balance: result.balance ?? 0,
      });
      // Brief flash, then dismiss.
      dismissTimer.current = setTimeout(() => onClose(), 700);
    } catch (e) {
      setErrMsg(friendlySbMessage(e, 'Could not place wager.'));
    } finally {
      // Without this a throw left the button on its spinner forever.
      inFlight.current = false;
      setPlacing(false);
    }
  }, [subject, canPlace, stake, onPlaced, onClose]);

  if (!subject) return null;

  const card = (
    <View style={S.card}>
      <View style={S.titleRow}>
        <Icon name="dice" size={22} color={c.primary} />
        <Text style={S.title}>Propose Wager</Text>
      </View>
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
      <KeyboardTextInput
        style={[S.stakeInput, webInputFontFloor(S.stakeInput)]}
        accessibilityLabel="Stake in pickles"
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
            accessibilityRole="button"
            accessibilityLabel={`Stake ${n} pickles`}
            accessibilityState={{ selected: stake === n }}
          >
            <Text style={[S.chipText, stake === n && S.chipTextActive]}>{n}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={S.payoutBox}>
        <Text style={S.payoutLabel}>Potential win</Text>
        {projectedPayout > 0 ? (
          <PickleAmount amount={projectedPayout} preset="h3" color={c.text} iconColor={c.primary} />
        ) : (
          <Text style={S.payoutValue} accessibilityLabel="No potential win yet">—</Text>
        )}
      </View>

      {errMsg ? <Text style={S.errText}>{errMsg}</Text> : null}
      {okMsg  ? <Text style={S.okText}>{okMsg}</Text>   : null}

      <View style={S.btnRow}>
        <TouchableOpacity
          style={[S.btn, S.btnGhost]}
          onPress={onClose}
          disabled={placing}
          accessibilityRole="button"
        >
          <Text style={S.btnGhostText}>Cancel</Text>
        </TouchableOpacity>
        <Button
          title="Place wager"
          onPress={onPlace}
          disabled={!canPlace}
          loading={placing}
          style={S.btnFlex}
        />
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
        <View style={S.backdrop} {...keyboardDismissTap}>{card}</View>
      )}
    </Modal>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  const t = textStyles(c);
  return StyleSheet.create({
    backdrop:      { flex: 1, backgroundColor: c.backdrop, justifyContent: 'center', alignItems: 'center', padding: SPACE.xl },
    card:          { width: '100%', maxWidth: 440, backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.xl },
    titleRow:      { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.xs },
    title:         t.h2,
    subject:       { fontSize: FONT.size.md, color: c.textSub, lineHeight: FONT.line.normal, marginBottom: SPACE.lg },
    oddsRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                     backgroundColor: c.primaryLight, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: RADIUS.md, marginBottom: SPACE.md },
    oddsLabel:     { ...t.label, fontSize: FONT.size.base },
    oddsValue:     { fontSize: FONT.size.h2, fontWeight: FONT.weight.black, color: c.primary },
    oddsError:     { fontSize: FONT.size.base, color: c.danger, fontWeight: FONT.weight.bold },
    fieldLabel:    { ...t.fieldLabel, fontSize: FONT.size.sm, marginBottom: SPACE.xs },
    stakeInput:    { minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.md,
                     fontSize: FONT.size.xl, fontWeight: FONT.weight.bold, color: c.text, backgroundColor: c.surfaceAlt },
    chipsRow:      { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.sm, marginBottom: SPACE.md },
    chip:          { flex: 1, minHeight: 44, justifyContent: 'center', borderRadius: RADIUS.md, alignItems: 'center', borderWidth: HAIRLINE, borderColor: c.border, backgroundColor: c.surfaceAlt },
    chipActive:    { backgroundColor: c.primary, borderColor: c.primary },
    chipText:      { color: c.textSub, fontWeight: FONT.weight.bold },
    chipTextActive:{ color: c.textInverse },
    payoutBox:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 48,
                     paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: RADIUS.md, borderWidth: HAIRLINE, borderColor: c.border, marginBottom: SPACE.sm },
    payoutLabel:   { fontSize: FONT.size.base, fontWeight: FONT.weight.bold, color: c.textSub },
    payoutValue:   { fontSize: FONT.size.xl, fontWeight: FONT.weight.black, color: c.text },
    errText:       { color: c.danger, fontWeight: FONT.weight.bold, marginTop: SPACE.xs, marginBottom: SPACE.xs },
    okText:        { color: c.success, fontWeight: FONT.weight.bold, marginTop: SPACE.xs, marginBottom: SPACE.xs },
    btnRow:        { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.md },
    btn:           { flex: 1, minHeight: 50, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
    btnFlex:       { flex: 1 },
    btnGhost:      { backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border },
    btnGhostText:  { color: c.textSub, fontWeight: FONT.weight.heavy },
  });
}
