# SECURITY.md — DCA threat model (V1, after the automated AI reviews in AUDIT.md; no third-party audit yet)

Scope: `contracts/src/` contracts as deployed by `contracts/script/Deploy.s.sol` on Robinhood Chain (4663). This document lists what can go wrong, what the code does about it, and what it deliberately does not. The v0.1 audit and the v0.2 re-audit are in [`AUDIT.md`](AUDIT.md); the regression suite for every finding is `contracts/test/audit/`.

## Trust assumptions

| Party | Trusted to | Can NOT |
|---|---|---|
| **Owner** (multisig, `Ownable2Step`) | pause; set fees ≤ 90 bps; set `$DCA` thresholds and minimums; set router / fee recipient / keepers / operators / `keeperOnly`; **approve and revoke router hops**; list stocks; rescue foreign tokens | take user idle USDG or accrued stock; set any fee above 0.90%; rescue USDG, WETH or any ever-listed stock; upgrade code (no proxies) |
| **feeManager** | set fees within caps; force a dust sweep | anything else |
| **Keepers / operators** | trigger epochs (they are the only ones who can); pick page size and timing; pass a route override that selects among **approved** hops with a `minOut` **no lower than the auto-route's floor** | move funds anywhere but into the vault's own stock purchase; fill worse than the auto-router would; route through an unapproved pool; skip fees; change accounting |
| **FeeReceiver operators** | choose when and how much of the fee balance to split (70 / 30), convert (stock reserve → USDG / WETH reserve) or buy back (reserve → `$DCA`, burned) | send anything anywhere but the treasury, a reserve or a burn; sell `$DCA`; churn base reserves; go under the quote floor or past the on-path TWAP guard; touch user funds (fees have already left the vaults) |
| **Router + adapters** (owner-set) | execute swaps honestly over the approved hop list | hold funds between txs (they don't); receive approvals from vaults beyond the router itself; trade a pool the owner did not approve |
| **Stock Tokens, USDG, WETH** | standard ERC-20 semantics (no fee-on-transfer, no reentrant hooks) | — the registry flags fee-on-transfer and vaults refuse them; `_tryTransfer` tolerates blocklists |
| **DEX pools** | owner-approved (and, for V3, factory-verified or explicitly registered) | forge callbacks (callback authenticates `msg.sender == verified pool`) |

Anyone else is untrusted.

## Invariants (enforced by tests in `test/invariant/` and `test/audit/`)

1. `stock.balanceOf(vault) == totalStockAccrued[stock] + dustPot[stock]` for every stock.
2. `usdg.balanceOf(vault) == totalUsdgIdle + usdgDust` and `weth.balanceOf(vault) == wethDust` (fees leave immediately; every unit is accounted; the vault never holds user WETH).
3. Aggregates equal the sum over plans; `userStockAccrued` equals the per-user sum.
4. No plan is filled twice in one epoch; `lastExecutedEpoch ≤ currentEpochId`.
5. Every fee ≤ 90 bps (constructor + `setFees` validate).
6. `usdgDust < dustSweepMinUsdg` and `wethDust == 0` outside `advanceEpoch` (dust is swept at the threshold).
7. A plan in the stock index has, or has had, ≥ `minDeposit` USDG; `amountPerEpoch ≥ minAmountPerEpoch`.

## Threats

### 1. Router failure / bad quotes

**Risk.** The auto-router returns a bad path (thin pool, adapter bug) or reverts.

**Mitigations.**
- **Allowlist.** The router quotes and executes only owner-approved hops. Unknown factory pools, unregistered V4 keys and hand-built paths are refused (`RouteNotApproved`), for every caller including keepers.
- Impact cap vs pool mid-price (`maxPriceImpactBps`, 150) on every candidate; direct and two-hop (via WETH) candidates; adapters that revert on quote are skipped (`try/catch`).
- `minOut = quote × (1 − swapSlippageBps)`; the vault measures real balance deltas, reverts on zero output (`SwapReturnedZero`) or over-spend (`Overspent`), and returns unspent USDG pro-rata (remainder → `usdgDust`).
- **Skip, never revert.** If the page's quote fails, is dust, or the swap reverts, the page is skipped (`EpochPageSkipped`): nobody is charged, the cursor advances, the epoch completes. No plan state, pool state or token amount can revert an epoch for other users.
- **Route override** (operators): may pick a different approved path or a tighter `minOut`; may not go below the auto floor. Override failures revert so the page is retried, not lost.
- `setRouter` swaps the router atomically and revokes approvals to the old one.
- A failing stock never blocks other stocks (`EpochKeeper` isolates jobs with `try/catch`).

**Residual.** Nobody can be forced to provide liquidity. If no approved route within the cap exists, the epoch simply does not fill and users keep their idle balance.

### 2. Sandwiching / MEV on epoch swaps — OPEN (accepted for now)

**Risk.** Epoch swaps are large, predictable (00:00 UTC) and their price references (quote, `minOut`, impact-vs-`slot0`) are all read inside the executing transaction. Whoever can place transactions around the operator's call can push the pool before it and unwind after it.

**What is closed.** The *unprivileged, atomic* variant found in the v0.1 audit (anyone calling `advanceEpoch` / `runDue` inside their own sandwich) is closed: `keeperOnly` is on by default and every `EpochKeeper` execution entry point is operator-only.

**What remains.** A block builder, or anyone who can land a transaction before and after the operator's in the same block, can still sandwich it. `test/audit/Audit.H02.Sandwich.t.sol::test_KNOWN_RESIDUAL_*` keeps the loss visible: with a $1M pool and a $600k push, a $10k epoch loses ~55%.

**Operational mitigations (do these).**
1. Submit operator transactions through a private relay / builder with no public mempool exposure.
2. Pass a **reference-price `minOut` override** on every run: compute the expected stock amount from an off-chain reference (Robinhood quote, or `TwapOracle.consultTick` over ≥ 30 min on the reference pool), apply a tolerance (e.g. 1–3%), and call `EpochKeeper.run(job, 0, abi.encode(path, minOut))`. Under manipulation the fill reverts and the operator retries (`test_mitigation_referenceMinOutOverrideRevertsUnderManipulation`).
3. Randomise the execution time within the epoch instead of firing exactly at the boundary.

**Contract-level options for V2 (recommended, in order of effort).**
1. *On-chain TWAP guard* in `_buyStock`: owner-designated reference pool per stock; require `bought ≥ expectedFromTwap(totalNet) × (1 − maxDeviationBps)`; skip the page otherwise. ~40 lines using the existing `TwapOracle`; removes the dependency on operator discipline.
2. *Commit / execute*: record `minOut` from a quote in one transaction and execute in a later block, so no single block can set both the reference and the fill.
3. *Oracle floor*: if a Chainlink / Pyth stock feed exists on Robinhood Chain, use it as the reference instead of a pool TWAP.
4. *Order splitting*: several smaller randomised sub-buys per epoch raise the attacker's cost per unit extracted.

**$DCA is bought without the price floor (deliberate).** Robinhood Chain has no Chainlink feed for `$DCA`, so when it is listed as a plan asset (`LIST_DCA`) its feed is set to `PriceGuardLib.UNGUARDED` (`0xFFfF…FFfF`) instead: `PriceGuardLib.check` skips the floor for it, while every other stock stays floored and `requireFeed` stays on. (A feed pinned to a fixed price is not an alternative: it refuses every page once the pool moves ~2.2%, i.e. 3% less the LP fee and `swapSlippageBps`.) What defends `$DCA` against a sandwich is its trading tax. An attacker pays it on both legs, so with a per-leg cost `t` (tax + LP fee) a sandwich only pays when the page is larger than about `t` × the pool's USDG depth; the router's `maxPriceImpactBps` keeps a page's own move below twice that fraction, so the attack loses money as long as `maxPriceImpactBps ≤ 2t` (1.5% cap ⇒ `t` ≥ 0.75%). The router quote, `swapSlippageBps`, the impact cap and the page cap still apply. **Revisit this if** `$DCA` can be routed through any pool that does not charge the tax, if the tax drops below half the impact cap, or if a Chainlink `$DCA` feed appears (then set it). Tests: `test/unit/PlanVault.PriceGuardUnguarded.t.sol`.

### 3. Epoch griefing

| Vector | Handling |
|---|---|
| Unbounded loop over plans | `maxPlansPerTx` (≤ 1000, default 150) + cursor pagination. |
| Reordering the plan index mid-epoch (swap-remove) | `prunePlan` (now `nonReentrant`) reverts while the stock's epoch is pending. Plans appended mid-epoch are simply processed. |
| Filling the index with empty plans to burn keeper gas | Only plans that credited ≥ `minDeposit` (10 USDG) are ever indexed; re-indexing a pruned plan needs another ≥ 10 USDG deposit; each empty-and-refill cycle pays the 25 bps withdraw fee. Emptied plans cost the keeper ~9k gas each until anyone prunes them between epochs. |
| A plan that makes the page's purchase unquotable / dust | The page reverts and the keeper retries it within the epoch (retry-not-skip; no `EpochPageSkipped` event any more); a plan above the page's notional cap sits that page out (`PlanTooLarge`); if the page never fills, that epoch is missed for the stock, nobody is charged. `minAmountPerEpoch` bounds only the per-buy setting: an indexed plan can drain to any balance (partial buys, withdrawals), and that balance is bought as is on its next buy. |
| A recipient that reverts on stock transfer (blocklisted) | `_tryTransfer` never reverts the page; the share accrues instead. |
| A stock token that reverts on transfer to the vault (delisted at the token level) | The swap reverts → the page reverts (retried, then the epoch is missed); owner delists in the registry so it is no longer `isEpochDue`. Users withdraw idle. |
| Keeper never finishes a multi-page epoch | Remaining plans miss that epoch; the next epoch starts from index 0. No double charging (`plan.lastEpochId` guard). |
| Re-entrancy via tokens or router | `nonReentrant` on every state-changing entry (incl. `prunePlan` and `closePlan`); checks-effects-interactions; `SafeERC20`; adapters are `onlyRouter`. `PlanExitLib` (linked library for `withdrawIdle`, `claim`, `prunePlan`, `closePlan`) returns the `totalUsdgIdle` delta, applied by the vault after the delegatecall — sound only under the guard: every `PlanExitLib` entry point is reachable only via a `nonReentrant` vault function and a direct CALL to the library reverts (`test/audit/v0.4` Reentrancy PoC, which also pins the four dispatched selectors). The unguarded owner setters (`setPlanPaused` / `setPlanAmount` / `setPlanRecipient`) never read `totalUsdgIdle`. |
| `closePlan` against a blocked fee recipient | `closePlan` (`nonReentrant onlyPlanOwner`, atomic) reverts as a whole if the USDG or stock token refuses `feeRecipient` (accepted L-06, amplified); the single legs stay as the fallback. Runbook: allowlist `FeeReceiver` on USDG and every stock (AUDIT-FeeReceiver R-05). Mid-epoch it pays out but keeps the plan indexed and paused (`PlanClosed(..., false)`), so the swap-remove guard above is never bypassed; a parked plan costs one storage read per page until pruned. |
| Hourly vault cadence | Buys every hour, 24/7, including when stock markets are closed; off-hours the Chainlink floor reads the last close, and updates older than the feed staleness (default 25 h, `HOURLY_FEED_MAX_STALENESS`) skip the hour with `PriceFeedStale`. Its 90 bps purchase fee is exactly the `FeeMath` cap and the vault is not upgradeable, so the tier can only be lowered. |
| Unbounded `keeperTipBps` | ≤ 10% of purchase fees (`MAX_KEEPER_TIP_BPS` in `VaultAdminLib`), never from user principal. |

### 4. `$DCA` flash-buy

**Risk.** Perks read `dca.balanceOf(owner)` at execution and at claim. A user can buy ≥ 100k `$DCA` (the deploy threshold for both perks) right before the epoch (halved fee, auto-send) and sell right after.

**Handling.** Accepted for V1 and documented in the app. Since epochs are operator-only the flash-buy can no longer be made atomic with the epoch by the user. The economic damage is bounded to the fee discount / claim fee waiver on one epoch's spend. V2 option: checkpointed balances (`ERC20Votes`-style `getPastVotes`) with a lookback, or a staking snapshot. With `dca == address(0)` there are no perks regardless of thresholds; thresholds cannot be zeroed.

### 5. Rounding

- Fees round **down** (user-favourable). Halving floors (75 → 37 bps).
- Pro-rata stock distribution floors; the remainder (< number of plans, in wei) goes to `dustPot[stock]` and is folded into the next distribution — never to the treasury, never lost.
- Unspent USDG (partial fill) is returned pro-rata; the remainder that cannot be split exactly is booked in `usdgDust` and forwarded to `feeRecipient` once it reaches `dustSweepMinUsdg` (1 USDG). WETH forwarded back by a partially filled second hop is booked in `wethDust` and forwarded immediately. Nothing is ever unaccounted (invariant 2 is strict).
- ETH/WETH deposits credit exactly what the swap produced; unfilled WETH goes back to the depositor.
- **Known / pinned:** the purchase fee and keeper tip are computed on `spend`, not on the USDG actually consumed; on a partial fill the returned USDG is charged again next epoch (`Audit.L02`). Not a safety issue; revisit with revenue in mind.
- `mulDiv` (512-bit) everywhere prices/amounts are multiplied; `SafeCast` on every narrowing.

### 6. Stock Token depeg vs the underlying

The vault buys the **on-chain** Stock Token at the **on-chain** price. If the token trades above/below the NYSE/Nasdaq price (thin liquidity, issuer halts, market closed while crypto trades), users buy at that price. Nothing in the protocol references the off-chain price. Mitigations are operational: only approve pools with real depth; operators can hold a stock (`setJobActive(false)`), pass a reference-price `minOut`, or the owner can revoke its hops / delist during a dislocation. Users can pause their plans at any time.

### 7. Permissioned Stock Tokens

Robinhood Stock Tokens may enforce allowlists / blocklists at the token level. Consequences:
- Transfer *to* the vault blocked → the swap reverts → the page is skipped (nobody charged).
- Transfer *from* the vault to a user blocked → auto-distribute falls back to accrual; `claim` reverts for that user until they are allowed (funds stay accounted on the vault).
- Vault address itself blocked → epochs for that token skip; users withdraw idle USDG.
- **Accepted (`Audit.L06`):** `claim` pushes the claim fee to `feeRecipient` first; if the treasury is blocked by a stock token, claims of that stock revert until the owner zeroes `claimFeeBps` or moves `feeRecipient`. Make sure the treasury is allowlisted on every listed token.

### 8. Admin key compromise

Owner cannot steal user funds directly (no sweep of USDG/WETH/stocks, fees ≤ 0.90%). An attacker with the owner key could: approve a malicious pool and point `router` / hops at it (steals up to one epoch's `totalNet` per stock per epoch — balance-delta checks make a zero-output router revert, but a pool returning 1 wei of stock would pass), set `feeRecipient`, pause, raise minimums. Use a multisig + timelock; monitor `RouterSet`, `HopApproved`, `HopRevoked`, `FeeConfigSet`, `KeeperSet`, `OperatorSet`, `FeeRecipientSet`, `MinimumsSet`.

### 9. Denial via `pause` / operator outage

Pause blocks new plans, deposits and epochs; **claims and idle withdrawals are never pausable**, so users can always exit. There is deliberately no permissionless fallback for epochs: if every operator is down, epochs are missed (never caught up) until an operator returns. Run at least two independent operators (a bot plus Chainlink Automation).

### 11. Boost — Morpho Blue lending of idle USDG (new, unaudited)

Boosted plans' idle USDG sits in `boostStrategy` (`MorphoBlueStrategy`, an ERC-4626 over one Morpho Blue market) as a supply position. New surface:

- **Liquidity.** A fully borrowed market cannot pay withdrawals. `withdrawIdle` / `setPlanBoost(false)` on a boosted plan then revert (`ERC4626ExceededMaxWithdraw`) until borrowers repay or new suppliers arrive; plain plans are unaffected. At epoch time the vault pulls the page's boosted spend in one `try` — on failure the boosted fills are dropped (`BoostWithdrawFailed`, plans not charged, not marked filled) and the page still executes for everyone else. **An illiquid market can never brick an epoch.** Tested: `test_fill_illiquidMarket_*`, invariant handler `liquidity(drain)`.
- **Bad debt.** Morpho socialises realised bad debt across suppliers: `boostAssets()` drops, every boosted plan's balance falls pro rata, `boostEarned` never decreases and losses show as `boosted < boostPrincipal`. The protocol does not backstop this. Tested: `test_badDebt_*`, handler `loss()`.
- **Strategy / market choice (admin).** `setBoostStrategy` is owner-only, 2-step ownership; the asset must be USDG; migrations move the whole position atomically; clearing with positions open is impossible (`BoostInUse`). A malicious or broken strategy is the same trust class as a malicious router: the owner can point vaults at it. The Morpho market (collateral, oracle, IRM, LLTV) is chosen at deploy (`MORPHO_MARKET_ID`) — pick a blue-chip, curated market; its parameters are immutable on Morpho.
- **Accounting.** Vault-internal shares with a virtual (1, 1) offset; withdrawals burn shares rounded up against the plan; `sum(plan.boostShares) == totalBoostShares`, `!boosted ⇒ boostShares == 0`, `usdg.balanceOf(vault) == totalUsdgIdle + usdgDust` (boosted funds never sit on the vault), `usdg.balanceOf(strategy) == 0` (the strategy never holds loan tokens between transactions) — all in `VaultInvariants` at CI depth. Rounding dust (≤ 1 wei per full drain) stays in the strategy in favour of remaining holders.
- **Reentrancy / delegatecall.** Every boost entry point is `nonReentrant`; `BoostLib` is a linked library (immutable address baked into the vault bytecode) executed by `delegatecall` on the vault's own storage — no upgradeability, no external storage.
- **Gas estimation.** Calls that touch the strategy accrue Morpho interest for the elapsed seconds; an estimate taken in a block where the market was just touched is cheaper than the real execution. The app pads every estimate (×1.25 + 100k); bots should do the same.
- **Not yet covered.** No fork test against a live Morpho Blue deployment yet (the mock reproduces Morpho's share maths and accrual; `test/fork/` is the place for it once Robinhood Chain has a market).

### 12. FeeReceiver — fee split and `$DCA` buyback (new, reviewed)

**What it holds.** Every vault fee, the moment it is taken. Nothing user-owned: a fee that reached the receiver has already been charged. The worst case for users is therefore unchanged by this contract; the assets at risk are the protocol's 70% (treasury) and 30% (buyback reserve).

**What protects the 30%.** The reserve can only leave through the owner-approved router into `$DCA` that is burned in the same transaction (a Stock Token reserve may first become a USDG / WETH reserve). No rescue, sweep or withdraw exists; the split is a pair of constants. Operators are gated (`onlyOperator`) and price-bounded twice: `minOut ≥ quote × (1 − maxSlippageBps)` (default 50 bps, cap 500) and, because that quote is taken in the same transaction and cannot see a sandwich (§2), an **on-path TWAP guard** — every V3 / Ramses pool on the quoted path must have its spot tick within `guardMaxTicks` (300 ≈ 3%) of its `guardWindow` (30 min) TWAP or the swap reverts. Hops with no oracle (Uniswap V4) are refused unless the owner opts in. Approvals are per call and reset; outputs are measured on the receiver's own balance. Invariants: `balance ≥ reserve` per token, treasury receives exactly Σ 70%, reserve ledger balances, bought `$DCA` never lingers — `test/invariant/FeeReceiverInvariants.t.sol` at CI depth with `fail_on_revert`.

**Residuals** (full list in [`audit/AUDIT-FeeReceiver.md`](audit/AUDIT-FeeReceiver.md) §4): the owner key can drain the reserve via `setRouter` / `setGuard(0)` (same trust as §8); holding a manipulated price for the whole TWAP window bounds a single buyback's loss at ≈ `guardMaxTicks + maxSlippageBps`, so keep buybacks small and pass a reference `minOut`; V4-only routes re-open the §2 residual; a token with no approved route keeps its reserve until a hop is approved; §7's allowlisting applies to the receiver (as claim-fee recipient) and the treasury (as `distribute` recipient); pools on the buyback route need observation cardinality for the window. Monitor `TreasurySet`, `RouterSet`, `OperatorSet`, `GuardSet`, `MaxSlippageSet`, and `PriceDeviates` / `UnguardedHop` reverts.

### 13. Out of scope / not protected

- Loss of value from the underlying stock or from USDG.
- Front-end compromise (the UI is not the protocol; contracts are permissionless and verifiable).
- Geo-blocking is an app-layer control only.
- Native-ETH V4 pools (adapter rejects them).
- Split routes / RFQ / off-chain solvers.

## Reporting

Open a private security advisory on the repository or email the maintainers. Please do not test on mainnet vaults with real user funds.
