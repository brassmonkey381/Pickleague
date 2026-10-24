/**
 * Reliability score — how trustworthy a PLUPR rating is.
 *
 * Formula:
 *   base  = min(totalMatches, 30) / 30          (30 matches → fully established)
 *   decay = exp(-daysInactive / 120)            (120-day characteristic decay)
 *   score = base * decay                         (0–1)
 *
 * A brand-new player starts at 0.
 * After 15 matches with no inactivity → ~50%.
 * After 30 matches with no inactivity → 100%.
 * After 30 matches but 6 months idle → ~22%.
 *
 * Tier colours come from the theme (light and dark): computeReliability takes
 * the palette and returns the tier's token colour.
 */
import type { Theme } from '@just-messin-around/expo-foundation/theme';

export type ReliabilityInfo = {
  score: number;          // 0–1
  pct: number;            // 0–100 rounded
  label: string;          // human-readable tier
  color: string;          // the tier's theme colour
  detail: string;         // tooltip-style explanation
  dots: number;           // 0–5 filled dots
};

type TierTone = 'success' | 'primary' | 'warning' | 'danger' | 'textMuted';

const TIERS: ReadonlyArray<{ min: number; label: string; tone: TierTone }> = [
  { min: 0.80, label: 'Established', tone: 'success' },
  { min: 0.55, label: 'Reliable',    tone: 'primary' },
  { min: 0.35, label: 'Developing',  tone: 'warning' },
  { min: 0.12, label: 'Provisional', tone: 'danger' },
  { min: 0.00, label: 'Inactive',    tone: 'textMuted' },
];

export function computeReliability(
  totalMatches: number,
  lastMatchAt:  string | null,
  c:            Theme,
): ReliabilityInfo {
  const base = Math.min(totalMatches, 30) / 30;

  let decay = 1.0;
  let daysInactive = 0;
  if (lastMatchAt) {
    daysInactive = (Date.now() - new Date(lastMatchAt).getTime()) / 86_400_000;
    decay = Math.exp(-daysInactive / 120);
  } else if (totalMatches === 0) {
    decay = 0;
  }

  const score = base * decay;
  const pct   = Math.round(score * 100);
  const dots  = Math.round(score * 5);

  const tier  = TIERS.find(t => score >= t.min) ?? TIERS[TIERS.length - 1];

  const matchPhrase = totalMatches === 0
    ? 'No matches yet'
    : `${totalMatches} match${totalMatches === 1 ? '' : 'es'} played`;

  const idlePhrase = !lastMatchAt
    ? ''
    : daysInactive < 3
      ? ' · active recently'
      : daysInactive < 30
        ? ` · ${Math.round(daysInactive)}d ago`
        : ` · ${Math.round(daysInactive / 30)}mo ago`;

  return {
    score,
    pct,
    label: tier.label,
    color: c[tier.tone],
    detail: `${matchPhrase}${idlePhrase}`,
    dots,
  };
}

/** Format reliability as "87% reliable" for compact inline use */
export function reliabilityShort(info: ReliabilityInfo): string {
  return `${info.pct}%`;
}
