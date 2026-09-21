# DCA Protocol — Security Re-audit (v0.2, post-remediation)

| | |
|---|---|
| **Target** | `contracts/src/**` at tag `v0.2` (commit `8abc39f`; diff vs `v0.1`: 15 files, +604/−635 in `src` + `script`); solc 0.8.28, via-ir, OZ 5.1.0. Apps migrated in `babe8f3`. |
| **Date** | 2026-09-20 |
| **Previous report** | [`audit/AUDIT-v0.1.md`](audit/AUDIT-v0.1.md) — 2 High, 3 Medium, 6 Low, 15 Info |
| **Method** | Line-by-line re-review of every changed file; every v0.1 finding re-tested against the remediated code with a permanent regression test (`contracts/test/audit/`, 30 tests); existing suites rewritten for the new API; invariants tightened and re-run at CI depth (fuzz 2048, invariants 256×64); Slither 0.11.6; coverage; contract sizes. |
| **Result** | **All 5 High/Medium findings closed or mitigated; 5 of 6 Lows closed; 2 items accepted by decision (L-02, L-06); 1 item open by decision (H-02 block-level sandwich) with concrete mitigations in place and a V2 design.** Two new issues were found in the remediated code during this pass and fixed in the same change (N-01, N-02). No new High or Medium. |

## 1. Status of v0.1 findings

| ID | v0.1 finding | Sev | Status | What changed | Regression test |
|---|---|---|---|---|---|
| H-01 | Dust zap plan permanently bricks a stock's epochs | High | **Closed** | Zap-at-epoch removed (vaults USDG-only); `minAmountPerEpoch` / `minDeposit` = 10 USDG; a page whose purchase cannot be quoted/executed is **skipped** (`EpochPageSkipped`), never reverted | `Audit.H01.ZapDustDoS` (5) |
| H-02 | Epoch swap atomically sandwichable by anyone | High | **Mitigated / open** | Unprivileged atomic variant closed (operator-only triggering, `keeperOnly` default on). Block-level sandwich of the operator's tx remains by decision; operators can pass a reference-price `minOut` override which reverts the fill under manipulation. See §3. | `Audit.H02.Sandwich` (4, incl. `test_KNOWN_RESIDUAL_*`) |
| M-01 | Aggregate zap sizing/caps let one plan grief all zap plans | Med | **Closed** | Feature removed; ETH/WETH converts per-deposit with the depositor's own `minUsdgOut`, unfilled WETH returned to depositor | `Audit.M01.UsdgOnly` (3) |
| M-02 | Route override = unbounded price override for keepers | Med | **Closed** | Router trades only owner-approved hops (`approveHop`/`revokeHop`, `RouteNotApproved` for every caller); override `minOut ≥ max(auto floor, override path's own floor)`; override failures revert (page not consumed) | `Audit.M02.RouteOverride` (5) |
| M-03 | `keeperOnly` bypassed via permissionless EpochKeeper | Med | **Closed** | `runDue` / `run` / `performUpkeep` are `onlyOperator`; `checkUpkeep` stays view; vaults default `keeperOnly = true`; Deploy registers `KEEPERS` as operators | `Audit.M03.KeeperOnlyBypass` (4) |
| L-01 | `_creditZap` rounding: stranded USDG, WETH under-debit | Low | **Closed** | No WETH accounting left; USDG remainder of pro-rata splits → `usdgDust`, swept to treasury at `dustSweepMinUsdg`; invariants now strict (`usdg == idle + usdgDust`, `weth == wethDust`) and green at CI depth | `Audit.L01.ExactAccounting` (2), `VaultInvariants` |
| L-02 | Fee charged on unspent USDG in partial fills | Low | **Accepted (pinned)** | Unchanged by decision; documented in SECURITY.md §5 | `Audit.L02.PartialFillFee::test_KNOWN_*` |
| L-03 | Sub-unit stock output reverts the page | Low | **Closed** | Covered by skip-not-revert + minimums | `Audit.H01…::test_dustOutputPageIsSkipped_otherPagesFill` |
| L-04 | Hop-2 refund stranded on the vault | Low | **Closed** | Router forwards unspent intermediates to `recipient`; vault books incoming WETH as `wethDust` and sweeps it in the same tx | `Audit.L04.HopRefund` (2) |
| L-05 | Free empty plans indexed; prune blocking | Low | **Closed** | Nothing enters the index below `minDeposit`; re-index needs another ≥ 10 USDG; each cycle pays the withdraw fee | `Audit.L05.IndexSpam` (3) |
| L-06 | Push fee transfers can block exits | Low | **Accepted** | Unchanged by decision; runbook note in SECURITY.md §7 | `Audit.L06…::test_KNOWN_ACCEPTED_*` |
| I-01 | Invariant suite red; swap layer mocked linearly | Info | **Closed** | Suite green; `MockRouter` quotes are now fill-aware; real-router + CPMM fixture in `test/audit/`; handler exercises partial fills and route outages | — |
| I-02 | `advanceEpoch` on empty stock marks epoch executed | Info | **Closed** | Reverts `EpochNotDue` | `test_noPlans_notDueAndReverts` |
| I-03 | Skipped zap plan forgoes its USDG | Info | **Closed** | Mode removed | — |
| I-04 | `prunePlan` not `nonReentrant` | Info | **Closed** | Added | — |
| I-05 | Registry accepts non-contracts | Info | **Closed** | `NotAContract` check (USDG/WETH still listable by owner — unchanged) | `StockRegistry.t.sol::test_reverts` |
| I-06 | `setThresholds` unbounded; no-DCA edge | Info | **Closed** | Thresholds must be > 0; `_perks` returns none when `dca == 0` | `test_noDcaToken_noPerks` |
| I-08 | Missing zero checks / adapter id check | Info | **Closed** | Router `weth`, adapters `router`/`poolManager`, `setKeeper(0)`, `setOperator(0)`; `setAdapter` verifies `protocolId()` | `test_admin` |
| I-11 | `totalNotionalUsdg` counted residual | Info | **Closed** | Counts `spent` | `test_residualUsdgReturnedProRata` |
| I-14 | `MockDCA` in `src/` | Info | **Closed** | Moved to `test/mocks/` | — |
| I-15 | Documentation drift | Info | **Closed** | README / SECURITY.md rewritten for the new model | — |
| I-07, I-09, I-10, I-12, I-13 | Zap minOut/deadline; tip sweep; DCA flash-buy; Cancun/OZ; admin timelock | Info | **Unchanged** | Operational / V2 items; see §4 | — |

