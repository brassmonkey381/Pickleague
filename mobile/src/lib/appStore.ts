// The App Store listing, in one place.
//
// Pickleague went live on the App Store 2026-09-03. This URL is also hardcoded
// in two non-TypeScript places that cannot import it — mobile/public/landing.html
// (the marketing install band) and scripts/generate-landing-qr.js (the printed QR
// target). If the listing ever moves, all three change together.

/** Numeric App Store Connect app ID. Same value as `ascAppId` in eas.json. */
export const APP_STORE_ID = '6796130870';

/** Public listing URL. Safe to open from any platform: on a Mac or iPhone it
 *  hands off to the App Store app, everywhere else it renders the web listing —
 *  which is why it is a fine link to show a desktop or Android visitor rather
 *  than hiding the button from them. */
export const APP_STORE_URL = `https://apps.apple.com/us/app/pickleague-club/id${APP_STORE_ID}`;
