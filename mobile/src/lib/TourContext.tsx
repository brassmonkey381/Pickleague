import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Tour definitions ──────────────────────────────────────────────────
// A "tour" is a once-per-user spotlight walkthrough. Screens register
// measurable anchor refs for each step; SpotlightTour measures them and
// highlights them in sequence. Steps whose anchor never mounts are skipped.

export type TourStep = {
  stepKey: string;
  title: string;
  body: string;
};

export type TourKey = 'leagues' | 'profile';

export const TOURS: Record<TourKey, TourStep[]> = {
  leagues: [
    { stepKey: 'search', title: 'Find a league', body: 'Browse or search open leagues here.' },
    { stepKey: 'join',   title: 'Join in one tap', body: 'Tap the big Join button to enter a league.' },
    { stepKey: 'record', title: 'Record matches', body: 'Once you have played, record results from the highlighted card.' },
  ],
  profile: [
    { stepKey: 'edit',    title: 'Set up your profile', body: 'Add an avatar and details here.' },
    { stepKey: 'rewards', title: 'Unlockable rewards',   body: 'Track pickles and unlocks here.' },
  ],
};

// Anchors are measured via measureInWindow, which exists on the host
// component instance behind a ref. react-native-web implements it too.
type Measurable = {
  measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => void;
} | null;

type AnchorRef = React.MutableRefObject<Measurable> | { current: Measurable };

const seenKey = (tourKey: string) => `pickleague_tour_${tourKey}`;

type TourContextValue = {
  // Public API consumed by screens / FTUE card.
  armTour: (tourKey: TourKey) => void;
  registerAnchor: (tourKey: string, stepKey: string, ref: AnchorRef) => void;
  // Internal state consumed by <SpotlightTour/>.
  activeTour: TourKey | null;
  stepIndex: number;
  getAnchor: (tourKey: string, stepKey: string) => AnchorRef | undefined;
  next: () => void;
  finish: () => void;
};

const TourContext = createContext<TourContextValue | null>(null);

export function TourProvider({ children }: { children: React.ReactNode }) {
  // Which tour we want to begin once its first anchor mounts. Held in a ref
  // so arming (which happens just before navigation) doesn't depend on a
  // re-render to take effect.
  const armedRef = useRef<TourKey | null>(null);
  // anchors[tourKey][stepKey] = ref. Refs only; never triggers re-render.
  const anchorsRef = useRef<Map<string, Map<string, AnchorRef>>>(new Map());

  const [activeTour, setActiveTour] = useState<TourKey | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  // Mirror the active tour + step in refs so next()/finish() can read the
  // latest values without nesting state updaters (which StrictMode may
  // double-invoke, causing duplicate AsyncStorage writes).
  const activeTourRef = useRef<TourKey | null>(null);
  const stepIndexRef = useRef(0);
  activeTourRef.current = activeTour;
  stepIndexRef.current = stepIndex;

  // In-memory cache of the persisted "seen" flag per tour. undefined = not yet
  // read from storage. We need a synchronous answer in tryStart, so the async
  // read result is cached here and tryStart is re-run once it lands.
  const seenRef = useRef<Map<string, boolean>>(new Map());

  const tryStart = useCallback((tourKey: string) => {
    // Arm gate: this tour must be armed AND confirmed not-yet-seen.
    if (armedRef.current !== tourKey) return;
    if (seenRef.current.get(tourKey) !== false) return; // unknown or seen → wait/skip
    // Only start once a real anchor exists for this tour.
    const stepMap = anchorsRef.current.get(tourKey);
    if (!stepMap || stepMap.size === 0) return;
    armedRef.current = null;
    activeTourRef.current = tourKey as TourKey;
    stepIndexRef.current = 0;
    setStepIndex(0);
    setActiveTour(tourKey as TourKey);
  }, []);

  const armTour = useCallback((tourKey: TourKey) => {
    // Arm synchronously so a fast-mounting destination screen's anchor
    // registration sees the armed tour (avoids a race with the async seen
    // read). The seen-flag check below gates whether it actually starts.
    armedRef.current = tourKey;
    const cached = seenRef.current.get(tourKey);
    if (cached !== undefined) {
      // Already know the answer: if seen, disarm; tryStart will pick it up
      // (re-invoked here in case the anchor is already registered).
      if (cached) armedRef.current = null;
      else tryStart(tourKey);
      return;
    }
    // First time: read the persisted flag, cache it, then re-evaluate start.
    AsyncStorage.getItem(seenKey(tourKey)).then((v) => {
      const seen = !!v;
      seenRef.current.set(tourKey, seen);
      if (seen) {
        if (armedRef.current === tourKey) armedRef.current = null;
        return;
      }
      tryStart(tourKey);
    });
  }, [tryStart]);

  const registerAnchor = useCallback(
    (tourKey: string, stepKey: string, ref: AnchorRef) => {
      let stepMap = anchorsRef.current.get(tourKey);
      if (!stepMap) {
        stepMap = new Map();
        anchorsRef.current.set(tourKey, stepMap);
      }
      stepMap.set(stepKey, ref);
      // A newly-registered anchor may be the first one for an armed tour.
      tryStart(tourKey);
    },
    [tryStart],
  );

  const getAnchor = useCallback((tourKey: string, stepKey: string) => {
    return anchorsRef.current.get(tourKey)?.get(stepKey);
  }, []);

  const finish = useCallback(() => {
    const tour = activeTourRef.current;
    if (!tour) return;
    AsyncStorage.setItem(seenKey(tour), '1');
    seenRef.current.set(tour, true); // keep cache in sync for same-session re-arms
    activeTourRef.current = null;
    stepIndexRef.current = 0;
    setActiveTour(null);
    setStepIndex(0);
  }, []);

  const next = useCallback(() => {
    const tour = activeTourRef.current;
    if (!tour) return;
    const steps = TOURS[tour];
    const ni = stepIndexRef.current + 1;
    if (ni >= steps.length) {
      finish();
      return;
    }
    stepIndexRef.current = ni;
    setStepIndex(ni);
  }, [finish]);

  const value = useMemo<TourContextValue>(
    () => ({ armTour, registerAnchor, activeTour, stepIndex, getAnchor, next, finish }),
    [armTour, registerAnchor, activeTour, stepIndex, getAnchor, next, finish],
  );

  return (
    <TourContext.Provider value={value}>
      <View style={{ flex: 1 }}>{children}</View>
    </TourContext.Provider>
  );
}

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) {
    // Defensive no-op so screens calling useTour() outside the provider
    // (e.g. isolated tests) don't crash.
    return {
      armTour: () => {},
      registerAnchor: () => {},
      activeTour: null,
      stepIndex: 0,
      getAnchor: () => undefined,
      next: () => {},
      finish: () => {},
    };
  }
  return ctx;
}
