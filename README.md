# DCA — Buy stocks on a clock

Scheduled, on-chain purchases of **Robinhood Stock Tokens** on **Robinhood Chain** (chain id 4663, Arbitrum Orbit).

A user opens a **plan** inside a frequency **vault** (Daily / Weekly / Monthly): one Stock Token, a USDG amount per epoch, funded with USDG and/or ETH/WETH. Every epoch the vault takes the purchase fee, pools everyone's notional, routes one swap USDG → stock through the best of Uniswap V3 / Uniswap V4 / Ramses V3, and credits each plan pro-rata. Holders of ≥ 10,000 `$DCA` get stock sent straight to their wallet (0 claim fee); everyone else accrues on-vault and `claim`s (0.25%). ≥ 50,000 `$DCA` halves the purchase fee.

> Stock Tokens are **economic exposure, not shareholder rights**. Not offered to US persons. The contracts are permissionless; the UI is geo-blocked (US / UK / CA / AU / sanctioned). Unaudited software.

---

## Contents

- [Architecture](#architecture)
- [Fees](#fees)
- [Epochs and scheduling](#epochs-and-scheduling)
- [Routing](#routing)
- [Running a keeper](#running-a-keeper)
- [Adding a stock](#adding-a-stock)
- [Repo layout](#repo-layout)
- [Build, test, deploy](#build-test-deploy)
- [Frontend](#frontend)
- [Risks](#risks)
- [Geo / legal](#geo--legal)

---

## Architecture

```
                 ┌──────────────┐   list/approve   ┌───────────────┐
   owner ───────►│ StockRegistry│◄─────────────────│  VaultDirectory│◄── frontend bootstrap
                 └──────┬───────┘                  └───────────────┘
                        │ isPurchasable(stock)
      ┌─────────────────┼─────────────────┐
      ▼                 ▼                 ▼
┌──────────┐      ┌──────────┐      ┌──────────┐      plans, deposits, claims
│DailyVault│      │WeeklyVlt │      │MonthlyVlt│◄──── users
│ 1d, 75bp │      │ 7d, 50bp │      │30d, 25bp │
└────┬─────┘      └────┬─────┘      └────┬─────┘
     │  advanceEpoch(stock, limit, routeOverride)      ┌─────────────┐
     └───────────────┬─────────────────┘◄──────────────│ EpochKeeper │◄── bot / Chainlink / Gelato
                     │ quote / swapWithRoute            └─────────────┘
                     ▼
            ┌──────────────────┐
            │ AggregatorRouter │  best-of-N, direct or via WETH, impact cap 150 bps
            └───┬─────┬─────┬──┘
                ▼     ▼     ▼
           UniV3   UniV4   RamsesV3   (adapters; disabled when factory / PoolManager = 0)
```

**Vaults** (`src/vault/`) — one `PlanVault` implementation; `DailyVault` / `WeeklyVault` / `MonthlyVault` are thin subclasses fixing `epochLength` and the default purchase fee. Immutable, non-upgradeable, `Ownable2Step` + `Pausable` + `ReentrancyGuard`. All user balances live on `Plan` structs (`usdgIdle`, `wethIdle`, `stockAccrued`). Fees leave the vault the moment they are taken; the vault never holds protocol funds.

**Registry** (`src/registries/StockRegistry.sol`) — owner-curated whitelist. Tokens are never forgotten (`known` stays true) so `rescueERC20` can never touch user accounting. Fee-on-transfer tokens are refused.

**Router** (`src/router/`) — the only swap entry the vaults call. Vaults approve **only** the router; adapters pay pools from their transient balance (V3 callback / V4 settle), so no approvals to third-party routers exist anywhere.

**Keeper** (`src/keeper/EpochKeeper.sol`) — job list `(vault, stock)`, permissionless `runDue()`, Chainlink/Gelato-compatible `checkUpkeep` / `performUpkeep`. One failing job never blocks the others.

**Periphery** — `Zap` (ETH/WETH ⇄ USDG, deposit ETH as USDG into a plan), `ClaimHelper` (read-only aggregation: positions, claimables, fee previews), `TwapOracle` (mean-tick helper for keepers).

**`$DCA`** — read as a **spot balance at execution / claim time** (never at plan creation). `dca == address(0)` disables perks. `MockDCA` exists for tests and local stacks only; the production script refuses to deploy it.

### Design decisions worth knowing

| Decision | Why |
|---|---|
| **Per-page swaps.** `advanceEpoch(stock, limit)` processes ≤ `maxPlansPerTx` (150) plans per call with at most two swaps (aggregate WETH→USDG zap, aggregate USDG→stock buy). | Bounded gas with no two-pass cursor; a 10k-plan stock is simply several txs. |
| **Only the current epoch executes.** Missed epochs are skipped, never caught up. | Users are charged at most one spend per epoch; a keeper outage never triple-buys. |
| **Rounding dust → next-epoch pot** (`dustPot[stock]`). | User-favourable; tested. Never sent to the treasury. |
| **Auto-distribute uses a non-reverting transfer.** If a Stock Token blocks the recipient, the share accrues instead. | A permissioned token can't brick an epoch page for 149 other users. |
| **Aligned origins.** Daily = 00:00 UTC, Weekly = Monday 00:00 UTC, Monthly = 30-day epochs from 00:00 UTC of deploy day. Epoch 0 is never executed. | Predictable cron; first fire is the next boundary. |
| **USDG decimals detected at deploy** (`usdgDecimals`). `amountPerEpoch` is in USDG units. | Works with 6- or 18-decimal USDG. |
| **No on-chain factory.** `VaultDirectory` records addresses; `contracts/script/Deploy.s.sol` deploys. | Three ~23 KB vault initcodes can't fit under EIP-170 inside a factory. |
| **Deposits are open** (anyone may fund any plan). | Enables `Zap.depositEthAsUsdg`; it can only add value. |

---

## Fees

All fees are in **bps** (`uint16`), hard-capped at **90 bps** in `FeeMath.MAX_FEE_BPS`. Owner or `feeManager` sets them via `setFees(FeeConfig)`.

| Fee | Default | Range | When |
|---|---|---|---|
| Purchase — Daily | 75 bps | 0–90 | on spend, at epoch, before the swap |
| Purchase — Weekly | 50 bps | 0–90 | " |
| Purchase — Monthly | 25 bps | 0–90 | " |
| Deposit | **0** | 0–90 | on deposit (hook exists, off) |
| Withdraw idle | 25 bps | 0–90 | on `withdrawIdle` notional (USDG and WETH) |
| Claim | 25 bps | 0–90 | on `claim` path only; **0** when auto-distribute tier |

`$DCA` tiers (thresholds owner-settable, in raw token units; deploy = `10_000 * 10**dec`, `50_000 * 10**dec`):

- `balance ≥ autoDistributeThreshold` → stock sent to `plan.recipient` at epoch, no claim fee (also 0 fee on `claim` for older accruals).
- `balance ≥ feeHalveThreshold` → `purchaseFeeBps / 2`, **floored** (75 → 37, 25 → 12).

Other tolerances (not fees): `swapSlippageBps` (minOut = quote × (1 − 0.50%)), `maxWethSlippageBps` (100 bps default cap on zap-at-epoch impact, per-plan override), `keeperTipBps` (share of purchase fees paid to whoever calls `advanceEpoch`, default 0, max 50%).

Fee math is exact integer arithmetic, rounds down in the user's favour, and is fuzzed (`test/unit/FeeMath.t.sol`).

---

## Epochs and scheduling

`epochId = (block.timestamp − origin) / epochLength`. `advanceEpoch` is allowed once `currentEpochId > lastExecutedEpoch[stock]`.

Per page of plans:

1. **Collect** eligible plans (unpaused, has idle, not yet filled this epoch).
2. **Zap** — for zap-at-epoch plans whose `usdgIdle < amountPerEpoch`: size just enough WETH (conservative rate from a sizing quote), quote the aggregate, **skip** any plan whose cap is below the quoted impact (`PlanSkippedSlippage`) or if there is no WETH route (`PlanSkippedNoRoute`), then one aggregate WETH→USDG swap credited pro-rata.
3. **Spend** — `spend = min(amountPerEpoch, usdgIdle)`; snapshot `$DCA` balance; `fee = spend × effBps / 10_000`; debit.
4. **Fees out** — keeper tip to `msg.sender`, remainder to `feeRecipient`.
5. **Buy** — one swap `totalNet` USDG → stock via `router.quote` + `swapWithRoute` (or the keeper's `routeOverride`). Reverts on zero output. Unspent USDG (partial fill) is returned pro-rata.
6. **Distribute** — `share = mulDiv(bought + dustPot, net, totalNet)` (floor); auto-distribute or accrue; remainder → `dustPot`.
7. **Cursor** — `nextPlanIndex[stock][epochId] = end`; when `end == stockPlanCount`, `lastExecutedEpoch[stock] = epochId`.

Events: `PlanFilled`, `EpochPageExecuted`, `EpochExecuted`, `WethZapped`, `PlanSkipped*`. Counters: `totalNotionalUsdg`, `epochsCompleted`.

While an epoch is pending (cursor started, not finished) `prunePlan` reverts (`EpochInProgress`) so the index cannot be reordered under the keeper. Deposits, withdrawals and claims are never blocked by a pending epoch.

**Pause** stops `createPlan`, deposits and `advanceEpoch`. `claim` and `withdrawIdle` always work. Delisting a stock in the registry stops new plans, deposits and epochs for it; users can still withdraw and claim.

---

## Routing

`AggregatorRouter.quoteWithImpact(tokenIn, tokenOut, amountIn)` probes each enabled adapter for the best direct pool and for a one-hop path via WETH, computes price impact against the pool mid-price (`slot0.sqrtPriceX96`), and returns the highest-output path with `impact ≤ maxPriceImpactBps` (150). `swapWithRoute` executes a path from `quote` or a trusted override.

- **UniV3Adapter / RamsesV3Adapter** — factory discovery over fee tiers `100 / 500 / 3000 / 10000` plus explicitly registered pools. Quotes by simulating the swap and reverting inside `uniswapV3SwapCallback` with a sentinel (no QuoterV2 dependency). Callback is authenticated against `verifiedPool`.
- **UniV4Adapter** — talks to the `PoolManager` directly (`unlock` → `swap` → `sync/settle/take`). Pools are registered by `PoolKey` (`addPool`). ERC-20/ERC-20 pools only. Mid-price via `extsload` at the v4-core `POOLS_SLOT` (owner-overridable).
- An adapter with `factory == 0` / `poolManager == 0` (or no pools) reports `enabled() == false` and is skipped.

Split routes are out of scope for V1 (single pool per hop).

---

## Running a keeper

Cron (UTC): Daily fires at **00:00**, Weekly at **Monday 00:00**, Monthly every **30 days** from its origin. Poll a few minutes after each boundary and keep going until nothing is due (a large stock spans several pages).

**The scheduler bot — `apps/scheduler`:**

```bash
pnpm scheduler                              # loop: wakes right after each vault boundary, at least every 30s
pnpm --filter @dca/scheduler once           # one pass then exit (cron / systemd timer)
pnpm --filter @dca/scheduler dry-run        # simulate only
```

It reads `EpochKeeper.jobs()` / `dueJobs()`, and for each due job calls `EpochKeeper.run(job, 0, "")` one transaction at a time until the vault emits `EpochExecuted` (pagination). Every call is simulated first, so a job that would revert is logged with its decoded reason and skipped without gas. Config is env (`RPC_URL`, `PRIVATE_KEY`, `KEEPER_ADDRESS`; the last one falls back to `contracts/deployments/<chainId>.json`) — see [`apps/scheduler/README.md`](apps/scheduler/README.md). `pnpm fork` writes `apps/scheduler/.env.local` with the local `bot` wallet, and the local stack includes a **2-minute test vault** so you can watch it fill (below).

**Even simpler — `cast` on a cron:**

```bash
# every 5 minutes
cast send $KEEPER "runDue()" --rpc-url $RH_RPC --private-key $BOT_KEY
```

`runDue()` runs one page for every due job in a single transaction and forwards any USDG keeper tips to the caller. It is permissionless (unless a vault has `keeperOnly` on — then the `EpochKeeper` contract itself is whitelisted, so calling through it still works).

**Chainlink Automation / Gelato:** register `EpochKeeper` as an upkeep. `checkUpkeep("")` returns `(true, abi.encode(uint256[] jobIndices))` for up to `maxJobsPerUpkeep` due jobs; `performUpkeep(performData)` re-checks due-ness on chain.

**Trusted route override** (owner / vault keeper / keeper operator only) — for a broken auto-router or a tighter `minOut`:

```bash
# 1. Quote (simulation, no --broadcast). Prints the best path and a ready routeOverride blob.
cd contracts && forge script script/Quote.s.sol --rpc-url $RH_RPC \
  --sig "run(address,address,address,uint256,uint16)" $ROUTER $USDG $NVDA 1000000000 50

# 2. Submit with the override (the blob is abi.encode(Route[] path, uint256 minOut))
cast send $KEEPER "run(uint256,uint256,bytes)" $JOB_INDEX 0 $ROUTE_OVERRIDE --rpc-url $RH_RPC --private-key $OPERATOR_KEY
```

`minOut` must be > 0. WETH zaps always auto-route. Use a private mempool for keeper txs (see SECURITY.md).

Useful views: `vault.isEpochDue(stock)`, `vault.isEpochPending(stock)`, `vault.nextPlanIndex(stock, epochId)`, `vault.stockPlanCount(stock)`, `keeper.dueJobs()`.

---

## Adding a stock

1. Confirm the token is a standard ERC-20 (no fee-on-transfer, no hooks) and that a USDG (or WETH) pool with real depth exists on one of the supported DEXes.
2. List it (owner):
   ```bash
   cast send $REGISTRY "listStock(address,string,bool,bool)" $TOKEN "NVDA" false true --rpc-url $RH_RPC --private-key $OWNER_KEY
   ```
3. Add keeper jobs for each vault:
   ```bash
   cast send $KEEPER "addJob(address,address)" $DAILY $TOKEN ...
   cast send $KEEPER "addJob(address,address)" $WEEKLY $TOKEN ...
   cast send $KEEPER "addJob(address,address)" $MONTHLY $TOKEN ...
   ```
4. If the pool lives on V4, register its key: `UniV4Adapter.addPool(PoolKey)`. If a V3-fork factory has a non-standard ABI, `UniV3Adapter.registerPool(pool)`.
5. Sanity-check a quote with `contracts/script/Quote.s.sol`.

The frontend picks the stock up automatically from `registry.approvedStocks()`. Delist with `setApproved(token, false)`.

---

## Repo layout

```
contracts/                Foundry project (Forge / Anvil)
  config/                  addresses.rh.json (TODOs for every external address), fees.json
  src/
    interfaces/            IPlanVault, IStockRegistry, IWETH, IEpochAdvanceable (V2 hook), IUniswapV3, IUniswapV4
    libraries/             FeeMath, EpochLib
    oracles/               TwapOracle
    router/                IAggregatorRouter, AggregatorRouter, adapters/{ISwapAdapter,UniV3,UniV4,RamsesV3}
    registries/            StockRegistry
    token/                 IDCA, MockDCA (tests/local only)
    vault/                 VaultTypes, PlanVault, DailyVault, WeeklyVault, MonthlyVault, VaultDirectory
    periphery/             Zap, ClaimHelper
    keeper/                EpochKeeper
  test/
    unit/ fuzz/ invariant/ fork/ mocks/   (mocks/TestVault.sol = short-epoch vault for local stacks only)
  script/                  Deploy.s.sol (prod), DeployLocal.s.sol (anvil stack), Quote.s.sol (keeper helper)
apps/web/                 Next.js app (/ marketing, /app dashboard)
apps/scheduler/           epoch scheduler bot (viem): pnpm scheduler
scripts/                   fork.sh (pnpm fork), deploy.sh (pnpm protocol:deploy)
```

pnpm workspace: `apps/*` are the workspace packages; `contracts/` is a plain Foundry project driven by the root scripts below and `cd contracts && forge …` directly.

---

## Build, test, deploy

Requires Foundry (nightly ≥ 1.6 used here; `via_ir = true`, solc 0.8.28) and Node 22 / pnpm.

```bash
cd contracts
forge build --sizes            # vaults ~22.3 KB runtime (EIP-170 margin ~2.3 KB)
forge test                     # 201 tests: unit, fuzz, invariant (fork suite self-skips without RH_RPC)
forge coverage --ir-minimum --no-match-coverage "(script|test)/"   # src/: 97% lines; vault 98.9%, router 91–98%
```

**Local stack (anvil + mocks + real router/vaults/keeper):**

```bash
pnpm fork                        # terminal 1
# → contracts/deployments/31337.json ; six wallets, printed to the console (address + private key)
# → apps/web/.env.local and apps/scheduler/.env.local are written automatically
pnpm scheduler                   # terminal 2: advances epochs — the test vault fills every 2 minutes
pnpm dev:test-vault              # terminal 3: http://localhost:3000, with the test vault shown in the app
                                 #   (pnpm dev = the three production frequencies only)
```

`pnpm fork` wraps `anvil` + `forge script script/DeployLocal.s.sol --broadcast` + wiring both `.env.local` files (see `scripts/fork.sh`). It pulls six wallets straight from anvil's own deterministic accounts (0-5) and prints their addresses, ETH/USDG balances and private keys once the fork is up:

| Role | Anvil account | Gets |
|---|---|---|
| `deployer` | 0 | deploys + owns/admins every contract; USDG |
| `treasury` | 1 | `feeRecipient` — where protocol fees accrue; USDG |
| `test1` / `test2` / `test3` | 2 / 3 / 4 | funded wallets for interacting with the protocol; USDG, WETH, 60k mDCA |
| `bot` | 5 | the scheduler's wallet — only pays gas for `EpochKeeper.run` |

All six already hold 10,000 ETH from anvil's genesis.

**Test vault.** Besides Daily / Weekly / Monthly, the local stack deploys a `TestVault` (`contracts/test/mocks/TestVault.sol` — same `PlanVault` code, `epochLength` = `TEST_EPOCH_MINUTES` minutes, default 2, origin aligned to a multiple of that length) with keeper jobs for every liquid stock and three deployer-owned plans (NVDA 100 / AAPL 50 / TSLA 25 USDG per epoch, 500k USDG each), so `pnpm scheduler` has an epoch to advance every couple of minutes. `TEST_EPOCH_MINUTES=5 pnpm fork` changes the cadence. Its address is `testVault` in `contracts/deployments/31337.json` (and `NEXT_PUBLIC_TEST_VAULT` in `apps/web/.env.local`); it is not in `VaultDirectory`. The web app shows it as a fourth **Test** frequency (tagged `dev`) in the frequency picker, My plans, Activity, the vaults table and the sidebar countdown only when the dev server is started with the flag — `pnpm dev:test-vault`, or `NEXT_PUBLIC_SHOW_TEST_VAULT=1` / `SHOW_TEST_VAULT=1 pnpm dev` — and only on chain 31337; the marketing site always shows the three production vaults. Plans can also be added with `cast`:

```bash
cast send $USDG "approve(address,uint256)" $TEST_VAULT 1000000000 --rpc-url http://127.0.0.1:8545 --unlocked --from $TEST1
cast send $TEST_VAULT "createPlan(address,uint96,bool,address,uint256,uint256,uint256)" $NVDA 10000000 false 0x0000000000000000000000000000000000000000 1000000000 0 0 --rpc-url http://127.0.0.1:8545 --unlocked --from $TEST1
```

Note that anvil evaluates `eth_call` at the **last mined block's** timestamp, so on an idle chain nothing ever looks due; the scheduler handles this by mining a block (0-value self-transfer) when a boundary has passed since the last block.

**Robinhood Chain:**

```bash
cp contracts/.env.example contracts/.env   # fill USDG, WETH, DCA, DEX factories, OWNER, FEE_RECIPIENT, STOCKS
pnpm protocol:deploy
# → contracts/deployments/4663.json
# then, from the OWNER multisig: acceptOwnership() on registry, router, adapters, vaults, keeper, directory
```

`pnpm protocol:deploy` (`scripts/deploy.sh`) sources `contracts/.env`, confirms before broadcasting, then runs `forge script script/Deploy.s.sol --broadcast --verify`. The production script applies `contracts/config/fees.json`, wires the keeper to every vault, creates a job per approved stock, and never deploys a mock `$DCA` (`DCA` empty ⇒ perks disabled; on 4663 you must set `ALLOW_NO_DCA=true` to confirm that).

**Fork test** (needs `contracts/config/addresses.rh.json` filled): `cd contracts && RH_RPC=… forge test --match-path test/fork/RobinhoodFork.t.sol -vvv`.

---

## Frontend

`apps/web/` — Next.js 15 (App Router) + TypeScript + viem + wagmi + Tailwind v4. Reads chain state directly; no backend. Wallets are discovered with EIP-6963 (`src/components/ConnectButton.tsx`); no wallet SDK.

```bash
pnpm install                   # installs the whole workspace
pnpm --filter @dca/web abi     # export ABIs from ../../contracts/out into src/abi (already committed)
pnpm --filter @dca/web env:local   # write apps/web/.env.local from ../../contracts/deployments/31337.json
pnpm dev                       # http://localhost:3000 (or: pnpm --filter @dca/web dev)
```

- `/` — marketing site: sticky nav, hero with a live product preview, stats strip, how it works, vault comparison, benefits, `$DCA` perks, live fee table, FAQ, final CTA.
- `/app` — sidebar shell (logo, **Create new plan** CTA, My plans, Activity; *Protocol*: Overview, DCA Token, Docs; *Vaults*: next-buy countdowns), wallet button top-right, centred content column. Pages:
  - **Overview** — total value locked (USDG + ETH + stock on hand, all at router prices) with a composition bar, stock value bought with a sparkline built from `EpochPageExecuted` logs, and the vaults table (next buy, waiting to buy, stock on hand, bought to date). Fees are deliberately not shown here.
  - **Create** — four steps: stock → frequency (Daily / Weekly / Monthly, no vault or fee language) → amount per buy (slider + input) → upfront funding (slider 0…balance, USDG or ETH toggle; ETH is zapped to USDG by `createPlan`). Approve + create run as one click. The purchase/claim fee appears only in the small print of the summary.
  - **My plans** — one table with inline **Deposit** (USDG or ETH), **Withdraw**, **Claim** and a `⋯` menu with Pause/Resume and **Remove**. Remove runs `withdrawIdle → claim → prunePlan` as a guided sequence (the vault has no multicall, so up to three signatures). `prunePlan` keeps the plan record, so removed plans are hidden client-side from the last `PlanIndexed` event; a later deposit re-indexes and un-hides them.
  - **Activity** — "My buys" (`PlanFilled`) and "All buys" (`EpochPageExecuted`) with frequency filters.
  - **DCA Token** — price / market cap (router quote × `totalSupply`; "—" without a `$DCA`/USDG route), protocol volume, USDG fees accrued from logs, holder perks with the connected wallet's status, live fee schedule. The tokenomics allocation block is a placeholder.
  - **Docs** — placeholder documentation (`#dca` is the target of the "Find out more" links).
- Visual system: the `$PIE` dark register (Inter, lime `#ccff00`, 12/10/8/6px radii). One ladder of warm greys with a step of contrast per layer — `surface-0` `#0c0c0b` frame (sidebar, key stat tile) → `surface-1` `#121211` canvas → `surface-2` `#1a1a18` cards/tables → `surface-3` `#232220` inputs, hover rows, tiles → `surface-4` `#2f2e2a` fills. Tokens and utilities (`card`, `stat-strip`, `tile`, `tbl` + `sort-btn`, `toolbar`, `btn-*`, `chip-*`, `chip-dev`, `range`, `menu`) live in `src/app/globals.css`; primitives in `src/components/ui.tsx` (`PageHeader`, `Card`, `StatCard`, `SearchInput`, `SortTh`, `Slider`, `AmountInput`, `Segmented`, `Modal`, `Menu`, `Sparkline`, `StockAvatar`).
- Stock logos: `public/tickers/<TICKER>.svg` (shared with `$PIE`) via `StockAvatar`; a missing file falls back to the ticker's letters on a lime disc. Company names for search come from `src/lib/tickers.ts`.
- Everything is discovered from `VaultDirectory` (`NEXT_PUBLIC_DIRECTORY`); `ClaimHelper` powers the plan list; prices come from `AggregatorRouter.quote` simulated for one whole token (`usePrices`).
- **Local dev without a wallet extension:** on chain 31337 the header shows **Use test wallet**, a wagmi `mock` connector for anvil's unlocked `test1/2/3` accounts (see `src/lib/wagmi.ts`). Transactions are signed by anvil itself. Never enabled on other chains.
- **Test vault (dev flag):** `pnpm dev:test-vault` (= `NEXT_PUBLIC_SHOW_TEST_VAULT=1 next dev`; `SHOW_TEST_VAULT=1 pnpm dev` also works via `next.config.ts`) adds the local 2-minute `TestVault` as a fourth frequency, tagged `dev`. `VAULT_KINDS` in `src/lib/config.ts` becomes `[daily, weekly, monthly, test]`, `useDirectory()` merges `NEXT_PUBLIC_TEST_VAULT` into the vault map, and every app page follows; the marketing components use `PRODUCTION_VAULT_KINDS` and never show it. Requires chain 31337 — the flag is ignored elsewhere. To run a flagged and an unflagged dev server side by side from one checkout, give the second one its own build dir: `NEXT_DIST_DIR=.next-test-vault pnpm dev:test-vault --port 3001`.
- Geo-block: `src/middleware.ts` redirects `/app/*` to `/restricted` for `NEXT_PUBLIC_BLOCKED_COUNTRIES` (default US, GB, CA, AU, CU, IR, KP, SY) using the CDN country header (`x-vercel-ip-country` / `cf-ipcountry`). A first-visit disclaimer gate covers the rest. Contracts stay permissionless.

---

## Risks

Read [SECURITY.md](SECURITY.md) for the threat model. Headlines:

- **Router / liquidity.** Purchases execute against on-chain pools. Thin liquidity → impact cap trips → no fill that epoch. A broken router blocks epochs until the owner points vaults at a new one (`setRouter`) or a keeper passes a route override.
- **Keeper liveness.** No keeper, no purchases. Missed epochs are skipped, not caught up.
- **`$DCA` flash-buy.** Perks read spot balances at execution; someone can buy right before an epoch. Accepted for V1; a checkpointed snapshot is the V2 fix.
- **Zap-at-epoch.** WETH sits unhedged until the epoch; it can be skipped for slippage. Zap-now (default) takes the ETH/USDG risk at deposit time instead.
- **Stock Token depeg.** The token can trade away from the underlying's NYSE/Nasdaq price; the vault buys at the on-chain price.
- **Admin.** Owner can pause, change fees (≤ 0.90%), thresholds, router and keepers. Use a multisig; ownership is 2-step.

## Geo / legal

Robinhood Stock Tokens are not offered to US persons. This interface is unavailable in the United States, United Kingdom, Canada, Australia and sanctioned regions. Stock Tokens provide economic exposure to the underlying, not shareholder rights — users never own NYSE/Nasdaq shares. DCA is independent software, not affiliated with or endorsed by Robinhood, and nothing here is investment advice.
