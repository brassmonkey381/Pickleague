import React, { useEffect, useState } from 'react';
import { sbCall } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../lib/supabase';
import { navigationRef } from '../lib/navigationRef';
import EntityRow from './EntityRow';

/**
 * Whether the signed-in account is a guest (anonymous) one. Re-checks
 * `profiles.is_guest` on every auth state change (including the refreshSession
 * the upgrade screen fires on success), so it flips to false once the guest
 * converts. Split out of the old banner so Home's Get started panel can count
 * the offer as one of its rows (plan section 3: guest and DUPR offers are rows
 * in Get started, never separate banners).
 */
export function useIsGuest(): boolean {
  const [isGuest, setIsGuest] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // IMPORTANT: never call an auth method (getUser/refreshSession) inside the
    // onAuthStateChange callback — supabase-js invokes it while holding its auth
    // lock, so an auth call there deadlocks. (That froze updateUser during the
    // upgrade flow.) Use the session handed to us, and defer the PostgREST check
    // off the lock with setTimeout. `supabase.from(...)` is lock-free, so safe.
    async function check(user: { id: string; is_anonymous?: boolean } | null) {
      // Only anonymous sessions can be guests — skip the DB query for everyone else.
      if (!user || !user.is_anonymous) { if (!cancelled) setIsGuest(false); return; }
      try {
        const data = await sbCall(() =>
          supabase.from('profiles').select('is_guest').eq('id', user.id).maybeSingle(),
        );
        if (!cancelled) setIsGuest(!!data?.is_guest);
      } catch {
        // Keep whatever we last showed. A failed read used to hide the nudge —
        // exactly the banner a guest most needs to see before their account
        // expires.
      }
    }
    supabase.auth.getSession().then(({ data: { session } }) => check(session?.user ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      setTimeout(() => check(user), 0);
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  return isGuest;
}

type RowProps = {
  /** The Panel's final row (no divider under it). */
  lastRow?: boolean;
  /** Analytics hook; navigation to UpgradeAccount happens here regardless. */
  onPressed?: () => void;
};

/** The "save your account" offer as a Get started row. Presentational: render
 *  it only when useIsGuest() is true. */
export function GuestUpgradeRow({ lastRow, onPressed }: RowProps) {
  return (
    <EntityRow
      kind="player"
      layout="row"
      iconName="wave"
      title="Save your account"
      subtitle="You're a guest. Add an email so you don't lose access."
      trailingText="Save"
      lastRow={lastRow}
      onPress={() => {
        onPressed?.();
        if (navigationRef.isReady()) navigationRef.navigate('UpgradeAccount');
      }}
    />
  );
}

/** Self-checking variant: the row, only for guests. */
export default function GuestUpgradeBanner(props: RowProps) {
  const isGuest = useIsGuest();
  if (!isGuest) return null;
  return <GuestUpgradeRow {...props} />;
}
