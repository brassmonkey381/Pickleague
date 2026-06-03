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

// ── Tours ─────────────────────────────────────────────────────────────
// A "tour" is a once-per-user spotlight walkthrough. Screens register
// measurable anchor refs for each step; a SpotlightTour component measures them
// and highlights them in sequence. Steps whose anchor never mounts are skipped.
//
// This is the generic engine: an app supplies its own tour definitions (keyed by
// its own union of tour keys) + a storage-key prefix, and gets back a
// { TourProvider, useTour } pair bound to one context instance.

export type TourStep = {
  stepKey: string;
  title: string;
  body: string;
};

// Anchors are measured via measureInWindow, which exists on the host component
// instance behind a ref. react-native-web implements it too.
type Measurable = {
  measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => void;
} | null;

export type AnchorRef = React.MutableRefObject<Measurable> | { current: Measurable };

export type TourContextValue<K extends string> = {
  // Public API consumed by screens / FTUE card.
  armTour: (tourKey: K) => void;
  registerAnchor: (tourKey: string, stepKey: string, ref: AnchorRef) => void;
  // Internal state consumed by a <SpotlightTour/> renderer.
  activeTour: K | null;
  stepIndex: number;
  getAnchor: (tourKey: string, stepKey: string) => AnchorRef | undefined;
  next: () => void;
  finish: () => void;
};

export function createTourContext<K extends string>(opts: {
  /** Prefix for the per-tour "seen" AsyncStorage flag, e.g. 'myapp_tour_'. */
  storagePrefix: string;
  /** Tour definitions keyed by the app's tour-key union. */
  tours: Record<K, TourStep[]>;
}) {
  const { storagePrefix, tours } = opts;
  const seenKey = (tourKey: string) => `${storagePrefix}${tourKey}`;

  const TourContext = createContext<TourContextValue<K> | null>(null);

  function TourProvider({ children }: { children: React.ReactNode }) {
    // Which tour we want to begin once its first anchor mounts. Held in a ref
    // so arming (which happens just before navigation) doesn't depend on a
    // re-render to take effect.
    const armedRef = useRef<K | null>(null);
    // anchors[tourKey][stepKey] = ref. Refs only; never triggers re-render.
    const anchorsRef = useRef<Map<string, Map<string, AnchorRef>>>(new Map());

    const [activeTour, setActiveTour] = useState<K | null>(null);
    const [stepIndex, setStepIndex] = useState(0);
    // Mirror the active tour + step in refs so next()/finish() can read the
    // latest values without nesting state updaters (which StrictMode may
    // double-invoke, causing duplicate AsyncStorage writes).
    const activeTourRef = useRef<K | null>(null);
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
      activeTourRef.current = tourKey as K;
      stepIndexRef.current = 0;
      setStepIndex(0);
      setActiveTour(tourKey as K);
    }, []);

    const armTour = useCallback((tourKey: K) => {
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
      const steps = tours[tour];
      const ni = stepIndexRef.current + 1;
      if (ni >= steps.length) {
        finish();
        return;
      }
      stepIndexRef.current = ni;
      setStepIndex(ni);
    }, [finish]);

    const value = useMemo<TourContextValue<K>>(
      () => ({ armTour, registerAnchor, activeTour, stepIndex, getAnchor, next, finish }),
      [armTour, registerAnchor, activeTour, stepIndex, getAnchor, next, finish],
    );

    return (
      <TourContext.Provider value={value}>
        <View style={{ flex: 1 }}>{children}</View>
      </TourContext.Provider>
    );
  }

  function useTour(): TourContextValue<K> {
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

  return { TourProvider, useTour };
}
