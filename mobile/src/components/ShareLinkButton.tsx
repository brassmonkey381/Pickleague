import React, { useState } from 'react';
import { Platform, Text, TouchableOpacity, StyleSheet, ViewStyle } from 'react-native';
import { setClipboard } from '@just-messin-around/expo-foundation/platform';
import { Icon } from '@just-messin-around/expo-foundation/icons';
import { RADIUS, SPACE } from '@just-messin-around/expo-foundation/styles';
import { FONT } from '@just-messin-around/expo-foundation/typography';
import { shareInvite } from '../lib/share';
import { useTheme } from '../lib/ThemeContext';

/**
 * Share this page's canonical URL — the in-app counterpart of copying the
 * address bar on web. Every entity URL serves an Open Graph card to preview
 * crawlers (api/_lib/cards.tsx), so wherever the link lands — Discord,
 * WhatsApp, iMessage, Slack — it unfurls into the live snapshot card. The
 * share itself rides the OS share sheet (foundation shareInvite; 1.15.1+ so
 * the url survives on native), falling back to the clipboard on desktop web.
 */
export default function ShareLinkButton({
  url,
  message,
  title,
  style,
  onCopied,
  onShare,
}: {
  /** Canonical https URL of this screen's entity — the thing that unfurls. */
  url: string;
  /** One line of context sent alongside the link. */
  message: string;
  title?: string;
  style?: ViewStyle;
  /** Fired when the desktop-web clipboard fallback was used, so the screen
   *  can flash "link copied" — the sheet opening is its own feedback. */
  onCopied?: () => void;
  /** Fired on every press, before the sheet or the copy (analytics). */
  onShare?: () => void;
}) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);

  async function onPress() {
    if (busy) return;
    onShare?.();
    setBusy(true);
    try {
      if (Platform.OS === 'web') {
        // Deliberately NOT the Web Share API: on web this button just copies
        // the URL — bare, no message text — so it pastes clean into Discord /
        // WhatsApp where the link unfurls into the card by itself.
        await setClipboard(url);
        onCopied?.();
      } else {
        const res = await shareInvite({ title, message, url });
        if (res.copied) onCopied?.();
      }
    } catch {
      // Share sheet dismissed or clipboard blocked — nothing to clean up.
    } finally {
      setBusy(false);
    }
  }

  return (
    <TouchableOpacity
      style={[S.btn, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }, style]}
      onPress={onPress}
      disabled={busy}
      accessibilityLabel="Share link"
    >
      {busy ? null : <Icon name={Platform.OS === 'web' ? 'link' : 'share'} size={14} color={colors.textSub} />}
      <Text style={[S.text, { color: colors.textSub }]}>
        {busy ? '…' : Platform.OS === 'web' ? 'Copy link' : 'Share'}
      </Text>
    </TouchableOpacity>
  );
}

const S = StyleSheet.create({
  btn:  {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xs,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1.5,
    alignSelf: 'flex-start',
  },
  text: { fontSize: FONT.size.base, fontWeight: FONT.weight.bold },
});
