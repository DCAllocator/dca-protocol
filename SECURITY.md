# SECURITY.md — DCA threat model (V1)

Scope: `contracts/src/` contracts as deployed by `contracts/script/Deploy.s.sol` on Robinhood Chain (4663). Unaudited. This document lists what can go wrong, what the code does about it, and what it deliberately does not.

## Trust assumptions

| Party | Trusted to | Can NOT |
|---|---|---|
| **Owner** (multisig, `Ownable2Step`) | pause; set fees ≤ 90 bps; set `$DCA` thresholds; set router / fee recipient / keepers / `keeperOnly`; list stocks; rescue foreign tokens | take user idle USDG/WETH or accrued stock; set any fee above 0.90%; rescue USDG, WETH or any ever-listed stock; upgrade code (no proxies) |
| **feeManager** | set fees within caps | anything else |
| **Keepers / operators** | trigger epochs; pass `routeOverride` (path + `minOut > 0`) | move funds anywhere but into the vault's own stock purchase; skip fees; change accounting |
| **Router + adapters** (owner-set) | execute swaps honestly | hold funds between txs (they don't); receive approvals from vaults beyond the router itself |
| **Stock Tokens, USDG, WETH** | standard ERC-20 semantics (no fee-on-transfer, no reentrant hooks) | — the registry flags fee-on-transfer and vaults refuse them; `_tryTransfer` tolerates blocklists |
| **DEX pools** | factory-verified or owner-registered | forge callbacks (callback authenticates `msg.sender == verified pool`) |

Anyone else is untrusted.

## Invariants (enforced by tests in `test/invariant/`)

1. `stock.balanceOf(vault) == totalStockAccrued[stock] + dustPot[stock]` for every stock.
2. `usdg.balanceOf(vault) == totalUsdgIdle` and `weth.balanceOf(vault) == totalWethIdle` (fees leave immediately; no fee pot on the vault).
3. Aggregates equal the sum over plans; `userStockAccrued` equals the per-user sum.
4. No plan is filled twice in one epoch; `lastExecutedEpoch ≤ currentEpochId`.
5. Every fee ≤ 90 bps (constructor + `setFees` validate).

## Threats

### 1. Router failure / bad quotes

**Risk.** The auto-router returns a bad path (thin pool, stale tier, adapter bug) or reverts, blocking every epoch for a stock.

**Mitigations.**
- Impact cap vs pool mid-price (`maxPriceImpactBps`, 150) on every path; direct and one-hop candidates; adapters that revert on quote are skipped (`try/catch`).
- `minOut = quote × (1 − swapSlippageBps)`; the vault measures real balance deltas, reverts on zero output (`SwapReturnedZero`) or over-spend (`Overspent`), and returns unspent USDG pro-rata.
- **Trusted route override**: owner / vault keeper / keeper operator can pass `abi.encode(Route[] path, uint256 minOut)` to force the USDG→stock route so a broken auto-router cannot brick an epoch. `minOut` must be non-zero.
- `setRouter` swaps the router atomically and revokes approvals to the old one.
- A failing stock never blocks other stocks (`EpochKeeper` isolates jobs with `try/catch`).

**Residual.** Nobody can be forced to provide liquidity. If no route within the cap exists, the epoch simply does not fill and users keep their idle balance.

### 2. Sandwiching / MEV on epoch swaps

**Risk.** Epoch swaps are large, predictable (00:00 UTC) and public. A searcher can move the price before the tx, and the in-tx quote + mid-price check will both see the moved price.

**Mitigations.**
- The impact cap bounds how far from the *current* mid the fill may land; the slippage tolerance is tight (0.50%).
- Keepers should (a) submit through a private mempool / builder, (b) sanity-check the quote against `TwapOracle.consultTick` or an off-chain reference and (c) use the route override with a tight `minOut` when the auto quote looks off.
- Per-page swaps spread a large stock across several txs.

**Residual.** V1 has no on-chain TWAP guard on the vault (it is a keeper-side tool). V2 candidate: reference-pool TWAP deviation check in `_buyStock`.

### 3. Epoch griefing

| Vector | Handling |
|---|---|
| Unbounded loop over plans | `maxPlansPerTx` (≤ 1000, default 150) + cursor pagination. |
| Reordering the plan index mid-epoch (swap-remove) | `prunePlan` reverts while the stock's epoch is pending. Plans appended mid-epoch are simply processed. |
| Filling the index with empty plans to burn keeper gas | Empty plans cost one cold SLOAD each and are prunable by anyone; index is per stock. Creating plans costs the attacker gas + nothing is free. |
| A recipient that reverts on stock transfer (blocklisted) | `_tryTransfer` never reverts the page; the share accrues instead. |
| A stock token that reverts on transfer to the vault (delisted at the token level) | The epoch reverts; keeper isolates the job; owner delists in the registry so it is no longer `isEpochDue`. Users withdraw idle. |
| Keeper never finishes a multi-page epoch | Remaining plans miss that epoch; the next epoch starts from index 0. No double charging (`plan.lastEpochId` guard). |
| Re-entrancy via tokens or router | `nonReentrant` on every state-changing entry; checks-effects-interactions; `SafeERC20`; adapters are `onlyRouter`. |
| Unbounded `keeperTipBps` | ≤ 50% of purchase fees, never from user principal. |

### 4. `$DCA` flash-buy

**Risk.** Perks read `dca.balanceOf(owner)` at execution and at claim. A user can buy ≥ 50k `$DCA` right before the epoch (halved fee, auto-send) and sell right after; with a flash-loanable `$DCA` market, within one tx around the keeper call.

**Handling.** Accepted for V1 and documented in the app ("perks read your spot balance at execution time"). The economic damage is bounded to the fee discount / claim fee waiver on one epoch's spend. V2 option: checkpointed balances (`ERC20Votes`-style `getPastVotes`) with a lookback, or a staking snapshot.

### 5. Rounding

- Fees round **down** (user-favourable). Halving floors (75 → 37 bps).
- Pro-rata distribution floors; the remainder (< number of plans, in wei) goes to `dustPot[stock]` and is folded into the next distribution — never to the treasury, never lost. Tested (`test_proRata_weightsAndDust`, fuzz conservation).
- WETH zap credits are pro-rata by WETH contributed; residue < 1 unit per plan.
- `mulDiv` (512-bit) everywhere prices/amounts are multiplied; `SafeCast` on every narrowing.

### 6. Stock Token depeg vs the underlying

The vault buys the **on-chain** Stock Token at the **on-chain** price. If the token trades above/below the NYSE/Nasdaq price (thin liquidity, issuer halts, market closed while crypto trades), users buy at that price. Nothing in the protocol references the off-chain price. Mitigations are operational: only list tokens with real depth; keepers can hold a stock (`setJobActive(false)`) or the owner can delist during a dislocation. Users can pause their plans at any time.

### 7. Permissioned Stock Tokens

Robinhood Stock Tokens may enforce allowlists / blocklists at the token level. Consequences:
- Transfer *to* the vault blocked → the swap reverts → no fill (job isolated).
- Transfer *from* the vault to a user blocked → auto-distribute falls back to accrual; `claim` reverts for that user until they are allowed (funds stay accounted on the vault).
- Vault address itself blocked → epochs for that token stop; users withdraw idle USDG/WETH.

### 8. Admin key compromise

Owner cannot steal user funds directly (no sweep of USDG/WETH/stocks, fees ≤ 0.90%). An attacker with the owner key could: point `router` at a malicious contract (steals up to one epoch's `totalNet` per stock per epoch — the vault only approves the router and only spends per-page `totalNet`; balance-delta checks make a zero-output router revert, but a router that returns 1 wei of stock would pass), set `feeRecipient`, pause. Use a multisig + timelock; monitor `RouterSet`, `FeeConfigSet`, `KeeperSet`, `FeeRecipientSet`.

### 9. Denial via `pause`

Pause blocks new plans, deposits and epochs; **claims and idle withdrawals are never pausable**, so users can always exit.

### 10. Out of scope / not protected

- Loss of value from the underlying stock or from USDG.
- Front-end compromise (the UI is not the protocol; contracts are permissionless and verifiable).
- Geo-blocking is an app-layer control only.
- Native-ETH V4 pools (adapter rejects them).
- Split routes / RFQ / off-chain solvers.

## Reporting

Open a private security advisory on the repository or email the maintainers. Please do not test on mainnet vaults with real user funds.
