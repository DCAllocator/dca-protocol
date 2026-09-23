# DCA — Buy stocks on a clock

Scheduled, on-chain purchases of **Robinhood Stock Tokens** on **Robinhood Chain** (chain id 4663, Arbitrum Orbit).

A user opens a **plan** inside a frequency **vault** (Daily / Weekly / Monthly): one Stock Token, a USDG amount per epoch (≥ 10 USDG), funded with USDG and/or ETH/WETH (ETH/WETH is converted to USDG at deposit time — vaults hold USDG only). Every epoch the vault takes the purchase fee, pools everyone's notional, routes one swap USDG → stock through the best **owner-approved** route on Uniswap V3 / Uniswap V4 / Ramses V3, and credits each plan pro-rata. Holders of ≥ 100,000 `$DCA` get stock sent straight to their wallet (0 claim fee) and pay half the purchase fee; everyone else accrues on-vault and `claim`s (0.25%). Both thresholds are owner-settable and independent. A plan can be **boosted**: its idle USDG is lent on **Morpho Blue** between buys and earns the market's supply rate, pulled back automatically at every buy and withdrawal (see [Boost](#boost)).

> Stock Tokens are **economic exposure, not shareholder rights**. Not offered to US persons. The contracts are permissionless; the UI is geo-blocked (US / UK / CA / AU / sanctioned). Unaudited software.

---

## Contents

- [Architecture](#architecture)
- [Fees](#fees)
- [Boost](#boost)
- [Epochs and scheduling](#epochs-and-scheduling)
- [Routing](#routing)
- [Querying balances](#querying-balances)
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
            │ AggregatorRouter │  best of the APPROVED hops, direct or via WETH, impact cap 150 bps
            └───┬─────┬─────┬──┘
                ▼     ▼     ▼
           UniV3   UniV4   RamsesV3   (adapters validate / quote / execute one approved hop)
```

**Vaults** (`src/vault/`) — one `PlanVault` implementation; `DailyVault` / `WeeklyVault` / `MonthlyVault` are thin subclasses fixing `epochLength` and the default purchase fee. Immutable, non-upgradeable, `Ownable2Step` + `Pausable` + `ReentrancyGuard`. **USDG-only**: all user balances live on `Plan` structs (`usdgIdle`, `stockAccrued`); ETH/WETH deposits are converted to USDG on the spot and any unfilled WETH is returned to the depositor. Fees leave the vault the moment they are taken; rounding dust that cannot be split exactly (`usdgDust`, and any WETH forwarded back by a partially filled second hop, `wethDust`) is swept to the treasury. `advanceEpoch` is keeper-only by default.

**Registry** (`src/registries/StockRegistry.sol`) — owner-curated whitelist. Tokens are never forgotten (`known` stays true) so `rescueERC20` can never touch user accounting. Fee-on-transfer tokens are refused.

**Router** (`src/router/`) — the only swap entry the vaults call. It trades **only owner-approved hops** (`approveHop` / `revokeHop`, one per pool and direction) and picks the highest output — i.e. the lowest effective fee + slippage — among approved direct routes and approved two-hop routes via WETH; `swapWithRoute` refuses any path with an unapproved hop, whoever supplies it. Vaults approve **only** the router; adapters pay pools from their transient balance (V3 callback / V4 settle), so no approvals to third-party routers exist anywhere.

**Keeper** (`src/keeper/EpochKeeper.sol`) — job list `(vault, stock)`, operator-only `runDue()` / `run()` / `performUpkeep()` (register your bots and the Chainlink Automation forwarder with `setOperator`), public `checkUpkeep`. One failing job never blocks the others.

**Boost** (`src/boost/`, `src/libraries/BoostLib.sol`) — each vault has an owner-set ERC-4626 `boostStrategy`; `MorphoBlueStrategy` is an ERC-4626 over one Morpho Blue market (deposits restricted to the vaults, withdrawals bounded by the market's liquidity, `supplyRatePerSecond()` for the live APY). Boosted plans' idle USDG lives in that one strategy position, split by vault-internal shares. The pool mutations live in `BoostLib`, a **linked external library** (delegatecall on the vault's storage) — that is what keeps `PlanVault` under the EIP-170 limit.

**Periphery** — `Zap` (ETH/WETH ⇄ USDG, deposit ETH as USDG into a plan), `ClaimHelper` (read-only aggregation: positions with boosted balances and earnings, claimables, fee previews), `TwapOracle` (mean-tick helper for keepers).

**`$DCA`** — read as a **spot balance at execution / claim time** (never at plan creation). `dca == address(0)` disables perks. `MockDCA` exists for tests and local stacks only; the production script refuses to deploy it.

### Design decisions worth knowing

| Decision | Why |
|---|---|
| **Per-page swaps.** `advanceEpoch(stock, limit)` processes ≤ `maxPlansPerTx` (150) plans per call with exactly one swap (aggregate USDG→stock buy). | Bounded gas with no two-pass cursor; a 10k-plan stock is simply several txs. |
| **Skip, never revert.** If a page's purchase cannot be quoted or executed, the page is skipped (`EpochPageSkipped`): nobody is charged, the cursor still advances. | One plan's state, a thin pool or a dust-sized page can never brick an epoch for everyone else. |
| **Minimums.** `amountPerEpoch ≥ minAmountPerEpoch` and every deposit must credit ≥ `minDeposit` (both 10 USDG by default, owner-settable). | Dust plans never enter the index; spamming the index costs real capital. |
| **Only the current epoch executes.** Missed epochs are skipped, never caught up. | Users are charged at most one spend per epoch; a keeper outage never triple-buys. |
| **Rounding dust → next-epoch pot** (`dustPot[stock]`). | User-favourable; tested. Never sent to the treasury. |
| **Auto-distribute uses a non-reverting transfer.** If a Stock Token blocks the recipient, the share accrues instead. | A permissioned token can't brick an epoch page for 149 other users. |
| **Aligned origins.** Daily = 00:00 UTC, Weekly = Monday 00:00 UTC, Monthly = 30-day epochs from 00:00 UTC of deploy day. Epoch 0 is never executed. | Predictable cron; first fire is the next boundary. |
| **USDG decimals detected at deploy** (`usdgDecimals`). `amountPerEpoch` is in USDG units. | Works with 6- or 18-decimal USDG. |
| **No on-chain factory.** `VaultDirectory` records addresses; `contracts/script/Deploy.s.sol` deploys. | Three ~23 KB vault initcodes can't fit under EIP-170 inside a factory. |
| **Deposits are open** (anyone may fund any plan, ≥ `minDeposit`). | Enables `Zap.depositEthAsUsdg`; it can only add value. |
| **Boost is opt-in, per plan, and a strategy failure never blocks an epoch.** If the strategy cannot pay a page's boosted spend, the boosted plans of that page sit it out (`BoostWithdrawFailed`) and everyone else fills. | Lending liquidity is outside the protocol's control; it must never turn into a DoS on unboosted users. |

---

## Fees

All fees are in **bps** (`uint16`), hard-capped at **90 bps** in `FeeMath.MAX_FEE_BPS`. Owner or `feeManager` sets them via `setFees(FeeConfig)`.

| Fee | Default | Range | When |
|---|---|---|---|
| Purchase — Daily | 75 bps | 0–90 | on spend, at epoch, before the swap |
| Purchase — Weekly | 50 bps | 0–90 | " |
| Purchase — Monthly | 25 bps | 0–90 | " |
| Deposit | **0** | 0–90 | on deposit (hook exists, off) |
| Withdraw idle | 25 bps | 0–90 | on `withdrawIdle` notional (USDG) |
| Claim | 25 bps | 0–90 | on `claim` path only; **0** when auto-distribute tier |

`$DCA` perks (two independent thresholds, owner-settable via `setThresholds` in raw token units; constructor default and `config/fees.json` deploy value = `100_000 * 10**dec` for both — the production script applies the config on deploy):

- `balance ≥ autoDistributeThreshold` → stock sent to `plan.recipient` at epoch, no claim fee (also 0 fee on `claim` for older accruals).
- `balance ≥ feeHalveThreshold` → `purchaseFeeBps / 2`, **floored** (75 → 37, 25 → 12).

Other tolerances (not fees): `swapSlippageBps` (minOut = quote × (1 − 0.50%), also the floor for any route override), `keeperTipBps` (share of purchase fees paid to whoever calls `advanceEpoch`, default 0, max 50%). Minimums: `minAmountPerEpoch` / `minDeposit` (10 USDG). Dust: `dustSweepMinUsdg` (1 USDG) — `usdgDust` is forwarded to `feeRecipient` during `advanceEpoch` once it reaches this; `wethDust` whenever non-zero; `sweepDust()` (owner / feeManager) forces it.

Fee math is exact integer arithmetic, rounds down in the user's favour, and is fuzzed (`test/unit/FeeMath.t.sol`). There is **no fee on boost yield**; the withdraw fee applies to boosted balances like any other idle USDG.

---

## Boost

A plan's USDG normally waits on the vault for days or weeks before it is spent. A **boosted** plan lends that idle USDG through the vault's `boostStrategy` — `MorphoBlueStrategy`, an ERC-4626 over one Morpho Blue market — and earns the market's supply rate until each buy. Off by default; `createPlan(..., boost=true)` or `setPlanBoost(planId, true)` on an existing plan (retroactive, moves the whole idle balance); `setPlanBoost(planId, false)` pulls everything back into `usdgIdle`, yield included (works while paused).

**Accounting.** The vault holds ONE strategy position and splits it between boosted plans with internal shares (`Plan.boostShares`, `totalBoostShares`; `boostAssets()` = `strategy.convertToAssets(strategy.balanceOf(vault))`). A plan's boosted balance is `boostShares × (boostAssets + 1) / (totalBoostShares + 1)` (`ClaimHelper.boostValueOf`), its spendable balance `usdgIdle + boosted`. Spends and withdrawals take `usdgIdle` first, then burn shares rounded up against the plan; a plan drained to its full value gives up every share (no dust). `boostPrincipal` is the plan's cost basis, reduced pro rata on every burn; the part of a withdrawal above it is booked into `boostEarned` (`BoostWithdrawn(planId, out, shares, earned)`), so lifetime earnings = `boostEarned + max(0, boosted − boostPrincipal)`. Deposits into a boosted plan are lent straight away; the unspent residual of a partial fill is returned as plain `usdgIdle` (spent first next epoch; `setPlanBoost(true)` again sweeps it into the pool).

**Epochs.** `_collect` values every boosted plan against one pool snapshot per page; the page's boosted spend is pulled from the strategy in **one** withdrawal before the swap. If that withdrawal reverts (fully utilised market), the page's boosted fills are dropped — those plans are neither charged nor marked filled and simply try again next epoch — and the unboosted plans are filled as usual (`BoostWithdrawFailed(stock, epochId, usdg, reason)`; the scheduler logs it). If the page's *swap* is skipped instead, the USDG already pulled goes straight back to the strategy in the same transaction.

**Admin.** `setBoostStrategy(strategy)` (owner) sets or migrates the strategy: the asset must be USDG; with positions open the whole pool is redeemed from the old strategy and deposited into the new one in the same call (internal shares untouched); clearing it with positions open reverts `BoostInUse`. Any ERC-4626 with the same asset works (a MetaMorpho vault, or a plain holding vault to pause yield). The strategy's shares are never `rescueERC20`-able. `MorphoBlueStrategy` itself is `Ownable2Step`: `setDepositor(vault, bool)` gates deposits; `skim()` lends stray loan tokens to all holders.

**APY.** The app quotes Morpho's own definition, computed with Morpho's SDK (`@morpho-org/blue-sdk` `Market.getSupplyApy`) from raw chain state: `e^(endBorrowRate × utilisation × (1 − marketFee) × 365 d) − 1`, where `endBorrowRate` is the AdaptiveCurveIrm's instantaneous rate at the chain's current timestamp (reads: `strategy.marketId/marketParams`, `morpho.market(id)`, `irm.rateAtTarget(id)`, latest block). For markets on another IRM (no `rateAtTarget`, where the SDK itself throws) it falls back to `MorphoBlueStrategy.supplyRatePerSecond()` = `borrowRateView × utilisation × (1 − fee)`, i.e. the IRM's *average* rate since the market was last touched — identical whenever the market was touched this block, and within 0.001 % of Morpho's figure on every live mainnet market checked. `pnpm --filter @dca/web apy:check` prints Morpho's API, the SDK figure and the fallback side by side for live markets (or `node scripts/check-boost-apy.mjs <rpc> <morpho> <chainId> <marketId…>` for any chain). Refreshed every 30 s.

**Risks** (SECURITY.md §11): boosted USDG is a Morpho Blue supply position — a fully borrowed market means boosted withdrawals (and boosted spends, see above) wait for liquidity; bad debt on the market is socialised across its suppliers, so a plan's boosted balance can fall below its principal (`boostEarned` never goes negative; losses show as `boosted < boostPrincipal`).

Deploy: `MORPHO` + `MORPHO_MARKET_ID` in `contracts/.env` (see `config/addresses.rh.json → morpho`); empty ships without boost and `setBoostStrategy` wires it later. The local stack deploys a `MockMorpho` market (real share maths and interest accrual, phantom borrower at 90 % utilisation, ~5 % supply APY) behind a real `MorphoBlueStrategy` on every vault, with the seeded NVDA test plan boosted.

---

## Epochs and scheduling

`epochId = (block.timestamp − origin) / epochLength`. `advanceEpoch` is allowed once `currentEpochId > lastExecutedEpoch[stock]`.

Per page of plans:

1. **Collect** eligible plans (unpaused, has idle, not yet filled this epoch) and tally, in memory, `spend = min(amountPerEpoch, usdgIdle)`, the `$DCA` perks snapshot and `fee = spend × effBps / 10_000`.
2. **Buy** — one swap `totalNet` USDG → stock via `router.quote` + `swapWithRoute` (or the keeper's `routeOverride`). If the quote fails, is too small, or the swap reverts, the **page is skipped** (`EpochPageSkipped(reason)`): nothing below happens, nobody is charged. Override failures revert instead (the page is not consumed).
3. **Commit** — debit `spend` from each plan, mark `lastEpochId`.
4. **Fees out** — keeper tip to `msg.sender`, remainder to `feeRecipient`.
5. **Distribute** — `share = mulDiv(bought + dustPot, net, totalNet)` (floor); auto-distribute or accrue; stock remainder → `dustPot`. Unspent USDG (partial fill) is returned pro-rata; its remainder → `usdgDust`.
6. **Sweep** — `usdgDust ≥ dustSweepMinUsdg` and any `wethDust` go to `feeRecipient`.
7. **Cursor** — `nextPlanIndex[stock][epochId] = end`; when `end == stockPlanCount`, `lastExecutedEpoch[stock] = epochId`.

Events: `PlanFilled`, `EpochPageExecuted`, `EpochPageSkipped`, `EpochExecuted`, `DustSwept`. Counters: `totalNotionalUsdg` (USDG actually spent), `epochsCompleted`.

While an epoch is pending (cursor started, not finished) `prunePlan` reverts (`EpochInProgress`) so the index cannot be reordered under the keeper. Deposits, withdrawals and claims are never blocked by a pending epoch.

**Pause** stops `createPlan`, deposits and `advanceEpoch`. `claim` and `withdrawIdle` always work. Delisting a stock in the registry stops new plans, deposits and epochs for it; users can still withdraw and claim.

---

## Routing

The router holds an **allowlist of hops**. A hop is `(protocol, tokenIn, tokenOut, fee, pool)` — one pool in one direction — approved by the owner with `approveHop(Route)` after the adapter validates it (`validateRoute`: registered / factory-verified pool, matching tokens). `quoteWithImpact(tokenIn, tokenOut, amountIn)` quotes every approved direct hop and every approved `(tokenIn → WETH) × (WETH → tokenOut)` combination, computes price impact against the pool mid-price (`slot0.sqrtPriceX96`), and returns the highest-output path with `impact ≤ maxPriceImpactBps` (150) — the lowest effective fee + slippage among approved routes. `swapWithRoute` executes a path only if every hop is approved (`RouteNotApproved` otherwise).

A typical SPY allowlist: `USDG → SPY` (Uniswap V3), `USDG → WETH` + `WETH → SPY` (Uniswap V4 keys), `USDG → SPY` (Ramses V3), plus `WETH → USDG` / `USDG → WETH` for deposits and the Zap. Approve at deploy with `V3_POOLS="1:0xpool,3:0xpool"` (both directions of each pool) or later with `script/ApproveRoutes.s.sol`.

- **UniV3Adapter / RamsesV3Adapter** — accept a pool if the owner registered it (`registerPool`) or, with a factory configured, if `factory.getPool(token0, token1, fee)` returns it. Quotes by simulating the swap and reverting inside `uniswapV3SwapCallback` with a sentinel (no QuoterV2 dependency). Callback is authenticated against `verifiedPool`.
- **UniV4Adapter** — talks to the `PoolManager` directly (`unlock` → `swap` → `sync/settle/take`). Pools are registered by `PoolKey` (`addPool`) before their hops can be approved. ERC-20/ERC-20 pools only. Mid-price via `extsload` at the v4-core `POOLS_SLOT` (owner-overridable).
- Unspent input of the first hop is refunded to the caller; unspent intermediate tokens of a later hop are forwarded to the recipient (the vault books them as `wethDust`).

Split routes are out of scope for V1 (single pool per hop).

---

## Querying balances

```bash
pnpm balance <wallet> ETH
pnpm balance <wallet> WETH
pnpm balance <wallet> USDG
pnpm balance <wallet> NVDA --json
pnpm balance <wallet> 0xTokenAddress --rpc http://127.0.0.1:8545
pnpm balance --list

pnpm transfer <from> <to> ETH 1.5
pnpm transfer <from> <to> USDG 250
pnpm transfer <from> <to> NVDA 2.5 --json
```

The CLI accepts `ETH`, `WETH`, `USDG`, every Robinhood Stock Token ticker in the connected deployment's `StockRegistry`, or a raw ERC-20 address. RPC selection is `--rpc`, then `RPC_URL`, then `apps/scheduler/.env.local`, with Robinhood Chain RPC as the default. Production ticker addresses come from `contracts/config/addresses.rh.json`; zero-address placeholders are rejected until populated.

`pnpm transfer` is restricted to the local Anvil fork (chain 31337). It parses amounts in the asset's native decimals, waits for the transaction receipt, and requires the `from` wallet to be one of Anvil's unlocked accounts. No private key is passed on the command line.

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

`runDue()` runs one page for every due job in a single transaction and forwards any USDG keeper tips to the caller. **Operators only**: vaults run `keeperOnly` (default), the `EpochKeeper` contract is their keeper, and `runDue` / `run` / `performUpkeep` require `isOperator[msg.sender]` (or the owner). `KEEPERS` in `.env` become operators at deploy; add more with `keeper.setOperator(addr, true)`.

**Chainlink Automation / Gelato:** register `EpochKeeper` as an upkeep and register the Automation **forwarder** (or Gelato's dedicated sender) as an operator. `checkUpkeep("")` (public view) returns `(true, abi.encode(uint256[] jobIndices))` for up to `maxJobsPerUpkeep` due jobs; `performUpkeep(performData)` re-checks due-ness on chain.

**Route override** (operators) — to pin a specific approved path or, more usefully, to pass a **tighter `minOut`** derived from an off-chain reference price (the recommended MEV mitigation today, see SECURITY.md):

```bash
# 1. Quote (simulation, no --broadcast). Prints the best path and a ready routeOverride blob.
cd contracts && forge script script/Quote.s.sol --rpc-url $RH_RPC \
  --sig "run(address,address,address,uint256,uint16)" $ROUTER $USDG $NVDA 1000000000 50

# 2. Submit with the override (the blob is abi.encode(Route[] path, uint256 minOut))
cast send $KEEPER "run(uint256,uint256,bytes)" $JOB_INDEX 0 $ROUTE_OVERRIDE --rpc-url $RH_RPC --private-key $OPERATOR_KEY
```

Every hop of the override must be approved on the router, and `minOut` may not be below the auto-route's own floor (`quote × (1 − swapSlippageBps)`) — an override can pick a path, never a worse price. An override that cannot fill reverts (the page is not consumed); an auto-route that cannot fill skips the page. Use a private mempool for keeper txs (see SECURITY.md).

Useful views: `vault.isEpochDue(stock)`, `vault.isEpochPending(stock)`, `vault.nextPlanIndex(stock, epochId)`, `vault.stockPlanCount(stock)`, `keeper.dueJobs()`.

---

## Adding a stock

1. Confirm the token is a standard ERC-20 (no fee-on-transfer, no hooks, 18 decimals preferred) and that a USDG (or WETH) pool with real depth exists on one of the supported DEXes.
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
4. Approve the route(s) on the router — nothing trades until you do. V3-style pool: `forge script script/ApproveRoutes.s.sol --sig "v3(address,uint8,address,address,address)" $ROUTER 1 $POOL $USDG $TOKEN ...` (protocol 3 for Ramses; `UniV3Adapter.registerPool(pool)` first if the factory ABI is non-standard). V4: `UniV4Adapter.addPool(PoolKey)` then `--sig "v4(...)"`. For a two-hop route approve both legs (`USDG → WETH`, `WETH → TOKEN`).
5. Sanity-check a quote with `contracts/script/Quote.s.sol`.

The frontend picks the stock up automatically from `registry.approvedStocks()`. Delist with `setApproved(token, false)`.

---

## Repo layout

```
contracts/                Foundry project (Forge / Anvil)
  config/                  addresses.rh.json (TODOs for every external address), fees.json
  src/
    interfaces/            IPlanVault, IStockRegistry, IWETH, IMorpho (+ IIrm), IEpochAdvanceable (V2 hook), IUniswapV3, IUniswapV4
    libraries/             FeeMath, EpochLib, BoostLib (linked external lib: the vault's boost pool), MorphoLib (Morpho share maths)
    boost/                 MorphoBlueStrategy (ERC-4626 over one Morpho Blue market)
    oracles/               TwapOracle
    router/                IAggregatorRouter, AggregatorRouter, adapters/{ISwapAdapter,UniV3,UniV4,RamsesV3}
    registries/            StockRegistry
    token/                 IDCA, MockDCA (tests/local only)
    vault/                 VaultTypes, PlanVault, DailyVault, WeeklyVault, MonthlyVault, VaultDirectory
    periphery/             Zap, ClaimHelper
    keeper/                EpochKeeper
  test/
    unit/ fuzz/ invariant/ fork/ audit/ mocks/   (mocks/TestVault.sol = short-epoch vault for local stacks only;
                                              mocks/MockMorpho.sol = Morpho Blue lender surface with real accrual)
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
forge build --sizes            # vaults ~23.6 KB runtime (EIP-170 margin ~1 KB — BoostLib is a linked library for that reason)
forge test                     # 303 tests: unit, fuzz, invariant, audit regression (fork suite self-skips without RH_RPC)
forge test --match-path "test/audit/*" -vv   # regression suite for the v0.1 audit findings (real router + CPMM pool)
forge coverage --ir-minimum --no-match-coverage "(script|test)/"
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

**Stocks.** The registry lists the full Robinhood lineup. Sixteen "liquid" tickers get a seeded USDG pool (mock price, whole supply in the pool) and keeper jobs; the rest are listed with no pool, so — like a thin real ticker — the router has no route and the app shows no price. The seeded supplies are shaped like Robinhood Chain, where Stock Tokens are minted on demand (mainnet `totalSupply()` of 21 Sep 2026 ×10: NVDA ≈ 913k, SPY ≈ 319k … AVGO ≈ 5.7k), so the create page's **Popular** row — ranked by tokenised market cap, supply × price — orders the same way locally as live. Edit `_seedSymbols()` in `DeployLocal.s.sol` to change either.

**Test vault.** Besides Daily / Weekly / Monthly, the local stack deploys a `TestVault` (`contracts/test/mocks/TestVault.sol` — same `PlanVault` code, `epochLength` = `TEST_EPOCH_MINUTES` minutes, default 2, origin aligned to a multiple of that length) with keeper jobs for every liquid stock and three deployer-owned plans (NVDA 100 / AAPL 50 / TSLA 25 USDG per epoch, 500k USDG each), so `pnpm scheduler` has an epoch to advance every couple of minutes. `TEST_EPOCH_MINUTES=5 pnpm fork` changes the cadence. Its address is `testVault` in `contracts/deployments/31337.json` (and `NEXT_PUBLIC_TEST_VAULT` in `apps/web/.env.local`); it is not in `VaultDirectory`. The web app shows it as a fourth **Test** frequency (tagged `dev`) in the frequency picker, My plans, Activity, the vaults table and the sidebar balances only when the dev server is started with the flag — `pnpm dev:test-vault`, or `NEXT_PUBLIC_SHOW_TEST_VAULT=1` / `SHOW_TEST_VAULT=1 pnpm dev` — and only on chain 31337; the marketing site always shows the three production vaults. Plans can also be added with `cast`:

```bash
cast send $USDG "approve(address,uint256)" $TEST_VAULT 1000000000 --rpc-url http://127.0.0.1:8545 --unlocked --from $TEST1
# createPlan(stock, amountPerEpoch, recipient, usdgAmount, wethAmount, minUsdgOut, boost)
cast send $TEST_VAULT "createPlan(address,uint96,address,uint256,uint256,uint256,bool)" $NVDA 10000000 0x0000000000000000000000000000000000000000 1000000000 0 0 true --rpc-url http://127.0.0.1:8545 --unlocked --from $TEST1
cast send $TEST_VAULT "setPlanBoost(uint256,bool)" $PLAN_ID false --rpc-url http://127.0.0.1:8545 --unlocked --from $TEST1   # unboost
```

Note that anvil evaluates `eth_call` at the **last mined block's** timestamp, so on an idle chain nothing ever looks due; the scheduler handles this by mining a block (0-value self-transfer) when a boundary has passed since the last block.

**Robinhood Chain:**

```bash
cp contracts/.env.example contracts/.env   # fill USDG, WETH, DCA, DEX factories, OWNER, FEE_RECIPIENT, KEEPERS, STOCKS, V3_POOLS, MORPHO + MORPHO_MARKET_ID (optional)
pnpm protocol:deploy
# → contracts/deployments/4663.json
# then, from the OWNER multisig: acceptOwnership() on registry, router, adapters, vaults, keeper, directory
```

`pnpm protocol:deploy` (`scripts/deploy.sh`) sources `contracts/.env`, confirms before broadcasting, then runs `forge script script/Deploy.s.sol --broadcast --verify`. The production script applies `contracts/config/fees.json`, wires the keeper to every vault, creates a job per approved stock, deploys `MorphoBlueStrategy` over `MORPHO_MARKET_ID` and sets it on the three vaults when `MORPHO` is set, and never deploys a mock `$DCA` (`DCA` empty ⇒ perks disabled; on 4663 you must set `ALLOW_NO_DCA=true` to confirm that). `BoostLib` is a linked library: `forge script` deploys and links it automatically (it is in the broadcast; pass it to `--libraries` when verifying by hand).

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
- `/app` — sidebar shell (logo, **Create new plan** CTA, My plans, Activity; *Protocol*: Overview, DCA Token, Docs; *Vaults*: USDG waiting to buy per vault, boosted included), wallet button top-right, centred content column. Pages:
  - **Overview** — total value locked (USDG on the vaults + USDG boosted on Morpho + stock on hand, all at router prices) with a composition bar, stock value bought with a sparkline built from `EpochPageExecuted` logs, and the vaults table (next buy, waiting to buy incl. boosted, boost APY, stock on hand, bought to date). Fees are deliberately not shown here.
  - **Create** — one centred swap card (Jupiter's DCA form), read top to bottom: **Fund with** (big amount, `USDG ▾ / ETH ▾` pill, `≈ $` line, balance with HALF / MAX; ETH is zapped to USDG by `createPlan`) → arrow → **Buy** (stock pill with search, ranked popular-first — `useRankedStocks`: `totalSupply` × router price, shown only once every supply and price has answered — plus a **Popular** row of the five biggest by tokenised market cap; the most popular is the default pick) → **Every** (`day / week / month`, plus `test` locally; an ⓘ notes that fill timing is randomised against frontrunning) beside **Per buy** (amount, "covers N buys") → the monthly estimate → the **Earn while you wait** switch (off by default) with the live Morpho APY — on, `createPlan` is sent with `boost = true` → one tall button (approve + create as one click) → first buy, fee and tolerances beneath. No vault or fee language in the form; the small print sits under the card.
  - **Create (legacy)** — `/app/create/legacy`, the previous layout kept for comparison: four numbered steps on the `$PIE` create-flow grid (42px step heads, 14px bodies, lime badge once a step is satisfied) with a sticky summary, checklist and the same boost switch and button. Not linked from the sidebar.
  - **My plans** — one table with inline **Deposit** (USDG or ETH), **Withdraw**, **Claim**, **Boost** / **Unboost** and a `⋯` menu with Pause/Resume and **Remove**. Balance = vault-held USDG + boosted balance; boosted rows show lifetime boost earnings (`ClaimHelper` fields). Withdraw covers the boosted balance (the vault's `type(uint256).max` sentinel is used for "all"). Remove runs `setPlanBoost(false) → withdrawIdle → claim → prunePlan` as a guided sequence (the vault has no multicall, so up to four signatures). `prunePlan` keeps the plan record, so removed plans are hidden client-side from the last `PlanIndexed` event; a later deposit re-indexes and un-hides them. Every write pads the gas estimate (×1.25 + 100k): a Morpho-touching call estimated right after an accrual is cheaper than its real execution a block later.
  - **Activity** — "My buys" (`PlanFilled`) and "All buys" (`EpochPageExecuted`) with frequency filters.
  - **DCA Token** — price / market cap (router quote × `totalSupply`; "—" without a `$DCA`/USDG route), protocol volume, USDG fees accrued from logs, holder perks with the connected wallet's status, live fee schedule. The tokenomics allocation block is a placeholder.
  - **Docs** — placeholder documentation (`#dca` is the target of the "Find out more" links; `#boost` explains Boost and its risks).
- Visual system: the `$PIE` dark register (Inter, lime `#ccff00`, 12/10/8/6px radii). One ladder of warm greys with a step of contrast per layer — `surface-0` `#0c0c0b` frame (sidebar, key stat tile) → `surface-1` `#121211` canvas → `surface-2` `#1a1a18` cards/tables → `surface-3` `#232220` inputs, hover rows, tiles → `surface-4` `#2f2e2a` fills. Tokens and utilities (`card`, `stat-strip`, `tile`, `step-*` / `amount-box` / `quick` / `note` / `check-item` for the create flow, `tbl` + `sort-btn`, `toolbar`, `btn-*`, `chip-*`, `chip-dev`, `range`, `menu`) live in `src/app/globals.css`; primitives in `src/components/ui.tsx` (`PageHeader`, `Card`, `StatCard`, `SearchInput`, `SortTh`, `Slider`, `AmountInput`, `Segmented`, `Modal`, `Menu`, `Sparkline`, `StockAvatar`).
- Stock logos: `public/tickers/<TICKER>.svg` (shared with `$PIE`) via `StockAvatar`; a missing file falls back to the ticker's letters on a lime disc. Company names for search come from `src/lib/tickers.ts`.
- Everything is discovered from `VaultDirectory` (`NEXT_PUBLIC_DIRECTORY`); `ClaimHelper` powers the plan list; prices come from `AggregatorRouter.quote` simulated for one whole token (`usePrices`). The boost APY (`useBoostApys`) is Morpho's own number: the blue-sdk's `Market.getSupplyApy` over `morpho.market(id)` + `irm.rateAtTarget(id)` at the latest block's timestamp, with `MorphoBlueStrategy.supplyRatePerSecond()` as the fallback for non-AdaptiveCurve IRMs (see [Boost](#boost)); product copy for the feature (names of the Boost / Unboost actions, the card title, the tooltip) is `BOOST` in `src/lib/config.ts`.
- **Local dev without a wallet extension:** on chain 31337 the header shows **Use test wallet**, a wagmi `mock` connector for anvil's unlocked `test1/2/3` accounts (see `src/lib/wagmi.ts`). Transactions are signed by anvil itself. Never enabled on other chains.
- **Slow and failing transactions:** anvil mines each tx the moment it arrives and the test wallet signs instantly, so the in-flight states of the UI flash by. `pnpm latency` starts `scripts/rpc-latency.mjs`, an RPC proxy on :8555 in front of anvil that behaves like a real network: every call takes 150±100 ms, the test wallet takes 3 s to "sign", and anvil mines a block every 2 s (preset `realistic`; also `off`, `slow`, `chaos`). It also injects failures, each as a share from 0 to 1: `reject` (the wallet answers "User rejected the request."), `revert` (the tx goes out with a gas limit that runs out, so it is mined and reverts), `drop` (the tx is evicted from the mempool and never mined). Run the app through it with `pnpm dev:latency` (http://localhost:3004, own `.next-latency` build dir) and change the settings live: `curl 'localhost:8555/__latency?preset=slow'`, `curl 'localhost:8555/__latency?reject=1'`, or `curl 'localhost:8555/__latency?blockTime=manual'` to hold every tx pending until `curl localhost:8555/__latency/mine`. The proxy's console prints each tx's timeline (in the wallet, sent, mined / reverted / dropped, seconds after send). `blockTime` switches anvil's own mining mode, so every client of the node sees it; the proxy puts anvil back on automine when it exits.
- **Test vault (dev flag):** `pnpm dev:test-vault` (= `NEXT_PUBLIC_SHOW_TEST_VAULT=1 next dev`; `SHOW_TEST_VAULT=1 pnpm dev` also works via `next.config.ts`) adds the local 2-minute `TestVault` as a fourth frequency, tagged `dev`. `VAULT_KINDS` in `src/lib/config.ts` becomes `[daily, weekly, monthly, test]`, `useDirectory()` merges `NEXT_PUBLIC_TEST_VAULT` into the vault map, and every app page follows; the marketing components use `PRODUCTION_VAULT_KINDS` and never show it. Requires chain 31337 — the flag is ignored elsewhere. To run a flagged and an unflagged dev server side by side from one checkout, give the second one its own build dir: `NEXT_DIST_DIR=.next-test-vault pnpm dev:test-vault --port 3001`.
- Geo-block: `src/middleware.ts` redirects `/app/*` to `/restricted` for `NEXT_PUBLIC_BLOCKED_COUNTRIES` (default US, GB, CA, AU, CU, IR, KP, SY) using the CDN country header (`x-vercel-ip-country` / `cf-ipcountry`). A first-visit disclaimer gate covers the rest. Contracts stay permissionless.

---

## Risks

Read [SECURITY.md](SECURITY.md) for the threat model. Headlines:

- **Router / liquidity.** Purchases execute against on-chain pools. Thin liquidity → impact cap trips → the page is skipped that epoch (nobody charged). A broken router skips epochs until the owner points vaults at a new one (`setRouter`) or approves other hops.
- **MEV on the epoch swap (open, see SECURITY.md §2).** Triggering is operator-only, but an operator's transaction can still be sandwiched at the block level. Operators should submit through a private relay and pass a reference-price `minOut` override.
- **Keeper liveness.** No operator, no purchases (there is no permissionless fallback). Missed epochs are skipped, not caught up.
- **`$DCA` flash-buy.** Perks read spot balances at execution; someone can buy right before an epoch. Accepted for V1; a checkpointed snapshot is the V2 fix.
- **ETH deposits.** ETH/WETH is converted to USDG at deposit with the depositor's `minUsdgOut`; the ETH/USDG price risk is taken at deposit time, never at epoch.
- **Boost (Morpho Blue).** Boosted USDG is a lending position: a fully utilised market delays boosted withdrawals and spends until liquidity returns (unboosted plans are unaffected), and bad debt on the market is shared by its suppliers. The strategy contract and the market choice are owner decisions. See SECURITY.md §11.
- **Stock Token depeg.** The token can trade away from the underlying's NYSE/Nasdaq price; the vault buys at the on-chain price.
- **Admin.** Owner can pause, change fees (≤ 0.90%), thresholds, minimums, router, approved routes, keepers and operators. Use a multisig; ownership is 2-step.

## Geo / legal

Robinhood Stock Tokens are not offered to US persons. This interface is unavailable in the United States, United Kingdom, Canada, Australia and sanctioned regions. Stock Tokens provide economic exposure to the underlying, not shareholder rights — users never own NYSE/Nasdaq shares. DCA is independent software, not affiliated with or endorsed by Robinhood, and nothing here is investment advice.
