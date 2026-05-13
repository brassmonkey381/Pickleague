// Premium-flair effects. Keyed by the hex stored in profiles.name_color
// (lowercased). Each entry can add a prefix/suffix glyph around the name
// and/or a text-shadow glow. Free flairs (cost ≤ 1000) just get the color
// applied directly and pass through unchanged.

export type FlairEffect = {
  color: string;
  prefix?: string;
  suffix?: string;
  glow?: { color: string; radius: number };
};

const PREMIUM: Record<string, FlairEffect> = {
  // Gold (1500) — shimmering sparkles + warm glow.
  '#d4af37': {
    color:  '#d4af37',
    suffix: '✨',
    glow:   { color: '#fff176', radius: 6 },
  },
  // Neon Green (1800) — lime laser glow, no glyph (clean neon sign look).
  '#39ff14': {
    color: '#39ff14',
    glow:  { color: '#39ff14', radius: 10 },
  },
  // Sunset Orange (2000) — sunrise leading the name.
  '#ff6f3c': {
    color:  '#ff6f3c',
    prefix: '🌅',
    glow:   { color: '#ff8a50', radius: 4 },
  },
  // Royal Blue (2200) — crown of authority.
  '#1e3a8a': {
    color:  '#1e3a8a',
    prefix: '👑',
  },
  // Crimson (2500) — dagger dripping blood.
  '#dc143c': {
    color:  '#dc143c',
    suffix: '🗡️🩸',
    glow:   { color: '#8b0000', radius: 3 },
  },
  // Coral (3000) — reef-side flex.
  '#ff7f50': {
    color:  '#ff7f50',
    suffix: '🪸',
    glow:   { color: '#ffab91', radius: 4 },
  },
};

export function getFlairEffect(nameColor: string | null | undefined): FlairEffect | null {
  if (!nameColor) return null;
  const key = nameColor.toLowerCase();
  if (PREMIUM[key]) return PREMIUM[key];
  // Unknown color (free flair) — color only, no decoration.
  return { color: nameColor };
}
