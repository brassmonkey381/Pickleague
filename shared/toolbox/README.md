# @stockman/rn-foundation — Toolbox

A reusable, **domain-agnostic** localhost web GUI for running a project's local-only
dev scripts. No framework, no build step, no runtime dependencies — just Node.

The engine (`server.mjs` + `index.html`) knows nothing about any specific project.
Each repo supplies a **config** describing its keys + tools, and the engine renders
a Keys tab (with "Parse keys from file") and a tab per tool (input fields, Install
deps / Run / Stop, live-streaming console).

## Use it in a repo

1. Create a config (e.g. `tools/toolbox/toolbox.config.mjs`):

```js
export default {
  title: 'My App Toolbox',
  // secretsFile: 'toolbox.secrets.json',   // default: alongside this config (gitignore it!)
  keys: [
    { name: 'SUPABASE_URL', label: 'Supabase URL', hint: 'https://…',
      aliases: ['supabaseurl', 'supaurl'], match: { regex: '^https?://[a-z0-9-]+\\.supabase\\.(co|in)' } },
    { name: 'SUPABASE_SERVICE_ROLE_KEY', label: 'Service-role key',
      aliases: ['servicerole'], match: { jwtRole: 'service_role' } },
  ],
  envAliases: { SUPABASE_URL: ['EXPO_PUBLIC_SUPABASE_URL', 'SUPA_URL'] },
  tools: [
    { id: 'migrate', label: 'Migrations', description: '…', cwd: '../..', cmd: 'node',
      baseArgs: ['scripts/migrate.mjs'],
      fields: [{ name: 'mode', flag: '--mode', type: 'select', options: ['check','run'], default: 'check' }] },
  ],
};
```

2. Launch it, pointing at your config:

```bash
node node_modules/@stockman/rn-foundation/toolbox/server.mjs --config tools/toolbox/toolbox.config.mjs
# (or, with a sibling foundation checkout) node ../foundation/toolbox/server.mjs --config tools/toolbox/toolbox.config.mjs
# open http://localhost:4317
```

A 3-line `run.mjs` launcher in your repo makes this `node tools/toolbox/run.mjs`.

## Config reference

- **keys**: `{ name, label, hint?, aliases?: string[], match?: MatchSpec }`
  - `aliases` — extra names the file parser matches (normalized, case/underscore-insensitive).
  - `match` — declarative value-shape for "Parse keys from file":
    `{ prefix?, regex?, flags?, jwtRole?, pathEndsWith? }` (all present conditions must pass).
- **envAliases**: `{ SRC_KEY: ['ALT_ENV', …] }` — a saved key is also exported under these names.
- **tools**: `{ id, label, description?, cwd, cmd, baseArgs?, needsInstall?, fields[] }`
  - `cwd` resolves **relative to the config file's directory**.
  - **fields**: `{ name, type:'text'|'number'|'select'|'checkbox', flag?, positional?, env?, options?, default?, placeholder?, help? }`
    - non-checkbox + value → `--flag value` (or a bare value if `positional`); checkbox → `--flag` when checked; `env:'VAR'` injects the value into the child env instead of argv.
  - A field named `dry-run` triggers a write-confirm when unchecked.

## Notes
- Binds to **127.0.0.1**, no auth — single-user local tool. Secrets are plaintext in the secrets file; **gitignore it**.
- Port: `--port`, or `TOOLBOX_PORT`, or `config.port` (default 4317).
- `.sh` tools spawn via the shell; on Windows run from an environment with Git Bash on PATH.
