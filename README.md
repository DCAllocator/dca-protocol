# DCA — Buy stocks on a clock

Scheduled, on-chain purchases of **Robinhood Stock Tokens** on **Robinhood Chain** (chain id 4663, Arbitrum Orbit).

A user opens a **plan** inside a frequency **vault** (Hourly / Daily / Weekly / Monthly): one Stock Token, a USDG amount per epoch (≥ 10 USDG), funded with USDG and/or ETH/WETH (ETH/WETH is converted to USDG at deposit time — vaults hold USDG only). Every epoch the vault takes the purchase fee, pools everyone's notional, routes one swap USDG → stock through the best **owner-approved** route on Uniswap V3 / Uniswap V4 / Ramses V3, and credits each plan pro-rata. Holders of ≥ 100,000 `$DCA` get stock sent straight to their wallet (0 claim fee) and pay half the purchase fee; everyone else accrues on-vault and `claim`s (0.25%). Both thresholds are owner-settable and independent. A plan can be **boosted**: its idle USDG is lent on **Morpho Blue** between buys and earns the market's supply rate, pulled back automatically at every buy and withdrawal (see [Boost](#boost)).

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
│DailyVault│      │WeeklyVlt │      │MonthlyVlt│◄──── users   (+ HourlyVault: 1h, 90bp)
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

**Vaults** (`src/vault/`) — one `PlanVault` implementation; `HourlyVault` / `DailyVault` / `WeeklyVault` / `MonthlyVault` are thin subclasses fixing `epochLength` and the default purchase fee. Immutable, non-upgradeable, `Ownable2Step` + `Pausable` + `ReentrancyGuard`. **USDG-only**: all user balances live on `Plan` structs (`usdgIdle`, `stockAccrued`); ETH/WETH deposits are converted to USDG on the spot and any unfilled WETH is returned to the depositor. Fees leave the vault the moment they are taken; rounding dust that cannot be split exactly (`usdgDust`, and any WETH forwarded back by a partially filled second hop, `wethDust`) is swept to the treasury. `advanceEpoch` is keeper-only by default.

**Registry** (`src/registries/StockRegistry.sol`) — owner-curated whitelist. Tokens are never forgotten (`known` stays true) so `rescueERC20` can never touch user accounting. Fee-on-transfer tokens are refused.

**Router** (`src/router/`) — the only swap entry the vaults call. It trades **only owner-approved hops** (`approveHop` / `revokeHop`, one per pool and direction) and picks the highest output — i.e. the lowest effective fee + slippage — among approved direct routes and approved two-hop routes via WETH; `swapWithRoute` refuses any path with an unapproved hop, whoever supplies it. Vaults approve **only** the router; adapters pay pools from their transient balance (V3 callback / V4 settle), so no approvals to third-party routers exist anywhere.

**Keeper** (`src/keeper/EpochKeeper.sol`) — job list `(vault, stock)`, operator-only `runDue()` / `run()` / `performUpkeep()` (register your bots and the Chainlink Automation forwarder with `setOperator`), public `checkUpkeep`. One failing job never blocks the others.

**Boost** (`src/boost/`, `src/libraries/BoostLib.sol`) — each vault has an owner-set ERC-4626 `boostStrategy`; `MorphoBlueStrategy` is an ERC-4626 over one Morpho Blue market (deposits restricted to the vaults, withdrawals bounded by the market's liquidity, `supplyRatePerSecond()` for the live APY). Boosted plans' idle USDG lives in that one strategy position, split by vault-internal shares. The pool mutations live in `BoostLib`, a **linked external library** (delegatecall on the vault's storage) — that is what keeps `PlanVault` under the EIP-170 limit.

**Periphery** — `Zap` (ETH/WETH ⇄ USDG, deposit ETH as USDG into a plan), `ClaimHelper` (read-only aggregation: positions with boosted balances and earnings, claimables, fee previews), `TwapOracle` (mean-tick helper for keepers and the FeeReceiver's price guard).

**FeeReceiver** (`src/treasury/FeeReceiver.sol`) — the vaults' `feeRecipient`. Every fee lands there; operators split each token **70% → treasury wallet, 30% → `$DCA` buyback + burn** (constants). The 30% can only leave through the router into `$DCA` that is burned in the same transaction (or a Stock Token reserve into USDG/WETH first); there is no rescue or withdraw. Every swap is floored at `quote × (1 − maxSlippageBps)` and every V3-style pool on the path must trade within `guardMaxTicks` of its 30-minute TWAP. Reviewed in [`audit/AUDIT-FeeReceiver.md`](audit/AUDIT-FeeReceiver.md).

**`$DCA`** — read as a **spot balance at execution / claim time** (never at plan creation). `dca == address(0)` disables perks. `MockDCA` exists for tests and local stacks only; the production script refuses to deploy it.

### Design decisions worth knowing

| Decision | Why |
|---|---|
| **Per-page swaps.** `advanceEpoch(stock, limit)` processes ≤ `maxPlansPerTx` (150) plans per call with exactly one swap (aggregate USDG→stock buy). | Bounded gas with no two-pass cursor; a 10k-plan stock is simply several txs. |
| **Skip, never revert.** If a page's purchase cannot be quoted or executed, the page is skipped (`EpochPageSkipped`): nobody is charged, the cursor still advances. | One plan's state, a thin pool or a dust-sized page can never brick an epoch for everyone else. |
| **Minimums.** The per-buy setting `amountPerEpoch ≥ minAmountPerEpoch` and every deposit must credit ≥ `minDeposit` (both 10 USDG by default, owner-settable). A plan holding less than its buy amount spends what it has on its next buy (a partial buy). | A plan enters the index only after a real deposit, so spamming the index costs real capital. |
| **Only the current epoch executes.** Missed epochs are skipped, never caught up. | Users are charged at most one spend per epoch; a keeper outage never triple-buys. |
| **Rounding dust → next-epoch pot** (`dustPot[stock]`). | User-favourable; tested. Never sent to the treasury. |
| **Auto-distribute uses a non-reverting transfer.** If a Stock Token blocks the recipient, the share accrues instead. | A permissioned token can't brick an epoch page for 149 other users. |
| **Aligned origins.** Hourly = the top of the hour (UTC, 24/7), Daily = 00:00 UTC, Weekly = Monday 00:00 UTC, Monthly = 30-day epochs from 00:00 UTC of deploy day. Epoch 0 is never executed. | Predictable cron; first fire is the next boundary. |
| **USDG decimals detected at deploy** (`usdgDecimals`). `amountPerEpoch` is in USDG units. | Works with 6- or 18-decimal USDG. |
| **No on-chain factory.** `VaultDirectory` records addresses; `contracts/script/Deploy.s.sol` deploys. | Four ~24 KB vault initcodes can't fit under EIP-170 inside a factory. |
| **Deposits are open** (anyone may fund any plan, ≥ `minDeposit`). | Enables `Zap.depositEthAsUsdg`; it can only add value. |
| **Boost is opt-in, per plan, and a strategy failure never blocks an epoch.** If the strategy cannot pay a page's boosted spend, the boosted plans of that page sit it out (`BoostWithdrawFailed`) and everyone else fills. | Lending liquidity is outside the protocol's control; it must never turn into a DoS on unboosted users. |

---

## Fees

All fees are in **bps** (`uint16`), hard-capped at **90 bps** in `FeeMath.MAX_FEE_BPS`. Owner or `feeManager` sets them via `setFees(FeeConfig)`.

| Fee | Default | Range | When |
|---|---|---|---|
| Purchase — Hourly | 90 bps | 0–90 | " (the cap; 45 bps with the fee-halve perk) |
| Purchase — Daily | 75 bps | 0–90 | on spend, at epoch, before the swap |
| Purchase — Weekly | 50 bps | 0–90 | " |
| Purchase — Monthly | 25 bps | 0–90 | " |
| Deposit | **0** | 0–90 | on deposit (hook exists, off) |
| Withdraw idle | 25 bps | 0–90 | on `withdrawIdle` notional (USDG) |
| Claim | 25 bps | 0–90 | on `claim` path only; **0** when auto-distribute tier |

`$DCA` perks (two independent thresholds, owner-settable via `setThresholds` in raw token units; constructor default and `config/fees.json` deploy value = `100_000 * 10**dec` for both — the production script applies the config on deploy):

- `balance ≥ autoDistributeThreshold` → stock sent to `plan.recipient` at epoch, no claim fee (also 0 fee on `claim` for older accruals).
- `balance ≥ feeHalveThreshold` → `purchaseFeeBps / 2`, **floored** (75 → 37, 25 → 12).

Other tolerances (not fees): `swapSlippageBps` (minOut = quote × (1 − 0.50%), also the floor for any route override), `keeperTipBps` (share of purchase fees paid to whoever calls `advanceEpoch`, default 0, max 10% — `MAX_KEEPER_TIP_BPS` in `VaultAdminLib`). Minimums: `minAmountPerEpoch` / `minDeposit` (10 USDG). Dust: `dustSweepMinUsdg` (1 USDG) — `usdgDust` is forwarded to `feeRecipient` during `advanceEpoch` once it reaches this; `wethDust` whenever non-zero; `sweepDust()` (owner / feeManager) forces it.

Fee math is exact integer arithmetic, rounds down in the user's favour, and is fuzzed (`test/unit/FeeMath.t.sol`). There is **no fee on boost yield**; the withdraw fee applies to boosted balances like any other idle USDG.

**Where fees go.** `feeRecipient` on every vault is the `FeeReceiver`. Per token, `distribute(token)` (operator) forwards 70% of what arrived since the last split to the treasury wallet and books 30% into `buybackReserve[token]`; `buyback(token, amount, minOut)` swaps reserve into `$DCA` through the router and burns it (`burn(uint256)` if the token has one, else `0x…dEaD`); `convert(stock, USDG|WETH, …)` turns a Stock Token reserve (claim fees) into a base-token reserve first. `pending(token)`, `buybackReserve(token)` and `totalBurned()` are the views the app reads. `FEE_RECIPIENT` in `.env` is the treasury wallet; the receiver is deployed by `Deploy.s.sol` whenever `DCA` is set.

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

1. **Collect** eligible plans (unpaused, has idle or boosted USDG, not yet filled this epoch) and tally, in memory, `spend = min(amountPerEpoch, usdgIdle + boosted)` (the boosted value, see [Boost](#boost); a partial buy when the plan holds less), the `$DCA` perks snapshot and `fee = spend × effBps / 10_000`.
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

Cron (UTC): Hourly fires **on the hour, every hour, 24/7**, Daily at **00:00**, Weekly at **Monday 00:00**, Monthly every **30 days** from its origin. Poll a few minutes after each boundary and keep going until nothing is due (a large stock spans several pages).

**Hourly load.** Every approved stock is due every hour, so 16 stocks = 384 keeper pages a day (24× the daily vault); size `maxJobsPerUpkeep` / `MAX_PAGES_PER_JOB` for that. The scheduler is cadence-generic and needs no change. Missed hours are skipped, never caught up: a page that cannot fill for a whole hour drops that hour for every plan on the stock. A plan parked by `closePlan` mid-epoch (see Frontend › My plans) costs each page one storage read per epoch until it is pruned; there is no automatic prune sweep.

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
   cast send $KEEPER "addJob(address,address)" $HOURLY $TOKEN ...
   cast send $KEEPER "addJob(address,address)" $DAILY $TOKEN ...
   cast send $KEEPER "addJob(address,address)" $WEEKLY $TOKEN ...
   cast send $KEEPER "addJob(address,address)" $MONTHLY $TOKEN ...
   ```
4. Approve the route(s) on the router — nothing trades until you do. V3-style pool: `forge script script/ApproveRoutes.s.sol --sig "v3(address,uint8,address,address,address)" $ROUTER 1 $POOL $USDG $TOKEN ...` (protocol 3 for Ramses; `UniV3Adapter.registerPool(pool)` first if the factory ABI is non-standard). V4: `UniV4Adapter.addPool(PoolKey)` then `--sig "v4(...)"`. For a two-hop route approve both legs (`USDG → WETH`, `WETH → TOKEN`).
5. Sanity-check a quote with `contracts/script/Quote.s.sol`.

The frontend lists the stock from `registry.approvedStocks()`, but the create picker only offers it on a frequency once that vault has an active keeper job for it and, while the vault's `requireFeed` is on, a price feed (`vault.setPriceFeed`); until then it is not offered, and My plans marks any existing plan on it "Not being bought". The scheduler logs a warning for every vault that holds plans on an approved stock with no active job (`UNCOVERED_CHECK_SECONDS`). Delist with `setApproved(token, false)`.

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
    vault/                 VaultTypes, PlanVault, HourlyVault, DailyVault, WeeklyVault, MonthlyVault, VaultDirectory
    periphery/             Zap, ClaimHelper
    keeper/                EpochKeeper
    treasury/              FeeReceiver (70% treasury / 30% $DCA buyback + burn)
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
forge build --sizes            # vaults ~24.2 KB runtime; EIP-170 margin Hourly 373 / Daily 373 / Weekly 372 / Monthly 371 / TestVault 416 B
                               #   (BoostLib, VaultAdminLib, PriceGuardLib and PlanExitLib are linked libraries for that reason —
                               #   put every PlanVault addition in a library; ContractSizes.t.sol enforces the limit:
                               #   forge test --match-contract ContractSizes -vv logs the margins)
forge test                     # 480 tests: unit, fuzz, invariant, audit regression (fork suite self-skips without RH_RPC)
forge test --match-path "test/audit/*" -vv   # regression suite for the v0.1 audit findings (real router + CPMM pool)
forge coverage --ir-minimum --no-match-coverage "(script|test)/"
```

Test-writing note: with `via_ir`, `block.timestamp` read after `vm.warp` in the same call frame may return the pre-warp value (TIMESTAMP is treated as call-invariant and hoisted); compute origins from explicit timestamps or vault views. `BaseTest`'s `T0` is Friday 2027-01-15 14:00:00 UTC.

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
| `treasury` | 1 | the FeeReceiver's treasury wallet (70% of every fee; the vaults' `feeRecipient` is the FeeReceiver); USDG |
| `test1` / `test2` / `test3` | 2 / 3 / 4 | funded wallets for interacting with the protocol; USDG, WETH, 60k mDCA |
| `bot` | 5 | the scheduler's wallet — only pays gas for `EpochKeeper.run` |

All six already hold 10,000 ETH from anvil's genesis.

**Wallet.** The app has no built-in test wallet: every transaction is signed in a real browser wallet. Import an anvil account into MetaMask with the private key `pnpm fork` prints — `test1` (`0x3C44…93BC`) is the one to use; account 0 is the deployer/operator that `pnpm fork` and the `cast` / operator scripts also send from, so its nonce moves behind the wallet's back. Add a network with RPC `http://127.0.0.1:8545` (or `http://127.0.0.1:8555` through the latency proxy, see [Frontend](#frontend)), chain id `31337`, currency ETH. **After every fresh `pnpm fork`**, MetaMask → Settings → Advanced → **Clear activity tab data**: a new anvil starts the same accounts at the same nonces, and MetaMask's history of the previous fork makes it drop new transactions or sign them with a stale nonce ("nonce too low").

**Multicall3.** Right after anvil answers, `pnpm fork` installs the canonical Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11` (`anvil_setCode` with `scripts/multicall3.runtime.hex`, the runtime code deployed on Robinhood Chain; the codehash is checked), so the web app's reads batch into `aggregate3` calls as they do on Robinhood Chain. `env-from-deployment.mjs` writes `NEXT_PUBLIC_LOCAL_MULTICALL3=1` only when that code is present; without the flag (an older fork, a bare anvil) every read is its own `eth_call` — correct, just slow.

**Stocks.** The registry lists the full Robinhood lineup. Sixteen "liquid" tickers get a seeded USDG pool (mock price, whole supply in the pool) and keeper jobs; the rest are listed with no pool, so — like a thin real ticker — the router has no route and the app shows no price. They also have no keeper job or price feed, so the create picker does not offer them (they still show in the ticker tape). The seeded supplies are shaped like Robinhood Chain, where Stock Tokens are minted on demand (mainnet `totalSupply()` of 21 Sep 2026 ×10: NVDA ≈ 913k, SPY ≈ 319k … AVGO ≈ 5.7k), so the default pick and the stock picker's order until live prices arrive (and `/app/create/legacy`'s **Popular** row) — ranked by tokenised market cap, supply × price — order the same way locally as live. Edit `_seedSymbols()` in `DeployLocal.s.sol` to change either. The local `$DCA` (`MockDCA`, listed as "DCA") is a plan asset too: it has a pool (the mDCA/USDG pool the FeeReceiver buys back on), a mock price feed and keeper jobs on every vault. It is wired after every other contract, so a fresh stack keeps the addresses of older ones. A stack started before this change gets it with `pnpm dca:list` (`scripts/list-dca.sh`; a second run changes nothing).

**Test vault.** Besides Hourly / Daily / Weekly / Monthly, the local stack deploys a `TestVault` (`contracts/test/mocks/TestVault.sol` — same `PlanVault` code, `epochLength` = `TEST_EPOCH_MINUTES` minutes, default 2, origin aligned to a multiple of that length) with keeper jobs for every liquid stock and `$DCA`, and three deployer-owned plans (NVDA 100 / AAPL 50 / TSLA 25 USDG per epoch, 500k USDG each), so `pnpm scheduler` has an epoch to advance every couple of minutes. `TEST_EPOCH_MINUTES=5 pnpm fork` changes the cadence. Its address is `testVault` in `contracts/deployments/31337.json` (and `NEXT_PUBLIC_TEST_VAULT` in `apps/web/.env.local`); it is not in `VaultDirectory`. The web app shows it as a fourth **Test** frequency (tagged `dev`) in the frequency picker, My plans, Activity, the vaults table and the sidebar balances only when the dev server is started with the flag — `pnpm dev:test-vault`, or `NEXT_PUBLIC_SHOW_TEST_VAULT=1` / `SHOW_TEST_VAULT=1 pnpm dev` — and only on chain 31337; the marketing site always shows the four production vaults. The local stack therefore has five vaults, `keeper.jobCount()` is 85 (16 liquid stocks + `$DCA`, on each of the five vaults; 80 on a stack from before the `$DCA` listing until `pnpm dca:list` adds its five), and `31337.json` has an `hourly` key (no library addresses are recorded; redeploy an older local stack to get `closePlan`). Plans can also be added with `cast`:

```bash
cast send $USDG "approve(address,uint256)" $TEST_VAULT 1000000000 --rpc-url http://127.0.0.1:8545 --unlocked --from $TEST1
# createPlan(stock, amountPerEpoch, recipient, usdgAmount, wethAmount, minUsdgOut, boost)
cast send $TEST_VAULT "createPlan(address,uint96,address,uint256,uint256,uint256,bool)" $NVDA 10000000 0x0000000000000000000000000000000000000000 1000000000 0 0 true --rpc-url http://127.0.0.1:8545 --unlocked --from $TEST1
cast send $TEST_VAULT "setPlanBoost(uint256,bool)" $PLAN_ID false --rpc-url http://127.0.0.1:8545 --unlocked --from $TEST1   # unboost
```

Note that anvil evaluates `eth_call` at the **last mined block's** timestamp, so on an idle chain nothing ever looks due; the scheduler handles this by mining a block (0-value self-transfer) when a boundary has passed since the last block.

**Sharing the local stack (user testing).** `pnpm share` puts the web app on Vercel (`SITE_URL`, default `https://dcallocator.app`) while the chain stays on this machine: tester's browser and wallet → `SITE_URL/api/rpc` (`apps/web/src/app/api/rpc/route.ts`, a relay) → Cloudflare quick tunnel → `scripts/share-rpc-guard.mjs` on :8547 → anvil. The guard is the security boundary: it requires the per-run key the relay adds and allows only reads plus `eth_sendRawTransaction`, so nobody can use anvil's unlocked accounts or its `anvil_*` / `evm_*` methods. The quick tunnel's URL changes every run, so every run redeploys (`vercel deploy --prod` with the contract addresses from `31337.json` as build env; `.vercelignore` limits the upload to the workspace and `apps/web`). Needs `pnpm fork` (current version, for Multicall3: without it the landing page is ~220 requests through the tunnel instead of ~6) and `pnpm scheduler` running, `brew install cloudflared`, and the Vercel CLI logged in with the repo linked (`vercel link` at the repo root, code directory `apps/web`). Testers connect MetaMask and press "Switch network", which adds chain 31337 with the site's `/api/rpc`; fund their address with `pnpm fund <address>` (10 ETH, 10,000 USDG, 5 WETH, no `$DCA` so Claim is testable; `DCA=150000` for the holder perks). The shared build blocks only sanctioned countries (`NEXT_PUBLIC_BLOCKED_COUNTRIES=CU,IR,KP,SY`), and functions run in `lhr1` (`apps/web/vercel.json`), next to the machine running anvil.

**Mainnet fork (the production deploy against real liquidity).** `pnpm fork:mainnet` (`scripts/fork-mainnet.sh`) forks Robinhood Chain into anvil (chain id 31337 on :8545, like `pnpm fork` — run one or the other) and deploys with the production `script/Deploy.s.sol`, so the vaults, router and keeper run against the real USDG, WETH, Stock Tokens, Uniswap V3 pools, Chainlink feeds and the Morpho Blue USDG market (addresses in `contracts/config/fork.rh.json`). Which stocks are listed is decided live on every fork by `scripts/fork-mainnet-discover.py`: each Stock Token with a Chainlink feed on Robinhood Chain and a Uniswap V3 route from USDG (a USDG pool, else a WETH pool behind WETH/USDG) holding at least `FORK_MIN_POOL_USD` (10k) and priced within `FORK_MAX_DEVIATION_BPS` (200) of its feed; the list, the skipped tickers and why land in `contracts/deployments/31337-fork-discovery.json` (28 listed on 23 Sep 2026; the skips have empty V3 pools — their liquidity is elsewhere, e.g. Uniswap V4, which the fork does not route yet). Around the production script, `script/DeployFork.s.sol` adds what mainnet does not have: a mock `$DCA` with a real mDCA/USDG pool on the chain's own V3 factory (listed with `LIST_DCA` and no price floor — `DCA_PRICE_FEED=PriceGuardLib.UNGUARDED`, as production would; see SECURITY.md §2), and the 2-minute `TestVault` with the daily vault's jobs, feeds, guard, page caps and boost strategy, seeded with NVDA (boosted) / SPCX / TSLA deployer plans. Wallets are the same six anvil accounts; test1-3 get 100,000 real USDG (written into USDG's balance slot) and 10 WETH (wrapped); test1 also holds 150,000 `$DCA`, test2 / test3 none. `pnpm fund <address>` works on the fork too. The same web app, scheduler, `pnpm share` and MetaMask network apply. Limits: nothing else trades on a fork, so pool prices and Chainlink answers stay at the fork block — `FEED_MAX_STALENESS` defaults to 7 days here (25 h in production), and a restart picks up fresh prices. It needs an **archive** RPC in `RH_FORK_URL` or `contracts/.env.fork` (git-ignored), e.g. `RH_FORK_URL=https://robinhood-mainnet.g.alchemy.com/v2/<key>`: anvil loads mainnet state lazily at the fork block, and the public endpoint keeps only minutes of history, so a fork of it goes stale within ~15 minutes — anything not yet loaded (a new tester's balance, an approval, a stock nobody bought) then fails with "historical state … is not available". The script checks for this at startup and stops; `FORK_ALLOW_PRUNED=1` runs anyway for a quick check (throttled, since the public endpoint also rate-limits). `FORK_BLOCK=<n>` pins the block (needs an archive RPC such as Alchemy: the public endpoint only serves recent state); `PORT=8546 CHAIN_ID=31338 WRITE_APP_ENV=0 pnpm fork:mainnet` runs one beside a running stack without touching the apps' `.env.local`.

**Robinhood Chain:**

```bash
cp contracts/.env.example contracts/.env   # fill USDG, WETH, DCA, DEX factories, OWNER, FEE_RECIPIENT, KEEPERS, STOCKS, V3_POOLS, MORPHO + MORPHO_MARKET_ID (optional)
pnpm protocol:deploy
# → contracts/deployments/4663.json
# then, from the OWNER multisig: acceptOwnership() on registry, router, adapters, vaults, keeper, directory
```

`pnpm protocol:deploy` (`scripts/deploy.sh`) sources `contracts/.env`, confirms before broadcasting, then runs `forge script script/Deploy.s.sol --broadcast --verify`. The production script applies `contracts/config/fees.json`, wires the keeper to every vault, creates a job per approved stock, deploys `MorphoBlueStrategy` over `MORPHO_MARKET_ID` and sets it on the four vaults when `MORPHO` is set, and never deploys a mock `$DCA` (`DCA` empty ⇒ perks disabled; on 4663 you must set `ALLOW_NO_DCA=true` to confirm that). `BoostLib` and `PlanExitLib` (which itself links `BoostLib`) are linked libraries: `forge script` deploys and links them automatically (they are in the broadcast; pass both to `--libraries` when verifying by hand). The **hourly vault is deployed first**: its origin is aligned to the hour and the constructor reverts `BadOrigin` if the creation tx lands in a different wall-clock hour than the one the origin was computed in, so do not start a 4663 broadcast in the last minutes of an hour. `HOURLY_FEED_MAX_STALENESS` (default = `FEED_MAX_STALENESS`) sets the hourly vault's price-feed staleness: tighter means off-hours buys against a feed that stopped at the close are refused (`PriceFeedStale`, hour skipped) instead of filled at the last close inside the 3% band. `VaultDirectory.Entry` is now `{hourly, daily, weekly, monthly}` and `vaults()` returns `address[4]` in that order. The hourly tier's 90 bps equals the inclusive `FeeMath` cap and the vault is not upgradeable, so it can only ever be lowered.

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
- `/app` — sidebar shell (logo, **Create new plan** CTA, a **Buy $DCA** button, My plans, Activity; *Protocol*: Overview, DCA Token, Docs; *Vaults*: USDG waiting to buy per vault, boosted included), wallet button top-right, centred content column topped by a **stock ticker tape** (`components/app/StockTicker.tsx`: the registry's stocks by live market cap with price and 24 h change, scrolling at a constant px/s, paused on hover, static under reduced motion; `w-full`, so it fits whatever parent it is dropped into). Live market data comes from **`/api/stock-market`**, a route that proxies CoinGecko's "Robinhood Chain Stocks Ecosystem" category (one upstream call a minute, cached; optional `COINGECKO_API_KEY` demo key) — display only, nothing sent on chain depends on it. Pages:
  - **Overview** — total value locked (USDG on the vaults + USDG boosted on Morpho + stock on hand, all at router prices) with a composition bar, stock value bought with a sparkline built from `EpochPageExecuted` logs, and the vaults table (next buy, waiting to buy incl. boosted, boost APY, stock on hand, bought to date). Fees are deliberately not shown here.
  - **Create** — one centred swap card (Jupiter's DCA form), read top to bottom: **Fund with** (big amount, `USDG ▾ / ETH ▾` pill — ETH under Ethereum's blue mark — `≈ $` line, balance with HALF / MAX; ETH is zapped to USDG by `createPlan`) → arrow → **Buy**, `/app/create/2`'s stock row: the whole row opens the stock picker dialog (search, the five largest by on-chain market cap as pills, rows with ticker, name, price, 24 h change and market cap from `/api/stock-market`; until that answers, the order of `useRankedStocks`, from the CoinGecko market-cap snapshot in `src/data/market-caps.json`). `$DCA` is pinned first (with the router's price) and is the default pick where the frequency buys it, else the most popular; `/app/create?stock=<ticker|address>` preselects a stock, and the landing pages' stock links use it → **Every** (`hour / day / week / month`, plus `test` locally; an ⓘ notes that each buy runs shortly after its period starts (UTC)) beside **Per buy** (amount, "covers N buys") → the monthly estimate → the **Earn while you wait** switch (off by default) with the live Morpho APY — on, `createPlan` is sent with `boost = true` → one tall button (approve + create as one click) → first buy, fee and tolerances beneath. Under the card, the `$DCA` holder-perk notice headed **Hold $DCA for automatic distributions** (from the threshold, every buy is sent straight to the wallet and the buy fee is halved → Buy $DCA; once the wallet clears it, the same headline over a confirmation), then the small print. No vault or fee language in the form. Funding below the per-buy amount gets an amber warning (both variants): the vault spends `min(balance, amountPerEpoch)` each period, so the first buy takes the whole balance and the plan then buys nothing until it is topped up. Under the selected stock in the row, an **Add to MetaMask** button ("Add to wallet" for other wallets; `/app/create` only; EIP-747: registry ticker as the symbol, ≤ 11 chars, and the Robinhood Stock Token logo — `public/robinhood-stock-token.png`, the image Robinhood's asset registry publishes for every Stock Token — not the company logo; for `$DCA`, the token's own `symbol()` and `decimals()` with `/logo.png`), hidden when no wallet is connected or it is on the wrong chain. The form logic is `components/app/create/useCreatePlan.ts`; the page is assembled from `blocks.tsx`. A **Start a plan | Buy $DCA** strip above the card links between `/app/create`, `/app/create/2` and `/app/buy`.
  - **Create (variant B)** — `/app/create/2`, the same form in sentence order: **Spend** "$X ($) USDG every day ▾" centred, with the fill-timing ⓘ top right → **On**, one row that opens a stock picker dialog (search, the five largest by on-chain market cap as pills, rows with ticker, name, price, 24 h change and market cap from `/api/stock-market`) → **Fund plan** (USDG or ETH, and how many times the plan runs on it, a smaller last buy included) → boost → a one-line summary ("$100.00 of NVDA every day · 30 buys · $3,000.00 total · last ≈ 23 Oct") → button, then a `$DCA` holder-perk banner under the card (hold the threshold for stock sent straight to your wallet and halved fees → Buy $DCA; a confirmation instead once the wallet clears it). Same `useCreatePlan` (same default pick and `?stock=`), same transaction; default daily. A comparison URL only (no traffic split, no analytics); not linked from the sidebar.
  - **Buy $DCA** — `/app/buy`. When the router quotes USDG → `$DCA`, an in-app swap over `AggregatorRouter.swap` (quote of the real amount, minOut = quote − 0.5%, Approve USDG → Buy). When it cannot and `NEXT_PUBLIC_BUY_DCA_URL` is an https URL, a **Buy on Pons** hand-off; otherwise "No $DCA/USDG route on this chain yet." USDG only (ETH → `$DCA` is not routable). The tab lights on 31337, with `NEXT_PUBLIC_ENABLE_BUY_TAB=1`, or when the router quotes 1 USDG → `$DCA` — an ETH-paired Pons / Uniswap v4 pool will not light it without the flag or a WETH-side route. Both variables are in `apps/web/.env.local.example`; `pnpm --filter @dca/web env:local` writes them as commented lines.
  - **Create (legacy)** — `/app/create/legacy`, the previous layout kept for comparison: four numbered steps on the `$PIE` create-flow grid (42px step heads, 14px bodies, lime badge once a step is satisfied) with a sticky summary, checklist and the same boost switch and button. Not linked from the sidebar.
  - **My plans** — one table with inline **Deposit** (USDG or ETH), **Withdraw**, **Claim**, **Boost** / **Unboost**, **Add to wallet**, and a `⋯` menu with Pause/Resume and **Withdraw & remove plan**. Balance = vault-held USDG + boosted balance; boosted rows show lifetime boost earnings (`ClaimHelper` fields). Withdraw covers the boosted balance (the vault's `type(uint256).max` sentinel is used for "all"). Prices are quoted only for the stocks the user holds.
    - *Feedback.* Only the clicked button spins (Pause shows a spinner as the row's menu trigger); sibling buttons stay disabled while one write is in flight. Outcomes arrive as bottom-right toasts ("Boosted", "Plan paused", "Claimed NVDA", "Withdrew $50", "Deposited $100", "Plan removed") with an explorer link; a wallet rejection reads "You rejected this in your wallet." A slow receipt is never reported as a failure: multi-step flows (create, deposit, remove) keep the step "on the network" after 180 s and offer only **Keep waiting** (same hash, nothing resent); a single row action releases the row after 180 s with "Still pending — check your wallet or the explorer.", and the 15 s positions poll reconciles it when the tx lands. Before a step that follows one of the account's own mined transactions (approve → create, the remove legs), `useTxSequence` waits up to 25 s until the wallet's own view of the chain includes that transaction (`src/lib/walletSync.ts`; "Waiting for your wallet to catch up with the last step…" when it is slow), so MetaMask does not sign the new step with the previous nonce. A nonce conflict reported by the wallet is never re-prompted automatically. For "nonce too low" / "replacement transaction underpriced", if the node's pending nonce for the account did not move since the prompt, the dialog says nothing was sent and offers **Try again**; if it moved or could not be read, and always for "already known" (the wallet says the transaction is already in the pool), it says the transaction may have gone through and points to the wallet's activity, with no **Try again**.
    - *Withdraw & remove plan.* When the vault has `closePlan(planId)` and a simulation passes, this is **one transaction**: unboost → all idle USDG to the signer (withdraw fee) → all accrued stock to the plan's recipient (claim fee, 0 with the `$DCA` perk) → unindex, emitting `PlanClosed(planId, owner, usdgOut, stockOut, unindexed)`. It works while paused and after delisting; empty or already pruned plans close idempotently. If the vault predates `closePlan` or the close would revert (Morpho short of liquidity, a token refusing the fee recipient), the app says why and falls back to the single legs `setPlanBoost(false) → withdrawIdle → claim → prunePlan`, built from a fresh `getPlan` + `isEpochPending` read; **Try again** resumes from the failed step and never resends a mined step. The user can also run the single steps by hand.
    - *Mid-epoch.* While a buy page is open for the stock, `closePlan` pays everything out but **parks** the empty plan (paused, still indexed, `unindexed = false`; only for a plan that was still indexed — a pruned/closed one reports `true` and is never parked). The app hides it at once and offers **Finish delete** / "Delete later" (one more `prunePlan` or `closePlan`) after the epoch; leaving it parked is harmless (never filled). The record always persists: a later deposit re-indexes it as a plain plan (it stays paused until the owner unpauses) and it reappears.
    - *Hiding.* A plan is hidden when it holds nothing AND the last of its `PlanIndexed` / `PlanClosed` / `Deposited` logs in the `LOG_LOOKBACK` window says it is closed or unindexed; a `Deposited` log brings it back; a plan with any USDG or stock is always listed. Every write pads the gas estimate (×1.25 + 100k): a Morpho-touching call estimated right after an accrual is cheaper than its real execution a block later.
  - **Activity** — "My buys" (`PlanFilled`, plus the user's own `PlanTooLarge` as "Sat out, above the page cap") and "All buys" (`EpochPageExecuted`, plus `BoostWithdrawFailed` as "Boosted plans sat this buy out") with frequency filters. `EpochPageSkipped` no longer exists (retry-not-skip): a page that cannot be bought shows up in the scheduler as a failed simulation, not as an event.
  - **DCA Token** — price / market cap (router quote × `totalSupply`; "—" without a `$DCA`/USDG route), protocol volume, USDG fees accrued from logs, holder perks with the connected wallet's status, live fee schedule. The tokenomics allocation block is a placeholder.
  - **Docs** — placeholder documentation (fee table with an Hourly column, hourly cadence and risk lines) (`#dca` is the target of the "Find out more" links; `#boost` explains Boost and its risks).
- Visual system: the `$PIE` dark register (Inter, lime `#ccff00`, 12/10/8/6px radii). One ladder of warm greys with a step of contrast per layer — `surface-0` `#0c0c0b` frame (sidebar, key stat tile) → `surface-1` `#121211` canvas → `surface-2` `#1a1a18` cards/tables → `surface-3` `#232220` inputs, hover rows, tiles → `surface-4` `#2f2e2a` fills. Tokens and utilities (`card`, `stat-strip`, `tile`, `step-*` / `amount-box` / `quick` / `note` / `check-item` for the create flow, `tbl` + `sort-btn`, `toolbar`, `btn-*`, `chip-*`, `chip-dev`, `range`, `menu`) live in `src/app/globals.css`; primitives in `src/components/ui.tsx` (`PageHeader`, `Card`, `StatCard`, `SearchInput`, `SortTh`, `Slider`, `AmountInput`, `Segmented`, `Modal`, `Menu`, `Sparkline`, `StockAvatar`).
- Stock logos: `public/tickers/<TICKER>.svg` (shared with `$PIE`) via `StockAvatar`; a missing file falls back to the ticker's letters on a lime disc. Company names for search come from `src/lib/tickers.ts`.
- Everything is discovered from `VaultDirectory` (`NEXT_PUBLIC_DIRECTORY`); `ClaimHelper` powers the plan list; `EpochKeeper` (`NEXT_PUBLIC_KEEPER`) decides what is buyable: `useBuyable` keeps a (vault, stock) pair when it has an active job and, where the vault requires one, a price feed, so the create picker only offers stocks that frequency will actually buy and My plans flags plans it never will (unset = no filtering); prices come from `AggregatorRouter.quote` for one whole token (`usePrices`). The boost APY (`useBoostApys`) is Morpho's own number: the blue-sdk's `Market.getSupplyApy` over `morpho.market(id)` + `irm.rateAtTarget(id)` at the latest block's timestamp, with `MorphoBlueStrategy.supplyRatePerSecond()` as the fallback for non-AdaptiveCurve IRMs (see [Boost](#boost)); product copy for the feature (names of the Boost / Unboost actions, the card title, the tooltip) is `BOOST` in `src/lib/config.ts`.
- **Reads and caching.** Contract reads issued in the same tick are batched by viem into Multicall3 `aggregate3` calls (`batch.multicall` in `src/lib/wagmi.ts`, up to 8 KiB of calldata each). That needs the chain to declare Multicall3: Robinhood Chain does (viem's `robinhood` chain, whose RPC URL `NEXT_PUBLIC_RH_RPC` overrides); the local chain only with `NEXT_PUBLIC_LOCAL_MULTICALL3=1` (see **Multicall3** under the local stack), otherwise every read is its own `eth_call`. The stock list (`useStocks`) is also kept in localStorage for up to 24 h, so a full reload renders it without waiting for the RPC and refreshes it in the background.
- **Local dev wallet:** there is no built-in test wallet or mock connector; `src/lib/wagmi.ts` registers only real browser wallets (EIP-6963 discovery plus the generic injected fallback), and the connect menu lists nothing else. Import an anvil account into MetaMask (`test1`, funded by `pnpm fork`) and add a network with RPC `http://127.0.0.1:8545` (or `:8555` through the latency proxy), chain id 31337 — see **Wallet** under the local stack, including the MetaMask reset after every fresh fork.
- **Slow and failing transactions:** anvil mines each tx the moment it arrives, so the in-flight states of the UI flash by. `pnpm latency` starts `scripts/rpc-latency.mjs`, an RPC proxy on :8555 in front of anvil that behaves like a real network: every call takes 150±100 ms, each `eth_sendTransaction` is held 3 s like a wallet prompt (`sign`), and anvil mines a block every 2 s (preset `realistic`; also `off`, `slow`, `chaos`). It also injects failures, each as a share from 0 to 1: `reject` (answered "User rejected the request."), `revert` (the tx goes out with a gas limit that runs out, so it is mined and reverts), `drop` (the tx is evicted from the mempool and never mined). `sign`, `reject` and `revert` only act on `eth_sendTransaction` senders, i.e. accounts anvil signs for (`cast send --unlocked --rpc-url http://127.0.0.1:8555`). A browser wallet signs by itself and sends a raw tx over its own network RPC, so only `latency`, `blockTime` and `drop` reach it — and `latency` / `drop` only if that RPC is the proxy (`http://127.0.0.1:8555` in MetaMask); delay or reject in the wallet yourself. Run the app through it with `pnpm dev:latency` (http://localhost:3004, own `.next-latency` build dir) and change the settings live: `curl 'localhost:8555/__latency?preset=slow'`, `curl 'localhost:8555/__latency?reject=1'`, or `curl 'localhost:8555/__latency?blockTime=manual'` to hold every tx pending until `curl localhost:8555/__latency/mine`. The proxy's console prints each tx's timeline (in the wallet, sent, mined / reverted / dropped, seconds after send). `blockTime` switches anvil's own mining mode, so every client of the node sees it; the proxy puts anvil back on automine when it exits.
- **Test vault (dev flag):** `pnpm dev:test-vault` (= `NEXT_PUBLIC_SHOW_TEST_VAULT=1 next dev`; `SHOW_TEST_VAULT=1 pnpm dev` also works via `next.config.ts`) adds the local 2-minute `TestVault` as a fourth frequency, tagged `dev`. `VAULT_KINDS` in `src/lib/config.ts` becomes `[hourly, daily, weekly, monthly, test]`, `useDirectory()` merges `NEXT_PUBLIC_TEST_VAULT` into the vault map, and every app page follows; the marketing components use `PRODUCTION_VAULT_KINDS` and never show it. Requires chain 31337 — the flag is ignored elsewhere. To run a flagged and an unflagged dev server side by side from one checkout, give the second one its own build dir: `NEXT_DIST_DIR=.next-test-vault pnpm dev:test-vault --port 3001`.
- **Developer notes.** `describeTxError` (`src/lib/txErrors.ts`) is the single place that turns viem errors into copy — detect rejections with it (it walks the cause chain), never via `error.name`. `useToast()` (`src/components/Toast.tsx`; `ToastProvider` is in `Providers`) is available app-wide. `Modal` takes `closable={false}` to hold a dialog open during a write; `useTx.write(params, { key, success })` labels the action for spinners and toasts.
- **ABI sync.** After `cd contracts && forge build`, `pnpm abi:check` compares `apps/*/src/abi/*.ts` with `contracts/out` and exits 1 on drift (`ERC20.ts` is hand-written and skipped). Regenerate with `pnpm --filter @dca/web abi && pnpm --filter @dca/scheduler abi`.
- Geo-block: `src/middleware.ts` redirects `/app/*` to `/restricted` for `NEXT_PUBLIC_BLOCKED_COUNTRIES` (default US, GB, CA, AU, CU, IR, KP, SY) using the CDN country header (`x-vercel-ip-country` / `cf-ipcountry`). A first-visit disclaimer gate covers the rest. Contracts stay permissionless.

---

## Risks

Read [SECURITY.md](SECURITY.md) for the threat model. Headlines:

- **Router / liquidity.** Purchases execute against on-chain pools. Thin liquidity → impact cap trips → the page reverts and is retried within the epoch; if it never fills, that epoch is skipped (nobody charged). A broken router skips epochs until the owner points vaults at a new one (`setRouter`) or approves other hops.
- **MEV on the epoch swap (open, see SECURITY.md §2).** Triggering is operator-only, but an operator's transaction can still be sandwiched at the block level. Operators should submit through a private relay and pass a reference-price `minOut` override.
- **Hourly buys run 24/7.** Hourly plans also buy while stock markets are closed. With the default 25 h feed staleness, off-hours buys use the last close as the price reference, and hours more than 25 h past the last update (long weekends) are skipped with `PriceFeedStale`.
- **Keeper liveness.** No operator, no purchases (there is no permissionless fallback). Missed epochs are skipped, not caught up.
- **`$DCA` flash-buy.** Perks read spot balances at execution; someone can buy right before an epoch. Accepted for V1; a checkpointed snapshot is the V2 fix.
- **ETH deposits.** ETH/WETH is converted to USDG at deposit with the depositor's `minUsdgOut`; the ETH/USDG price risk is taken at deposit time, never at epoch.
- **Boost (Morpho Blue).** Boosted USDG is a lending position: a fully utilised market delays boosted withdrawals and spends until liquidity returns (unboosted plans are unaffected), and bad debt on the market is shared by its suppliers. The strategy contract and the market choice are owner decisions. See SECURITY.md §11.
- **Stock Token depeg.** The token can trade away from the underlying's NYSE/Nasdaq price; the vault buys at the on-chain price.
- **Admin.** Owner can pause, change fees (≤ 0.90%), thresholds, minimums, router, approved routes, keepers and operators. Use a multisig; ownership is 2-step.

## Geo / legal

Robinhood Stock Tokens are not offered to US persons. This interface is unavailable in the United States, United Kingdom, Canada, Australia and sanctioned regions. Stock Tokens provide economic exposure to the underlying, not shareholder rights — users never own NYSE/Nasdaq shares. DCA is independent software, not affiliated with or endorsed by Robinhood, and nothing here is investment advice.
