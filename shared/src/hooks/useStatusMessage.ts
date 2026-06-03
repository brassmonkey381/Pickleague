import { useCallback, useState } from 'react';

/**
 * Unified success/error message state. Pair with <StatusBanner /> to render.
 * Set in either direction:
 *   const status = useStatusMessage();
 *   status.success('Saved.');
 *   status.error(err.message);
 *   status.clear();
 *
 * Optional missing-RPC hint helper (since multiple admin RPCs surface the same
 * "Run xyz.sql" message when PostgREST returns PGRST202):
 *   status.errorFromRpc(error, 'migration_xyz.sql');
 */
export type StatusMessage = { kind: 'success' | 'error'; text: string } | null;

export type UseStatusMessage = {
  value: StatusMessage;
  success: (text: string) => void;
  error: (text: string) => void;
  errorFromRpc: (
    err: { message?: string } | null | undefined,
    missingMigrationHint?: string,
  ) => void;
  clear: () => void;
};

export function useStatusMessage(): UseStatusMessage {
  const [value, setValue] = useState<StatusMessage>(null);

  const success = useCallback((text: string) => setValue({ kind: 'success', text }), []);
  const error   = useCallback((text: string) => setValue({ kind: 'error',   text }), []);
  const clear   = useCallback(() => setValue(null), []);

  const errorFromRpc = useCallback((
    err: { message?: string } | null | undefined,
    missingMigrationHint?: string,
  ) => {
    const msg = err?.message ?? 'Unknown error';
    const looksMissing = /does not exist|Could not find the function|PGRST202/i.test(msg);
    if (looksMissing && missingMigrationHint) {
      setValue({ kind: 'error', text: `${msg}\n\nLikely fix: run ${missingMigrationHint} in the Supabase SQL Editor.` });
    } else {
      setValue({ kind: 'error', text: msg });
    }
  }, []);

  return { value, success, error, errorFromRpc, clear };
}