## 2. New findings in the remediated code (found and fixed in this pass)

| ID | Title | Sev | Fix | Test |
|---|---|---|---|---|
| N-01 | Route selection picked the highest-output candidate *then* applied the impact cap: a thin pool with a marginally better output but > 150 bps impact masked an in-cap pool and produced `NoRoute` (latent in v0.1, more exposed with an explicit allowlist) | Low | `_bestHop` / `_bestTwoHop` now select the best output **among candidates within the cap** (per hop and end-to-end) | `Router.t.sol::test_quote_selectionIsCapAware` |
| N-02 | When the auto-route had no quote (e.g. only approved pool over the cap), an override's `minOut` was bounded only by `> 0`: a compromised operator could fill a page through an approved pool at any price precisely when a sandwich is most lucrative | Low | New `AggregatorRouter.quotePath(path, amountIn)`; the vault floors the override at `max(autoFloor, pathQuote × (1 − swapSlippageBps))` — an override can accept a path's impact, never a worse price than that path delivers right now | `Audit.M02…::test_noAutoQuote_overrideFlooredByPathQuote`, `Router.t.sol::test_quotePath` |

Nothing else surfaced: reentrancy (all entries `nonReentrant`, incl. `prunePlan`; `receive` removed — vault never unwraps), access control on every new admin path (`approveHop`, `revokeHop`, `setMinimums`, `setDustSweepMin`, `sweepDust`, `setOperator`), callback authentication unchanged, hop-key identity (`keccak(protocol, tokenIn, tokenOut, fee, extra)`) so two pools on one pair are distinct and revocation is exact, `MAX_HOPS_PER_PAIR = 8` bounds quote gas (≤ 8 + 8×8 simulations), `quoteRoute` is public but only caches `verifiedPool` for pools that already pass `_poolOk`, dust accounting conservation under fuzz/invariants, `Overspent` / `SwapReturnedZero` still guard the balance-delta path.

