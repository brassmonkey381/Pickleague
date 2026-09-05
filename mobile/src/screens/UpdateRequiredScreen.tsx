import React from 'react';
import { Linking, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { APP_STORE_URL } from '../lib/appStore';
import { useTheme } from '../lib/ThemeContext';

/**
 * Shown instead of the app when this build is below
 * `app_config.min_supported_version` (see lib/minVersion).
 *
 * Deliberately has no dismiss and no "continue anyway": the only reason to ever
 * set that config value is that an old client can no longer talk to the current
 * backend correctly, and letting someone past means letting them corrupt data or
 * stare at errors. If a version is merely *undesirable* rather than broken, the
 * right tool is an over-the-air update, not this screen.
 *
 * No navigation, no session, no data fetching - it renders above all of that, so
 * it must not depend on any of it.
 */
export default function UpdateRequiredScreen() {
  const { colors: c } = useTheme();
  const S = makeStyles(c);

  // Android has no Play listing yet, so there is nowhere to send that user; the
  // message stands on its own rather than offering a button that goes nowhere.
  const canOpenStore = Platform.OS === 'ios';

  return (
    <View style={S.root}>
      <Text style={S.emoji}>🥒</Text>
      <Text style={S.title}>Time to update</Text>
      <Text style={S.body}>
        This version of Pickleague is too old to work with our servers. Grab the latest
        version and you will be right back where you left off — nothing is lost.
      </Text>

      {canOpenStore && (
        <TouchableOpacity style={S.button} onPress={() => void Linking.openURL(APP_STORE_URL)}>
          <Text style={S.buttonText}>Update on the App Store</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    root:       { flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 32 },
    emoji:      { fontSize: 56, marginBottom: 20 },
    title:      { fontSize: 26, fontWeight: '800', color: c.text, marginBottom: 12, textAlign: 'center' },
    body:       { fontSize: 16, lineHeight: 23, color: c.textSub, textAlign: 'center', maxWidth: 340 },
    button:     { backgroundColor: c.primary, paddingVertical: 15, paddingHorizontal: 30, borderRadius: 10, marginTop: 28 },
    buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  });
}
