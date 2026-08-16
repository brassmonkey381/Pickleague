import React, { useState } from 'react';
import { Text, TouchableOpacity, StyleSheet, ViewStyle } from 'react-native';
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
}) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);

  async function onPress() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await shareInvite({ title, message, url });
      if (res.copied) onCopied?.();
    } catch {
      // Share sheet dismissed or unavailable — nothing to clean up.
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
      <Text style={[S.text, { color: colors.textSub }]}>{busy ? '…' : '↗ Share'}</Text>
    </TouchableOpacity>
  );
}

const S = StyleSheet.create({
  btn:  { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, borderWidth: 1.5, alignSelf: 'flex-start' },
  text: { fontSize: 13, fontWeight: '700' },
});