## 3. H-02 — what remains and how to close it

**Closed:** the v0.1 exploit (an unprivileged address pushing a pool, calling `advanceEpoch` and unwinding in one transaction). No public entry point can trigger an epoch: `advanceEpoch` requires `isKeeper` (default `keeperOnly = true`), and the EpochKeeper contract — the only whitelisted keeper — requires `isOperator` on `runDue`, `run` and `performUpkeep` (`test_atomicSandwichByAnyoneIsClosed`).

**Still open (kept visible by `test_KNOWN_RESIDUAL_operatorTxCanStillBeSandwichedInBlock`):** every price reference the vault uses — `quote`, `minOut = quote × 0.995`, the impact cap vs `slot0` — is read inside the executing transaction. A builder, or a searcher who can land a transaction before and after the operator's in the same block, still extracts value: with a $1M pool and a $600k push, a $10k epoch loses ~55%.

**In place today (operational, use all three):**
1. Operators submit through a private relay / builder with no public-mempool exposure.
2. Operators pass a **reference-price `minOut` override** each run: expected stock from an off-chain reference (Robinhood price, or `TwapOracle.consultTick` ≥ 30 min) × (1 − 1–3%); the override is accepted only if ≥ the auto floor, and under manipulation the fill **reverts** and the page is retried (`test_mitigation_referenceMinOutOverrideRevertsUnderManipulation`).
3. Randomise the execution time within the epoch rather than firing at the boundary.

**Recommended V2 contract change (closes it without operator discipline), in order of effort:**
1. **On-chain TWAP guard** in `_buyStock`: owner-set reference pool per stock; `expected = totalNet × twapPrice(pool, window)`; require `bought ≥ expected × (1 − maxDeviationBps)` else skip the page. Reuses `TwapOracle`; ~40 lines; make `window`/`maxDeviationBps` owner-settable with sane bounds (≥ 10 min, ≤ 500 bps).
2. **Commit / execute**: record the auto quote in one transaction (`commitEpoch`) and execute ≥ N blocks later using the committed `minOut`; no single block can set both the reference and the fill.
3. **Oracle floor**: if a Chainlink / Pyth feed for the stock exists on Robinhood Chain, use it as the reference (or as a second bound alongside the TWAP).
4. **Order splitting**: several randomised sub-buys per epoch raise the attacker's cost per unit extracted; combine with 1.

## 4. Residual / informational (unchanged or new, no code change made)

