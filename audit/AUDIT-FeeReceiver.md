# FeeReceiver — Security Review (v0.1)

> **Automated AI review, not an independent third-party audit.** This report was produced with an AI model (Claude) during development. It has not been reviewed by a professional audit firm and does not replace one.

| | |
|---|---|
| **Target** | [`contracts/src/treasury/FeeReceiver.sol`](../contracts/src/treasury/FeeReceiver.sol) (378 LoC, 8,510 bytes deployed) on top of `4ea7ba0`; solc 0.8.28, via-ir, OZ 5.1.0. Deploy wiring in `script/Deploy.s.sol` / `script/DeployLocal.s.sol`. |
| **Date** | 2026-09-22 |
| **Auditor** | Automated review by Claude (AI). Not an independent third-party audit. |
| **Scope** | The new contract and its interaction with the audited vaults (`feeRecipient`), the `AggregatorRouter` and the `$DCA` token. Vault / router code is unchanged and out of scope (see [`AUDIT.md`](../AUDIT.md)). |
| **Method** | Threat model first (§2), then line-by-line review of the final code; 47 unit tests, 3 vault-integration tests and a 5-invariant handler suite (`fail_on_revert = true`, CI depth: fuzz 2048, invariants 256×64); Slither 0.11.6; end-to-end run of `DeployLocal` on a throwaway anvil with a real `AggregatorRouter → UniV3Adapter → pool` buyback. Six weaknesses were found in earlier drafts of the design during this pass and fixed before the code was finalised (§3). |
| **Result** | **No High or Medium finding remains.** No unprivileged party can move value. Operators can only move value into three places — the treasury, a reserve, or a burn — and the price they pay is bounded on-chain by the router quote, the slippage cap and an on-path TWAP guard. The owner is trusted exactly as it is everywhere else in the protocol. Three Low residuals are accepted with operational mitigations (§4). |

**Severity = impact × likelihood**, as in the protocol audits: Impact High = loss of the reserve or the treasury share; Medium = bounded loss / degraded function; Low = dust, griefing, admin-recoverable. Likelihood High = unprivileged + cheap; Medium = needs a role, capital or conditions; Low = needs the owner key.

Run: `cd contracts && forge test --match-path "test/**/FeeReceiver*" -vv`

---

## 1. What the contract does

Every vault pushes its fees to `feeRecipient` the moment they are taken (USDG purchase / deposit / withdraw fees, USDG + WETH dust, Stock Token claim fees). With a `FeeReceiver` as `feeRecipient`, all of that lands in one contract that then, per token:

```
pending(token) = balanceOf(this) − buybackReserve[token]           // what arrived since the last split
distribute(token):  70% of pending → treasury                     // floor; rounding favours the buyback
                    30% of pending → buybackReserve[token]
buyback(token):     reserve → router → $DCA → burn()  (or 0x…dEaD if the token has no burn)
convert(stock→USDG|WETH): a stock reserve → a base-token reserve  (stocks rarely route to $DCA)
```

The split is a pair of `constant`s (`TREASURY_BPS = 7_000`, `BUYBACK_BPS = 3_000`). There is **no** rescue, sweep or withdraw function: every unit that enters can only leave through the split.

## 2. Threat model

