# DCA Protocol — Smart Contract Security Audit (v0.3, fresh review)

> **Automated AI review, not an independent third-party audit.** This report was produced with an AI model (Claude) during development. It has not been reviewed by a professional audit firm and does not replace one.

| | |
|---|---|
| **Target** | `contracts/src/**` (31 files, 3,501 non-blank LoC) and `contracts/script/**` at commit `4ea7ba0` plus the uncommitted working tree of 2026-09-22 (FeeReceiver, deploy wiring, mocks). solc 0.8.28, via-ir, `evm_version = cancun`, OpenZeppelin 5.1.0, forge-std 1.16.2. |
| **Chain** | Robinhood Chain (chain id 4663, Arbitrum Orbit, ArbOS 61). Single first-come-first-served sequencer run by Robinhood; no public mempool; L2 system contracts instantly upgradeable by a 7/8 multisig ([L2BEAT](https://l2beat.com/layer2s/projects/robinhood)). Stock Tokens are plain 18-decimal ERC-20s whose splits/dividends are expressed through an ERC-8056 `uiMultiplier` (raw balances never change) and have per-token Chainlink feeds ([Robinhood docs](https://docs.robinhood.com/chain/building-with-stock-tokens/)). |
| **Date** | 2026-09-22 |
| **Auditor** | Automated review by Claude Fable 5.1 (AI); not an independent third-party audit. Done separately from the earlier reviews (archived: [`audit/AUDIT-v0.1.md`](audit/AUDIT-v0.1.md), [`audit/AUDIT-v0.2.md`](audit/AUDIT-v0.2.md), [`audit/AUDIT-FeeReceiver.md`](audit/AUDIT-FeeReceiver.md)); their findings were not taken as given — every one was re-derived from the code. |
| **Method** | §2. Manual line-by-line review of every file against a written threat model; Slither 0.11.6; the existing 358-test suite plus invariants at CI depth (fuzz 2048, invariants 256×64); coverage; 18 new proof-of-concept tests (`contracts/test/audit/v0.3/`, all passing against the **unmodified** code). No source file was changed. |
| **Result** | **1 High, 4 Medium, 4 Low, 14 Informational.** No path lets an unprivileged party take idle balances or accrued stock out of the vault. The High is the epoch purchase itself: it has no manipulation-resistant price reference and runs on a public schedule, so an unprivileged attacker takes a large share of every page from another block (PoC: −41% for users, +5.6k USDG for the attacker on a 15k page). Two Mediums permanently destroy or divert user funds under specific conditions (boost strategy donation griefing; route override / second-hop refunds). One Medium is the standard centralization finding, sharpened: a single owner transaction hands custody of all idle USDG to an arbitrary contract. Everything is fixable with small, local changes listed in §9. |

**Read this first.** The protocol is well built: the code is clean, the accounting invariants hold under fuzzing, the fee sink even has an on-path TWAP guard. The problems are concentrated in one place — *the price at which user money is turned into stock* — and in the blast radius of admin keys. Both were noted as "accepted / operational" in the previous reports; this review treats them as open, because the mitigations they rely on (operator discipline, private relays, key hygiene) are exactly the kind that fail in the incidents we studied (§2.3).

---

## 1. Executive summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 1 | H-01 |
| Medium | 4 | M-01, M-02, M-03, M-04 |
| Low | 4 | L-01, L-02, L-03, L-04 |
| Informational | 14 | I-01 … I-14 |

**Before mainnet (blocking):**
1. **H-01** — give every epoch purchase an external price floor (the per-stock Chainlink feed the chain already provides, or the pool TWAP guard already written for `FeeReceiver`) and skip the page when the fill deviates. Apply the same floor to operator overrides.
2. **M-01** — seed the `MorphoBlueStrategy` at deploy, give it a decimals offset, and make the vault refuse a boost deposit that mints zero strategy shares.
3. **M-03** — replace the vault's standing `type(uint256).max` approvals to the router and strategy with per-call exact approvals (as `FeeReceiver` already does), and put the owner behind a timelock.

**Soon after:** M-02 (cap override impact; return second-hop refunds to users), M-04 (unaccounted balances), the Lows.

---

## 2. Scope and method

### 2.1 In scope

| File | LoC | Runtime size | Role |
|---|---|---|---|
| `src/vault/PlanVault.sol` (+ Daily/Weekly/Monthly) | 1,011 | 23,604 B at audit time (972 B under EIP-170); now ~24.2 KB, 371–416 B under — see §11 | Plans, deposits, epochs, fees, boost accounting |
| `src/libraries/BoostLib.sol` | 206 | 4,322 B (linked, delegatecalled) | Boost pool share maths, strategy calls |
| `src/boost/MorphoBlueStrategy.sol`, `src/libraries/MorphoLib.sol`, `src/interfaces/IMorpho.sol` | 172 / 71 / 64 | 8,392 B | ERC-4626 over one Morpho Blue market |
| `src/router/AggregatorRouter.sol`, `IAggregatorRouter.sol` | 317 / 68 | 8,749 B | Allow-listed best-of-N routing, impact cap |
| `src/router/adapters/UniV3Adapter.sol`, `RamsesV3Adapter.sol`, `UniV4Adapter.sol`, `ISwapAdapter.sol` | 225 / 13 / 255 / 28 | 5,511 / 5,511 / 6,056 B | Pool simulation + execution |
| `src/treasury/FeeReceiver.sol` | 378 | 8,510 B | 70/30 fee split, buyback-and-burn, TWAP guard |
| `src/keeper/EpochKeeper.sol` | 228 | 5,398 B | Operator-only job runner |
| `src/periphery/Zap.sol`, `ClaimHelper.sol` | 87 / 124 | — | Conveniences, read helpers |
| `src/registries/StockRegistry.sol`, `src/vault/VaultDirectory.sol`, `src/oracles/TwapOracle.sol`, `src/libraries/EpochLib.sol`, `FeeMath.sol`, `src/vault/VaultTypes.sol`, interfaces | — | — | Support |
| `script/Deploy.s.sol`, `DeployLocal.s.sol`, `ApproveRoutes.s.sol` | — | — | Deployment wiring (reviewed for configuration risk) |

### 2.2 Out of scope
`apps/**`, the `$DCA` token (not in the repo), Morpho Blue, Uniswap V3/V4, Ramses, the Stock Token contracts and Paxos USDG themselves (their documented behaviour was used as input), the Robinhood Chain sequencer/bridge.

### 2.3 What we borrowed from the reference reports

Before starting, the structure and failure modes of published audits were reviewed:

- **CertiK** ([methodology](https://www.certik.com/blog/how-we-audit-a-comprehensive-guide-to-certiks-auditing-methodology)): every finding carries category, severity, location and status, then *Description → Scenario → Proof of Concept → Recommendation*. Centralization is a first-class "Major" category. This report uses that finding layout.
- **Hacken** ([methodology](https://docs.hacken.io/methodologies/smart-contracts/)): severity from *likelihood × impact* adjusted by *exploitability* (privileged vs. unprivileged) and *complexity*; a fixed 15-category checklist (access control, reentrancy, arithmetic, initialisation/upgradeability, business logic, economic attacks, DoS, asset safety, front-running/MEV, randomness, time, external interactions, chain-specific, gas, documentation mismatch); a code-quality score; PoCs mandatory for High/Critical. §2.5 records the checklist result; §7 gives the scores.
- **What went wrong elsewhere.** [Merlin DEX](https://www.fxstreet.com/cryptocurrencies/news/zksync-dex-merlin-hacked-for-182-million-immediately-after-certik-audit-202304261156) lost $1.8M days after an audit that had *flagged* centralization: a privileged key held unlimited approvals over pool funds. [Swaprum](https://www.dlnews.com/articles/defi/defi-protocol-swaprum-in-3m-rug-pull-was-certik-audited/) was drained through an admin capability the report listed but did not weigh. [Mango Markets](https://blockworks.com/news/defi-platform-exploited-for-14-5m-despite-security-audits) lost $112M to price manipulation of the reference its contracts trusted. The common thread — *admin approvals and manipulable price references are accepted as "operational" and then exploited* — is exactly the profile of H-01 and M-03 here, which is why they are not downgraded on the strength of process mitigations.

### 2.4 Severity model

Severity = **impact × likelihood**, then adjusted one step down when exploitation needs a privileged key (Hacken's "dependent" exploitability).

| | Likelihood High (unprivileged, cheap, repeatable) | Medium (needs capital, timing or a role) | Low (owner key / rare state) |
|---|---|---|---|
| **Impact High** (loss or permanent lock of user funds, core function broken) | Critical | **High** | Medium |
| **Impact Medium** (bounded loss, degraded function, funds diverted to a protocol address) | High | **Medium** | Low |
| **Impact Low** (dust, griefing, admin-recoverable) | Medium | Low | Informational |

### 2.5 Checklist result (Hacken's 15 categories)

| Category | Result |
|---|---|
| Access control | Sound. Every admin path is `onlyOwner`/`onlyFeeManager`/`onlyOperator`; user paths check plan ownership; `advanceEpoch` is keeper-gated by default; `EpochKeeper` execution is operator-only. Permissionless by design: `depositUSDG` (any plan), `prunePlan`, adapter `quoteRoute`, `wrapEth`, `skim` (→ M-01). |
| Reentrancy | All vault entry points `nonReentrant`; `Zap`, `FeeReceiver` guarded; router/adapters stateless between transactions; callbacks authenticated (V3: `msg.sender == pool && verifiedPool`; V4: `msg.sender == poolManager`). Slither's hits are all on guarded paths or event-after-call (§8). |
| Arithmetic | `SafeCast` everywhere, `Math.mulDiv`, no `unchecked`. Rounding favours users on stock distribution and the pool on internal shares; the one user-unfavourable rounding (fee on unspent notional in partial fills) is a documented product decision. |
| Initialisation / upgradeability | No proxies; constructors validate inputs and origin alignment; `Ownable2Step` everywhere (I-01 on `renounceOwnership`). |
| Business logic | **H-01, M-02.** |
| Economic attacks | **M-01, L-01.** |
| Denial of service | Skip-not-revert epoch design is good; residual: **L-03** (boost liquidity), I-05 (`runDue` unbounded), I-06 (quote gas). |
| Asset / balance safety | **M-03, M-04, L-02.** Invariants `usdg == idle + dust`, `stock == accrued + dustPot`, `Σ boostShares == totalShares` hold at CI depth. |
| Front-running / MEV | **H-01** (predictable-timing manipulation; the chain's FCFS sequencer removes same-block sandwiching by third parties but not this). |
| Randomness | n/a. |
| Time | Epoch ids from `block.timestamp`; sequencer drift is seconds; I-09 on the deploy-time origin race. |
| External interactions | Morpho (try/catch on page withdrawals; migration path, L-03), DEX pools (allow-listed), tokens (`_tryTransfer` for stock, SafeERC20 elsewhere), USDG issuer powers (I-10). |
| Chain-specific | ArbOS 61 supports Cancun opcodes (I-11); ERC-8056 multiplier means Stock Token raw balances never rebase (good — the vault's raw accounting is safe) but the DEX price of a raw token steps on a split (I-12). |
| Gas | I-06 (quote cost is O(hops²) simulations), I-07 (`maxPlansPerTx` up to 1,000). |
| Documentation vs. code | NatSpec claim "an override picks a path, never a worse price" is false when the auto-route has no quote (M-02); `Zap` NatSpec still describes removed zap-at-epoch plans (I-13). |

---

## 3. System overview and threat model

```
user ──USDG/ETH──▶ PlanVault (Daily | Weekly | Monthly)          ── fees ──▶ FeeReceiver ──70%──▶ treasury
                      │  idle USDG (or lent via BoostLib ──▶ MorphoBlueStrategy ──▶ Morpho Blue)      └─30%──▶ buyback $DCA → burn
                      │
   operator ─ EpochKeeper ─▶ advanceEpoch(stock, limit, override?)
                      │
                      ▼  one aggregate USDG→stock swap per page
               AggregatorRouter (allow-listed hops, impact cap vs slot0) ──▶ UniV3 / Ramses / UniV4 adapters ──▶ pools
                      │
                      ▼  pro-rata stock to plans (auto-distribute or accrue) ; claims by plan owner
```

| Actor | Can | Cannot | Bound today | Findings |
|---|---|---|---|---|
| **Anyone** | fund any plan; prune empty plans; call router/adapters with own tokens; supply to Morpho on the strategy's behalf; trade the pools the vault buys from | touch balances, trigger epochs, pass overrides | — | **H-01** (pool state at the scheduled time is theirs to set), **M-01** (donation before first deposit) |
| **Plan owner** | deposit, withdraw idle (fee), claim (fee), pause, boost/unboost, set amount/recipient | affect other plans | own funds | L-01 (perk timing) |
| **Operator** (EpochKeeper role; owner always is one) | choose *when*, *page size* and *path/minOut* of every epoch fill | pull funds directly | `minOut ≥ max(auto floor, path floor)` — both computed from the pool state in the same block | **M-02** (uncapped path impact, second-hop refunds to treasury) |
| **feeManager** | set every fee ≤ 90 bps, keeper tip ≤ 50%, swap slippage ≤ 5% | anything else | — | I-03 |
| **Owner** (multisig, 2-step) | set router, strategy, fee recipient, hops/pools/adapters, keepers, thresholds, minimums, pause | change epoch length, exceed fee caps | **none on custody**: standing max approvals (**M-03**); no timelock (I-02) |
| **Morpho market** | be illiquid, accrue bad debt | — | boosted funds only | L-03 |
| **Stock Token issuer / USDG issuer** | pause, freeze, blocklist (documented for Paxos tokens) | — | systemic | I-10 |

Value at risk: all idle USDG in the three vaults (custody: owner via M-03; per-page fraction via H-01/M-02), all boosted USDG (Morpho + M-01), accrued stock (only via the claim fee bypass L-01, fee side).

---

## 4. Findings summary

| ID | Title | Severity | Exploitable by | PoC (`contracts/test/audit/v0.3/`) |
|---|---|---|---|---|
| **H-01** | Epoch purchases have no manipulation-resistant price reference; timing is public → cross-block value extraction from every page | **High** | anyone with capital | `Audit3.H01.PriceManipulation` (2) |
| **M-01** | Zero-share deposits: a donation to an empty `MorphoBlueStrategy` (Morpho `supply` on its behalf, or `skim`) makes every later boosted deposit worth 0, permanently | **Medium** | anyone (griefing, attacker pays ≥ victims' loss) | `Audit3.M01.StrategyDonation` (4) |
| **M-02** | Route override floor has no impact cap; a partially filled second hop forwards users' WETH to the treasury (also on the auto path within the cap) | **Medium** | operator (uncapped fill); anyone shaping pool liquidity (auto-path leak) | `Audit3.M02.OverrideUncapped` (3) |
| **M-03** | Standing `type(uint256).max` approvals make `setRouter` / `setBoostStrategy` single-transaction custody transfers; no timelock | **Medium** (Centralization / Major) | owner key | `Audit3.M03.AdminApprovalDrain` (2) |
| **M-04** | Unaccounted USDG / Stock Token balances in a vault are unrecoverable (no skim, rescue refuses them) | **Medium** (impact: permanent lock; likelihood low) | anyone who sends; issuers | `Audit3.L04.UnaccountedBalances` (1) |
| L-01 | $DCA perks are spot balances read in the user's own call → claim fee bypass with a transient balance | Low | any user | `Audit3.L01.ClaimFeeBypass` (1) |
| L-02 | `Zap` strands the router's first-hop refund (partial fills) with no sweep | Low | — (user loss on liquidity edge) | `Audit3.L02.ZapStrandsRefund` (2) |
| L-03 | Boost operational edges: flag without strategy bricks deposits; migration impossible while the market is illiquid; a borrower can make boosted plans miss an epoch | Low | user / owner / borrower | `Audit3.L03.BoostEdgeCases` (3) |
| L-04 | Purchase fee, keeper tip and impact cap all measured against the executing block's pool state; `feeManager` may widen slippage to 5% | Low | feeManager | — |
| I-01…I-14 | Informational (§6) | Info | — | — |

Run: `cd contracts && forge test --match-path "test/audit/v0.3/*" -vv`

---

## 5. Detailed findings

### H-01 · Epoch purchases have no manipulation-resistant price reference; timing is public

| | |
|---|---|
| **Category** | Business logic / MEV / oracle |
| **Severity** | **High** (impact High: unbounded fraction of every page; likelihood Medium: needs capital and a few seconds of exposure, no privilege, no mempool access, repeatable every epoch) |
| **Location** | [`PlanVault._buyStock`](contracts/src/vault/PlanVault.sol#L517-L558) (`quoted`, `minOut`), [`AggregatorRouter._bestHop`](contracts/src/router/AggregatorRouter.sol#L258-L272) / [`_bestTwoHop`](contracts/src/router/AggregatorRouter.sol#L277-L307) (impact vs `slot0`), [`UniV3Adapter._midOut`](contracts/src/router/adapters/UniV3Adapter.sol#L215-L224) |
| **Status** | Open. Listed as "H-02, mitigated / open by decision" in v0.2 with operational mitigations. Re-rated here with new evidence. |

**Description.** Every number the vault checks before it spends user money — the router quote, `minOut = quote × (1 − swapSlippageBps)`, and the price-impact cap — is derived from the pool's *current* state in the executing block. None of them measures the distance of that state from a fair price. The impact cap in particular bounds the page's *own* slippage relative to the pool mid it finds, so a pool that was pushed 70% away from fair passes the cap exactly as a fair pool does (PoC 2: pushes of $100k, $500k and $2M all pass).

The v0.2 report closed the *same-block* version (operator-only triggering) and accepted a residual "block-level sandwich" mitigated by private relays and an optional operator-supplied reference `minOut`. On Robinhood Chain there is no public mempool and the sequencer orders first-come-first-served, which does make same-block sandwiching by third parties impractical. It does nothing against the attack that matters here, which does not need ordering at all:

**Scenario.**
1. The keeper documentation fixes the schedule: Daily at 00:00 UTC, Weekly Monday 00:00, "poll a few minutes after each boundary". `isEpochDue` is public, `EpochKeeper.dueJobs()` lists what is about to be bought.
2. Seconds before the operator's expected transaction, the attacker buys the stock in the approved pool (block N). The pool is now priced above fair.
3. The operator's transaction lands (block N+k): the quote, floor and impact cap are all computed on the pushed pool, everything passes, the page fills at the pushed price.
4. The attacker sees the fill in the sequencer feed (soft-confirmed within a block) and sells back (block N+k+1). Their only cost is fees plus arbitrage exposure during the hold — on a new chain with thin stock-token pools and few arbitrageurs, a few seconds of hold is cheap.

**Proof of concept** — `test_crossBlockManipulation_takesValueFromEveryPlanOnThePage`: $2M USDG / 4,000 NVDA constant-product pool (a 15k page has 0.8% impact, well inside the cap), three plans of 5,000 USDG. Attacker pushes with 600k USDG in block N, operator runs the epoch in block N+1 with the auto-route and no override, attacker unwinds in block N+2.

```
fair NVDA        29.540
manipulated NVDA 17.511   (users receive 59% of fair)
attacker profit  5,623 USDG on a 15,000 USDG page
```

`test_impactCapIsBlindToThePushSize` shows the cap passing after pushes of any size.

Note also the inverse: in a *$1M* pool the same 15k page is already over the 150 bps cap and is **skipped** (nobody buys); the attacker's push, by deepening the USDG side, is what made the fill possible. Page skipping is itself steerable by whoever shapes the pool.

**Why the operational mitigations are not enough.** (a) Private relays are irrelevant on this chain and would not help anyway — the attack precedes the transaction. (b) The reference-price `minOut` override is optional, per-run, and requires the operator bot to fetch and sign a price for every stock every epoch; a bot that omits it (or is compromised, see M-02) leaves users exposed. (c) Randomising execution inside the epoch widens the attacker's hold window but does not remove it; `isEpochDue`/`dueJobs` still announce the target.

**Recommendation** (contract-level, in order of preference):

1. **External floor in `_buyStock`.** Robinhood Chain publishes a Chainlink `AggregatorV3Interface` feed per Stock Token (multiplier already applied). Owner-set `feed[stock]` (+ `maxStaleness`, `maxDeviationBps`); compute `expectedOut = amountIn × 10^stockDec / price` (adjusting USDG/feed decimals) and require `quoted ≥ expectedOut × (1 − maxDeviationBps)` — otherwise **skip the page** (`EpochPageSkipped("price deviates")`) so the attacker gains nothing and the plans try again next epoch. Apply the same check to the override branch. ~40 lines; the feed validation pattern (price > 0, `updatedAt` staleness, `answeredInRound`) is standard.
2. **Or reuse the guard already written for the fee sink.** `FeeReceiver._checkPath` (spot tick within `guardMaxTicks` of the `guardWindow` TWAP for every V3-style pool on the path) is exactly the guard the vault lacks. Move it into a small shared library and call it from `_buyStock` for the chosen path; skip the page on `PriceDeviates`. Requires observation cardinality on the approved pools (the FeeReceiver runbook already covers this).
3. **Commit-execute** as defence in depth: record the quote in one transaction and execute ≥ N blocks later against the committed `minOut`; forces the attacker to hold the pushed price for N blocks.
4. Keep the operator reference-price override as an additional layer, not the only one.

Choosing (1) also removes the fee sink's dependence on observation cardinality if you use the same feeds there.

---

### M-01 · Donation to an empty `MorphoBlueStrategy` makes later boosted deposits worth zero

| | |
|---|---|
| **Category** | Economic / ERC-4626 share inflation (griefing variant) |
| **Severity** | **Medium** (impact High: permanent loss of the deposit; likelihood Medium: unprivileged and cheap to trigger, but the attacker's donation is also lost, so it is griefing rather than theft; window open at launch and whenever the strategy empties) |
| **Location** | [`MorphoBlueStrategy`](contracts/src/boost/MorphoBlueStrategy.sol) (no `_decimalsOffset` override, no zero-share check), [`skim`](contracts/src/boost/MorphoBlueStrategy.sol#L146-L151), [`BoostLib._deposit`](contracts/src/libraries/BoostLib.sol#L158-L167) (does not verify what the strategy credited), [`Deploy.s.sol`](contracts/script/Deploy.s.sol#L184-L193) (strategy deployed unseeded) |
| **Status** | Open |

**Description.** `MorphoBlueStrategy` is an OpenZeppelin ERC-4626 with the default decimals offset, i.e. one virtual share. Deposits are gated to the vaults, but the strategy's `totalAssets()` is its Morpho supply position, and **anyone can grow that position**: Morpho Blue's `supply(…, onBehalf = strategy)` has no authorization check, and the strategy's own `skim()` is permissionless. While `totalSupply() == 0`, a deposit of `a` mints `a × 1 / (totalAssets + 1)` shares — zero whenever `a ≤ totalAssets`. OZ's `deposit` does not revert on zero shares; it pulls the assets and mints nothing. The vault, in `BoostLib._deposit`, credits the plan with internal shares computed *before* the strategy call and never checks how many strategy shares (or how much value) came back. The plan therefore shows `boostPrincipal = a` and a boosted value of 0, and the assets belong to the virtual share forever. Each swallowed deposit raises `totalAssets`, so the threshold snowballs.

**Scenario.** Strategy deployed by `Deploy.s.sol`, no deposits yet. Attacker supplies 11 USDG on the strategy's behalf. Alice opens a boosted plan with 10 USDG → 0 strategy shares, value 0. Bob deposits 20 USDG → 0 shares. Alice's `withdrawIdle(max)` reverts `ZeroAmount`. Carol deposits 1,000 USDG, gets 24 shares and works; Alice and Bob stay at zero and 41 USDG are owned by nobody. `test_windowReopensWhenTheStrategyEmpties` shows the same after every boosted user has unboosted (supply back to a few wei of dust shares): a 1,000 USDG donation then swallows a 50 USDG deposit.

**Proof of concept** — `Audit3.M01.StrategyDonation` (4 tests, all on the unmodified code).

**Recommendation** (all three, they are independent and cheap):
1. `MorphoBlueStrategy`: `function _decimalsOffset() internal pure override returns (uint8) { return 6; }` (10⁶ virtual shares; a 10 USDG deposit then needs a > $10M donation to round to zero, and the rounding loss per deposit is bounded by `totalAssets / 10⁶`).
2. `BoostLib._deposit`: measure `s.balanceOf(this)` and `poolAssets` before/after and revert (`BoostUnavailable` or a new `BoostDepositLost`) if the share delta is zero or the value delta is below `assets − 1`. This turns any future strategy misbehaviour into a revert instead of a silent loss.
3. `Deploy.s.sol`: seed the strategy in the same script (temporarily allow the deployer as depositor, deposit e.g. 100 USDG, transfer the shares to `0x…dEaD`, revoke the depositor). Document that a migration target must be seeded too.

---

### M-02 · Route override floor is uncapped; second-hop refunds go to the treasury

| | |
|---|---|
| **Category** | Business logic / privileged-role bound / asset safety |
| **Severity** | **Medium** (impact High on the page: up to the whole notional; likelihood Low–Medium: needs the operator key *or*, for the leak, a liquidity edge on the second hop) |
| **Location** | [`PlanVault._buyStock` override branch](contracts/src/vault/PlanVault.sol#L524-L537), [`AggregatorRouter.quotePath`](contracts/src/router/AggregatorRouter.sol#L179-L191) (no impact check), [`AggregatorRouter._execute`](contracts/src/router/AggregatorRouter.sol#L239-L247) (`refundTo = recipient` for later hops), [`PlanVault._buyStock` L555-556](contracts/src/vault/PlanVault.sol#L555-L556) (`wethIn → wethDust`), [`_sweepDust`](contracts/src/vault/PlanVault.sol#L648-L661) |
| **Status** | Open (v0.2 "R-02 trusted-operator override" and "N-02" partially cover it; the impact-cap gap and the WETH leak are new) |

**Description.** The override's floor is `max(autoFloor, quotePath(path) × (1 − slippage))`. `quotePath` simulates the path but applies **no impact cap** and no external reference. So precisely when the auto-route has no in-cap quote — the page is larger than any approved pool absorbs within 150 bps — the auto floor is 0 and the only bound is what the chosen path delivers *right now*, at any impact. The NatSpec promise "an override picks a path, never a worse price" therefore only holds when an auto quote exists. Combined with H-01 (the path quote is manipulable) a compromised operator key is a per-page extraction key with no on-chain bound, and the page-size lever (`limit`) that would make the auto-route work is left to the same operator.

The second part is independent of the operator. When a two-hop path's second hop fills only partially (its pool runs out of in-range liquidity), the router forwards the unspent **WETH** — which is the users' converted USDG — to the vault, and the vault books it as `wethDust` and forwards it to `feeRecipient` in the same transaction. A first-hop residual, by contrast, is returned to the plans pro rata. The auto path accepts such a route when the unfilled fraction keeps the combined impact under the cap (≈ up to 1.4%); the override path accepts any fraction.

**Scenario / PoC** (`Audit3.M02.OverrideUncapped`):
- `test_overrideFillsBeyondTheImpactCap_whenAutoRouteHasNoQuote`: $200k pool, 15k page (~7% impact) → auto-route `NoRoute`, page skipped; operator override fills at the 7%-impact price.
- `test_partialSecondHop_sendsUsersWethToTheTreasury`: USDG→WETH deep, WETH→NVDA with 10 NVDA of liquidity. Override fills: users are charged the full 15,000 USDG, receive 10 NVDA (~$5k) and **3.29 WETH (~$10k) of their money is forwarded to the treasury**; `totalUsdgIdle` shows no residual returned.
- `test_autoRoute_smallPartialSecondHop_stillLeaksToTreasury`: same on the auto path with a 1% partial second hop, inside the cap.

**Recommendation.**
1. Make `quotePath` return the path's impact (per-hop mids are already computed by the adapters; combine as `_bestTwoHop` does) and have the vault require `impact ≤ maxPriceImpactBps` for overrides. Better: also apply the H-01 external floor to overrides.
2. Treat second-hop refunds as user money: either revert the page on a partial later hop (router flag `requireFullFill` for vault callers; the page is then skipped, not consumed) or convert the WETH back to USDG through the approved WETH→USDG hop in the same transaction and return it pro rata with the USDG residual. Do not route it to `feeRecipient`.
3. Consider removing the override's price authority entirely: keep `path` selection (useful when a pool is degraded) but always floor at the auto/external reference; when the auto-route has no quote, the correct operator tool is a smaller `limit`, not a worse price.

---

### M-03 · Standing unlimited approvals turn `setRouter` / `setBoostStrategy` into single-transaction custody transfers

| | |
|---|---|
| **Category** | Centralization / privilege (CertiK "Major") |
| **Severity** | **Medium** (impact Critical: every idle USDG and WETH in the vault; likelihood Low: owner key; no delay, no bound, no interface check) |
| **Location** | [`PlanVault._setRouter`](contracts/src/vault/PlanVault.sol#L999-L1010) (`forceApprove(newRouter, max)` for USDG and WETH), [`BoostLib.setStrategy`](contracts/src/libraries/BoostLib.sol#L146-L149) (`forceApprove(strategy, max)`), [`PlanVault.setBoostStrategy`](contracts/src/vault/PlanVault.sol#L719-L721) |
| **Status** | Open (v0.2 I-13 "admin timelock" listed as unchanged) |

**Description.** The vault approves `type(uint256).max` of USDG and WETH to whatever address the owner passes to `setRouter`, and `type(uint256).max` of USDG to whatever passes `setBoostStrategy` (the only check is `asset() == usdg`). Neither call verifies a router/strategy interface, neither is delayed, and the approval is usable by the target contract immediately and independently of any swap or deposit. The `Overspent` / `SwapReturnedZero` checks in `_buyStock` bound what a malicious router can take *during a page*; they do not bound what it can `transferFrom` on its own. `FeeReceiver` was written the right way (exact `amountIn` approval before the call, reset to 0 after) — the vault, which holds the user funds, was not.

This matters beyond "the owner is trusted": it is the difference between a compromised owner key having to execute a swap-shaped action bounded by the impact cap and page size, and a compromised key draining every vault in two transactions with no user-visible warning beyond an event. The multisig's L2 also has instantly upgradeable system contracts (L2BEAT), so a timelock at the protocol level is the only delay users would get.

**Proof of concept** — `Audit3.M03.AdminApprovalDrain`: `setRouter(EvilRouter)` then anyone calls `evil.drain()` → 200,000 USDG of two users gone, their withdrawals revert; same with `setBoostStrategy(EvilStrategy)` whose only ERC-4626 method is `asset()`.

**Recommendation.**
1. Per-call exact approvals: in `_buyStock` and `_zapWethDeposit` approve `amountIn` immediately before `swapWithRoute`/`swap` and `forceApprove(…, 0)` after; in `BoostLib._deposit` and `setStrategy` approve `assets`/`moved` before `deposit` and reset after. Remove the standing approvals from `_setRouter` and `setStrategy`. Gas cost: two `SSTORE`s per page and per boost deposit.
2. Interface sanity in `setRouter` (`IAggregatorRouter(newRouter).weth() == _weth`, `maxPriceImpactBps() > 0`) and in `setBoostStrategy` (`totalAssets()`/`convertToAssets` callable), as `FeeReceiver._setRouter` does.
3. Put the owner behind a `TimelockController` (≥ 24–48 h) for `setRouter`, `setBoostStrategy`, `setFeeRecipient`, `approveHop`, `setAdapter`, `registerPool`/`addPool`; keep `pause`, `revokeHop`, `setKeeper(…, false)` on a fast path. Emit and monitor `RouterSet` / `BoostStrategySet`.

---

### M-04 · Unaccounted USDG / Stock Token balances in a vault are unrecoverable

| | |
|---|---|
| **Category** | Asset safety / recoverability |
| **Severity** | **Medium** (impact High: permanent lock of whatever arrives; likelihood Low: needs an external transfer — an issuer distribution, a mistaken send, a future token feature) |
| **Location** | [`PlanVault.rescueERC20`](contracts/src/vault/PlanVault.sol#L757-L767) (refuses USDG, WETH, strategy shares and every `isKnown` stock), [`_sweepDust`](contracts/src/vault/PlanVault.sol#L648-L661) (moves only the `usdgDust` counter) |
| **Status** | Open |

**Description.** The vault's accounting is counter-based (`totalUsdgIdle + usdgDust`, `totalStockAccrued + dustPot`), which is correct and robust, and `rescueERC20` is rightly forbidden from touching those tokens. But nothing reconciles `balanceOf` with the counters: any USDG or Stock Token that reaches the vault outside its own flows is invisible to every function and can never leave. Robinhood's ERC-8056 design means splits and dividends do **not** change raw balances (good), but issuer distributions in another form, refunds from a future DEX/hook, a partner airdrop, or a plain mistaken transfer all land here. The PoC shows 1 NVDA and 500 USDG stuck after every user has exited.

**Recommendation.** Add an owner/feeManager `skim(token)` that books the excess into the existing user-favourable sinks rather than to the treasury: `stock.balanceOf − totalStockAccrued − dustPot → dustPot[stock]` (distributed pro rata to that stock's plans at the next epoch) and `usdg.balanceOf − totalUsdgIdle − usdgDust → usdgDust` (or, if you prefer, a new `usdgExcess` swept to the treasury — a product decision, but make it possible). Keep the invariants exact by asserting them in `skim`.

---

### L-01 · $DCA perks are spot balances → claim fee bypass with a transient balance

| | |
|---|---|
| **Severity** | Low (impact Low–Medium: the protocol's 25 bps claim fee; likelihood High for any user with access to $DCA liquidity) |
| **Location** | [`PlanVault._claim`](contracts/src/vault/PlanVault.sol#L933) (`isAutoDistribute(p.owner)` at claim time), [`_perks`](contracts/src/vault/PlanVault.sol#L972-L976) |

`claim` is the user's own transaction, so the perk check is atomic with anything they do around it: borrow ≥ `autoDistributeThreshold` $DCA (flash loan, lending market, a friend), claim with a 0 fee, return it. PoC: `Audit3.L01.ClaimFeeBypass` — the treasury receives 0 instead of 25 bps. (The epoch-time fee halving is operator-timed and only predictable, not atomic — v0.2 I-10.) **Recommendation:** snapshot-based perks (balance at the previous epoch boundary, or a minimum holding age via a checkpointed token), or compute claim perks from the balance at the plan's last fill.

### L-02 · `Zap` strands the router's first-hop refund

| | |
|---|---|
| **Severity** | Low (bounded by the unfilled fraction the impact cap lets through, ~≤ 1.5%; permanent) |
| **Location** | [`Zap._wethToUsdg`](contracts/src/periphery/Zap.sol#L83-L86), [`swapUsdgForEth`](contracts/src/periphery/Zap.sol#L53-L66); [`AggregatorRouter._execute` refund to `msg.sender`](contracts/src/router/AggregatorRouter.sol#L244) |

The router refunds an unspent first-hop input to `msg.sender`; for `Zap` that is the `Zap` contract, which has no sweep and passes only `msg.value`/`amountIn` onward. PoC: `Audit3.L02.ZapStrandsRefund` — 0.1 ETH of WETH and 100 USDG stranded on 10%-fill routes. **Recommendation:** measure the input balance delta in `Zap` and return `amountIn − spent` to the user (as `PlanVault._zapWethDeposit` does), or add a `refundTo` parameter to `router.swap`.

### L-03 · Boost operational edge cases

| | |
|---|---|
| **Severity** | Low |
| **Location** | [`BoostLib.setPlanBoost`](contracts/src/libraries/BoostLib.sol#L63-L82) (no strategy check when `usdgIdle == 0`), [`BoostLib.setStrategy`](contracts/src/libraries/BoostLib.sol#L131-L152) (atomic full redeem), [`BoostLib.withdrawPage`](contracts/src/libraries/BoostLib.sol#L119-L126) |

PoC `Audit3.L03.BoostEdgeCases`:
- **Flag without strategy.** With the strategy cleared, `setPlanBoost(true)` on an empty plan succeeds (nothing to lend, no check); every subsequent deposit to that plan by anyone — the owner, a friend, `Zap.depositEthAsUsdg` — reverts `BoostUnavailable` until the owner unboosts. *Fix:* require `pool.strategy != 0` when enabling.
- **Migration blocked while illiquid.** `setBoostStrategy(new)` redeems the whole position atomically; when the market is fully utilised (`liquidity() == 0`) it reverts, and clearing reverts `BoostInUse`. The owner cannot leave a bad market exactly when they want to. *Fix:* allow a migration that leaves the old position in place (old strategy stays withdrawable per plan; new deposits go to the new one), or a partial redeem loop.
- **Borrower-driven epoch miss.** A borrower who takes the free liquidity just before the epoch makes every boosted plan on the page "sit out" (dropped fills, never caught up); unboosted plans fill. Inherent to lending; document it in the boost UI (the existing `test_fill_illiquidMarket_boostedPlansSitOut` covers the mechanism) and consider filling boosted plans from `usdgIdle` first up to a small buffer.

### L-04 · Slippage/tip parameters and `feeManager` scope

| | |
|---|---|
| **Severity** | Low |
| **Location** | [`PlanVault.setFees`](contracts/src/vault/PlanVault.sol#L669-L680), `MAX_SWAP_SLIPPAGE_BPS = 500`, `MAX_KEEPER_TIP_BPS = 5_000` |

`feeManager` (a hot-wallet-style role, not necessarily the multisig) can widen `swapSlippageBps` to 5% — which, with H-01, is the fraction of every page an attacker can take *without* moving the impact cap — and can route 50% of purchase fees to `msg.sender` of `advanceEpoch` as tips. **Recommendation:** owner-only for `swapSlippageBps` and `keeperTipBps` (or lower caps: ≤ 100 bps / ≤ 1,000 bps), and keep the H-01 external floor independent of `swapSlippageBps`.

---

## 6. Informational

| ID | Note | Location |
|---|---|---|
| I-01 | `renounceOwnership` remains callable on every `Ownable2Step` contract; a mistaken call bricks admin forever (no upgrade path). Override it to revert. | all contracts |
| I-02 | No timelock on any owner action; every admin change is instant (see M-03). | all |
| I-03 | `feeManager` may be `address(0)`-cleared but has no 2-step; document it as a hot role and monitor `FeeConfigSet`. | `PlanVault.setFeeManager` |
| I-04 | `EpochKeeper._forwardTips` sends tips to `msg.sender`; when that is the Chainlink Automation forwarder contract the USDG is stuck there. Make the tip recipient configurable. | [`EpochKeeper.sol#L218-L223`](contracts/src/keeper/EpochKeeper.sol#L218-L223) |
| I-05 | `runDue` / `checkUpkeep` / `dueJobs` loop over every job; with 3 vaults × N stocks all due at the same boundary, `runDue` executes N pages in one transaction and will exceed the block gas limit; `checkUpkeep` may exceed Automation's simulation limit. `run(index)` is the practical path — document it; consider a cursor for `runDue`. | [`EpochKeeper.sol#L144-L179`](contracts/src/keeper/EpochKeeper.sol#L144-L179) |
| I-06 | Quote cost is O(hops²) full swap simulations: with `MAX_HOPS_PER_PAIR = 8` on both legs a single `quoteWithImpact` can run 8 direct + 8 first-leg + 64 second-leg simulations (~100k gas each on real V3 pools). Keep approved hops per pair to 1–3 and memoise the second-leg quote per distinct `o1`. | [`AggregatorRouter._bestTwoHop`](contracts/src/router/AggregatorRouter.sol#L277-L307) |
| I-07 | `maxPlansPerTx` may be set to 1,000; a page of 1,000 plans (≈ 3 `SSTORE`s each plus perk calls) is likely above the block gas limit. Cap at ~250 or document `limit`. | `PlanVault.setMaxPlansPerTx` |
| I-08 | `quoteRoute` on both adapters is public and non-view and caches `verifiedPool[pool] = true` for any factory pool; harmless (only factory pools) but it lets anyone re-verify a pool after `unregisterPool`. Treat `revokeHop` as the only real off-switch (already documented). | [`UniV3Adapter.sol#L111`](contracts/src/router/adapters/UniV3Adapter.sol#L111) |
| I-09 | `Deploy.s.sol` derives `origin` from the simulation timestamp; if the broadcast lands after the day/week boundary the constructor reverts `BadOrigin` (safe, but re-run). | [`Deploy.s.sol#L140-L146`](contracts/script/Deploy.s.sol#L140-L146) |
| I-10 | External issuer powers: Paxos USDG carries freeze/blocklist roles; a frozen vault address locks everything, a frozen user cannot withdraw. Robinhood Stock Tokens are minted/burned only by the issuer; their pause powers are undocumented. Add to SECURITY.md as accepted systemic risk. | — |
| I-11 | `evm_version = cancun` is supported on ArbOS 61 (the Cancun opcode set landed in ArbOS 20–30, Prague in ArbOS 40); `prague` would also be available. OZ 5.1.0 → latest 5.x is advisable (no advisory affects the components used). | `foundry.toml` |
| I-12 | ERC-8056: a Stock Token split changes `uiMultiplier`, not balances, so the vault's raw accounting is unaffected, **but** the raw-token DEX price steps by the split ratio at `effectiveAt`. Any reference-price guard (H-01) must use a multiplier-aware source (the Chainlink feeds are) or reset its TWAP window across `UIMultiplierUpdated`. Frontends must display `stockAccrued × uiMultiplier`. | — |
| I-13 | Documentation drift: `Zap` NatSpec still refers to "zap-at-epoch plans whose owner wants USDG credited instead of WETH" (feature removed in v0.2); `WethZapped` names its first parameter `wethIn` but receives `spent`; `IEpochAdvanceable` is unused; `TwapOracle` NatSpec says "nothing in the vault depends on it" while `FeeReceiver` now does. | `Zap.sol`, `IPlanVault.sol`, `IEpochAdvanceable.sol`, `TwapOracle.sol` |
| I-14 | Minor hygiene: `Zap` and `VaultDirectory.set` have no zero-address checks; `hopKey` includes the informational `fee` field so one pool can be approved under several keys (owner error only, counts against `MAX_HOPS_PER_PAIR`); `_tryTransfer` forwards all gas to the stock token; `MorphoBlueStrategy` shares are freely transferable ERC-20s (fine, the vault never transfers them, but a future `rescueERC20` change must keep excluding them). | various |

---

## 7. Code quality assessment

| Dimension (Hacken) | Score | Notes |
|---|---|---|
| Documentation | **9/10** | README/SECURITY.md/NatSpec are unusually thorough and honest about trade-offs; minor drift (I-13). |
| Code quality | **9/10** | Small functions, explicit phases (`_collect → _buyStock → _commitSpend → _payFees → _distribute → _finalizePage`), custom errors, events on every admin path, SafeERC20/SafeCast throughout, lint-clean. Vault at the EIP-170 edge (972 B headroom) constrains fixes — the H-01 floor and M-03 approvals fit; anything larger needs another linked library. |
| Architecture | **7/10** | Allow-listed routing, skip-not-revert epochs and counter-based accounting are strong choices. Weak points are the missing external price reference (H-01), the asymmetry between `FeeReceiver`'s guards/approvals and the vault's (H-01, M-03), and no reconciliation path for stray balances (M-04). |
| Test coverage | **9/10** | 358 tests → 376 with this suite; 98.1% lines / 97.0% statements / 90.0% branches on `src`; invariant handler with partial fills, route outages, boost toggles, liquidity crunches and bad debt, green at CI depth. Gaps: no fork test against live Morpho / Uniswap; nothing exercised an empty-strategy deposit (M-01) or a partial second hop (M-02) before this review. |
| Security posture | **6/10** | Excellent on the classic classes (reentrancy, access control, arithmetic, callbacks). The residual risk is concentrated and design-level: price reference, admin blast radius, ERC-4626 edge. |

Trail of Bits maturity view: Arithmetic Satisfactory · Auditing/events Satisfactory · Access controls Satisfactory · Complexity Satisfactory · **Decentralization Weak** (M-03, I-02) · Documentation Strong · Low-level code Satisfactory · **Transaction ordering / price integrity Weak** (H-01, M-02) · Testing Strong.

---

## 8. Appendix — tooling

- **Tests.** `forge test`: 358 pass / 0 fail before this review; `test/audit/v0.3/*`: 18 pass; full suite at CI profile (fuzz 2048, invariants 256×64) with the PoCs included: **376 pass / 0 fail** (38 suites; `VaultInvariants` 10/10, `FeeReceiverInvariants` 5/5).
- **Coverage** (`forge coverage --ir-minimum`, `src/` only): 98.10% lines (1344/1370), 96.97% statements, 89.97% branches, 99.56% functions. `PlanVault` 99.2% lines / 86.9% branches; adapters 92–94% lines.
- **Slither 0.11.6** (`--exclude-informational --exclude-optimization`, src only): 147 results. Triage: `arbitrary-send-eth` (Zap: caller-chosen recipient, by design); `reentrancy-balance` / `reentrancy-eth` / `reentrancy-no-eth` / `reentrancy-benign` / `reentrancy-events` (all on `nonReentrant` paths, or event-after-call, or stateless router — no finding); `uninitialized-state` (mapping, false positive); `incorrect-equality` (balance-delta checks, intended); `unused-return` (`forceApprove`/`deposit` return values, benign — but see M-01 for why checking the strategy's return *would* have helped); `missing-zero-check` (I-14); `calls-loop` (`_perks`, `_tryTransfer` per plan, bounded by `maxPlansPerTx`); `timestamp` (epoch maths, intended). No true positive that is not already a finding above.
- **`forge lint src`**: clean. **Contract sizes**: vaults 23,604 B; router 8,749 B; V3 adapter 5,511 B; V4 adapter 6,056 B; FeeReceiver 8,510 B; strategy 8,392 B; BoostLib 4,322 B.
- **Not run:** the fork suite (`RH_RPC` unset, `config/addresses.rh.json` still has placeholder addresses); formal verification; a live Morpho Blue / Uniswap V4 integration test.

**Reproduce:** `cd contracts && forge test --match-path "test/audit/v0.3/*" -vv`. The PoC files contain no fixes; they will start failing when the corresponding finding is closed, at which point flip the assertions and keep them as regressions (the pattern used by `test/audit/` for v0.1).

---

## 9. Recommendation roadmap

| Priority | Item | Effort | Closes |
|---|---|---|---|
| **P0** | External price floor in `_buyStock` (Chainlink feed per stock, or the `FeeReceiver` TWAP guard as a shared library), applied to auto and override paths; skip the page on deviation | ~60 lines + tests | H-01, most of M-02 |
| **P0** | Per-call exact approvals in the vault (router, strategy); interface checks in `setRouter`/`setBoostStrategy`; `TimelockController` as owner | ~30 lines + ops | M-03, I-02 |
| **P0** | `MorphoBlueStrategy._decimalsOffset = 6`; `BoostLib._deposit` share/value delta check; seed the strategy in `Deploy.s.sol` | ~20 lines | M-01 |
| **P1** | Impact cap (or the P0 floor) enforced for `quotePath`/overrides; second-hop refunds returned to users or the page reverted | ~40 lines | rest of M-02 |
| **P1** | `skim(token)` reconciling stray balances into `dustPot` / `usdgDust` | ~25 lines | M-04 |
| **P1** | Perk snapshotting for claims; owner-only slippage/tip; `setPlanBoost(true)` strategy check; `Zap` refund handling | small | L-01, L-04, L-03a, L-02 |
| **P2** | Non-atomic strategy migration; configurable tip recipient; `runDue` cursor; `renounceOwnership` disabled; docs drift | small | L-03b, I-01, I-04, I-05, I-13 |
| **Before mainnet, non-code** | Fill `config/addresses.rh.json` from official sources and run the fork suite against live Morpho/Uniswap; confirm observation cardinality on every approved pool if the TWAP route is chosen; record USDG/Stock Token issuer powers in SECURITY.md; re-audit the diff after P0/P1 | — | — |

*This report reflects the code as of 2026-09-22. Findings are ordered by the reviewer's assessment of risk to user funds; the severity of H-01 and M-03 in particular is a judgement that operational mitigations should not substitute for contract-level guarantees on a product that custodies retail savings on a schedule everyone can read.*

---

## 10. Remediation status (post-audit, 2026-09-22)

Applied on top of the audited commit for every Medium and Low finding; High and Informational items are left for
manual review as requested. Each fix has a regression in `contracts/test/audit/v0.3/` (the former PoC, flipped to
assert the fixed behaviour); tests marked `test_KNOWN_*` document what is still open by decision.

| ID | Status | What changed | Where |
|---|---|---|---|
| H-01 | **Fixed (contract-level floor)** | New linked `PriceGuardLib`: every epoch purchase's `minOut` must be ≥ the stock's Chainlink reference output × (1 − `maxDeviationBps`, default 300) or the page reverts `PriceDeviates` on both the auto and the override path (not consumed, retried later when the pool is fair). Feeds are `AggregatorV3` "USD per raw token" (Robinhood Chain's feeds apply the ERC-8056 multiplier); per-feed staleness window; optional L2 sequencer uptime feed + grace. **Fail closed:** `requireFeed` defaults to true, so no stock is bought until it has a feed or the owner opts out; `Deploy.s.sol` sets `PRICE_FEEDS` on every vault and aborts if an approved stock lacks one. Residual: the feed itself is trusted (Chainlink); legitimate on-chain/feed divergence beyond the tolerance (after-hours moves, a feed heartbeat lagging a split) delays that stock's buys until the owner widens `maxDeviationBps` or the feed catches up — an availability cost, never a price cost. Randomising the operator's execution time remains worthwhile as a second layer. | `libraries/PriceGuardLib.sol`, `interfaces/IChainlink.sol`, `vault/PlanVault.sol`, `script/*` |
| M-01 | **Fixed** | `MorphoBlueStrategy` uses 10⁶ virtual shares (`_decimalsOffset = 6`; share `decimals()` is now 12). `BoostLib._deposit` measures the strategy shares and value actually credited and reverts `BoostDepositLost` on a zero-share or short deposit. `Deploy.s.sol` / `DeployLocal.s.sol` seed the strategy with `BOOST_SEED_USDG` (default 100) of dead shares. | `boost/MorphoBlueStrategy.sol`, `libraries/BoostLib.sol`, `script/*` |
| M-02 | **Fixed** | `AggregatorRouter.quotePath` computes the path's end-to-end impact and reverts `PriceImpactTooHigh` above `maxPriceImpactBps`, so an override can never accept more impact than the auto-route. The router executes **full fills only**: adapters report a hop that cannot consume its whole input as "no fill" (the simulate sentinel now carries `amountInUsed`), and `_execute` reverts `PartialFill(hop)`. No refund or intermediate is ever forwarded; `wethDust` can no longer be fed by a swap. | `router/AggregatorRouter.sol`, `router/adapters/*` |
| M-03 | **Fixed (contract side)** | No standing approvals anywhere: the vault approves exactly one swap's input before `swapWithRoute` / `swap` and resets it to 0 (also on the caught-revert path); `BoostLib` does the same around every strategy `deposit` (incl. migration and the skip-path `redeposit`). `setRouter` checks `weth()` matches (`RouterMismatch`). **Open (ops decision):** timelock in front of the owner — see the questions in the remediation summary. | `vault/PlanVault.sol`, `libraries/BoostLib.sol` |
| M-04 | **Fixed** | `skim(token)` (owner / feeManager): excess of a listed stock → that stock's `dustPot` (to its plans at the next epoch); excess USDG / WETH → the dust sinks swept to `feeRecipient`. Implemented in the new linked `VaultAdminLib` together with `rescueERC20`, which keeps `PlanVault` under EIP-170 (24,223 B, 353 B headroom). Dust counters moved into a `DustState` struct; the `usdgDust()` / `wethDust()` getters are unchanged. | `libraries/VaultAdminLib.sol`, `vault/PlanVault.sol` |
| L-01 | **Accepted by decision** (fix implemented, then reverted) | The perk is meant to be the live $DCA balance: 25 bps of a claim is small, $DCA volume is welcome, and a fill-time snapshot changed a product promise. `Audit3.L01` pins the accepted behaviour as `test_KNOWN_ACCEPTED_*`. | — |
| L-02 | **Fixed (by M-02)** | With full fills only there is no refund for `Zap` to strand; regression uses the real router + adapter. | — |
| L-03 | **Partly fixed** | `setPlanBoost(true)` reverts `BoostUnavailable` when no strategy is set. **Open:** atomic migration still fails while the market is illiquid (`test_KNOWN_migrationImpossibleWhileMarketIlliquid`) — needs a design decision; borrower-driven epoch miss is inherent and documented (`test_KNOWN_borrowerCanMakeBoostedPlansMissTheEpoch`). | `libraries/BoostLib.sol` |
| L-04 | **Fixed** | `swapSlippageBps` cap 500 → **100**, `keeperTipBps` cap 5,000 → **1,000**; both may only be changed by the owner (the feeManager can still set every fee). | `vault/PlanVault.sol` |
| I-01…I-14 | Open (manual review) | — | — |

**Page semantics (changed after the audit, at the team's request).** A page that cannot be bought no longer *skips* (cursor advanced, plans missed the epoch); it **reverts** with the router's or vault's own error (`NoRoute`, `PriceImpactTooHigh`, `PartialFill`, `InsufficientOutput`, `PriceDeviates`, `QuoteTooSmall`) and the cursor stays, so the operator retries later or with a smaller `limit`. `EpochPageSkipped` no longer exists. To keep one oversized plan from blocking everyone behind it under revert semantics (the v0.1 H-01 shape), pages are now sized on-chain: `maxPageNotional` (vault default 100,000 USDG) with a per-stock override `maxPageNotionalOf[stock]`; a page stops before its USDG notional would exceed the cap (so `limit` is a maximum plan count and pages fit the pools — TWAP over pages without off-chain sizing), and a single plan larger than the cap sits the epoch out with `PlanTooLarge` instead of blocking the page. Size the caps with `forge script script/RouteBench.s.sol` (section 0 prints the largest page each pool fills inside the impact cap) and set them via `PAGE_NOTIONAL_CAPS` at deploy or `setMaxPageNotional` later. Unit tests: `PlanVault.Epoch.t.sol` (`test_pageUnfillable_*`, `test_pageCap_*`); the v0.1 regressions were rewritten for the new semantics. Two operator tools were added: `script/RouteBench.s.sol` (per-pool impact table for 20 → 20M USDG pages, max in-cap page, single vs split routing net of gas; mock or fork mode) and `script/GasSim.s.sol` + `script/gas-sim.sh` (epoch gas per plan count and page size, priced at the live ETH price).

**Price guard operations.** Before mainnet: map every approved stock to its Chainlink feed (`PRICE_FEEDS`), confirm the feed heartbeat (staleness default 25 h) and whether a sequencer uptime feed exists on Robinhood Chain (`SEQUENCER_FEED`), and monitor `PriceDeviates` reverts in the keeper logs — a persistent one means the tolerance or the feed needs attention, not the pool. `PlanVault` was then 24,491 B (85 B under EIP-170); after the exit paths moved into `PlanExitLib` (§11) the margins are Hourly 373 / Daily 373 / Weekly 372 / Monthly 371 / TestVault 416 B. Every further vault change should still go into a linked library; `test/unit/ContractSizes.t.sol` enforces the limit.

**ABI / integration impact** (apps must regenerate their ABIs): `IPlanVault` gained `skim`, `setPriceFeed`, `setPriceGuard`, `priceFeed`, `priceGuard`, `Skimmed`, `PriceFeedSet`, `PriceGuardSet`, `BoostDepositLost`, `NotSkimmable`, `RouterMismatch`, `NotOwner`, `PriceDeviates`, `PriceFeedMissing`, `PriceFeedStale`, `SequencerDown`, `InvalidFeed`; `IPlanVault` also gained `setMaxPageNotional`, `maxPageNotional`, `maxPageNotionalOf`, `MaxPageNotionalSet`, `PlanTooLarge`, `QuoteTooSmall` and lost `EpochPageSkipped`; `IAggregatorRouter` gained `PriceImpactTooHigh`, `PartialFill`; `MorphoBlueStrategy.decimals()` is 12; the vaults link three libraries (`BoostLib`, `VaultAdminLib`, `PriceGuardLib`). Local anvil deployments predate these changes and must be redeployed. Product-visible changes: a router swap either fills in full or reverts; a page too large for the pool is skipped (auto) or refused (override) — operators should page with `limit`; the claim-fee tier is the one held at purchase time.

---

## 11. Post-audit additions — pending review (2026-09-23)

The following code was written after this audit and has **not** been independently reviewed. Only the internal review notes below apply to it.

| Code | What | Status |
|---|---|---|
| `src/libraries/PlanExitLib.sol` (2,306 B, links `BoostLib`) + `PlanVault.closePlan` | The exit paths (`withdrawIdle`, `claim`, `prunePlan`, new `closePlan`) moved into a linked library; `closePlan(planId)` (`nonReentrant onlyPlanOwner`) unboosts, pays idle USDG to the caller, claims accrued stock to the recipient and unindexes, emitting `PlanClosed(planId, owner, usdgOut, stockOut, unindexed)`. Mid-epoch (page cursor open) a still-indexed plan is paused and stays indexed (`unindexed = false`) until `prunePlan` / a later `closePlan`; the record persists and a later deposit re-indexes it. | **Pending review** |
| `src/vault/HourlyVault.sol` | 1 h epochs aligned to the hour (UTC, 24/7), 90 bps default purchase fee (the inclusive `FeeMath` cap — irreversible upward for that deployment), `HOURLY_FEED_MAX_STALENESS` at deploy. Directory order `[hourly, daily, weekly, monthly]`, `vaults()` returns `address[4]`. | **Pending review** |

Sizes (`forge build --sizes`, runtime margin under EIP-170): Hourly 373, Daily 373, Weekly 372, Monthly 371, TestVault 416 B. `forge test`: 480 passing.

**Internal review of `closePlan` (fixed in place):**
- **CP-01 (Low, fixed)** — deferred unindex applied to plans that were already unindexed; now only a still-indexed plan is parked. Regression: `test_closePlan_alreadyUnindexed_whilePending_doesNotParkAndReportsUnindexed`.
- **CP-02 (Info, fixed)** — the `Claimed` event recipient is cached before transfers. PoC: `test_reentryFromStockToken_recipientSwitch_claimedEventNamesTheActualPayee`.
- **CP-02' (Info, fixed)** — the Reentrancy PoC now enforces that `PlanExitLib` dispatches exactly the four pinned selectors `f67c66ae` / `95a29d5f` / `b0d178d8` / `da5ac5e9`.
- **CP-03 (Info)** — frontend consumer note: hide a row on `PlanClosed` or `PlanIndexed(false)`, un-hide on `PlanIndexed(true)` or `Deposited` (a re-funded parked plan emits only `Deposited`); "Delete later" only for `PlanClosed(..., false)`.
- **CEI nuance (Info, accepted)** — in `withdrawIdle`, `totalUsdgIdle` is debited after the USDG transfers (delta returned by `PlanExitLib`, applied by the guarded vault stub). Not externally observable: every fund-touching entry is `nonReentrant` and the unguarded owner setters never read it.
- **L-06 amplified (accepted)** — a fee recipient blocked on USDG or the stock reverts the whole `closePlan`; single legs remain the fallback; allowlist `FeeReceiver` on USDG and every stock (AUDIT-FeeReceiver R-05).

Tests: PoC suite `test/audit/v0.4/` (`Audit4.ClosePlan.BlockedFeeRecipient`, `.Reentrancy`, `.MidEpoch`); new invariants `closed ⇒ balances zero ∧ (unindexed ∨ paused)` and index-entry consistency probed via storage; GasBench `closePlan` plain 83,866 / boosted 101,190 gas. Deployment: `forge script` auto-links `PlanExitLib` and `BoostLib`; verification needs `--libraries` for both; existing deployments must be redeployed to expose `closePlan`.
