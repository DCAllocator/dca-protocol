# DCA Protocol — Smart Contract Security Audit (v0.1)

> **Automated AI review, not an independent third-party audit.** This report was produced with an AI model (Claude) during development. It has not been reviewed by a professional audit firm and does not replace one.

| | |
|---|---|
| **Target** | `contracts/src/**` at tag `v0.1` (commit `20f3ad4`), solc 0.8.28, via-ir, OZ 5.1.0 |
| **Date** | 2026-09-20 |
| **Auditor** | Automated review by Claude (AI). Not an independent third-party audit. |
| **Method** | Manual line-by-line review of all 27 source files (2,942 LoC) against the README / SECURITY.md threat model; Slither 0.11.6; 26 new PoC / property tests (`contracts/test/audit/`) run against the **real** `AggregatorRouter` + `UniV3Adapter` with constant-price and constant-product pool mocks; existing suite re-run (fuzz 512, invariants 64×32); coverage. Source code was **not** modified. |
| **Result** | **2 High, 3 Medium, 6 Low, 15 Informational.** No issue lets an unprivileged party take *idle* balances or accrued stock. Both Highs attack the epoch purchase itself: one is a cheap, permanent per-stock DoS; the other lets anyone atomically sandwich every epoch swap. Neither is a one-line fix; both need a design decision before mainnet. |

**Severity = impact × likelihood.** Impact: High = loss/lock of user funds or core function; Medium = degraded function / bounded loss; Low = dust, griefing, or admin-recoverable. Likelihood: High = unprivileged + cheap; Medium = needs conditions or capital; Low = needs a privileged key. Critical = High×High with unbounded theft (none found).

## Findings summary

| ID | Title | Severity | PoC |
|---|---|---|---|
| H-01 | One dust zap-at-epoch plan permanently bricks every epoch page it sits on (unhandled `quoteWithImpact` revert) | **High** | `Audit.H01.ZapDustDoS` (4) |
| H-02 | Epoch buys use only in-tx spot references; permissionless `advanceEpoch` ⇒ atomic sandwich of every epoch | **High** | `Audit.H02.Sandwich` (4) |
| M-01 | WETH zap sizing / caps use page-wide aggregates ⇒ one plan griefs all zap-at-epoch plans, over-converts neighbours | Medium | `Audit.M01.ZapAggregateGriefing` (4) |
| M-02 | `routeOverride` with `minOut ≥ 1` lets a keeper/operator fill a page at any price (contradicts trust model) | Medium | `Audit.M02.RouteOverride` (3) |
| M-03 | `keeperOnly` is void: whitelisted `EpochKeeper` exposes permissionless `runDue/run/performUpkeep` | Medium | `Audit.M03.KeeperOnlyBypass` (3) |
| L-01 | `_creditZap` floors both legs: USDG dust stranded; on partial fills `totalWethIdle > balance` (last withdraw reverts). Shipped invariant test already fails | Low | `Audit.L01.CreditZapRounding` (2) |
| L-02 | Purchase fee + keeper tip charged on `spend`, not on USDG actually bought ⇒ double fee on partial fills | Low | `Audit.L02.PartialFillFee` (1) |
| L-03 | Page with sub-unit stock output reverts instead of skipping (low-decimal / very high-priced stocks) | Low | `Audit.L03.DustPageRevert` (1) |
| L-04 | Hop-2 partial-fill refund (WETH) is stranded on the vault, unaccounted and unrescuable | Low | `Audit.L04.HopRefundStranded` (1) |
| L-05 | Free empty plans are indexed; ~9.3k gas each per epoch; `prunePlan` blocked while pending; 1 unit re-indexes | Low | `Audit.L05.IndexSpamGas` (2) |
| L-06 | Push-style fee transfers make `claim`/`withdrawIdle` depend on `feeRecipient` being an allowed recipient | Low | `Audit.L06.FeeRecipientBlocksExit` (1) |
| I-01…I-15 | Informational / documentation / hygiene | Info | — |

Run: `cd contracts && forge test --match-path "test/audit/*" -vv`

---

## H-01 · Dust zap plan permanently bricks a stock's epochs

