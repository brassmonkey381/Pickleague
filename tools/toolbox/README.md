# Pickleague Toolbox

A localhost GUI for Pickleague's local-only dev/sim tools. The **engine lives in the
foundation** (`shared/toolbox/`, generic + reusable — vendored from the same engine
Doggle uses); this folder only holds Pickleague's **config** (keys + tools) and a launcher.

```bash
node tools/toolbox/run.mjs
# open http://localhost:4317
```

`run.mjs` finds the engine at `shared/toolbox/server.mjs` and starts it with
`toolbox.config.mjs`.

## Tabs

- **🔑 Keys** — Supabase URL, service-role key (writes/bypasses RLS), anon key (Simulate
  Flows signs in *as* the sim users, so RLS + RPC grants are exercised for real), optional
  Google Places key. Saved to `tools/toolbox/toolbox.secrets.json` (**gitignored**),
  injected as env vars when a tool runs. **📄 Parse keys from file** fills empty fields from
  a `.env`/notes file (it picks the `service_role` vs `anon` JWT by decoding each).
- **🛠 Tools:**
  - **Seed Fake Players** — create N `sim_player_*@pickleague.test` accounts (password
    `Pickle123!`), each with a target DUPR. Simulates a match history whose outcomes follow
    the DUPR gaps so PLUPR converges organically through the real DB triggers; optional
    **calibrate** snaps global + league PLUPR exactly to target. **delete** removes all sim
    players + their matches + `[SIM]` leagues (rating effects reversed by the delete trigger).
  - **Simulate Flows** — pick N sim players and drive real flows by signing in as them:
    `league` (create + joins / invite-code redemptions) or `tournament` (create → invites+
    accepts or requests+approvals → doubles pairing → generate round 1 → play to completion),
    across format / match-type / team-creation / registration-mode. `cleanup` tears down all
    `[SIM]` leagues & tournaments.
  - **Backdate & Finish Tournaments** — existing script; backdate open tournaments, simulate
    unfinished matches, mark completed. (No dry-run — writes immediately.)

Tools with a **dry-run** field default to ON; uncheck to write (with a confirm).

## SIM data convention

Everything these tools create is namespaced so cleanup is safe (see `simulations/README.md`):
`sim_player_*` usernames, `[SIM] …` league/tournament names. Never assume the DB is empty —
the scripts key on the sim namespace, not table totals.

## Add / change a tool

Edit `toolbox.config.mjs` (the `keys` / `tools` arrays). `cwd` is relative to this folder.
See the engine's config reference: `shared/toolbox/README.md`.
