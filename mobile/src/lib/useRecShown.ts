// `recs.shown` once per list appearance (lib/analytics trackRecShown), not on
// every render: the event fires when `ids` (the list's identity, joined here
// and never sent) first appears or changes while `enabled`, and again after
// the list was hidden (enabled false) and shows again. `ids` null means not
// loaded yet; an empty list is not an appearance and logs nothing.
import { useEffect, useRef } from 'react';
import { trackRecShown, type RecShownProps } from './analytics';
import type { Recommender } from './recsVersions';

export function useRecShown(
  recommender: Recommender,
  enabled: boolean,
  ids: readonly (string | number)[] | null | undefined,
  props: RecShownProps,
): void {
  const lastKey = useRef<string | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  // The surface and any enum props (a sort, a source) are part of the
  // appearance: a re-sort is a new list.
  const extraKey = JSON.stringify(props);
  const key = ids && ids.length ? `${ids.join(',')}|${extraKey}` : null;
  useEffect(() => {
    if (!enabled || !key) {
      if (!enabled) lastKey.current = null;
      return;
    }
    if (lastKey.current === key) return;
    lastKey.current = key;
    trackRecShown(recommender, propsRef.current);
  }, [enabled, key, recommender]);
}
