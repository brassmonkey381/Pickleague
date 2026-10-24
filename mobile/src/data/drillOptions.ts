// Predefined drill preference chips. Users can also add free-text custom tags.
//
// Each preference names a drawn glyph (glyphs-ui-plan.md 6.3), not an emoji:
// the chips render <Icon name={iconName} /> beside the label.
import type { IconName } from '@just-messin-around/expo-foundation/icons';

export type DrillPref = { slug: string; label: string; iconName: IconName };

export const SHOT_PREFS: DrillPref[] = [
  { slug: 'dinks-cross',      iconName: 'target',     label: 'Cross-court dinks' },
  { slug: 'dinks-straight',   iconName: 'target',     label: 'Straight dinks' },
  { slug: 'third-shot-drop',  iconName: 'shot-drop',  label: 'Third-shot drops' },
  { slug: 'third-shot-drive', iconName: 'rocket',     label: 'Third-shot drives' },
  { slug: 'volleys-kitchen',  iconName: 'shield',     label: 'Kitchen-line volleys' },
  { slug: 'volleys-transit',  iconName: 'wind',       label: 'Transition-zone volleys' },
  { slug: 'resets',           iconName: 'undo',       label: 'Resets' },
  { slug: 'returns-deep',     iconName: 'pickleball', label: 'Deep returns' },
  { slug: 'serves',           iconName: 'shot-serve', label: 'Serves' },
  { slug: 'lobs-offense',     iconName: 'shot-lob',   label: 'Offensive lobs' },
  { slug: 'lobs-defense',     iconName: 'shot-lob',   label: 'Defensive lobs' },
  { slug: 'erne-atp',         iconName: 'bolt',       label: 'Ernes / ATPs' },
  { slug: 'stacking',         iconName: 'handshake',  label: 'Stacking & poaching' },
  { slug: 'footwork',         iconName: 'walk',       label: 'Footwork & movement' },
  { slug: 'fitness',          iconName: 'dumbbell',   label: 'Drilling for fitness' },
  { slug: 'shadow',           iconName: 'account',    label: 'Shadow drills' },
  { slug: 'live-balls',       iconName: 'fire',       label: 'Live-ball points' },
];

export const PARTNER_PREFS: DrillPref[] = [
  { slug: 'similar-level', iconName: 'scale',      label: 'Similar skill level' },
  { slug: 'higher-level',  iconName: 'graduation', label: 'Higher level (learn from)' },
  { slug: 'lower-level',   iconName: 'heart',      label: 'Lower level (help out)' },
  { slug: 'casual',        iconName: 'smile',      label: 'Casual / fun pace' },
  { slug: 'intense',       iconName: 'fire',       label: 'Intense / focused' },
  { slug: 'one-off',       iconName: 'wave',       label: 'One-off session' },
  { slug: 'regular',       iconName: 'repeat',     label: 'Looking for a regular partner' },
  { slug: 'feedback',      iconName: 'chat',       label: 'Open to feedback' },
  { slug: 'drills-only',   iconName: 'target',     label: 'Drills only — no games' },
  { slug: 'mix',           iconName: 'shuffle',    label: 'Mix of drills + games' },
  { slug: 'singles-focus', iconName: 'person',     label: 'Singles focus' },
  { slug: 'doubles-focus', iconName: 'group',      label: 'Doubles focus' },
];

export function findShotPref(slug: string)    { return SHOT_PREFS.find(p => p.slug === slug); }
export function findPartnerPref(slug: string) { return PARTNER_PREFS.find(p => p.slug === slug); }