| ID | Note |
|---|---|
| R-01 | **No permissionless fallback for epochs.** By design after M-03: if every operator is down, epochs are missed (never caught up). Run ≥ 2 independent operators (bot + Chainlink Automation forwarder). A time-boxed fallback (anyone after `boundary + X h`) would re-open H-02's atomic variant for that window — not recommended without the TWAP guard. |
| R-02 | **Trusted-operator override.** Operators can still choose *which* approved path and *when*; combined with the block-level sandwich this means a malicious operator key is a fund-extraction key up to the impact cap per page. Keep operator keys in HSM/KMS, rotate, monitor `JobRun` fills vs reference prices. |
| R-03 | `USDG` / `WETH` are still listable as "stocks" by the owner (registry does not know them); listing USDG makes every epoch for it skip (`InvalidPath`). Owner error only. |
| R-04 | Two-hop selection is best-first-leg × best-second-leg; it does not consider a worse first leg paired with a much better second leg. Fine for ≤ 8 hops per pair; revisit if the allowlist grows. |
| R-05 | `quoteRoute` / `quotePath` are non-view (sentinel-revert simulation) and callable by anyone; harmless (no state beyond `verifiedPool` caching of already-valid pools) but frontends must `eth_call` them. |
| R-06 | The 10 USDG minimums are owner-settable with no upper bound; raising them mid-life does not affect existing plans' `amountPerEpoch` (only new plans and changes) — intended, but document for users. |
| I-07 | `Zap` swaps accept `minOut = 0` and have no deadline; the frontend must always set `minOut`. |
| I-09 | `EpochKeeper._forwardTips` sweeps the contract's USDG balance to the calling operator (by design). |
| I-10 | `$DCA` perks are spot balances; now that epochs are operator-only the user can no longer make the flash-buy atomic with the epoch, but can still time it. V2: lookback snapshot. |
| I-12 | Confirm Robinhood Chain's ArbOS supports `PUSH0` / `MCOPY` (`evm_version = cancun`); bump OZ to latest 5.x. |
| I-13 | Owner powers apply instantly (`setRouter`, `approveHop`, `setFees`, `setOperator`, `setMinimums`); put the owner behind a timelock and monitor `HopApproved` / `HopRevoked` / `RouterSet` / `OperatorSet`. |

## 5. App migration (done — commit `babe8f3`, after tag `v0.2`)

Both apps now consume the v0.2 ABI (`pnpm --filter @dca/web abi`, `pnpm --filter @dca/scheduler abi`). Points specific to the changed zap behaviour:

- **Create / deposit with ETH.** `createPlan` has no zap-mode flag; ETH is converted inside the call. The UI quotes the amount **net of any deposit fee** (what the vault actually swaps) and sends `minOut = quote × (1 − 0.5%)`; the 10 USDG `minDeposit` is enforced client-side on the *worst case* the swap may credit (quote − tolerance), so a deposit that would revert on chain is blocked before signing. Copy states that the plan holds USDG, never ETH, and that any unfilled sliver of ETH is returned in the same transaction.
- **Funding is required.** A plan cannot be started unfunded; the create page reads `minAmountPerEpoch` / `minDeposit` from the vault (fallback 10 USDG) for the slider floor, validation and messaging.
- **Withdraw / remove** are USDG-only (`withdrawIdle(planId, amount)`); the ETH checkbox and `wethIdle` displays are gone; TVL and "waiting to buy" no longer have an ETH component.
- **Skipped pages** (`EpochPageSkipped`) are decoded (router custom errors / `Error(string)` / ASCII tag) and shown inline in the Activity feed ("Skipped — no approved route within the impact cap. Nobody was charged…"); the scheduler logs the same as a warning.
- **Scheduler pre-flight** checks `isOperator` / `owner` for its wallet and logs an explicit error otherwise (every run would revert `NotOperator`).

Verified end to end on an isolated anvil + `DeployLocal` stack: ETH-funded create (blocked below the minimum, accepted above; vault WETH balance 0, `usdg.balanceOf == totalUsdgIdle`), operator fill through the scheduler, ETH top-up (min check), partial USDG withdrawal, remove, and a skipped page after revoking the stock's hop.

## 6. Code maturity (Trail of Bits categories) — v0.1 → v0.2

| Category | v0.1 | v0.2 | Why |
|---|---|---|---|
| Arithmetic | Moderate | **Satisfactory** | Rounding remainders are booked, not floored away; strict balance invariants green at CI depth; L-02 pinned knowingly |
| Auditing / events | Satisfactory | Satisfactory | + `EpochPageSkipped(reason)`, `DustSwept`, `HopApproved/Revoked`, `MinimumsSet` |
| Access controls | Moderate | **Satisfactory** | Keeper path closed end to end; override bounded; allowlist gate in the router for every caller |
| Complexity | Satisfactory | **Satisfactory+** | Vault −1.3 KB (20.97 KB runtime, 3.6 KB headroom); zap-at-epoch machinery (≈150 lines) removed; adapters no longer discover pools |
| Decentralization | Moderate | Moderate | Operator-only epochs add an availability dependency (R-01); owner still un-timelocked (I-13) |
| Documentation | Strong | Strong | README / SECURITY.md updated; scheduler README notes the operator requirement |
| Low-level code | Satisfactory | Satisfactory | Unchanged |
| Transaction ordering | **Weak** | **Moderate** | Atomic unprivileged sandwich closed; block-level sandwich remains with operational mitigations; contract-level guard is a V2 item (§3) |
| Testing & verification | Moderate | **Satisfactory** | 244 tests (was 201): real-router + CPMM regression suite for every finding, fill-aware mock, invariant handler with partial fills and route outages, strict invariants, CI profile green |

