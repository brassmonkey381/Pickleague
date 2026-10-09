// Pickleague's store-rating policy on top of the foundation's rate limiter.
//
// Call noteGoodMoment() right after something the player is glad about: a match
// result they just confirmed, a court check-in that went through. The
// foundation asks the OS for the review sheet once two such moments have
// happened, then waits four months, and never more than three times a year.
// Never on web, never throws, never awaited by a button.
import { noteGoodMoment as note } from '@just-messin-around/expo-foundation/platform';

const POLICY = { storageKey: 'pickleague_review', minMoments: 2, cooldownDays: 120, maxAsksPerYear: 3 };

export function noteGoodMoment(): void {
  void note(POLICY).catch(() => {});
}
