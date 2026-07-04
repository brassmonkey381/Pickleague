#!/usr/bin/env node
// Launch the foundation toolbox engine with Pickleague's config.  node tools/toolbox/run.mjs
// The engine lives in the shared foundation (shared/toolbox/server.mjs), same
// pattern as Doggle's tools/toolbox — this repo only holds config + launcher.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const candidates = [
  path.join(repoRoot, 'shared/toolbox/server.mjs'),
  path.join(repoRoot, 'mobile/node_modules/@stockman/rn-foundation/toolbox/server.mjs'),
];
const serverPath = candidates.find(existsSync);
if (!serverPath) { console.error('Could not find the foundation toolbox engine. Looked in:\n  ' + candidates.join('\n  ')); process.exit(1); }

const config = path.join(here, 'toolbox.config.mjs');
spawn(process.execPath, [serverPath, '--config', config, ...process.argv.slice(2)], { stdio: 'inherit' });
