// Headless app driver: log in as a sim player, open a screen, screenshot it.
//   node driver.mjs <urlPath> <shotName> [--full]
// Session persists to state.json after the first login so later shots are fast.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:8095';
const EMAIL = 'sim_player_1@pickleague.test';
const PASSWORD = 'pickle123';
const STATE = path.join(here, 'state.json');

// Git Bash rewrites leading "/" args into Windows paths — accept the path
// without a leading slash (and strip any mangling that slipped through).
const raw = (process.argv[2] ?? '').replace(/^[A-Za-z]:.*Git\/?/, '');
const urlPath = '/' + raw.replace(/^\/+/, '');
const shotName = process.argv[3] ?? 'shot';
const full = process.argv.includes('--full');

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 430, height: Number(process.env.SHOT_H || 3000) },   // phone-ish, like the app
  storageState: existsSync(STATE) ? STATE : undefined,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(BASE + urlPath, { waitUntil: 'networkidle', timeout: 90_000 });
await page.waitForTimeout(2500); // let the bundle hydrate + queries settle

// If we landed on the login screen, sign in and retry the target URL.
const emailBox = page.getByPlaceholder('Email');
if (await emailBox.count()) {
  console.log('logging in as', EMAIL);
  await emailBox.fill(EMAIL);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByText('Sign In', { exact: true }).click();
  await page.waitForTimeout(4000);
  await ctx.storageState({ path: STATE });
  await page.goto(BASE + urlPath, { waitUntil: 'networkidle', timeout: 90_000 });
  await page.waitForTimeout(2500);
}

const shot = path.join(here, 'shots', `${shotName}.png`);
await page.screenshot({ path: shot, fullPage: full });
console.log('saved', shot);
await browser.close();
