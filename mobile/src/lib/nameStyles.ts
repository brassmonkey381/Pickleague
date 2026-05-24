// Name-style preset library. Keyed by shop_items.slug — must match the seeded
// rows 1:1 (see supabase/migration_name_styles.sql). The shop_items row owns
// the ownership/display metadata; this file is the source of truth for the
// visual recipe applied at render time.
//
// Backward compat: the legacy `profiles.name_color` flair path is unchanged
// and lives in `nameFlair.ts`. The new style system only activates when a
// FlairName consumer passes a `styleId`.

export type NameStyle =
  | { kind: 'solid';    color: string }
  | { kind: 'gradient'; stops: string[]; direction?: 'horizontal' | 'vertical' }
  | { kind: 'glow';     color: string; radius: number }
  | { kind: 'metallic'; base: string; shineColor: string }
  | { kind: 'animated'; effect: 'pulse' | 'rainbow' | 'sparkle' | 'typewriter' | 'holographic'; base: string };

// Library of presets. Keys must match shop_items.slug.
export const NAME_STYLES: Record<string, NameStyle> = {
  // ── Purchasable list styles ──────────────────────────────────────
  // Solid (500p)
  'list-solid-ruby':          { kind: 'solid', color: '#e0245e' },
  'list-solid-sapphire':      { kind: 'solid', color: '#1d4ed8' },
  'list-solid-emerald':       { kind: 'solid', color: '#059669' },
  'list-solid-royal-purple':  { kind: 'solid', color: '#7c3aed' },
  'list-solid-cyber':         { kind: 'solid', color: '#06b6d4' },
  'list-solid-sunset-orange': { kind: 'solid', color: '#f97316' },

  // Gradients (2,500p)
  'list-grad-sunset':     { kind: 'gradient', stops: ['#ff7e5f', '#feb47b'], direction: 'horizontal' },
  'list-grad-ocean':      { kind: 'gradient', stops: ['#2193b0', '#6dd5ed'], direction: 'horizontal' },
  'list-grad-forest':     { kind: 'gradient', stops: ['#134e5e', '#71b280'], direction: 'horizontal' },
  'list-grad-lavender':   { kind: 'gradient', stops: ['#8e2de2', '#f093fb'], direction: 'horizontal' },
  'list-grad-volcano':    { kind: 'gradient', stops: ['#ff416c', '#ff4b2b'], direction: 'horizontal' },
  'list-grad-monochrome': { kind: 'gradient', stops: ['#232526', '#414345'], direction: 'horizontal' },

  // Glow (4,000p)
  'list-glow-neon-pink':   { kind: 'glow', color: '#ec4899', radius: 8 },
  'list-glow-cyber-blue':  { kind: 'glow', color: '#22d3ee', radius: 8 },
  'list-glow-toxic-green': { kind: 'glow', color: '#84cc16', radius: 8 },
  'list-glow-inferno':     { kind: 'glow', color: '#f97316', radius: 8 },

  // Metallic (6,500p)
  'list-metal-gold-leaf':         { kind: 'metallic', base: '#d4af37', shineColor: '#fff8dc' },
  'list-metal-silver-shine':      { kind: 'metallic', base: '#a3a3a3', shineColor: '#f5f5f5' },
  'list-metal-bronze':            { kind: 'metallic', base: '#b08d57', shineColor: '#f1d4a5' },
  'list-metal-holographic-foil':  { kind: 'metallic', base: '#a78bfa', shineColor: '#fce7ff' },

  // ── Purchasable hero animated styles (10k–15k) ───────────────────
  'hero-anim-pulse':       { kind: 'animated', effect: 'pulse',       base: '#ec4899' },
  'hero-anim-rainbow':     { kind: 'animated', effect: 'rainbow',     base: '#a78bfa' },
  'hero-anim-sparkle':     { kind: 'animated', effect: 'sparkle',     base: '#fbbf24' },
  'hero-anim-typewriter':  { kind: 'animated', effect: 'typewriter',  base: '#22d3ee' },
  'hero-anim-holographic': { kind: 'animated', effect: 'holographic', base: '#a78bfa' },

  // ── Progression-unlock styles (free, badge-gated) ────────────────
  'style-first-rally-glow':        { kind: 'glow',     color: '#22d3ee', radius: 7 },
  'style-top-rated-prismatic':     { kind: 'animated', effect: 'holographic', base: '#a78bfa' },
  'style-hot-streak-fire':         { kind: 'animated', effect: 'pulse',       base: '#ef4444' },
  'style-veteran-classic':         { kind: 'metallic', base: '#b08d57', shineColor: '#f1d4a5' },
  'style-court-hopper-rainbow':    { kind: 'animated', effect: 'rainbow', base: '#a78bfa' },
  'style-singles-specialist-solo': { kind: 'solid',    color: '#059669' },
  'style-doubles-dynamo-duo':      { kind: 'gradient', stops: ['#2193b0', '#6dd5ed'], direction: 'horizontal' },
  'style-champion-gold':           { kind: 'metallic', base: '#d4af37', shineColor: '#fff8dc' },
};

/** Resolve a slug to its preset recipe. Returns null for null/unknown slugs. */
export function getNameStyle(slug: string | null | undefined): NameStyle | null {
  if (!slug) return null;
  return NAME_STYLES[slug] ?? null;
}

/**
 * In list contexts we forbid animations to avoid visual chaos in dense lists.
 * Animated recipes degrade to a static solid using the recipe's `base` color.
 * Everything else passes through unchanged.
 */
export function degradeForList(style: NameStyle): NameStyle {
  if (style.kind === 'animated') {
    return { kind: 'solid', color: style.base };
  }
  return style;
}
