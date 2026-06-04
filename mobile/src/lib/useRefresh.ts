import { useCallback, useState } from 'react';

/**
 * Pull-to-refresh helper. Wraps an existing async loader so each screen can
 * wire a RefreshControl without re-implementing the `refreshing` flag.
 *
 *   const load = async () => { ...fetch... };
 *   const refresh = useRefresh(load);
 *   <ScrollView refreshControl={<AppRefreshControl {...refresh} />}>
 *
 * The loader may be sync or async; `refreshing` flips off when it settles
 * (even if it throws), so a failed reload never leaves the spinner stuck.
 */
export function useRefresh(loader: () => Promise<unknown> | unknown) {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loader();
    } finally {
      setRefreshing(false);
    }
  }, [loader]);
  return { refreshing, onRefresh };
}
