// Predefined drill preference chips. Users can also add free-text custom tags.

export type DrillPref = { slug: string; label: string; emoji: string };

export const SHOT_PREFS: DrillPref[] = [
  { slug: 'dinks-cross',     emoji: '🎯', label: 'Cross-court dinks' },
  { slug: 'dinks-straight',  emoji: '🎯', label: 'Straight dinks' },
  { slug: 'third-shot-drop', emoji: '🪂', label: 'Third-shot drops' },
  { slug: 'third-shot-drive',emoji: '🚀', label: 'Third-shot drives' },
  { slug: 'volleys-kitchen', emoji: '🛡',  label: 'Kitchen-line volleys' },
  { slug: 'volleys-transit', emoji: '🌪',  label: 'Transition-zone volleys' },
  { slug: 'resets',          emoji: '🧘', label: 'Resets' },
  { slug: 'returns-deep',    emoji: '🎾', label: 'Deep returns' },
  { slug: 'serves',          emoji: '🏐', label: 'Serves' },
  { slug: 'lobs-offense',    emoji: '☁️', label: 'Offensive lobs' },
  { slug: 'lobs-defense',    emoji: '⛅', label: 'Defensive lobs' },
  { slug: 'erne-atp',        emoji: '⚡', label: 'Ernes / ATPs' },
  { slug: 'stacking',        emoji: '🤝', label: 'Stacking & poaching' },
  { slug: 'footwork',        emoji: '🦶', label: 'Footwork & movement' },
  { slug: 'fitness',         emoji: '💪', label: 'Drilling for fitness' },
  { slug: 'shadow',          emoji: '👤', label: 'Shadow drills' },
  { slug: 'live-balls',      emoji: '🔥', label: 'Live-ball points' },
];

export const PARTNER_PREFS: DrillPref[] = [
  { slug: 'similar-level', emoji: '⚖️', label: 'Similar skill level' },
  { slug: 'higher-level',  emoji: '🎓', label: 'Higher level (learn from)' },
  { slug: 'lower-level',   emoji: '🤲', label: 'Lower level (help out)' },
  { slug: 'casual',        emoji: '😄', label: 'Casual / fun pace' },
  { slug: 'intense',       emoji: '🔥', label: 'Intense / focused' },
  { slug: 'one-off',       emoji: '👋', label: 'One-off session' },
  { slug: 'regular',       emoji: '🔁', label: 'Looking for a regular partner' },
  { slug: 'feedback',      emoji: '💬', label: 'Open to feedback' },
  { slug: 'drills-only',   emoji: '🎯', label: 'Drills only — no games' },
  { slug: 'mix',           emoji: '🎲', label: 'Mix of drills + games' },
  { slug: 'singles-focus', emoji: '🏓', label: 'Singles focus' },
  { slug: 'doubles-focus', emoji: '👥', label: 'Doubles focus' },
];

export function findShotPref(slug: string)    { return SHOT_PREFS.find(p => p.slug === slug); }
export function findPartnerPref(slug: string) { return PARTNER_PREFS.find(p => p.slug === slug); }
