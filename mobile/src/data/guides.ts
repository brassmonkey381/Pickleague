import type { IconName } from '@just-messin-around/expo-foundation/icons';

/**
 * Settings › About › Guides: the explainer infographics. Each page is a
 * self-contained HTML file from infographics-studio, copied into
 * mobile/public/guides/ so it deploys with the web app. To add one: copy the
 * studio's out/*.html there and add a row here (newest first).
 */
export type Guide = { slug: string; title: string; desc: string; icon: IconName };

export const GUIDES: Guide[] = [
  { slug: 'plupr', title: 'Why did my PLUPR move?', desc: 'How your rating changes after a match.', icon: 'scale' },
];

export const GUIDES_BASE_URL = 'https://www.pickleague.club/guides/';

export function guideUrl(g: Pick<Guide, 'slug'>): string {
  return `${GUIDES_BASE_URL}${g.slug}.html`;
}
