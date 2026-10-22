// God mode switches for test accounts (supabase/migration_hide_test_accounts.sql):
//   HideTestAccountsSwitch  the app-wide "Hide test accounts from discovery"
//                           (God mode console)
//   TestAccountSwitch       "Test account" on another player's profile; renders
//                           nothing unless the viewer is a God mode admin
// The server refuses everyone else (hint 'pl:admin.only'), so hiding these is
// for tidiness, not safety. Each switch reads its value from the server and
// shows what the server saved; a failure says why and what to do.
import React, { useCallback, useEffect, useState } from 'react';
import { Panel, SettingSwitchRow } from '@just-messin-around/expo-foundation/ui';
import { friendlySbMessage } from '@just-messin-around/expo-foundation/supabase';
import type { StyleProp, ViewStyle } from 'react-native';
import { isGodmodeUserId } from '../lib/godmode';
import {
  getHideTestAccounts, setHideTestAccounts, getProfileTestAccount, setProfileTestAccount,
} from '../data/testAccounts';

type AdminSwitchProps = {
  label: string;
  hint: string;
  load: () => Promise<boolean>;
  save: (on: boolean) => Promise<boolean>;
  inset?: boolean;
};

/** One server-backed switch: loads its value, saves on tap, says why on failure. */
function AdminSwitch({ label, hint, load, save, inset = true }: AdminSwitchProps) {
  const [value, setValue] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      setValue(await load());
    } catch (e) {
      setProblem(`${friendlySbMessage(e, "Couldn't load this setting.")} Tap the switch to try again.`);
    } finally {
      setBusy(false);
    }
  }, [load]);

  useEffect(() => { void reload(); }, [reload]);

  async function onChange(next: boolean) {
    // Not loaded yet (or the load failed): a tap retries the load instead of
    // saving a value we never read.
    if (value === null) { void reload(); return; }
    setBusy(true);
    setProblem(null);
    try {
      setValue(await save(next));
    } catch (e) {
      setProblem(`${friendlySbMessage(e, "Couldn't save this setting.")} Nothing changed; try again.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingSwitchRow
      label={label}
      hint={hint}
      value={value === true}
      onChange={onChange}
      disabled={busy}
      inset={inset}
      footnote={problem ?? (value === null && busy ? 'Loading…' : undefined)}
    />
  );
}

/** The app-wide switch, for the God mode console. */
export function HideTestAccountsSwitch({ inset = false }: { inset?: boolean }) {
  return (
    <AdminSwitch
      label="Hide test accounts from discovery"
      hint="On: players stop seeing test accounts in player search, friend suggestions and who's at a court. Test accounts and admins still see them."
      load={getHideTestAccounts}
      save={setHideTestAccounts}
      inset={inset}
    />
  );
}

/** "Test account" on another player's profile. Nothing for non-admins or on yourself. */
export function TestAccountSwitch({ profileId, meId, style }: {
  profileId: string;
  meId: string | null;
  style?: StyleProp<ViewStyle>;
}) {
  const load = useCallback(() => getProfileTestAccount(profileId), [profileId]);
  const save = useCallback((on: boolean) => setProfileTestAccount(profileId, on), [profileId]);
  if (!meId || meId === profileId || !isGodmodeUserId(meId)) return null;
  return (
    <Panel padded={false} style={style}>
      <AdminSwitch
        label="Test account"
        hint="Admins only. While God mode hides test accounts, other players won't find this account in search, suggestions or at a court."
        load={load}
        save={save}
      />
    </Panel>
  );
}
