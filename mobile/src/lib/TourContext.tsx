// The spotlight-tour engine moved to @just-messin-around/expo-foundation/tour as a factory.
// This adapter keeps the Pickleague-specific tour definitions + storage-key
// prefix and instantiates the engine, so consumers
// (`import { TourProvider, useTour, TOURS } from '../lib/TourContext'`) are
// unchanged.
import { createTourContext, type TourStep } from '@just-messin-around/expo-foundation/tour';

export type { TourStep } from '@just-messin-around/expo-foundation/tour';

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

const tour = createTourContext<TourKey>({
  storagePrefix: 'pickleague_tour_',
  tours: TOURS,
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
    nextLabel: 'Next →',
  },
});

export const { TourProvider, useTour } = tour;

/** Kit-bound overlay. Render it via components/SpotlightTour.tsx, which layers
 *  the Pickleague palette on top. */
export const SpotlightTourBase = tour.SpotlightTour;