| Actor | Can | Cannot | Bound |
|---|---|---|---|
| **Anyone** | send tokens / ETH here; `wrapEth()` | call `distribute` / `buyback` / `convert`; read anything useful | — |
| **Operator** (owner-set; owner always is one) | choose *when* and *how much* to distribute, convert, buy back; pass a `minOut` **above** the floor | send anything anywhere but `treasury`, a reserve or a burn; sell $DCA; churn USDG↔WETH; bypass the floor, the guard or the split; hold approvals (per-call, reset to 0) | per swap: ≤ `maxSlippageBps` (50 bps, cap 500) under the router quote **and** every pool on the path within `guardMaxTicks` (300 ≈ 3%) of its 30-min TWAP; router impact cap 150 bps still applies |
| **Owner** (multisig, `Ownable2Step`) | set treasury (≠ 0, ≠ self), router (must share WETH), operators, slippage (≤ 500), guard (window / ticks / allow-unguarded) | change the 70/30 split (constants); rescue any token; upgrade | fully trusted, as everywhere in the protocol |
| **Router + adapters** (owner-set) | execute the quoted path | receive more than the exact `amountIn` approved for one call; leave tokens anywhere (unspent input refunds to the receiver and is measured) | receiver checks `out ≥ minOut` on its own balance delta, not on the router's return value |
| **$DCA token** (immutable) | burn or not | make bought tokens linger (a `burn` that does nothing ⇒ `0x…dEaD`; one that burns a different amount ⇒ revert) | — |
| **Fee tokens** (USDG, WETH, listed stocks) | blocklist the treasury | affect any other token's accounting | a blocked token's `distribute` reverts until `setTreasury` |
| **DEX pools on the route** | be manipulated | — | spot must stay within `guardMaxTicks` of the TWAP or the swap reverts (`PriceDeviates`) |

Invariants (enforced by `test/invariant/FeeReceiverInvariants.t.sol`, `fail_on_revert = true`, 16,384 calls per invariant at CI depth):

1. `balanceOf(this) ≥ buybackReserve[token]` and `pending == balance − reserve`, for every token.
2. `treasury.balanceOf(token) == Σ toTreasury` reported by `Distributed` events — nothing else ever reaches the treasury.
3. `buybackReserve[token] == Σ booked + Σ converted-in − Σ spent` — the 30% is fully accounted from booking to burn.
4. `totalBurned == Σ burned`; `$DCA.totalSupply == fees-in + bought − burned`; the receiver never holds bought $DCA after a transaction.
5. Every USDG that left the receiver went to the treasury or into a buyback (`totalSupply − balance == Σ toTreasury + Σ spent`).
6. While a pool on the path deviates beyond `guardMaxTicks`, **every** `buyback` / `convert` reverts (`PriceDeviates`), whatever the operator passes.

## 3. Weaknesses found and fixed during this pass

These were present in earlier drafts of the design and are listed so the reasoning survives. Each has a regression test.

| ID | Sev (as found) | Weakness | Fix | Test |
|---|---|---|---|---|
| D-01 | **Medium** | The `minOut` floor comes from a router quote taken **in the same transaction** as the swap, so a push before the transaction moves the quote too. A rogue operator colluding with a sandwicher (or a builder sandwiching an honest operator) could extract most of the reserve's value over a few buybacks — the vault epochs' H-02 residual, but here the reserve is exactly what an attacker wants. | On-path TWAP guard: every V3-style pool on the quoted path must have `|spot tick − TWAP tick| ≤ guardMaxTicks` (300 ≈ 3%) over `guardWindow` (30 min); on by default. A push in the block, or a few blocks earlier, cannot move the TWAP; holding a pushed price for the whole window on a pool arbitrageurs watch is what the attacker now has to pay for. | `test_guard_blocksBuybackWhenSpotDeviates`, `test_guard_appliesToConvert`, invariant 6 |
| D-02 | **Medium** | First guard design read an owner-designated *reference* pool per token. The router picks the highest-output **approved** pool, which need not be the reference pool (e.g. guard on DCA/USDG, route through DCA/WETH): a push on the executing pool was invisible to the guard, and a misconfigured reference pool made it useless. | The guard reads the pools **in the path the router returned** (`abi.decode(extra, (address))` for V3 / Ramses hops), every hop, no configuration. Hops with no oracle (V4 `PoolKey`) are refused (`UnguardedHop`) unless the owner opts in. | `test_guard_checksEveryHopOfThePath`, `test_guard_unguardedHopRefusedUnlessAllowed` |
| D-03 | Low | `convert` accepted any `tokenIn`: an operator could round-trip the USDG reserve through WETH and back, paying pool fees + slippage each time — a slow drain of the reserve to LPs / a colluding trader. | `tokenIn ∉ {USDG, WETH, $DCA}`, `tokenOut ∈ {USDG, WETH}`: each stock reserve converts at most once, base reserves only ever go to `buyback`, $DCA is never sold. | `test_convert_reverts` |
| D-04 | Low | `setTreasury(address(this))` would make each `distribute` push 70% back into `pending`; repeating it routes ~100% into the reserve — the split bypassed in the burn direction by an owner slip. | Rejected (`InvalidTreasury`), together with `address(0)`. | `test_setTreasury` |
| D-05 | Low | The router forwards an unspent hop-2 intermediate (WETH) to the recipient. Landing as `pending`, it would be re-split 70/30 on the next `distribute`: buyback money leaking to the treasury. | `_swap` measures the WETH delta on paths that neither start nor end in WETH and credits it to `buybackReserve[WETH]`. | `test_buyback_hop2WethRefundStaysInReserve` |
| D-06 | Info | A `$DCA` whose `burn(uint256)` exists but does nothing (proxy fallback) would leave bought tokens on the receiver, indistinguishable from fees; a `burn` that burns a different amount would corrupt `totalBurned`. | `_burn` verifies the balance delta: exact ⇒ burned; unchanged ⇒ `0x…dEaD`; anything else ⇒ `BurnFailed`. | `test_buyback_fakeBurn_sendsToDead`, `test_buyback_halfBurn_reverts`, `test_buyback_noBurnFunction_sendsToDead` |