**Context** [PlanVault.sol:441-442](contracts/src/vault/PlanVault.sol#L441) (`_zapWeth`), [455](contracts/src/vault/PlanVault.sol#L455) (`_sizeZap`), [AggregatorRouter.sol:125](contracts/src/router/AggregatorRouter.sol#L125)

`_sizeZap` quotes the *whole* candidate WETH inside `_tryQuote` (try/catch), but `_zapWeth` then calls `_router.quoteWithImpact(weth, usdg, sumZap)` **unguarded**. `sumZap = Σ ceil(deficit·W/outAll)` — for a 1-unit deficit that is ~3.3e8 wei of WETH (worth 1e-6 USDG). Every real V3/V4 pool rounds that output to 0 (fee rounds up, output rounds down) ⇒ `_bestLeg` finds nothing ⇒ `NoRoute` ⇒ the entire `advanceEpoch` page reverts. The page never advances, so **every plan at or after the offending index never fills again**; `lastExecutedEpoch` never moves; `prunePlan` reverts (`PlanNotEmpty`, and `EpochInProgress` once page 0 ran); nobody but the plan owner can pause or withdraw it. The keeper burns gas emitting `JobFailed` forever.

Trigger: `createPlan(stock, 1, true, 0, 0, 0.001 ether, 0)` — ~$3, permissionless. Also hit **accidentally** by any honest zap-at-epoch user whose `usdgIdle` is one unit short of `amountPerEpoch` (PoC 2).

Admin escape hatches are all collateral: delist the stock, pause, or break the WETH→USDG route (then *every* zap-at-epoch plan is skipped, PoC 4).

**Recommendation**
1. Wrap the second quote in try/catch and treat failure like `_skipAllWeth` (skip the zap candidates, still spend their idle USDG).
2. Add a minimum zap size (e.g. skip a plan whose `wethToZap` is below a configurable `minZapWei`, or whose deficit is below `minSpend`).
3. Generally: the epoch loop must never revert because of one plan's state. Every per-plan external quote/transfer should degrade to "skip this plan" (see also L-03).
4. Consider an owner `forcePausePlan`/`forceUnindex` for empty-or-dust plans as a last-resort operational tool.

## H-02 · Every epoch swap can be atomically sandwiched by anyone

**Context** [PlanVault.sol:579-582](contracts/src/vault/PlanVault.sol#L579) (`_buyStock`), [361-363](contracts/src/vault/PlanVault.sol#L361), [UniV3Adapter.sol:269-278](contracts/src/router/adapters/UniV3Adapter.sol#L269) (`_midOut`), [AggregatorRouter.sol:93-95](contracts/src/router/AggregatorRouter.sol#L93)

All three price references the vault relies on are read **in the same transaction** as the swap: (i) `quote` → `minOut = quote × 0.995`; (ii) the router's 150 bps impact cap is measured against `slot0.sqrtPriceX96`, i.e. the *current* (already moved) pool price; (iii) `swapSlippageBps` therefore only guards against a change between two calls in one tx, which cannot happen. Nothing references a TWAP, oracle, or last-epoch price. `advanceEpoch` is permissionless by default, so the attacker does not need to win a mempool race or beat a private relay: in one tx they push the pool, call `advanceEpoch` (or `EpochKeeper.runDue()`), and unwind.

PoC (1M USDG / 2k NVDA pool, 10 plans × 1,000 USDG): a 600k push nets the attacker **$5,678** of the $10k epoch; users get 7.7 NVDA instead of 19.65. A 3M push (flash-loanable) leaves users 1.24 NVDA (−94%) and the attacker +$8,554. Loss is bounded only by pool depth vs. attacker capital. SECURITY.md §2 lists the *mempool* sandwich as residual and points keepers at private relays and `TwapOracle` — but those mitigations assume the keeper is the one submitting. `keeperOnly` does not help (M-03).

**Recommendation** (pick one, ideally two)
1. **On-chain price guard in `_buyStock`/`_executeZap`**: require the realised price to be within `X` bps of a TWAP (`TwapOracle.consultTick` over ≥30 min on the reference pool, or a Chainlink/Pyth stock feed on Robinhood Chain if available). Revert-to-skip rather than fill on deviation.
2. **Make triggering genuinely permissioned**: `keeperOnly = true` at deploy *and* gate `EpochKeeper.runDue/performUpkeep/run` behind `isOperator` (Chainlink Automation forwarder address is a fine operator). Keep permissionless fallback only after a grace period (e.g. `boundary + 6h`) so liveness does not depend on operators.
3. Compute `minOut` from a price captured in a *previous* block (commit at boundary, execute ≥ N blocks later), or from the TWAP rather than the spot quote.
4. Document that the impact cap is **not** a manipulation defence (it bounds slippage relative to whatever the spot price is).

## M-01 · Aggregate zap sizing and cap checks let one plan grief all zap-at-epoch plans

**Context** [PlanVault.sol:424-427](contracts/src/vault/PlanVault.sol#L424), [454-467](contracts/src/vault/PlanVault.sol#L454), [470-484](contracts/src/vault/PlanVault.sol#L470)

`ctx.wethCandidates` sums each candidate's **entire** `wethIdle` (not its deficit) and `_sizeZap` quotes that sum; `_applyZapCaps` compares every plan's cap with the impact of the **aggregate** zap. Consequences, all from a single plan with a 1-unit deficit (nothing is ever spent):
- (a) 50 WETH idle in a 1,000 WETH pool ⇒ sizing quote > 150 bps ⇒ `NoRoute` ⇒ *every* zap plan on the page is `PlanSkippedNoRoute`, every epoch, indefinitely (PoC 1).
- (b) A large deficit under the router cap still exceeds neighbours' 100 bps `maxWethSlippageBps` ⇒ all `PlanSkippedSlippage` (PoC 2).
- (c) Honest case: the sizing rate is the average over everyone's full balances, so a small plan next to a large one is over-zapped (PoC 3: +1.15 % WETH converted, ~3 USDG left idle against the user's intent).

**Recommendation** Size from deficits, not balances: quote `Σ deficit_i` converted at a *small* reference amount (or per-plan quotes when `n` is small), cap `toZap_i` to `deficit_i / rate + ε`; apply per-plan caps against the plan's own marginal impact, or fall back to "skip plans whose cap is tighter than the aggregate, then re-quote the survivors" so a tight cap never removes others. Bound the WETH a zap-at-epoch plan may hold relative to `amountPerEpoch` (e.g. ≤ N epochs' worth) or exclude excess from `wethCandidates`.

## M-02 · `routeOverride` is an unbounded price override for keepers/operators

**Context** [PlanVault.sol:574-576](contracts/src/vault/PlanVault.sol#L574), [EpochKeeper.sol:178-185](contracts/src/keeper/EpochKeeper.sol#L178), SECURITY.md "Trust assumptions"

The only check on an override is `minOut != 0`; the router's best-of-N and impact cap are bypassed. A keeper, an `isOperator` address, or the EpochKeeper owner can route a whole page through any factory pool (e.g. one they LP'd or just moved) and take essentially all of `totalNet` (PoC: fill at 100× worse price, 9,925 USDG into the bad pool). SECURITY.md says keepers "can NOT move funds anywhere but into the vault's own stock purchase" — the override makes them a fund-moving role. Keeper EOAs are hot keys by nature (bots), so this widens the compromise blast radius from "epochs stop" to "epochs are drained".

**Recommendation** Bound overrides: require `minOut ≥ autoQuote × (1 − maxOverrideSlippageBps)` where `autoQuote` is the router's own quote (or the TWAP from H-02) and `maxOverrideSlippageBps` is owner-set (e.g. ≤ 300); keep the override useful (custom path) while removing the price freedom. Alternatively restrict overrides to `owner` only and let keepers pass only `limit`.

## M-03 · `keeperOnly` provides no protection while `EpochKeeper` is whitelisted

**Context** [EpochKeeper.sol:150-185](contracts/src/keeper/EpochKeeper.sol#L150), [Deploy.s.sol:127](contracts/script/Deploy.s.sol#L127), README "Running a keeper"

`Deploy.s.sol` registers the EpochKeeper contract as a vault keeper; `runDue()`, `performUpkeep()` and `run(i, limit, "")` have no access control. With `keeperOnly = true` any address still triggers epochs, chooses page size and timing (PoCs). The README presents this as a feature, but it silently disables the one switch SECURITY.md §2 offers against MEV, and it means an "operators only" deployment is not achievable without redeploying the keeper.

**Recommendation** Add `onlyOperator` variants (or a `permissionless` toggle) to `runDue/performUpkeep/run`; Chainlink/Gelato forwarders become operators. Document precisely what `keeperOnly` does and does not restrict.

## L-01 · `_creditZap` rounding: stranded USDG, and WETH under-debit on partial fills

**Context** [PlanVault.sol:506-511](contracts/src/vault/PlanVault.sol#L506); `invariant_idleBackedByBalance` in `test/invariant/VaultInvariants.t.sol`

`usdgShare` and `wethDeduct` both floor. Σ`usdgShare` < `received` ⇒ dust USDG on the vault in nobody's `usdgIdle`, unrescuable (`TokenNotRescuable`). Σ`wethDeduct` < `wethSpent` when the router consumed less than `finalSum` ⇒ `totalWethIdle` exceeds the real balance; the last user to withdraw their full `wethIdle` reverts (PoC 2). The shipped invariant suite **fails on every fuzz seed** because of the USDG half (README claims 201/201 passing; SECURITY.md invariant #2 states strict equality, the code comment says `>=`).

**Recommendation** Assign remainders explicitly: give the last credited plan `received − Σshares` and `wethSpent − Σdeducts` (or ceil the deduction of one plan). Same pattern for `residual` in `_distribute` ([601-605](contracts/src/vault/PlanVault.sol#L601)) so `usdg.balanceOf == totalUsdgIdle` holds tightly. Fix the invariant test and keep it green in CI.

## L-02 · Fee and tip charged on unspent USDG

**Context** [PlanVault.sol:540-544](contracts/src/vault/PlanVault.sol#L540), [557-562](contracts/src/vault/PlanVault.sol#L557), [601-605](contracts/src/vault/PlanVault.sol#L601)

`fee = spend × bps` is paid out before the swap; a partial fill returns the unspent net USDG to idle but not its fee. PoC: 50 % fill ⇒ effective fee 151 bps on what was bought, and the same USDG pays 75 bps again next epoch; a 50 % keeper tip is inflated identically.

**Recommendation** Take fees after the swap on `spent` (pro-rata: `fee_i = spend_i × spent/totalSpend × bps`), or refund `residual × bps/(BPS−bps)` alongside the residual.

## L-03 · Sub-unit stock output reverts the page

**Context** [PlanVault.sol:579-585](contracts/src/vault/PlanVault.sol#L579)

`quote(usdg, stock, totalNet)` reverts `NoRoute` (or `SwapReturnedZero`) when the pool output rounds to 0, taking the whole page with it. For 18-decimal stocks 1 USDG unit ≈ 1e9 wei so this needs a ≤6-decimal or extremely high-priced token; the registry accepts any decimals. A 1-unit plan alone on the last page (the newest plan is always last) stalls that page (PoC).

**Recommendation** As H-01: on quote failure skip the page's buy (return USDG to idle, emit `PageSkipped`), and enforce a minimum `amountPerEpoch` (e.g. ≥ 1 USDG) in `createPlan`/`setPlanAmount`.

## L-04 · Intermediate-token refund stranded on the vault

**Context** [AggregatorRouter.sol:175](contracts/src/router/AggregatorRouter.sol#L175), [UniV3Adapter.sol:193-195](contracts/src/router/adapters/UniV3Adapter.sol#L193), [PlanVault.sol:691-698](contracts/src/vault/PlanVault.sol#L691)

Every hop refunds unspent input to `msg.sender` = vault. For USDG→WETH→stock a hop-2 remainder is WETH: `_buyStock` measures only USDG, so the users of that page paid in full for a partial fill and the WETH sits outside `totalWethIdle`, unrescuable (PoC: 0.00496 WETH stranded).

**Recommendation** In `_execute`, if hop `i>0` under-consumes, either revert (`PartialHop`) or swap the remainder back / forward it to `recipient` and report it; in the vault, measure the WETH delta in `_buyStock` and credit it pro-rata to `wethIdle` (or to `dustPot`-like `wethPot`).

## L-05 · Index spam: keeper gas amplification, prune blocking

**Context** [PlanVault.sol:231](contracts/src/vault/PlanVault.sol#L231), [332-338](contracts/src/vault/PlanVault.sol#L332), [797](contracts/src/vault/PlanVault.sol#L797), SECURITY.md §3

`createPlan` with zero deposit is indexed and costs the keeper **~9.3k gas per plan per epoch** (measured cold; SECURITY.md estimates one cold SLOAD), i.e. ~1.4M gas for a page of 150 empties — every day on the Daily vault. `prunePlan` is blocked for the whole epoch once page 0 runs, and a pruned plan is re-indexed by anyone for 1 unit of USDG (open deposits).

**Recommendation** Index on first funding only (and unindex on `withdrawIdle` to zero); require a minimum first deposit / `amountPerEpoch`; let the keeper skip-and-unindex empty plans it encounters (cheap since the slots are already warm); allow prune of empty plans *behind* the cursor during a pending epoch.

## L-06 · Push fee transfers can block user exits

**Context** [PlanVault.sol:852](contracts/src/vault/PlanVault.sol#L852), [860](contracts/src/vault/PlanVault.sol#L860), [886](contracts/src/vault/PlanVault.sol#L886)

`withdrawIdle` and `claim` `safeTransfer` the fee to `feeRecipient` first. Robinhood Stock Tokens are permissioned and Paxos USDG has a freeze list: if the treasury is not (or stops being) an allowed recipient, every non-tier user's `claim` (or USDG `withdrawIdle`) reverts until the owner sets a new recipient or zeroes the fee (PoC). This contradicts "users can always exit" (SECURITY.md §9) in the presence of a lost/slow owner key.

**Recommendation** Accrue fees in the vault (`pendingFees[token]`) and let anyone `sweepFees()` to the recipient (pull), or make the fee leg non-reverting (`_tryTransfer`, accrue on failure). Check `feeRecipient` allowlisting per stock at listing time.

---

## Informational

| ID | Note |
|---|---|
| I-01 | Test-suite health: `invariant_idleBackedByBalance` fails deterministically (see L-01); README "201 tests" is stale. Coverage 97 % lines but every vault test uses `MockRouter` (linear rate, full fills, no rounding, static price) — H-01/H-02/L-01/L-03/L-04 are invisible to it. Add the real router + CPMM fixture (`test/audit/AuditBase.sol`) to the main suite and the fuzz/invariant handlers. |
| I-02 | `advanceEpoch` for a purchasable stock with **zero** plans marks the epoch executed and increments `epochsCompleted` (`isEpochDue` checks `length > 0`, `_advanceEpoch` does not). Cosmetic. |
| I-03 | A zap-at-epoch plan that is skipped (slippage / no route) also forgoes spending its *available* USDG ([PlanVault.sol:530](contracts/src/vault/PlanVault.sol#L530)). With open deposits anyone can make a plan `wethNeeded` by depositing 1 wei WETH, so third parties can decide whether it fills whenever the WETH route is impaired. Consider spending idle USDG regardless of the zap outcome. |
| I-04 | `prunePlan` and the `setPlan*` setters are not `nonReentrant`. Before page 0 writes `nextPlanIndex`, `_isEpochPending` is false, so a token/hook callback during `_distribute` could reorder `_stockPlans` mid-page (plan skipped this epoch). Requires a stock token with transfer hooks or a malicious V4 hook — both outside the stated trust model, but a `nonReentrant` on `prunePlan` is free. |
| I-05 | `StockRegistry.listStock` accepts USDG/WETH (USDG as stock ⇒ every epoch `InvalidPath`), any decimals (L-03), no `code.length` check. `UniV3Adapter.unregisterPool` cannot blocklist a factory pool (re-verified on next quote). |
| I-06 | `setThresholds` unbounded; with `dca == address(0)` and threshold 0, everyone gets auto-distribute + halved fee. Add `> 0` or a floor. |
| I-07 | `Zap` swaps accept `minOut = 0` and have no deadline; `Zap.depositEthAsUsdg(vault, …)` approves USDG to an arbitrary `vault` address (caller's own funds only). Consider a `VaultDirectory` check. |
| I-08 | Missing zero checks: `AggregatorRouter.weth`, adapters' `router`; `setAdapter` does not verify `adapter.protocolId() == protocol`. |
| I-09 | `EpochKeeper._forwardTips` sweeps the contract's whole USDG balance to any caller of `runDue/performUpkeep/run` (by design for tips; note stray transfers are claimable by anyone). |
| I-10 | `$DCA` perks read spot balances (acknowledged). With permissionless `advanceEpoch` the flash-buy is atomic and riskless; the lookback snapshot planned for V2 should land with H-02's fix. |
| I-11 | `totalNotionalUsdg += ctx.totalNet` counts USDG later refunded as `residual`. Use `spent`. |
| I-12 | `evm_version = cancun` + via-ir: confirm Robinhood Chain's ArbOS supports `PUSH0`/`MCOPY` before deploying; bump OZ from 5.1.0 to latest 5.x. |
| I-13 | Admin power (acknowledged): `setRouter` grants unlimited USDG/WETH approval to an arbitrary address ⇒ a malicious router drains one page's `totalNet` per stock per epoch; `setFees`/`setKeeper`/`setFeeRecipient` apply instantly. Put owner behind a timelock; emit and monitor. `feeManager` may set `swapSlippageBps` up to 5 %. |
| I-14 | `MockDCA` lives in `src/` and is compiled into production artifacts; move to `test/`. `RamsesV3Adapter` assumes the V3 ABI — verify on-chain (tick-spacing-keyed factories differ) before enabling. |
| I-15 | Documentation drift: SECURITY.md invariant #2 (strict equality), "one cold SLOAD" per empty plan (measured 9.3k), `keeperOnly` semantics (M-03), keeper trust statement (M-02). |

## What was checked and found sound

Reentrancy (all state-changing entries `nonReentrant`, CEI respected, `receive` restricted to WETH, 2300-gas-safe); access control on every admin path (Ownable2Step, `onlyFeeManager`, `onlyRouter`, callback authentication `msg.sender == d.pool && verifiedPool`, V4 `unlockCallback` from PoolManager only); fake-pool injection via overrides (factory re-verification + token checks hold); fee caps (90 bps hard cap, tolerance caps); epoch math (`EpochLib` alignment, epoch 0 never executes, one spend per epoch per plan, missed epochs skipped); pagination cursor / swap-remove index consistency; `rescueERC20` cannot reach USDG/WETH/any ever-listed stock; `dustPot` conservation; auto-distribute fallback; V4 `extsload` slot / `Slot0` unpacking; hop impact scaling; `_tryTransfer` return-data handling; overflow/narrowing (`SafeCast` everywhere, `mulDiv` 512-bit).

## Code maturity (Trail of Bits categories)

| Category | Rating | Rationale |
|---|---|---|
| Arithmetic | Moderate | `mulDiv`/`SafeCast` throughout, fee math fuzzed; but rounding direction is wrong in `_creditZap` (L-01) and fees are computed on the wrong base (L-02). |
| Auditing / events | Satisfactory | Rich, indexed events incl. skip reasons; full `FeeConfig` emitted; `JobFailed` carries reasons. |
| Access controls | Moderate | Clean role model, but `keeperOnly` is ineffective (M-03) and the override gives keepers price authority the model denies them (M-02). |
| Complexity | Satisfactory | Phased epoch pipeline is readable; `PlanVault` at 22.3 KB is 2.3 KB under EIP-170 — little room for fixes; consider a library for the zap phase. |
| Decentralization | Moderate | Non-upgradeable, 2-step ownership, fee caps; owner can still redirect swaps (`setRouter`) and fees instantly — no timelock. |
| Documentation | Strong | README + SECURITY.md are unusually good; several statements are now inaccurate (I-15). |
| Low-level code | Satisfactory | Small, `memory-safe` assembly for sentinel reverts / `BalanceDelta` unpacking; `extsload` slot owner-overridable. |
| Transaction ordering | **Weak** | No external price reference; spot-price impact cap; permissionless timing (H-02). |
| Testing & verification | Moderate | 97 % line coverage, fuzz + invariant suites, fork test scaffold — but the swap layer is a linear mock, the invariant suite is red, and no test exercised dust amounts, partial hops, or moving prices. |

## Recommended order of work

1. H-02 — decide the MEV posture (TWAP guard and/or operator-gated triggering). This changes the keeper design, so do it first.
2. H-01 + L-03 + I-03 — make the epoch loop skip, never revert, on any per-plan quote/size failure; add minimum sizes.
3. M-01 — deficit-based zap sizing with per-plan caps.
4. M-02 / M-03 — bound overrides, gate the keeper contract.
5. L-01 / L-02 / L-04 — rounding + fee base + hop refunds; turn the invariant suite green; adopt `test/audit/AuditBase.sol` (real router, CPMM pool) in the fuzz/invariant handlers.
6. L-05 / L-06 / Informational sweep; refresh README/SECURITY.md; consider a second review after the redesign of 1–3.

## Appendix — tooling output

- `forge test` (shipped suite): 200 pass / 1 fail (`invariant_idleBackedByBalance`, every seed). With `test/audit/`: 226 pass / 1 fail.
- `forge coverage --ir-minimum` (src, shipped tests): 97.2 % lines, 96.2 % statements, 89.5 % branches.
- Slither 0.11.6 (`--exclude-informational --exclude-optimization`): 10 High-impact hits — all false positives (`reentrancy-*` on `nonReentrant` paths, `arbitrary-send-eth` to `msg.sender`/caller-chosen recipient); Medium: `incorrect-equality` (intentional `== 0` checks), `unused-return` (deltas measured via balances instead — intentional). No detector surfaced a real issue.
- Contract sizes: vaults 22,317–22,319 B runtime (limit 24,576).
- Not run: fork suite (`RH_RPC` unset; `config/addresses.rh.json` still has TODO addresses), formal verification.

*Audit performed by Claude (Opus 5) as an automated review. It is not a substitute for a manual review by an independent firm before mainnet, particularly for the redesign implied by H-01/H-02.*
