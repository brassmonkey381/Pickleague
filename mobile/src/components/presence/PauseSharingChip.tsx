// "⏸ Pause sharing" on the checked-in court card: for 1 hour, the rest of
// today or 24 hours, everyone but you sees "a player" instead of your name
// (you still count toward "N playing now"). Paused, the chip says until when
// and offers Resume. The pause is presence_settings.paused_until on the
// server, so it covers every device and every surface at once.
//
// Renders nothing while FRIENDS_AT_COURTS_ENABLED is off, so the court card
// can render it unconditionally.
import React, { useState } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { ActionSheetModal, Chip, type ActionSheetAction } from '@just-messin-around/expo-foundation/ui';
import { SMALL_TEXT_MAX_SCALE } from '@just-messin-around/expo-foundation/styles';
import { useTicker } from '@just-messin-around/expo-foundation/hooks';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { FRIENDS_AT_COURTS_ENABLED } from '../../lib/features';
import { useToast } from '../../lib/useToast';
import { PAUSE_CHOICES, isPaused, pauseUntil, pausedUntilLabel, type PauseChoice } from '../../lib/presencePrivacy';
import { setPresenceSettings, usePresenceSettings } from '../../data/presenceSettings';

type Props = { style?: StyleProp<ViewStyle> };

export default function PauseSharingChip(props: Props) {
  return FRIENDS_AT_COURTS_ENABLED ? <PauseSharingChipBody {...props} /> : null;
}

function PauseSharingChipBody({ style }: Props) {
  const toast = useToast();
  const settings = usePresenceSettings();
  // Re-checks each minute so the chip flips back by itself when a pause ends.
  const now = useTicker(60_000);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pausedUntil = settings.data?.paused_until ?? null;
  const paused = isPaused(pausedUntil, now);

  async function pause(choice: PauseChoice) {
    setBusy(true);
    try {
      const until = pauseUntil(choice, new Date()).toISOString();
      await setPresenceSettings({ pausedUntil: until });
      toast.success(`Sharing paused ${pausedUntilLabel(until, Date.now())}. Others see "a player" until then.`);
    } catch (e) {
      toast.error(friendlySbMessage(e, "Couldn't pause sharing just now."));
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    setBusy(true);
    try {
      await setPresenceSettings({ clearPause: true });
      toast.success('Sharing is back on.');
    } catch (e) {
      toast.error(friendlySbMessage(e, "Couldn't resume sharing just now."));
    } finally {
      setBusy(false);
    }
  }

  const actions: ActionSheetAction[] = [
    ...(paused ? [{ label: 'Resume sharing now', onPress: () => void resume() }] : []),
    ...PAUSE_CHOICES.map((c) => ({ label: c.label, onPress: () => void pause(c.value) })),
  ];

  const label = paused && pausedUntil ? `⏸ Paused ${pausedUntilLabel(pausedUntil, now)}` : '⏸ Pause sharing';

  return (
    <>
      <Chip
        size="sm"
        hitBox
        label={busy ? 'Saving…' : label}
        tone={paused ? 'warning' : 'neutral'}
        variant={paused ? 'soft' : 'outline'}
        maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
        // Kept pressable while saving so the 44 box (hitBox) doesn't collapse.
        onPress={() => {
          if (!busy) setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={paused ? `Sharing paused ${pausedUntil ? pausedUntilLabel(pausedUntil, now) : ''}` : 'Pause sharing'}
        accessibilityHint="Hides your name at the court for a while"
        style={style}
      />
      <ActionSheetModal
        visible={open}
        title={paused ? 'Sharing is paused' : 'Pause sharing'}
        subtitle='Others see "a player" instead of your name. You still count toward who is playing.'
        actions={actions}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
