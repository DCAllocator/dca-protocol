# 04 — Hourly vault

> F-numbers (e.g. F15) refer to the verified facts ledger at the end of `tasks/00-overview.md`.

## Summary
Hourly is "just a parameter" at the PlanVault level — `epochLength` is a constructor immutable (`PlanVault.sol:78-79`)
and Daily/Weekly/Monthly are 25-line wrappers fixing the epoch, the default fee and `vaultKind()` — but it is not just a
config change: it needs a new `HourlyVault` subclass, `EpochLib.alignToHour`, a breaking `VaultDirectory.Entry`/`vaults()`
ABI change, `PlanVault[3]` → `[4]` fan-out in both deploy scripts, a fee key, `hourly` in the web vault kinds, and ~10
hardcoded "three vaults / daily, weekly or monthly" copy sites. No PlanVault logic change; no scheduler code change. The
real risks are economic and operational: 90 bps sits exactly on the inclusive cap; keeper gas per stock rises 24×; the
10 USDG per-buy minimum implies ≥ 7,200 USDG per 30 days per hourly plan; price-guard staleness plus never-caught-up epochs
silently drop off-hours buys. Nothing is deployed on 4663, so there is no migration. Covers list items: 4.

## Current state
- Cadence is a per-vault immutable, nothing else depends on it [confirmed]: constructor `PlanVault.sol:182-188`
  (`BadOrigin` unless `origin ≤ now < origin + epochLength`), `currentEpochId`/`nextEpochStart` pure `EpochLib` math
  (806-813). `DailyVault.sol:10-24` is the template; `contracts/test/mocks/TestVault.sol` is the configurable variant;
  `contracts/script/GasSim.s.sol:136-149` already instantiates a 1-hour vault.
- `EpochLib.sol:37-47` has `alignToDay`/`alignToMonday` only; deploy uses them at `Deploy.s.sol:159-164`, `DeployLocal.s.sol:308-313`.
- Fee cap inclusive 90 (`FeeMath.sol:12-19`); perk holders pay `bps/2` = 45; PlanVault is non-upgradeable → 90 is permanent for that vault.
- Deploy re-applies fees by exact JSON key (`Deploy.s.sol:166-172`, `_cfgUint` → `readUint`, no default) → a missing
  `hourlyPurchaseFeeBps` key reverts the script [hypothesis]. No script calls `setMinimums` (`PlanVault.sol:704-709`) — every vault keeps the constructor default 10 USDG.
- Three-vault fan-out: `Deploy.s.sol:187` `PlanVault[3]`, loops at 189/219/341/352/361, `_setPriceFeeds`/`_setPageCaps`
  signatures 333/359, directory Entry 229-241, ownership 250-252, JSON 413-415; `DeployLocal.s.sol:319-325`, `339-346`,
  `372-377` (already `[4]` incl. testVault — the pattern to copy). Both scripts are dirty from the FeeReceiver work.
- `VaultDirectory.sol:11-20,39-42` fixed struct + `address[3]`; web mirrors it (`useProtocol.ts:17-26,43-46`); only other
  `vaults()` consumer is `contracts/test/unit/VaultDirectory.t.sol`. Scheduler never reads the directory (F15).
- Web kinds: `config.ts:40,64,71-79`; `fmtEpochLength` (93-97) already renders "hour" but only for `kind === "test"`.
  Auto-adapting consumers: `create/page.tsx:607-608`, `plans/page.tsx:205-208`, activity, Sidebar, app page, token page,
  Live. Manual sites: `Sections.tsx:75-79` (`as const` — typecheck fails once the union widens, F27), `:85-86`, `:173-174`,
  `:44`; `Landing.tsx:266-270,252,275`; `docs/page.tsx:32,42`.
- Retry-not-skip + never-caught-up at 1 h [confirmed]: `isEpochDue` (816-819) needs only indexed plans; `_isEpochPending`
  (1011-1014) looks at the current epoch's cursor, so an abandoned old epoch never blocks prune; a page that cannot be
  bought for a whole hour = that hour is skipped for every plan on the stock (`README.md:76`).
- Price guard: `PriceGuardLib.sol:85-86` floor, `:98-107` `PriceFeedStale` when `block.timestamp - updatedAt > maxStaleness`
  (deploy default `FEED_MAX_STALENESS` 90,000 s = 25 h), sequencer check off by default. `setPriceFeed` is per (vault, stock)
  → the hourly vault can get its own staleness window. Hourly buys outside US market hours will run against a stale feed
  (inside the 25 h window, at the last close price ± 3 %) or hit `PriceFeedStale` with a tight window → page retried, hour skipped.
