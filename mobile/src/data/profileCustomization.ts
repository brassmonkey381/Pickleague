export type AvatarDef = {
  id: number;
  emoji: string;
  name: string;
  bgColor: string;
  unlock?: { badge: string; description: string };
};

export type TagDef = {
  slug: string;
  label: string;
  funny?: boolean;
  unlock?: { badge: string; description: string };
};

export type TagSlotUnlock = {
  slots: number;
  badge: string;
  description: string;
};

export const AVATARS: AvatarDef[] = [
  // Free avatars (17)
  { id: 1,  emoji: '🐻', name: 'Bear',       bgColor: '#c8a97e' },
  { id: 2,  emoji: '🐼', name: 'Panda',      bgColor: '#e0e0e0' },
  { id: 3,  emoji: '🐸', name: 'Frog',       bgColor: '#a5d6a7' },
  { id: 4,  emoji: '🦊', name: 'Fox',        bgColor: '#ffb74d' },
  { id: 5,  emoji: '🐱', name: 'Cat',        bgColor: '#f8bbd0' },
  { id: 6,  emoji: '🐶', name: 'Dog',        bgColor: '#ffe082' },
  { id: 7,  emoji: '🐯', name: 'Tiger',      bgColor: '#ffa726' },
  { id: 8,  emoji: '🦁', name: 'Lion',       bgColor: '#ffcc80' },
  { id: 9,  emoji: '🐺', name: 'Wolf',       bgColor: '#b0bec5' },
  { id: 10, emoji: '🐧', name: 'Penguin',    bgColor: '#81d4fa' },
  { id: 11, emoji: '🦄', name: 'Unicorn',    bgColor: '#e1bee7' },
  { id: 12, emoji: '🦅', name: 'Eagle',      bgColor: '#90caf9' },
  { id: 13, emoji: '🦋', name: 'Butterfly',  bgColor: '#b3e5fc' },
  { id: 14, emoji: '🐲', name: 'Dragon',     bgColor: '#c8e6c9' },
  { id: 15, emoji: '🤖', name: 'Robot',      bgColor: '#cfd8dc' },
  { id: 16, emoji: '👾', name: 'Alien',      bgColor: '#ce93d8' },
  { id: 17, emoji: '🦝', name: 'Raccoon',    bgColor: '#b0bec5' },
  // Unlockable avatars (3)
  {
    id: 18, emoji: '🔥', name: 'Inferno',  bgColor: '#ffccbc',
    unlock: { badge: 'Hot Streak',    description: 'Win 5 consecutive matches' },
  },
  {
    id: 19, emoji: '👑', name: 'Royalty',  bgColor: '#fff9c4',
    unlock: { badge: 'League Leader', description: 'Reach #1 in a league\'s PLUPR standings' },
  },
  {
    id: 20, emoji: '🏆', name: 'Champion', bgColor: '#fff8e1',
    unlock: { badge: 'Top Rated',     description: 'Reach an overall PLUPR of 4.0 or higher' },
  },
];

