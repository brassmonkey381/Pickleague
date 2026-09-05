import React from 'react';
import { Platform, StyleSheet, Text, View, type TextProps, type ViewStyle } from 'react-native';
import { track } from '../lib/analytics';
import { APP_STORE_URL } from '../lib/appStore';
import { rememberDestination } from '../lib/deferredLink';
import { useTheme } from '../lib/ThemeContext';

/**
 * Visible "get it on the App Store" call to action for the WEB build.
 *
 * Why this exists alongside the Smart App Banner: the `apple-itunes-app` meta
 * tag in public/index.html renders only in Safari on iOS, and it stays gone once
 * dismissed. Our printed flyers and business cards say "Free on the App Store"
 * and their QR codes land on the site root, so anyone scanning with an Android
 * phone, Chrome on iOS, or reading on a desktop previously saw no store link at
 * all. This one renders in every browser.
 *
 * Deliberately a real anchor, not a tap handler. react-native-web's Text swaps
 * its host element to `a` when `href` is set, and its click handler only calls
 * stopPropagation (never preventDefault), so `onPress` and the navigation both
 * fire — verified in react-native-web 0.21. That buys middle-click, "open in new
 * tab", right-click-copy and crawlability, none of which a JS-only handler gives.
 *
 * Opens in a new tab on purpose. Leaving the page would tear down the analytics
 * session mid-visit, and campaign attribution reads the landing query string on
 * first paint — see CAMPAIGN_PARAMS in lib/analytics. Keeping this tab alive is
 * what lets a scanned flyer still record its `?code=`.
 *
 * Native returns null: offering an App Store download inside the installed app
 * is nonsense.
 */
/**
 * `href` / `hrefAttrs` are react-native-web additions that react-native's own
 * TextProps does not declare, so TS rejects them at the call site. The cast is
 * confined here rather than sprinkled as `as any`, and it is only ever reached
 * on web — the component returns null on native before rendering.
 *
 * `target: 'blank'` (no underscore) is intentional: RNW prefixes it for you.
 */
const ANCHOR_PROPS = {
  href: APP_STORE_URL,
  hrefAttrs: { target: 'blank', rel: 'noopener noreferrer' },
} as unknown as TextProps;

export default function GetTheAppButton({
  /** Where this instance lives, recorded on the click event so we can tell a
   *  flyer scan converting from an idle browse. */
  from,
  style,
}: {
  from: string;
  style?: ViewStyle;
}) {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  if (Platform.OS !== 'web') return null;

  return (
    <View style={[S.wrap, style]}>
      <Text
        accessibilityRole="link"
        {...ANCHOR_PROPS}
        onPress={() => {
          track('appstore.click', { from });
          // Remember where they were so ContinueInAppBanner can offer it
          // back on their next visit — our SDK-free deferred deep link.
          rememberDestination();
        }}
        style={S.btn}
      >
        <Text style={S.kicker}>DOWNLOAD ON THE{'\n'}</Text>
        <Text style={S.name}>App Store</Text>
      </Text>
      <Text style={S.note}>Free on iPhone — or keep using it right here in your browser.</Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    wrap:   { alignItems: 'center', marginTop: 28 },
    // Two-line lockup: the shape people read as a store badge. No Apple logo
    // glyph on purpose — U+F8FF is an Apple private-use codepoint that renders
    // as a tofu box on Windows and Android, and using the real mark means
    // following Apple's badge artwork guidelines rather than drawing our own.
    btn:    {
      borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surface,
      borderRadius: 14, paddingVertical: 10, paddingHorizontal: 22,
      textAlign: 'center', textDecorationLine: 'none',
    },
    kicker: { fontSize: 10, fontWeight: '700', letterSpacing: 0.9, color: c.textSub },
    name:   { fontSize: 19, fontWeight: '800', color: c.text },
    note:   { marginTop: 10, fontSize: 13, color: c.textMuted, textAlign: 'center' },
  });
}