- **BadOrigin deploy window [confirmed constraint]**: with `alignToHour`, the HourlyVault create tx must land before the
  next top of hour or reverts `BadOrigin` (F14) — deploy it first among the vaults; broadcast duration on 4663 [hypothesis].
- Scheduler nudge (`scheduler.ts:178-185,329-343`): when no block was mined across a boundary the bot sends a 0-value
  self-transfer — up to +24 small txs/day on a chain that mines on demand; whether Robinhood Chain mines empty blocks [hypothesis].

## Related prior investigation (2026-09-23; external facts, verify before relying)
A market-hours investigation (project memory `market-hours-execution`) found that Robinhood Chain's Chainlink equity feeds
are 24/5: 86,400 s heartbeat, 0.5 % deviation, no heartbeat off-hours, a ~52 h weekend gap (~81.5 h over Labor Day) and
weekday gaps up to 18.7 h; only 35 feeds are listed for ~195 tokens, which clashes with `REQUIRE_PRICE_FEED=true`. It
proposed hourly as **market-hours-only** (~6 buys per trading day, ≈ 125 per 30 days), executed by a scheduler calendar
module; decision pending. Consequences for this spec:
- 24/7 hourly with the 25 h default staleness buys nights at the last close price inside the 3 % band, and every weekend
  hour past 25 h staleness reverts `PriceFeedStale` and is skipped; a tight hourly window skips all off-hours.
- Market-hours-only changes `VAULT_META.hourly.buysPerMonth` (720 → ≈ 125) and the cadence copy, and cuts keeper cost to
  roughly a quarter of the table below. An off-chain calendar is ignored by `EpochKeeper.runDue` callers and Chainlink
  Automation unless also gated on-chain, and the vault has no bytes for an on-chain gate.
- A separate per-plan study (memory `per-plan-contracts-study`) recommended keeping the pooled vault, which supports the
  subclass design here over `PlanAccount.sol`.

## Keeper / automation support
Yes, without code changes [confirmed]: the scheduler is cadence-generic (F15); `TX_TIMEOUT_SECONDS=120` and
`MAX_PAGES_PER_JOB=20` are fine for a 3,600 s epoch; `EpochKeeper.dueJobs()`/`runDue()` loop every job (+16 jobs per
hourly stock); `maxJobsPerUpkeep` bounds Chainlink Automation batches. Reverting pages are re-simulated every tick at no gas.

## Gas and cost
Measured (F17): 1-plan page 246,617 gas (+ ~23k tx base ≈ 270k), 10 plans 335k, 50 plans 730k, 150 plans 1.72M; first
epoch of a stock 544k; empty page 49k (only when plans are indexed but all paused/drained). Formula per day per stock:
`24 × (page gas × gas price × ETH price + L1 data cost)`. With 16 stocks and one page each = 384 tx/day:

| Gas price input | Per page | Per day (16 stocks) | Daily vault for comparison |
|-----------------|----------|---------------------|----------------------------|
| repo default `GasSim.s.sol:49-51` (0.01 gwei, $3,000 ETH, 2 ¢ L1) | ≈ $0.028 | ≈ $10.8 | ≈ $0.45 |
| memory note 2026-09-23 (0.14 gwei, $2,752 ETH) [hypothesis, not repo data] | ≈ $0.124 | ≈ $48 | ≈ $2 |

If hourly is market-hours-only, pages drop to ~6–7 per stock per trading day and none on weekends: roughly a quarter of these figures.

The gas price is an explicit input the repo cannot verify (`addresses.rh.json` RPC is TODO); run `contracts/script/gas-sim.sh`
with `RH_RPC` set (and `SIM_BOOSTED=true`) before the fee/minimum decision (Q13). Keeper tips are off (`fees.json:14`),
capped at 10 % (`VaultAdminLib.sol:50`), and even at cap yield ~0.9 ¢ per 10 USDG fill — they cannot make hourly pages
self-funding at small notional. Real V3 swap gas replaces the mock's swap leg rather than adding to it [hypothesis].

