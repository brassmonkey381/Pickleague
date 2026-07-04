#!/usr/bin/env node
// @stockman/rn-foundation — generic local "toolbox" GUI engine.
//
// A dependency-free localhost web GUI for running a project's local-only dev
// scripts. It is DOMAIN-AGNOSTIC: all keys/tools come from a per-project config,
// so any repo can reuse it by supplying its own config file.
//
//   node <foundation>/toolbox/server.mjs --config path/to/toolbox.config.mjs [--port 4317]
//
// The config (a .mjs `export default {…}` or a .json) provides:
//   {
//     port?: number,
//     secretsFile?: string,              // where saved keys live (default: <configDir>/toolbox.secrets.json)
//     keys: [{ name, label, hint?, aliases?: string[], match?: MatchSpec }],
//     envAliases?: { SRC_KEY: ['ALT_ENV_NAME', …] },   // copy a saved key to other env names
//     tools: [{
//       id, label, description?, cwd, cmd, baseArgs?: string[], needsInstall?: bool,
//       fields: [{ name, type:'text'|'number'|'select'|'checkbox'|'file', flag?, positional?, env?,
//                  options?, default?, placeholder?, help?, accept? }],
//       (a 'file' field uploads the chosen file; the engine writes it to a temp
//        path and passes that path as the flag/positional value.)
//     }],
//   }
// Tool `cwd` paths resolve relative to the config file's directory. Saved keys
// are injected as env vars (plus envAliases) when a tool runs.
//
// Bound to 127.0.0.1 only; no auth (single-user local tool). Keys are stored in
// plaintext locally — never commit the secrets file.

import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const argv = process.argv;
const argOf = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

const configArg = argOf('--config');
if (!configArg) { console.error('Missing --config <path to toolbox.config.mjs|.json>'); process.exit(1); }
const CONFIG_PATH = path.resolve(process.cwd(), configArg);
const CONFIG_DIR = path.dirname(CONFIG_PATH);

let config;
try {
  if (CONFIG_PATH.endsWith('.json')) config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  else config = (await import(pathToFileURL(CONFIG_PATH).href)).default;
} catch (e) {
  console.error(`Could not load config ${CONFIG_PATH}: ${e.message}`); process.exit(1);
}
const KEYS = config.keys || [];
const TOOLS = config.tools || [];
const ENV_ALIASES = config.envAliases || {};
const SECRETS_PATH = config.secretsFile
  ? path.resolve(CONFIG_DIR, config.secretsFile)
  : path.join(CONFIG_DIR, 'toolbox.secrets.json');
const PORT = Number(argOf('--port')) || Number(process.env.TOOLBOX_PORT) || Number(config.port) || 4317;
const TITLE = config.title || 'Toolbox';

async function loadSecrets() { try { return JSON.parse(await readFile(SECRETS_PATH, 'utf8')); } catch { return {}; } }
async function saveSecrets(c) { await writeFile(SECRETS_PATH, JSON.stringify(c, null, 2)); }
function send(res, code, type, body) { res.writeHead(code, { 'Content-Type': type }); res.end(body); }
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      let html = await readFile(path.join(__dirname, 'index.html'), 'utf8');
      html = html.replace('{{TITLE}}', TITLE);
      return send(res, 200, 'text/html; charset=utf-8', html);
    }
    if (req.method === 'GET' && url.pathname === '/api/meta') {
      return send(res, 200, 'application/json', JSON.stringify({ title: TITLE, keys: KEYS, tools: TOOLS }));
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, 'application/json', JSON.stringify(await loadSecrets()));
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = JSON.parse((await readBody(req)) || '{}');
      await saveSecrets({ ...(await loadSecrets()), ...body });
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      const { toolId, action, args } = JSON.parse((await readBody(req)) || '{}');
      const tool = TOOLS.find((t) => t.id === toolId);
      if (!tool) return send(res, 404, 'text/plain', 'unknown tool');
      const cwd = path.resolve(CONFIG_DIR, tool.cwd || '.');
      const cfg = await loadSecrets();
      const env = { ...process.env, ...cfg };
      for (const [src, targets] of Object.entries(ENV_ALIASES)) {
        if (cfg[src]) for (const t of targets) env[t] = cfg[src];
      }

      let cmd, list;
      const tempFiles = []; // uploaded `file` fields are written here, then passed by path
      if (action === 'install') { cmd = 'npm'; list = ['install', '--no-audit', '--no-fund']; }
      else {
        cmd = tool.cmd; list = [...(tool.baseArgs || [])];
        for (const f of tool.fields || []) {
          const v = args?.[f.name];
          if (f.type === 'file') {
            // Browser sent { __file, filename, dataBase64 }; materialize to a temp
            // file and hand the script its path (file fields never go through env).
            if (v && v.__file && v.dataBase64) {
              const safe = String(v.filename || 'upload').replace(/[^\w.\-]+/g, '_');
              const tmp = path.join(os.tmpdir(), `toolbox-${crypto.randomUUID()}-${safe}`);
              await writeFile(tmp, Buffer.from(v.dataBase64, 'base64'));
              tempFiles.push(tmp);
              if (f.positional) list.push(tmp); else list.push(f.flag, tmp);
            }
            continue;
          }
          const hasVal = v !== undefined && v !== null && String(v).trim() !== '';
          if (f.env) { if (hasVal) env[f.env] = String(v); }
          else if (f.type === 'checkbox') { if (v) list.push(f.flag); }
          else if (hasVal) { if (f.positional) list.push(String(v)); else list.push(f.flag, String(v)); }
        }
      }
      const cleanupTemps = () => { for (const f of tempFiles) unlink(f).catch(() => {}); };

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.write(`$ ${cmd} ${list.join(' ')}\n(cwd: ${cwd})\n\n`);
      // With shell:true Node joins args UNQUOTED, so a multi-word value like
      // --place "Alameda Dog Park" would split into separate argv words on
      // Windows. Quote anything with spaces/metacharacters ourselves.
      const winQuote = (a) => (/[\s"^&|<>()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
      const argv = IS_WIN ? list.map(winQuote) : list;
      const child = spawn(cmd, argv, { cwd, env, shell: IS_WIN });
      child.stdout.on('data', (d) => res.write(d));
      child.stderr.on('data', (d) => res.write(d));
      child.on('error', (e) => { res.write(`\n[spawn error: ${e.message}]\n`); res.end(); cleanupTemps(); });
      child.on('close', (code) => { res.write(`\n[exit ${code}]\n`); res.end(); cleanupTemps(); });
      req.on('close', () => { if (child.exitCode === null) child.kill(); });
      return;
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    send(res, 500, 'text/plain', String(e?.message || e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`${TITLE} running at http://localhost:${PORT}`);
  console.log(`config: ${CONFIG_PATH}`);
  console.log(`secrets: ${SECRETS_PATH}`);
});