export const PLAY_TAGS: TagDef[] = [
  // --- Serious play style (free) ---
  { slug: 'dink-master',          label: 'Dink Master' },
  { slug: 'power-banger',         label: 'Power Banger' },
  { slug: 'net-rusher',           label: 'Net Rusher' },
  { slug: 'baseline-camper',      label: 'Baseline Camper' },
  { slug: 'spin-doctor',          label: 'Spin Doctor' },
  { slug: 'touch-player',         label: 'Touch Player' },
  { slug: 'counterpuncher',       label: 'Counterpuncher' },
  { slug: 'kitchen-wizard',       label: 'Kitchen Wizard' },
  { slug: 'drop-shot-artist',     label: 'Drop Shot Artist' },
  { slug: 'all-court',            label: 'All Court' },
  { slug: 'the-attacker',         label: 'The Attacker' },
  { slug: 'serve-and-volley',     label: 'Serve & Volley' },
  { slug: 'poacher',              label: 'Poacher' },
  { slug: 'patient-player',       label: 'Patient Player' },
  { slug: 'the-grinder',          label: 'The Grinder' },
  { slug: 'speed-demon',          label: 'Speed Demon' },
  { slug: 'defensive-wall',       label: 'Defensive Wall' },
  { slug: 'shake-and-bake',       label: 'Shake & Bake' },
  { slug: 'third-shot-legend',    label: 'Third Shot Legend' },
  { slug: 'the-strategist',       label: 'The Strategist' },
  { slug: 'wind-reader',          label: 'Wind Reader' },
  { slug: 'fast-twitch',          label: 'Fast Twitch' },
  { slug: 'aggressive-baseline',  label: 'Aggressive Baseline' },
  // --- Funny / personality (free) ---
  { slug: 'the-lobber',           label: 'The Lobber',           funny: true },
  { slug: 'dink-or-die',          label: 'Dink or Die',          funny: true },
  { slug: 'never-dinks',          label: 'Never Dinks',          funny: true },
  { slug: 'lucky-lobber',         label: 'Lucky Lobber',         funny: true },
  { slug: 'banana-roll',          label: 'Banana Roll',          funny: true },
  { slug: 'atp-enthusiast',       label: 'ATP Enthusiast',       funny: true },
  { slug: 'snack-bringer',        label: 'Snack Bringer 🍌',     funny: true },
  { slug: 'trash-talker',         label: 'Trash Talker',         funny: true },
  { slug: 'the-encourager',       label: 'The Encourager',       funny: true },
  { slug: 'left-handed-terror',   label: 'Left-Handed Terror',   funny: true },
  // --- Background / style (free) ---
  { slug: 'tennis-convert',       label: 'Tennis Convert' },
  { slug: 'ping-pong-pro',        label: 'Ping Pong Pro' },
  { slug: 'volleyball-convert',   label: 'Volleyball Convert' },
  { slug: 'weekend-warrior',      label: 'Weekend Warrior' },
  { slug: 'teaching-pro',         label: 'Teaching Pro' },
  { slug: 'beginner-vibes',       label: 'Beginner Vibes',       funny: true },
  // --- Unlockable by badge (12) ---
  { slug: 'hot-streak-slayer',  label: '🔥 Hot Streak Slayer',  unlock: { badge: 'Hot Streak',        description: 'Win 5 consecutive matches' } },
  { slug: 'league-dominator',   label: '⚡ League Dominator',    unlock: { badge: 'Dominant',          description: 'Win a match 11-0 or 11-1' } },
  { slug: 'the-legend',         label: '🎖️ The Legend',          unlock: { badge: 'Veteran',           description: 'Be a member for 30+ days' } },
  { slug: 'iron-defender',      label: '💪 Iron Defender',       unlock: { badge: 'Iron Player',       description: 'Play 5 different days in a league' } },
  { slug: 'hat-trick-hero',     label: '🪄 Hat Trick Hero',      unlock: { badge: 'Hat Trick',         description: 'Win 3+ matches in one day' } },
  { slug: 'home-court-king',    label: '🏠 Home Court King',     unlock: { badge: 'Home Court Hero',   description: 'Win 5 home-court matches' } },
  { slug: 'the-champion',       label: '🏆 The Champion',        unlock: { badge: 'Top Rated',         description: 'Reach PLUPR of 4.0+' } },
  { slug: 'globe-trotter',      label: '🌍 Globe Trotter',       unlock: { badge: 'Court Hopper',      description: 'Play at 5+ different courts' } },
  { slug: 'double-trouble',     label: '🤝 Double Trouble',      unlock: { badge: 'Doubles Dynamo',    description: 'Play 20 doubles matches' } },
  { slug: 'single-minded',      label: '🎯 Single-Minded',       unlock: { badge: 'Singles Specialist', description: 'Play 25 singles matches' } },
  { slug: 'comeback-machine',   label: '🔄 Comeback Machine',    unlock: { badge: 'Comeback King',     description: 'Score 8+ in a losing match' } },
  { slug: 'the-leader',         label: '👑 The Leader',          unlock: { badge: 'League Leader',     description: 'Reach #1 in a league' } },
];

export const BASE_TAG_SLOTS = 3;

export const TAG_SLOT_UNLOCKS: TagSlotUnlock[] = [
  { slots: 4, badge: 'Veteran',   description: 'Be a Pickleague member for 30+ days' },
  { slots: 5, badge: 'Top Rated', description: 'Reach a PLUPR of 4.0 or higher' },
];

export function computeMaxTagSlots(earnedBadgeNames: string[]): number {
  let slots = BASE_TAG_SLOTS;
  for (const u of TAG_SLOT_UNLOCKS) {
    if (earnedBadgeNames.includes(u.badge)) slots = u.slots;
  }
  return slots;
}
