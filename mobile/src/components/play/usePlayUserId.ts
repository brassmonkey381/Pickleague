// The signed-in user's id for Play's per-user saved filters
// (`play:<list>:<userId>`). currentUserId is a LOCAL session read, so this
// resolves on the next tick without a network round trip; until it does the
// saved-filter key is null and the filters run from their defaults in memory.
import { useEffect, useState } from 'react';
import { currentUserId } from '@just-messin-around/expo-foundation/supabase';
import { supabase } from '../../lib/supabase';

export function usePlayUserId(): string | null {
  const [uid, setUid] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    currentUserId(supabase)
      .then((id) => { if (alive) setUid(id ?? null); })
      .catch(() => { /* no id: filters stay in memory for this visit */ });
    return () => { alive = false; };
  }, []);
  return uid;
}
