# @dca/scheduler

Off-chain bot that advances vault epochs. It watches `EpochKeeper`'s job list `(vault, stock)`, wakes up right after
each vault's epoch boundary (and at least every `POLL_INTERVAL_SECONDS`), and for every job the keeper reports as
due it calls `EpochKeeper.run(job, limit, "")` one transaction at a time until the vault reports the epoch complete
(large stocks span several pages). Every call is simulated first, so a job that would revert (raced by another
keeper, no route, delisted stock) is logged and skipped without spending gas.

```bash
pnpm fork                              # terminal 1: anvil + local stack; writes apps/scheduler/.env.local
pnpm scheduler                         # terminal 2: loop forever
pnpm --filter @dca/scheduler once      # single pass then exit — for cron / a systemd timer
pnpm --filter @dca/scheduler dry-run   # simulate only
```

Locally the stack includes a **test vault** with a 2-minute epoch (`TEST_EPOCH_MINUTES` on `pnpm fork`) seeded
with three plans, so you see a fill every two minutes without waiting for a daily boundary.

## Configuration

Environment variables (`.env.local` / `.env` in this directory are loaded; the process environment wins). See
[`.env.example`](.env.example) for the full list. Required: `RPC_URL`, `PRIVATE_KEY` (not needed with `--dry-run`).
`KEEPER_ADDRESS` falls back to `contracts/deployments/<chainId>.json`.

## Production

```bash
pnpm --filter @dca/scheduler build
RPC_URL=… PRIVATE_KEY=… KEEPER_ADDRESS=… node apps/scheduler/dist/index.js
```

Run it under a supervisor (systemd, Docker restart policy). Two instances are safe — the second one just sees
`EpochNotDue` in simulation and skips — but wasteful. For MEV-sensitive deployments, point `RPC_URL` at a private
transaction endpoint (see `SECURITY.md`). The bot never passes a `routeOverride`; use `contracts/script/Quote.s.sol`
+ `cast` for a manual override as documented in the root README.

## Behaviour worth knowing

- **Chain time, not wall time.** Boundaries are computed from each vault's `origin` / `epochLength` and the latest
  block's timestamp, extrapolated with the wall clock. So it keeps working when anvil's clock has been warped.
- **Idle chains.** `eth_call` (and therefore `dueJobs()`) is evaluated at the *last mined block*. On a chain that
  only mines on demand (anvil, a quiet rollup) nothing would ever look due; if a boundary has passed since the last
  block, the bot mines one with a 0-value self-transfer, then re-checks.
- **Missed epochs are skipped, never caught up** — that is the vault's rule, not the bot's. A long outage costs at
  most one epoch per stock.
- Ctrl-C finishes the transaction in flight, then exits.
