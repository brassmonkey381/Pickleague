# Pickleague simulations

A growing collection of scripts that exercise app behavior end-to-end and assert
on the results. Each script is a runnable Node program; failures exit with code 1.

## Setup

```
cd simulations
npm install
```

## Running

```
npm run brackets        # exercise all bracket generators across player counts
```

## What's here

| Script    | What it covers | Touches Supabase? |
|-----------|----------------|-------------------|
| brackets  | round-robin, single-elim, pool play, rotating partners, MLP, seeding, pool snake-draft | No — pure functions from `mobile/src/lib/tournament.ts` |

## Planned

| Slice | Approach | Status |
|-------|----------|--------|
| Invites & notifications (MLP, tournament, gifts) | SIM-prefixed users + RPC scripts against prod | TODO |
| Match simulation + PLUPR + bracket advancement | SIM users in a SIM tournament; enter matches; assert PLUPR & R2 fills | TODO |
| Payouts (pickles, season bonuses) | SIM season; simulate to period end; call distribute; assert ledger | TODO |

## Conventions for the upcoming SIM-against-prod slices

- Every test user has email `sim_<scenario>_<n>@pickleague.test` and username `sim_*`.
- Every league name starts with `[SIM]`.
- Every tournament name starts with `[SIM]`.
- Every script must run a `cleanup()` step at the start AND end that deletes
  every row matching the SIM pattern in the right FK order. Cleanup must be
  idempotent — runnable when there's nothing to clean.
- Never assume the DB is empty; assertions key on counts of newly created rows,
  not totals.
