// The "⋯" on another player: Report, Block, Unblock, and "Hide my presence
// from <name>" (shipped with check-ins, not behind FRIENDS_AT_COURTS_ENABLED):
// they see "a player" instead of your name at the courts, whatever your
// setting. Undone here or in Settings > Privacy > Hidden from.
//
// One component so every surface that shows a player offers the same
// actions in the same order with the same wording — a profile, a drill thread,
// a search result. Renders nothing at all on your own row.
import React, { useState } from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import ActionSheetModal, { ActionSheetAction } from './ActionSheetModal';
import ConfirmModal from './ConfirmModal';
import ReportPlayerModal from './ReportPlayerModal';
import { useTheme } from '../lib/ThemeContext';
import { useToast } from '../lib/useToast';
import { blockUser, unblockUser, useBlockedIds, ReportSubjectType } from '../lib/moderation';
import { hidePresenceFrom, usePresenceHiddenIds } from '../data/presenceSettings';

type Props = {
  userId:       string;
  userName:     string;
  /** The signed-in user, so the menu can hide itself on your own row. */
  meId:         string | null;
  subjectType?: ReportSubjectType;
  subjectId?:   string | null;
  snapshot?:    Record<string, unknown> | null;
  /** Called after a block or unblock lands, so the host can refetch its list. */
  onChanged?:   () => void;
  /** Visual size of the "⋯" hit target. */
  compact?:     boolean;
};

export default function PlayerModerationMenu({
  userId, userName, meId, subjectType = 'profile', subjectId = null,
  snapshot = null, onChanged, compact = false,
}: Props) {
  const { colors } = useTheme();
  const S = makeStyles(colors);
  const toast = useToast();

  const [sheetOpen, setSheetOpen]     = useState(false);
  const [reportOpen, setReportOpen]   = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // What the sheet chose, held until the sheet is actually gone — see closeSheet.
  const [queued, setQueued]           = useState<null | 'report' | 'block'>(null);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);

  // One small cached query shared app-wide, so this is a cache read on every
  // surface but the first — and blocking here updates every other mounted list.
  const blocked = useBlockedIds().has(userId);
  // Same pattern for the hide-from list (shared with Settings > Hidden from).
  const presenceHidden = usePresenceHiddenIds(!!meId && meId !== userId).has(userId);

  if (!meId || meId === userId) return null;

  async function doHidePresence(hide: boolean) {
    try {
      await hidePresenceFrom(userId, hide);
      toast.success(
        hide
          ? `${userName} won't see you at the courts. They'll see "a player" instead.`
          : `${userName} can see you at the courts again, as your setting allows.`,
      );
    } catch (e) {
      toast.error(friendlySbMessage(e, "We couldn't change that just now."));
    }
  }

  async function doBlock() {
    setBusy(true);
    setError(null);
    try {
      await blockUser(userId);
      setConfirmOpen(false);
      toast.success(`${userName} is blocked. You won't see each other's requests or messages.`);
      onChanged?.();
    } catch (e) {
      setError(friendlySbMessage(e, "We couldn't block them just now. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  }

  async function doUnblock() {
    setBusy(true);
    try {
      await unblockUser(userId);
      toast.success(`${userName} is unblocked.`);
      onChanged?.();
    } catch (e) {
      toast.error(friendlySbMessage(e, "We couldn't unblock them just now."));
    } finally {
      setBusy(false);
    }
  }

  // iOS will not present a modal while another is still dismissing — doing it
  // synchronously from the sheet's onPress swallows the second one. So the
  // choice is queued and opened once the sheet's dismiss animation is done.
  function closeSheet() {
    setSheetOpen(false);
    if (!queued) return;
    const next = queued;
    setQueued(null);
    setTimeout(() => {
      if (next === 'report') setReportOpen(true);
      else { setError(null); setConfirmOpen(true); }
    }, 350);
  }

  const actions: ActionSheetAction[] = [
    {
      label: `Report ${userName}`,
      style: 'destructive',
      onPress: () => setQueued('report'),
    },
    blocked
      // Unblocking opens nothing, so it can run as the sheet closes.
      ? { label: `Unblock ${userName}`, onPress: () => { void doUnblock(); } }
      : { label: `Block ${userName}`, style: 'destructive', onPress: () => setQueued('block') },
    // A block already hides your name both ways, so it isn't offered then.
    ...(!blocked
      ? [presenceHidden
        ? { label: `Show my presence to ${userName}`, onPress: () => { void doHidePresence(false); } }
        : { label: `Hide my presence from ${userName}`, onPress: () => { void doHidePresence(true); } }]
      : []),
  ];

  return (
    <>
      {/* The touchable itself is the 44 box (react-native-web ignores
          hitSlop); the 34 circle, or the bare glyph in compact, sits inside. */}
      <TouchableOpacity
        onPress={() => setSheetOpen(true)}
        style={S.box}
        accessibilityLabel={`More options for ${userName}`}
        accessibilityRole="button"
      >
        <View style={[S.btn, compact && S.btnCompact]}>
          <Text style={[S.glyph, compact && S.glyphCompact]}>⋯</Text>
        </View>
      </TouchableOpacity>

      <ActionSheetModal
        visible={sheetOpen}
        title={userName}
        subtitle={blocked ? 'You have blocked this player.' : undefined}
        actions={actions}
        onClose={closeSheet}
      />

      <ReportPlayerModal
        visible={reportOpen}
        subjectUserId={userId}
        subjectName={userName}
        subjectType={subjectType}
        subjectId={subjectId}
        snapshot={snapshot}
        onClose={() => setReportOpen(false)}
      />

      <ConfirmModal
        visible={confirmOpen}
        title={`Block ${userName}?`}
        body={
          `You won't see each other's drill requests or messages, and neither of you can start a ` +
          `new one. Matches you have already played together stay in both your histories — they ` +
          `are shared results. You can undo this in Settings → Blocked players.`
        }
        primaryLabel="Block"
        variant="danger"
        busy={busy}
        error={error}
        onConfirm={() => { void doBlock(); }}
        onClose={() => { if (!busy) { setConfirmOpen(false); setError(null); } }}
      />
    </>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    box:          { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    btn:          { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceAlt },
    btnCompact:   { backgroundColor: 'transparent' },
    glyph:        { fontSize: 20, lineHeight: 22, fontWeight: '800', color: c.textSub },
    glyphCompact: { color: c.textMuted },
  });
}
