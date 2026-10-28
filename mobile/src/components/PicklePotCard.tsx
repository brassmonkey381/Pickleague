import React, { useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, TextInput, ScrollView,
  StyleSheet, ActivityIndicator, Pressable,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import StatusBanner from './StatusBanner';
import { useStatusMessage } from '../lib/useStatusMessage';
import { sbCall, friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { HAIRLINE, RADIUS, SPACE, webInputFontFloor } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { RankMedal, ordinal } from '@just-messin-around/expo-foundation/ui';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { PickleAmount, picklesLabel } from './PickleAmount';

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
  /**
   * Render without the card chrome and the title row, for a host that already
   * frames the pot (TournamentDetail's and SeasonStandings' collapsed "Pot"
   * sections name it and show the total in their header). Default false: the
   * standalone card, as SeasonStandings' Manage section uses it.
   */
  bare?: boolean;
};

export default function PicklePotCard(props: PicklePotCardProps) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);
  const {
    scopeType, scopeId, scopeLabel, pool, ante, structure,
    isAdmin, canDistribute, members, myPickleBalance, onChange, bare = false,
  } = props;

  const [showContribute, setShowContribute] = useState(false);
  const [showAward, setShowAward]           = useState(false);
  const [showDistribute, setShowDistribute] = useState(false);

  // These move REAL in-app currency, and Alert.alert renders nothing at all on
  // react-native-web — so on pickleague.club both the failure and the success
  // were invisible, and the natural "did that work?" retry double-spent.
  // Successes land here (the modal is gone by then); errors stay in the modal.
  const status = useStatusMessage();

  // Pickle transfers confirm with the pickle glyph beside the words.
  const pickleDone = (msg: string) => status.success(msg, { iconName: 'pickle' });

  return (
    <View style={bare ? null : S.card}>
      {!bare && (
        <View style={S.header}>
          <View style={S.titleRow}>
            <Icon name="pickle" size={16} color={c.primary} />
            <Text style={S.title}>{scopeLabel} Pot</Text>
          </View>
          <View style={S.poolPill}>
            <PickleAmount amount={pool} preset="bodySub" textStyle={S.poolValue} />
          </View>
        </View>
      )}

      <View style={S.metaRow}>
        {ante != null && ante > 0 && (
          <View style={S.metaPill} accessible accessibilityLabel={`Ante: ${picklesLabel(ante)}`}>
            <Text style={S.metaText}>Ante:</Text>
            <PickleAmount amount={ante} preset="meta" color={c.text} iconColor={c.primary} textStyle={S.metaAmount} />
          </View>
        )}
        <View
          style={S.metaPill}
          accessible
          accessibilityLabel={`Payout: ${structure.map((p, i) => `${ordinal(i + 1)} ${p}%`).join(', ')}`}
        >
          <Text style={S.metaText}>Payout:</Text>
          {structure.map((p, i) => (
            <View key={i} style={S.payoutItem}>
              {i > 0 ? <Text style={S.metaText}>·</Text> : null}
              {/* 1st-3rd as medal discs; 4th+ as words. */}
              {i < 3 ? <RankMedal place={i + 1} size={16} /> : <Text style={S.metaBold}>{ordinal(i + 1)}</Text>}
              <Text style={S.metaBold}>{p}%</Text>
            </View>
          ))}
        </View>
      </View>

      {ante != null && ante > 0 && scopeType === 'tournament' && (
        <Text style={S.hint}>Ante is auto-charged when registration is approved and added to the pot.</Text>
      )}

      <StatusBanner status={status.value} />

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
          {/* Seasons only. Tournament pots are paid through the automatic
              Payout flow (PayoutPreviewModal → auto_payout_tournament), which
              derives the podium from the final standings; hand-picking winners
              was never actually used and could disagree with those standings.
              Seasons have no automatic path — distribute_season_pool is the
              only way to pay a season pot — so the button stays there. */}
          {scopeType === 'season' && canDistribute && pool > 0 && (
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
        onDone={(msg) => { setShowContribute(false); pickleDone(msg); onChange(); }}
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
        onDone={(msg) => { setShowAward(false); pickleDone(msg); onChange(); }}
        S={S}
      />

      <DistributeModal
        visible={showDistribute}
        onClose={() => setShowDistribute(false)}
        scopeId={scopeId}
        scopeLabel={scopeLabel}
        pool={pool}
        structure={structure}
        onDone={(msg) => { setShowDistribute(false); pickleDone(msg); onChange(); }}
        S={S}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Contribute modal — admin pays X pickles, pool gets X * 1.25
// ─────────────────────────────────────────────────────────────────────

function ContributeModal({
  visible, onClose, scopeType, scopeId, scopeLabel, myBalance, onDone, S,
}: {
  visible: boolean; onClose: () => void;
  scopeType: ScopeType; scopeId: string; scopeLabel: string;
  myBalance?: number; onDone: (message: string) => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const { colors: c } = useTheme();
  const [amount, setAmount] = useState('');
  const [busy, setBusy]     = useState(false);
  const inFlight            = useRef(false);
  const status              = useStatusMessage();

  const n = parseInt(amount, 10);
  const valid = Number.isFinite(n) && n > 0 && (myBalance == null || n <= myBalance);

  async function submit() {
    if (inFlight.current) return;
    if (!valid) return;
    inFlight.current = true;
    setBusy(true);
    status.clear();
    try {
      // Not retried: this debits the admin's balance, and a retry after a lost
      // reply would contribute twice.
      const data = await sbCall<any>(() => supabase.rpc('contribute_pickles_to_pool', {
        p_scope_type: scopeType,
        p_scope_id:   scopeId,
        p_amount:     n,
      }), { retries: 0 });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.success) { status.error(row?.message ?? 'Could not contribute.'); return; }
      setAmount('');
      onDone(row.message ?? `Contributed ${picklesLabel(n)} to the ${scopeLabel.toLowerCase()} pot.`);
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not contribute.', {
        network: 'Lost the connection — check the pot balance before contributing again, in case it went through.',
      }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={S.modalBackdrop} onPress={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <View style={S.modalCard}>
          <Text style={S.modalTitle}>Contribute to {scopeLabel} Pot</Text>
          <Text style={S.modalBody}>
            Your pickles go straight into the pot for the winners.
          </Text>
          {myBalance != null && (
            <View style={S.modalSubRow}>
              <Text style={S.modalSubText}>Your balance:</Text>
              <PickleAmount amount={myBalance} preset="meta" color={c.textSub} />
            </View>
          )}

          <Text style={S.label}>Amount to contribute</Text>
          <TextInput
            style={[S.input, webInputFontFloor(S.input)]}
            keyboardType="number-pad"
            placeholder="100"
            value={amount}
            onChangeText={setAmount}
          />

          {myBalance != null && Number.isFinite(n) && n > myBalance && (
            <Text style={S.errorText}>You only have {picklesLabel(myBalance)}.</Text>
          )}

          <StatusBanner status={status.value} />

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
                ? <ActivityIndicator color={S.btnPrimaryText.color as string} size="small" />
                : <Text style={S.btnPrimaryText}>Contribute</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Pressable>
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
  pool: number; onDone: (message: string) => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const { colors: c } = useTheme();
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [amount, setAmount]           = useState('');
  const [reason, setReason]           = useState('');
  const [busy, setBusy]               = useState(false);
  const inFlight                      = useRef(false);
  const status                        = useStatusMessage();

  const n = parseInt(amount, 10);
  const valid = !!recipientId && Number.isFinite(n) && n > 0 && n <= pool;

  async function submit() {
    if (inFlight.current) return;
    if (!valid) return;
    inFlight.current = true;
    setBusy(true);
    status.clear();
    try {
      // Not retried: each call pays the recipient again.
      const data = await sbCall<any>(() => supabase.rpc('award_pickles_from_pool', {
        p_scope_type: scopeType,
        p_scope_id:   scopeId,
        p_recipient:  recipientId,
        p_amount:     n,
        p_reason:     reason.trim() || `${scopeLabel} reward`,
      }), { retries: 0 });
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.success) { status.error(row?.message ?? 'Could not award.'); return; }
      setRecipientId(null); setAmount(''); setReason('');
      onDone(`${picklesLabel(n)} sent.`);
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not award.', {
        network: 'Lost the connection — check the pot balance before awarding again, in case it went through.',
      }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={S.modalBackdrop} onPress={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <View style={[S.modalCard, { maxHeight: '85%' }]}>
          <Text style={S.modalTitle}>Award from {scopeLabel} Pot</Text>
          <View style={S.modalSubRow}>
            <Text style={S.modalSubText}>Pool balance:</Text>
            <PickleAmount amount={pool} preset="meta" color={c.textSub} />
          </View>

          <Text style={S.label}>Recipient</Text>
          <ScrollView style={S.memberList}>
            {members.map(m => {
              const sel = recipientId === m.id;
              return (
                <TouchableOpacity
                  key={m.id}
                  style={[S.memberRow, sel && S.memberRowSelected]}
                  onPress={() => setRecipientId(m.id)}
                  accessibilityRole="button"
                  accessibilityLabel={m.full_name}
                  accessibilityState={{ selected: sel }}
                >
                  <Text style={[S.memberName, sel && S.memberNameSelected]}>{m.full_name}</Text>
                  {sel && <Icon name="check-mark" size={16} color={c.primary} />}
                </TouchableOpacity>
              );
            })}
            {members.length === 0 && (
              <Text style={S.emptyText}>No eligible members.</Text>
            )}
          </ScrollView>

          <Text style={S.label}>Amount (max {pool})</Text>
          <TextInput style={[S.input, webInputFontFloor(S.input)]} keyboardType="number-pad" placeholder="50" value={amount} onChangeText={setAmount} />

          <Text style={S.label}>Reason (optional)</Text>
          <TextInput style={[S.input, webInputFontFloor(S.input)]} placeholder="e.g. Period 2 winner" value={reason} onChangeText={setReason} />

          <StatusBanner status={status.value} />

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
                ? <ActivityIndicator color={S.btnPrimaryText.color as string} size="small" />
                : <Text style={S.btnPrimaryText}>Award</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Distribute modal — SEASONS ONLY. The pot is paid from the locked-in
// final standings server-side; there is nothing to pick.
//
// This used to double as the tournament payout: an admin hand-picked one
// player per paying place and the pool was split across those picks. That
// path is gone. Tournaments pay through PayoutPreviewModal →
// auto_payout_tournament, which derives the podium from the same final
// standings that settle wagers, so hand-picking could only ever disagree
// with them. Seasons keep this because distribute_season_pool is their
// only payout route.
// ─────────────────────────────────────────────────────────────────────

function DistributeModal({
  visible, onClose, scopeId, scopeLabel, pool, structure, onDone, S,
}: {
  visible: boolean; onClose: () => void;
  scopeId: string; scopeLabel: string;
  pool: number; structure: number[]; onDone: (message: string) => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const { colors: c } = useTheme();
  const [busy, setBusy] = useState(false);
  const inFlight        = useRef(false);
  const status          = useStatusMessage();

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    status.clear();
    try {
      // Not retried: a second payout would pay the podium twice.
      const data = await sbCall<any>(
        () => supabase.rpc('distribute_season_pool', { p_season_id: scopeId }),
        { retries: 0 },
      );
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.success) { status.error(row?.message ?? 'Could not distribute.'); return; }
      onDone(row.message ?? `${picklesLabel(Number(row.distributed ?? 0))} paid out.`);
    } catch (e) {
      status.error(friendlySbMessage(e, 'Could not distribute.', {
        network: 'Lost the connection — check the pot balance before distributing again, in case it went through.',
      }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={S.modalBackdrop} onPress={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <View style={[S.modalCard, { maxHeight: '90%' }]}>
          <Text style={S.modalTitle}>Distribute {scopeLabel} Pot</Text>
          <View style={S.modalSubRow}>
            <Text style={S.modalSubText}>Pool:</Text>
            <PickleAmount amount={pool} preset="meta" color={c.textSub} />
            <Text style={S.modalSubText}>· structure {structure.join(' / ')}%</Text>
          </View>

          <Text style={S.modalBody}>
            Will pay top finishers from the locked-in <Text style={S.modalBold}>final standings</Text>
            {' '}using the configured payout structure. Make sure the season has been completed first.
          </Text>

          <StatusBanner status={status.value} />

          <View style={S.modalBtnRow}>
            <TouchableOpacity style={[S.modalBtn, S.btnSecondary]} onPress={onClose} disabled={busy}>
              <Text style={S.btnSecondaryText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.modalBtn, S.btnAccent, busy && S.btnDisabled]}
              onPress={submit}
              disabled={busy}
            >
              {busy
                ? <ActivityIndicator color={S.btnPrimaryText.color as string} size="small" />
                : <Text style={S.btnAccentText}>Distribute</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────
function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  // UI compaction P5b: SPACE / RADIUS tokens, theme colours only (no hex, no
  // shadow: the card is a plain hairline Panel; the modals are overlays and
  // keep the backdrop), FONT sizes only, and 44px boxes on every button.
  return StyleSheet.create({
    card: {
      backgroundColor: c.surface, borderRadius: RADIUS.lg, padding: SPACE.md, marginBottom: SPACE.md,
      borderWidth: HAIRLINE, borderColor: c.border,
    },
    header:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACE.sm },
    titleRow:  { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, flexShrink: 1 },
    title:     { fontSize: FONT.size.lg, fontWeight: FONT.weight.heavy, color: c.text },
    poolPill:  { backgroundColor: c.primaryLight, borderRadius: RADIUS.pill, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs, borderWidth: HAIRLINE, borderColor: c.primary },
    poolValue: { fontSize: FONT.size.md, fontWeight: FONT.weight.black, color: c.primary },

    metaRow:   { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginBottom: SPACE.xs },
    metaPill:  { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs, backgroundColor: c.surfaceAlt, borderRadius: RADIUS.pill, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderWidth: HAIRLINE, borderColor: c.border },
    metaText:  { fontSize: FONT.size.sm, color: c.textSub },
    metaBold:  { fontSize: FONT.size.sm, fontWeight: FONT.weight.bold, color: c.text },
    metaAmount: { fontWeight: FONT.weight.bold, letterSpacing: 0 },
    payoutItem: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
    hint:      { fontSize: FONT.size.xs, color: c.textMuted, marginTop: SPACE.xs, lineHeight: FONT.line.tight },

    btnRow:    { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.sm, flexWrap: 'wrap' },
    btn:       { flex: 1, minHeight: 44, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center', minWidth: 90 },
    btnPrimary:        { backgroundColor: c.primary },
    btnPrimaryText:    { color: c.textInverse, fontWeight: FONT.weight.heavy, fontSize: FONT.size.base },
    btnSecondary:      { backgroundColor: c.surfaceAlt, borderWidth: HAIRLINE, borderColor: c.border },
    btnSecondaryText:  { color: c.textSub, fontWeight: FONT.weight.bold, fontSize: FONT.size.base },
    btnAccent:         { backgroundColor: c.warning },
    btnAccentText:     { color: c.textInverse, fontWeight: FONT.weight.heavy, fontSize: FONT.size.base },
    btnDisabled:       { opacity: 0.45 },

    modalBackdrop: { flex: 1, backgroundColor: c.backdrop, justifyContent: 'center', padding: SPACE.lg },
    modalCard:     { backgroundColor: c.surface, borderRadius: RADIUS.lg, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.xl, maxWidth: 480, width: '100%', alignSelf: 'center' },
    modalTitle:    { fontSize: FONT.size.xl, fontWeight: FONT.weight.black, color: c.text, marginBottom: SPACE.xs },
    modalBody:     { fontSize: FONT.size.base, color: c.textSub, marginTop: SPACE.xs, lineHeight: FONT.line.tight },
    modalBold:     { fontWeight: FONT.weight.heavy, color: c.text },
    modalSubRow:   { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.xxs, marginBottom: SPACE.xs },
    modalSubText:  { fontSize: FONT.size.sm, color: c.textMuted },

    label:    { fontSize: FONT.size.xs, fontWeight: FONT.weight.bold, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: SPACE.md, marginBottom: SPACE.xs },
    input:    { minHeight: 44, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, fontSize: FONT.size.lg, color: c.text, backgroundColor: c.surface },

    errorText:     { fontSize: FONT.size.sm, color: c.danger, marginTop: SPACE.sm },

    memberList:    { maxHeight: 200, marginTop: SPACE.xs, borderWidth: HAIRLINE, borderColor: c.border, borderRadius: RADIUS.md },
    memberRow:     { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACE.md, borderBottomWidth: HAIRLINE, borderBottomColor: c.border },
    memberRowSelected: { backgroundColor: c.primaryLight },
    memberName:    { fontSize: FONT.size.md, color: c.text },
    memberNameSelected: { fontWeight: FONT.weight.bold, color: c.primary },
    emptyText:     { padding: SPACE.md, fontSize: FONT.size.base, color: c.textMuted, textAlign: 'center' },

    modalBtnRow:   { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.lg },
    modalBtn:      { flex: 1, minHeight: 44, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
  });
}