## 4. Residual risks (accepted, with mitigations)

| ID | Sev | Risk | Mitigation / decision |
|---|---|---|---|
| R-01 | Low | **Owner key.** A compromised owner can `setRouter` to a contract that quotes 1 wei and keeps the input, or `setGuard(0, …)` and sandwich its own buybacks: the 30% reserve is drainable by the owner. The 70% is the owner's already. | Same trust as `vault.setRouter` / `setFeeRecipient`; multisig + `Ownable2Step`. `setRouter` at least requires `router.weth() == weth`. No timelock (protocol-wide item I-13). |
| R-02 | Low | **TWAP manipulation over the window.** On a thin $DCA pool, holding the price 3% away from the TWAP for 30 minutes may be cheap enough to skew a large buyback by up to `guardMaxTicks` + `maxSlippageBps` (≈ 3.5%). | Keep single buybacks small relative to pool depth (many small buybacks are the point of a DCA protocol); operators pass a reference-price `minOut` from an off-chain source (it can only raise the floor); tighten `guardMaxTicks` / lengthen `guardWindow` as liquidity allows. Loss is bounded per swap, never the whole reserve. |
| R-03 | Low | **Unguarded hops.** Uniswap V4 pools have no on-chain TWAP; if the $DCA route is V4-only the owner must `setGuard(…, allowUnguarded = true)`, which re-opens the H-02-class sandwich for those hops. | Default is fail-closed. Prefer a V3 / Ramses pool for the buyback route; if V4 is unavoidable, treat buybacks like epoch runs (private relay, reference `minOut`, small sizes). |
| R-04 | Info | **Stuck reserve.** A token with no approved route (random airdrop, delisted stock without a pool) keeps its 30% reserve until the owner approves a hop; sub-quote dust (1 wei of a stock) stays forever; NFTs / non-ERC-20s sent here are unrecoverable. | By design — a rescue function is exactly what "nothing bypasses the split" forbids. The owner controls the hop allowlist, so no ERC-20 reserve is permanently stuck. |
| R-05 | Info | **L-06 moves to the receiver.** Stock tokens must allow the FeeReceiver as a *recipient* (vault `claim` pushes the claim fee to it) and as a *sender* (`distribute` transfers to the treasury). A stock that blocklists the receiver makes `claim` of that stock revert in the vault (unchanged vault behaviour, `Audit.L06`); one that blocklists the treasury makes that token's `distribute` revert until `setTreasury`. | Allowlist both addresses on every listed Stock Token; the receiver being one address makes this easier than before. `test_distribute_treasuryBlockedOnToken_revertsUntilTreasuryMoved`. |
| R-06 | Info | **Oracle cardinality.** A V3 pool with the default observation cardinality (1) cannot serve a 30-minute `observe`; every buyback through it reverts `OLD` until someone calls `increaseObservationCardinalityNext` (anyone can, once). | Deploy checklist (§6); `test_guard_oracleFailureBlocksSwap` pins the fail-closed behaviour. |
| R-07 | Info | **`distribute` is operator-only, not permissionless.** A permissionless split would be harmless in isolation, but lets a compromised *old* treasury front-run `setTreasury` for the pending 70%. Buybacks need an operator anyway, so no trustlessness is lost. | Decision. Revisit if a "anyone can trigger the split" property is ever wanted (drop the modifier on `distribute` only). |
| R-08 | Info | **`renounceOwnership`** is inherited (as on every protocol contract): after it, treasury / router / operators / guard are frozen forever. | Do not call it. |
| R-09 | Info | **Reentrancy detectors.** Slither flags state writes after external calls in `buyback` / `convert` / `_swap` / `_burn` (the reserve is debited by the *measured* `spent`, which is only known after the swap). Every state-changing entry point is `nonReentrant`; the callees are the owner-set router and the immutable $DCA token; a reentrant token passed to `distribute` is stopped by `onlyOperator` first and by the guard second. | `test_reentrancy_distributeBlocked` (both barriers). |