## Proposed approach
Option A (extend the fixed `Entry` with `hourly`, `vaults()` → `address[4]`) — picked: nothing is deployed on 4663,
`vaults()` has one test consumer, the web `VaultMap` is kind-keyed and typecheck catches every consumer. Options B (dynamic
`vaultsByKind()` beside the struct) / C (`(kind, addr)[]` list) only pay off if more frequencies are planned (C forces a
`VaultKind` literal-type refactor across ~15 web files). One branch, after the FeeReceiver deploy-script edits are committed.
1. `contracts/src/vault/HourlyVault.sol` copied from `DailyVault.sol` with `1 hours` / `90` / `"hourly"`.
2. `EpochLib`: `HOUR = 1 hours`, `alignToHour(ts) = toUint64(ts - ts % HOUR)`; policy doc line at 8-12.
3. `VaultDirectory`: `Entry.hourly` (position per Q9; default first), `vaults()` → `address[4]`; regenerate `apps/web/src/abi/VaultDirectory.ts` in the same commit.
4. `config/fees.json` `hourlyPurchaseFeeBps: 90`; `Deploy.s.sol`: deploy hourly FIRST with `alignToHour`, `setFees`/`setMaxPlansPerTx`/`setThresholds`, `PlanVault[4]` everywhere listed above, Entry, ownership, `j.serialize("hourly", …)`, comments; optional `HOURLY_FEED_MAX_STALENESS` env applied only to the hourly vault; optional `setMinimums` step (Q10).
5. `DeployLocal.s.sol`: same; `guarded`/`boostVaults` `[4]` → `[5]`.
6. `contracts/test/BaseTest.sol`: hourly fixture in all four blocks (96-101, 103-112, 142-149, 156-163).
7. Web: `config.ts:40` add `"hourly"`; `VAULT_META.hourly = { label: "Hourly", per: "hour", cadence: "Every hour, on the hour (UTC)", blurb: <owner>, buysPerMonth: 720 /* ≈ 125 if market-hours-only, Q11 */, defaultFeeBps: 90 }`; `useProtocol.ts:17-26,44` add `hourly`.
8. Copy: `Sections.tsx:75-79,85-86,173-174,44`; `Landing.tsx:266-270,252,275` (grid classes for four cards); `docs/page.tsx:32,42`; check `Live.tsx` fee table at phone width; check "Every hour" wording in the create widget.
9. Docs: `README.md` vault/fee/cron sections, `EpochKeeper.sol:17-19` cron comment, `scripts/fork.sh:12`, `contracts/.env.example`.
10. Local redeploy on a private port; `forge build --sizes`; `forge test`; web typecheck; scheduler dry-run.
11. Cost model run (`gas-sim.sh` with `RH_RPC`) attached to the PR before the fee decision is final.

## Files likely to change
`contracts/src/vault/HourlyVault.sol` (new); `contracts/src/libraries/EpochLib.sol`; `contracts/src/vault/VaultDirectory.sol`;
`contracts/config/fees.json`; `contracts/script/Deploy.s.sol`, `DeployLocal.s.sol`; `contracts/.env.example`;
`contracts/test/BaseTest.sol`; `contracts/test/unit/HourlyVault.t.sol` (new), `EpochLib.t.sol`, `VaultDirectory.t.sol`,
`PlanVault.Admin.t.sol`, `PlanVault.Epoch.t.sol`, `Keeper.t.sol`, `PlanVault.PriceGuard.t.sol`, `ContractSizes.t.sol` (from 01);
`contracts/src/keeper/EpochKeeper.sol:17-19` (comment); `apps/web/src/abi/VaultDirectory.ts` (+ side-effect regen of
`PlanVault.ts`); `apps/web/src/lib/config.ts`; `apps/web/src/hooks/useProtocol.ts`; `apps/web/src/components/site/Sections.tsx`,
`Landing.tsx`; `apps/web/src/app/app/docs/page.tsx`; `README.md`, `scripts/fork.sh`; `contracts/deployments/31337.json`
(regenerated in the worktree).

