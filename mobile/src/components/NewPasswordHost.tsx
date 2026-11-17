// "Choose a new password" after a password reset link signed the player in
// (lib/passwordRecovery). A kit Dialog over whatever screen opened; saving
// calls updateUser, and Not now keeps them signed in with the old password.
// Mount it inside the ToastProvider; it renders nothing until a recovery.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, Text } from 'react-native';
import { Dialog } from '@just-messin-around/expo-foundation/ui';
import { TextField } from '@just-messin-around/expo-foundation/forms';
import { useToast } from '@just-messin-around/expo-foundation/toast';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import { textStyles } from '@just-messin-around/expo-foundation/typography';
import { supabase } from '../lib/supabase';
import { useTheme } from '../lib/ThemeContext';
import { track } from '../lib/analytics';
import {
  getRecoveryPending, newPasswordProblem, setRecoveryPending, subscribeRecoveryPending,
} from '../lib/passwordRecovery';

export default function NewPasswordHost({ signedIn }: { signedIn: boolean }) {
  const open = useSyncExternalStore(subscribeRecoveryPending, getRecoveryPending, getRecoveryPending);
  const toast = useToast();
  const { colors: c } = useTheme();
  const t = textStyles(c);
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The web client fires PASSWORD_RECOVERY when it reads a recovery link itself.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setRecoveryPending(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (open) { setPw(''); setError(null); setShow(false); }
  }, [open]);

  async function save() {
    const problem = newPasswordProblem(pw);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const { error: e } = await supabase.auth.updateUser({ password: pw });
      if (e) { setError(friendlySbMessage(e, 'Could not save that password. Please try again.')); return; }
      track('auth.password_reset', {});
      setRecoveryPending(false);
      toast.success('Password changed. Use it next time you sign in.');
    } catch (e) {
      setError(friendlySbMessage(e, 'Could not save that password. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      visible={open && signedIn}
      onClose={() => setRecoveryPending(false)}
      title="Choose a new password"
      subtitle="You're signed in from your reset link."
      iconName="lock"
      busy={busy}
      error={error}
      primary={{ label: busy ? 'Saving…' : 'Save password', onPress: () => { void save(); }, loading: busy }}
      secondary={{ label: 'Not now', onPress: () => setRecoveryPending(false) }}
    >
      <TextField
        label="New password"
        value={pw}
        onChangeText={(v) => { setPw(v); setError(null); }}
        secureTextEntry={!show}
        autoComplete="new-password"
        textContentType="newPassword"
        autoFocus
        onSubmitEditing={() => { void save(); }}
        containerStyle={{ marginBottom: 0 }}
        trailingWidth={84}
        trailing={
          <Pressable
            onPress={() => setShow((s) => !s)}
            accessibilityRole="button"
            accessibilityLabel={show ? 'Hide password' : 'Show password'}
            style={{ minHeight: 40, justifyContent: 'center', paddingHorizontal: 6 }}
          >
            <Text style={[t.sub, { color: c.text, fontWeight: '700' }]}>{show ? 'Hide' : 'Show'}</Text>
          </Pressable>
        }
      />
    </Dialog>
  );
}