## 5. Review notes (things checked, nothing to fix)

- **Accounting.** `pending` is derived from balance, never stored, so tokens can arrive by any means (vault push, direct transfer, router refund) without a callback. Reserve updates are checks-effects-interactions in `distribute`; in `buyback` / `convert` the debit is `r − spent` with `r` read before the swap and `_swap` unable to touch `buybackReserve[tokenIn]` (it only ever credits WETH, and only when `tokenIn ≠ WETH`). Rounding: `toTreasury = floor(70%)`, remainder to the buyback (≤ 1 wei per distribution).
- **Approvals.** `forceApprove(router, amountIn)` immediately before the swap and `forceApprove(router, 0)` immediately after; a reverting swap reverts the approval too. `setRouter` therefore has nothing to revoke (`test_setRouter` asserts the old router's allowance is 0).
- **Balance-delta checks.** `spent` and `out` are measured on the receiver's own balances; `out ≥ minOut` is re-checked here (a router that ignores `minOut` or pays nothing reverts: `test_buyback_routerDeliversLess_reverts`, `test_buyback_routerTakesInputPaysNothing_reverts`). Fee-on-transfer tokens are handled (debit measured, credit measured); the registry keeps them out of the vaults anyway.
- **Guard correctness.** `TwapOracle.consultTick` (existing, unmodified) + `slot0` decoded as a two-word prefix so Ramses-style forks with extra fields work (`test_guard_toleratesForkSlot0Layout`). Deviation is absolute (both directions), inclusive at the bound, correct for negative ticks. Window `0` is the only way to disable; `maxTicks = 0` with a window on is rejected.
- **`$DCA` as a fee token.** Works: 70% to the treasury, 30% reserved, `buyback($DCA)` burns without a swap (`test_distribute_dcaItself`). $DCA is never sellable (`convert` rejects it).
- **ETH.** `receive()` accepts; `wrapEth()` (anyone) wraps the whole balance into WETH, which then flows as a normal fee. No ETH is ever sent out by the contract.
- **Vault side.** A contract `feeRecipient` changes nothing for users: ERC-20 pushes have no hook; `claim` / `withdrawIdle` / `advanceEpoch` / `sweepDust` all land on the receiver (`FeeReceiver.Integration.t.sol`, real `PlanVault`). Vault invariants unaffected.
- **Constructor.** Rejects zero addresses, non-distinct tokens, a non-contract `$DCA`, a treasury of `0` / self, a router on another WETH.
- **Deploy.** `Deploy.s.sol` deploys the receiver only when `DCA` is set (otherwise fees go straight to `FEE_RECIPIENT`, and a receiver can be added later with `vault.setFeeRecipient`), registers `BUYBACK_OPERATORS`, hands ownership to `OWNER` (2-step). `DeployLocal` seeds an mDCA/USDG pool so buybacks work on the fork; verified end-to-end on anvil: 1,000 USDG fee → 700 to the treasury, 300 reserved → 2,991 mDCA bought through the real router (0.3% pool fee) → `0x…dEaD` (MockDCA has no `burn`), reserve 0, allowance 0.
- **Slither 0.11.6:** 19 results, all reviewed — reentrancy-benign / reentrancy-events (R-09), 5× "dangerous strict equality" (`== 0` guards and the exact burn check, intended), uninitialised local `viaBurn` (defaults to `false`, intended), ignored return of `swapWithRoute` (balance deltas are used instead), external calls in loops (`distributeMany`, `_checkPath`, bounded by input), 2× low-level call (the `burn` probe and the `slot0` prefix decode). No high / medium detector fired.

## 6. Deploy / operations checklist

1. `acceptOwnership()` from the multisig (the receiver is in the post-deploy list with the other contracts).
2. Approve the buyback hops on the router: `USDG → $DCA` (and `WETH → $DCA`; the router also finds `USDG → WETH → $DCA` on its own if both hops are approved). Prefer a V3 / Ramses pool so the guard applies (R-03).
3. `pool.increaseObservationCardinalityNext(n)` on every pool of those routes with `n × blockTime ≥ guardWindow` (R-06). Until then buybacks revert `OLD`; `distribute` is unaffected.
4. Allowlist the FeeReceiver **and** the treasury on every listed Stock Token (R-05).
5. `setOperator` for the bot that will run `distributeMany` / `convert` / `buyback` (or leave it to the multisig). Send buyback transactions through a private relay and pass a reference `minOut` (R-02).
6. If the receiver is deployed after the vaults: `setFeeRecipient(receiver)` on Daily / Weekly / Monthly.
7. Monitor `PriceDeviates` / `UnguardedHop` reverts (the guard doing its job) and `Burned(amount, viaBurn = false)` (the token has no `burn`; tokens sit at `0x…dEaD`, supply unchanged — decide whether that is what you want before launch).

## 7. Test inventory

| Suite | Count | What it pins |
|---|---|---|
| `test/unit/FeeReceiver.t.sol` | 47 (2 fuzz) | construction / admin bounds / 2-step ownership; exact 70/30 split, rounding, accumulation, `pending` vs reserve, batch, $DCA as fee, blocked treasury; buyback: burn path, dead-address path, fake / half burn, partial amount, partial fill, floor tracks slippage, operator `minOut` only raises, `QuoteTooSmall`, no route, router revert, lying / thieving router, hop-2 WETH refund, approval hygiene; convert: stock → USDG / WETH, partial fill, every rejected direction; guard: set / off, deviation both signs + edge + negative ticks, applies to convert, unguarded hop refused / allowed, every hop of a 2-hop path, fork `slot0` layout, oracle failure; ETH wrap; reentrancy (both barriers); "no way out but the split" |
| `test/unit/FeeReceiver.Integration.t.sol` | 3 | real `PlanVault` with the receiver as `feeRecipient`: deposit / purchase / claim / withdraw / dust fees land, split, convert, burn; user exits unaffected |
| `test/invariant/FeeReceiverInvariants.t.sol` | 5 invariants × 16,384 calls (CI) | §2 invariants 1–6 under random fees (4 tokens + ETH), splits, partial fills, converts, buybacks and pool pushes; `fail_on_revert = true` (0 reverts) |