## Acceptance criteria
- AC1 `forge test` passes; `HourlyVault.epochLength() == 3600`, `vaultKind() == "hourly"`, `fees().purchaseFeeBps == 90`, perk-holder effective fee 45.
- AC2 `alignToHour(t)`: `r % 3600 == 0`, `r ≤ t`, `t − r < 3600` for 0/3599/3600/1_800_000_000 + fuzz; a vault built with it does not revert `BadOrigin`.
- AC3 one funded hourly plan: `isEpochDue` false at boundary−1, true at each of 24 consecutive boundaries, false after `EpochKeeper.run`; after a 10-epoch warp the plan is charged exactly once.
- AC4 `VaultDirectory.get()` returns `hourly`; `vaults()` returns 4 addresses in the documented order; ABI regenerated; web typecheck passes.
- AC5 `pnpm fork` (private port) deploys 5 vaults, writes `hourly` to `31337.json`, `keeper.jobCount()` == 80; the hourly vault has the same feeds, page cap and boost strategy as daily.
- AC6 `forge build --sizes`: `HourlyVault` ≤ 24,576 B (expected ≈ 24,49x); `ContractSizes.t.sol` covers it.
- AC7 `fees.json` has `hourlyPurchaseFeeBps: 90`; `forge script script/Deploy.s.sol` dry run does not revert on the config read.
- AC8 scheduler dry-run logs a `vault hourly` line with epoch 1h and next boundary ≤ 1h, with zero changes under `apps/scheduler/src/` (excluding regenerated ABIs).
- AC9 browser (client-side nav, MetaMask with test1 imported, RPC → :8545 or the proxy): "Every" menu lists hour/day/week/month(/test); an hourly NVDA plan shows "per hour" on /app/plans and an "Hourly" filter on plans and activity.
- AC10 `grep -rn "daily, weekly or monthly\|Three vaults\|three vaults\|three frequency" apps/web/src contracts README.md scripts` has no hit that omits hourly.
- AC11 hourly test: a page reverting `PriceFeedStale` leaves `nextPlanIndex(stock, id) == 0` and `isEpochDue == true`; after the boundary `nextPlanIndex(stock, id+1) == 0` and `isEpochPending == false`.
- AC12 the PR carries the cost table with the `gas-sim.sh` run (or an explicit note that `RH_RPC` was unavailable).

## Tests to add
Contract: `HourlyVault.t.sol` (mirror `TestVault.t.sol:47-89`: params; 24 boundaries in a day through `EpochKeeper.run`;
missed epochs skipped; `setFees(90)` ok / `setFees(91)` reverts `FeeTooHigh(91, 90)`; perk fee 45); `EpochLib.t.sol`
`alignToHour` cases + fuzz; `VaultDirectory.t.sol` 4-field round-trip, order, `DirectorySet`; `BaseTest` + Admin/Epoch
replays on the hourly instance warping by `1 hours` (incl. `test_pagination_abandonedPageRestartsNextEpoch` pattern);
`Keeper.t.sol` hourly + daily jobs on one stock: warp +1 h → only hourly due; `maxJobsPerUpkeep = 5` with 16 hourly jobs →
4 `performUpkeep` calls drain; `PriceGuard.t.sol` hourly vault with `maxStaleness = 2 hours`: T+1h fills, T+3h reverts
`PriceFeedStale` (cursor 0, still due), refreshed feed fills; sequencer grace semantics. Optional GasBench `EPOCH = 1 hours` variant.
Unit (web): typecheck is the gate; the two `as const` copy maps must fail until `hourly` is added.
E2E-manual: checklist row E11 (fork on own port → typecheck → scheduler dry-run shows hourly; create hourly plan; marketing
shows four cards at 375 px; run across an hour boundary with the scheduler — hourly job executes, daily does not).

## Dependencies and conflicts
- Requires the FeeReceiver `Deploy*.s.sol` hunks committed (adjacent lines). Contracts worktree shared with 03-P2 (order
  03-P2 → 04 if GO; else start right after the ABI-sync commit). HourlyVault consumes no PlanVault headroom (separate
  artifact of the same bytecode) — "freed headroom" is NOT a dependency.
- ABI regeneration in this PR; frontend branches rebase at merge. Web edits to `config.ts`/`useProtocol.ts` are disjoint from 05/06 (trivial rebase).
- `PlanAccount.sol` research (Q3) competes with the subclass design — resolve before starting.
- Product decisions (Q8–Q13) gate copy, `fees.json`, deploy env and `setMinimums` — not the contract skeleton, which can start immediately.

## Risk
**Medium. Touches smart contracts: yes.** Intrinsic code risk is low (25-line subclass, 3-line helper, struct field); what
makes it medium: deploy scripts fan out across ~15 sites and are dirty; breaking directory ABI must regenerate in lock-step
with the web; economics are irreversible per vault (90 bps cap in non-upgradeable bytecode; 24× keeper gas); hourly epochs
are never caught up, so any > 1 h feed/route condition silently drops that hour; the BadOrigin window makes a production
deploy timing-sensitive.

## Open questions
Overview Q3, Q8–Q13; plus: directory shape (A vs dynamic list); keeper economics (enable tips, Chainlink Automation beside
the scheduler, raise `maxJobsPerUpkeep`); sequencer grace on hourly; tangential doc fixes (`SECURITY.md:72-74` still says
pages are "skipped, never reverted"; keeper-tip cap 50 % vs 10 % at `VaultTypes.sol:59`/`README.md:105`) — here or separately?