## 7. Changes since this audit — **v0.3 Boost (unaudited)**

Added after the v0.2 review; **not covered by this report** and should be in scope of the next one.

- **Feature.** Per-plan opt-in lending of idle USDG on Morpho Blue between buys (`Plan.boosted`, `createPlan(..., bool boost)`, `setPlanBoost`), with per-plan share / cost-basis / realised-yield accounting (`boostShares`, `boostPrincipal`, `boostEarned`) and a live APY quoted from the market's IRM. README "Boost", SECURITY.md §11.
- **New code.** `src/boost/MorphoBlueStrategy.sol` (OZ ERC-4626 over one Morpho Blue market, depositor-gated, liquidity-bounded `maxWithdraw`), `src/libraries/BoostLib.sol` (**linked external library**, delegatecalled on vault storage — `PlanVault` would otherwise exceed EIP-170: 25.6 KB inline vs 23.6 KB linked), `src/libraries/MorphoLib.sol` (Morpho share maths + interest projection, reimplemented), `src/interfaces/IMorpho.sol`. `ClaimHelper` exposes `boostValueOf` and boost fields.
- **Vault changes.** `_collect` values boosted plans against one pool snapshot; the page's boosted spend is pulled in one strategy withdrawal before the swap, and a failed pull drops the boosted fills instead of reverting (`BoostWithdrawFailed`); a skipped swap re-lends the pulled USDG. `withdrawIdle` / `prunePlan` / `rescueERC20` account for boosted balances and strategy shares. `setBoostStrategy` migrates positions atomically.
- **Tests.** 303 (was 244): `MorphoBlueStrategy.t.sol` (16), `PlanVault.Boost.t.sol` (36 incl. a value-conservation fuzz), invariant handler extended with boost toggles, time warps, liquidity crunches and bad debt; two new invariants (`boostPoolConsistent`, `boostFundsAreLent`). Green at CI depth. No fork test against a live Morpho deployment yet.
- **Known trade-offs.** Vault EIP-170 headroom is now ~1 KB; boosted withdrawals/spends depend on Morpho market liquidity; bad debt is socialised; a mock (`test/mocks/MockMorpho.sol`) stands in for Morpho in all tests.

## 8. Appendix — tooling output

- `forge test`: 244 pass / 0 fail (default profile); CI profile (`fuzz.runs = 2048`, `invariant.runs = 256`, `depth = 64`): 244 pass / 0 fail.
- `forge coverage --ir-minimum` (src, all tests): 97.9 % lines, 96.5 % statements, 87.7 % branches; `PlanVault` 99.3 % lines.
- Slither 0.11.6 (`--exclude-informational --exclude-optimization`): 11 High-impact hits, all false positives (`reentrancy-*` on `nonReentrant` paths, `arbitrary-send-eth` to caller-chosen recipient in `Zap`, `uninitialized-state` on a mapping). No real finding.
- `forge lint src script`: clean.
- Contract sizes (runtime): vaults 20,967–20,969 B (limit 24,576), router 8,164 B, UniV3Adapter 5,511 B, UniV4Adapter 6,056 B, EpochKeeper 5,398 B.
- Not run: fork suite (`RH_RPC` unset; `config/addresses.rh.json` still has TODO addresses), formal verification.

*Automated review by Claude (Opus 5). The v0.1 findings are closed to the extent stated above; H-02 remains a live risk until the V2 guard ships and should be independently reviewed together with the redesigned router before mainnet.*
