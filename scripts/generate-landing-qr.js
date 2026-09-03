/**
 * Regenerates the two QR codes on the marketing landing page
 * (mobile/public/landing-assets/qr-*.svg).
 *
 *   node scripts/generate-landing-qr.js
 *
 * Why these are committed SVGs rather than a QR web service: a hotlinked
 * <img> would hand every landing-page visitor's IP to a third party and
 * would break the page the day that service disappears. SVG (not PNG) so
 * the codes stay razor-sharp at any size, which matters — a soft QR is a
 * QR that will not scan.
 *
 * The two targets are deliberately different; see the comment above the
 * install band in mobile/public/landing.html before changing either.
 *
 * `qrcode` is a transitive dep of the Expo toolchain and lives in
 * mobile/node_modules, so it is resolved from there explicitly — this
 * script's own directory has a separate node_modules that does not have it.
 */
const path = require('path');
const fs = require('fs');

const MOBILE = path.resolve(__dirname, '..', 'mobile');
const QRCode = require(path.join(MOBILE, 'node_modules', 'qrcode'));
const OUT = path.join(MOBILE, 'public', 'landing-assets');

const TARGETS = [
  {
    file: 'qr-appstore.svg',
    text: 'https://apps.apple.com/us/app/pickleague-club/id6796130870',
  },
  {
    // Canonical origin on purpose: the apex 307-redirects to www, and a
    // redirect hop on a phone camera scan is latency the visitor feels.
    file: 'qr-web.svg',
    text: 'https://www.pickleague.club/?utm_source=landing&utm_medium=qr&utm_campaign=footer',
  },
];

(async () => {
  for (const t of TARGETS) {
    const svg = await QRCode.toString(t.text, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#14241A', light: '#FFFFFF' },
    });
    fs.writeFileSync(path.join(OUT, t.file), svg, 'utf8');
    console.log(`wrote ${t.file}  ->  ${t.text}`);
  }
  console.log('\nScan both before shipping. A QR that encodes the wrong URL still looks perfect.');
})();
