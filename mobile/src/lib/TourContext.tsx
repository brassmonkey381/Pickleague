// The spotlight-tour engine moved to @just-messin-around/expo-foundation/tour as a factory.
// This adapter keeps the Pickleague-specific tour definitions + storage-key
// prefix and instantiates the engine, so consumers
// (`import { TourProvider, useTour, TOURS } from '../lib/TourContext'`) are
// unchanged.
import { createTourContext, type TourStep } from '@just-messin-around/expo-foundation/tour';
import { createSignal } from '@just-messin-around/expo-foundation/hooks';

export type { TourStep } from '@just-messin-around/expo-foundation/tour';

export type TourKey = 'leagues' | 'profile';

export const TOURS: Record<TourKey, TourStep[]> = {
  // Anchors: 'search' = the Play/Leagues search field (registered only while
  // that list is focused and its tab visible), 'join' = the [Join] on the first
  // joinable DISCOVER row, 'record' = LeagueDetail's quick-row Record.
  leagues: [
    { stepKey: 'search', title: 'Find a league', body: 'Search or browse leagues here.' },
    { stepKey: 'join',   title: 'Join in one tap', body: 'Tap Join to enter a league.' },
    { stepKey: 'record', title: 'Record matches', body: 'After you play, tap Record.' },
  ],
  profile: [
    { stepKey: 'edit',    title: 'Set up your profile', body: 'Add an avatar and details here.' },
    { stepKey: 'rewards', title: 'Unlockable rewards',   body: 'Your next unlock. Tap to see all your achievements.' },
  ],
};

// Fired the moment a tour actually starts (first run AND a manual replay), so
// the screens that host its anchors can make them reachable: Discover (Play,
// while Discover is off) switches to its Leagues tab, and the Leagues list
// closes its filter sheet and clears the
// Discover chips + route-param chips that could hide the first joinable row.
// A signal rather than a direct call because the engine is created once at
// module level and the screens come and go.
const tourStartSignal = createSignal<TourKey>();

/** Subscribe to tour starts. Returns an unsubscribe function. */
export const onTourStart = tourStartSignal.subscribe;

const tour = createTourContext<TourKey>({
  storagePrefix: 'pickleague_tour_',
  tours: TOURS,
  onStart: (tourKey) => tourStartSignal.emit(tourKey),
  // Behavior/layout of the overlay. These reproduce Pickleague's original
  // hand-rolled overlay: a non-blocking absolute layer (taps reach the
  // highlighted target), tap-the-dim-to-dismiss, an anchored 280px bubble, and
  // nothing rendered until the anchor has been measured. The theme-dependent
  // styling lives in components/SpotlightTour.tsx, which needs the palette.
  spotlight: {
    blockInteraction: false,
    dismissOnBackdropPress: true,
    showSkipOnLastStep: true,
    anchored: true,
    cardWidth: 280,
    spotlightPadding: 8,
    hideUntilMeasured: true,
    dimColor: 'rgba(0,0,0,0.62)',
    counterPlacement: 'aboveTitle',
    // "Next" plus the arrow glyph (foundation 1.66 nextIconName; the old
    // text arrow is gone). The last step's "Done" has no glyph.
    nextLabel: 'Next',
    nextIconName: 'arrow-right',
    // Pickleague's original overlay rendered a tight "1/3" and a 14px
    // body-to-footer gap (the kit defaults are " / " and 16).
    counterSeparator: '/',
    footerMarginTop: 14,
  },
});

export const { TourProvider, useTour } = tour;

/** Kit-bound overlay. Render it via components/SpotlightTour.tsx, which layers
 *  the Pickleague palette on top. */
export const SpotlightTourBase = tour.SpotlightTour;
