// The spotlight-tour engine moved to @stockman/rn-foundation/tour as a factory.
// This adapter keeps the Pickleague-specific tour definitions + storage-key
// prefix and instantiates the engine, so consumers
// (`import { TourProvider, useTour, TOURS } from '../lib/TourContext'`) are
// unchanged.
import { createTourContext, type TourStep } from '@stockman/rn-foundation/tour';

export type { TourStep } from '@stockman/rn-foundation/tour';

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

export const { TourProvider, useTour } = createTourContext<TourKey>({
  storagePrefix: 'pickleague_tour_',
  tours: TOURS,
});
