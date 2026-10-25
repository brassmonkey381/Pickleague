// My current check-in on this device, for a component: the cached copy as it
// mounts (peekCurrentCheckin), then every change (checkinChanged), and what
// the component itself learns (the setter: a check-in it just made, a
// reconcile it ran).
//
// A change heard before the cached read resolves wins. That read may have
// started before the change was stored (peekCurrentCheckin waits on the
// signed-in user, which can queue behind the auth lock at app start) and
// would put the old value back for good: a court page showing "Check in ▾"
// while the island says CHECKED IN there (3 runs in 5 on the web build,
// 2026-10-24, once Home's remount loop stopped re-sending the change every
// few milliseconds and hiding it).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSignal } from '@just-messin-around/expo-foundation/hooks';
import { checkinChanged, peekCurrentCheckin, type CurrentCheckin } from './courtCheckin';

/**
 * [current, set]. `resetKey` (e.g. signed in or not) reads the cached copy
 * again when it changes.
 */
export function useCurrentCheckin(
  resetKey?: string | number | boolean | null,
): readonly [CurrentCheckin | null, (c: CurrentCheckin | null) => void] {
  const [current, setCurrent] = useState<CurrentCheckin | null>(null);
  // Bumped by every newer value: a cached read started before it is dropped.
  const version = useRef(0);
  const set = useCallback((c: CurrentCheckin | null) => {
    version.current += 1;
    setCurrent(c);
  }, []);
  useEffect(() => {
    let on = true;
    const at = version.current;
    void peekCurrentCheckin()
      .then((cur) => {
        if (on && version.current === at) setCurrent(cur);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [resetKey]);
  useSignal(checkinChanged, set);
  return [current, set] as const;
}
