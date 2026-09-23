# 03 — Delete plan withdraws first (delete-withdraw)

## Summary
"Delete plan" today is a client-side sequence of up to four owner-signed transactions (`setPlanBoost(false)` →
`withdrawIdle(MAX)` → `claim(MAX)` → `prunePlan`) driven by `useTxSequence` inside a dismissible `Modal`. On chain a plan
cannot be deleted while it holds value, so "delete and lose the deposit" is not reproducible as fund loss; it is a
presentation failure of that sequence. This spec evaluates options (a), (b), (c) in order, ships (a) as the interim
safeguard now (Phase 1), and proposes (c) `closePlan` as the end state gated on owner decisions and a size measurement
(Phase 2). Covers list items: 3.

## Root cause
- **[confirmed — fund loss refuted]** The only path that removes a plan from the index is `prunePlan`
  (`PlanVault.sol:400-406`), which reverts `PlanNotEmpty` while `usdgIdle>0 || stockAccrued>0 || boostShares>0` (403);
  `_unindex` (998-1009) has no other caller; the record persists (`getPlan` 827-829) and any later deposit re-indexes it
  (304-310 → `_index`). Existing tests: `PlanVault.Plans.t.sol` `test_prunePlan_removesAndReindexes` (351),
  `test_prunePlan_revertsDuringPendingEpoch` (380); `PlanVault.Boost.t.sol` `test_prunePlan_revertsWhileBoosted` (554).
- **[confirmed]** The frontend never hides a funded plan (`plans/page.tsx:70-78`); `onRemoved` (63-66) runs only from
  `onDone`, reached only after every step mined (`useTx.ts:101-113`).
- **Defect 1 [confirmed] dismissible dialog.** `RemoveForm` renders inside generic `Modal` (450-453), which closes on
  Escape/backdrop/X unconditionally (`ui.tsx:246-262`); `runFrom` has no cancellation, so the wallet keeps prompting with
  no UI; the row's "Remove plan" entry is re-enabled immediately (417-422), so a second sequence can start concurrently.
- **Defect 2 [confirmed] retry re-runs from step 0 on a stale snapshot.** Dialog state stores the click-time `Position`
  (34, 272); steps are a `useMemo` over it (620-629); the button always calls `seq.run(steps)` (660) = `runFrom(steps, 0)`;
  `seq.retry` (`useTx.ts:119-122`) is never called. After a prune failure a second click re-sends `withdrawIdle(MAX)` on
  an emptied plan → `ZeroAmount` (`BoostLib.sol:105-106`). A step omitted because the snapshot said 0 makes `prunePlan`
  revert `PlanNotEmpty` (funds stay).
- **Defect 3 [confirmed] the friendly `EpochInProgress` notice cannot fire.** `plans/page.tsx:632` string-matches
  `seq.error`, but viem puts custom-error names in `metaMessages`; `shortMessage` is `The contract function "prunePlan"
  reverted.` (`viem/_esm/errors/contract.js:142-199`); a mined-but-reverted tx yields only `<label> reverted`
  (`useTx.ts:101`). Users see a generic revert after their USDG is already out.
- **Defect 4 [confirmed] copy.** 636 says "back to your wallet" while USDG goes to `msg.sender` (`PlanVault.sol:346`) and
  stock to `p.recipient` (987), both minus 25 bps; no boosted-liquidity notice in `RemoveForm` (the one at 605-607 is `WithdrawForm`'s).
- **[confirmed] the unboost step is load-bearing.** `BoostLib.withdrawIdle` touches the strategy only when
  `amount > fromIdle` (108-112), so dust `boostShares` whose value floors to 0 survive; only `setPlanBoost(false)` burns them
  (84-90). `ClaimHelper.Position` exposes `boostValue` but not `boostShares`, so the UI's "empty" is weaker than the
  contract's — verification must read `getPlan`.
- **[hypothesis] what testers saw:** the sequence stopping after "Withdraw funds" (rejection, dismissed dialog, or
  `EpochInProgress` on the prune) leaving an empty, still-listed "Needs funds" row with a generic error; possibly
  compounded by fees or a custom recipient. Not runtime-reproduced; Phase 1 starts with a repro task.

## Option (a) — existing contract / one call
**One-call delete-with-withdraw does not exist [confirmed]**: `IPlanVault.sol:123-142` has no `closePlan`/multicall;
`prunePlan` needs an empty plan and no pending epoch; `ClaimHelper` is view-only; `Zap` only deposits; no operator model
(`onlyPlanOwner` 236-239; `withdrawIdle` pays `msg.sender`). What exists is the owner-gated sequence the UI already
composes — complete and funds-safe; every defect is presentational.

Funds safety [confirmed]: every fund-moving leg is `nonReentrant onlyPlanOwner` and pays the user before `prunePlan`;
effects precede interactions (`BoostLib.sol:109` before 112; `PlanVault.sol:982-984` before 986-987); `prunePlan` moves
no value; no ordering strands funds (prune-before-withdraw reverts; withdraw-without-prune leaves an empty plan anyone can
prune later).

Edge cases: partial execution → stops at the failing step, moved funds are in the wallet, the rest stays in a still-listed
plan (safe); plan mid-execution → withdraw/claim are not blocked, only prune reverts `EpochInProgress` (404) to protect the
swap-and-pop index vs the page cursor (1002-1006 vs 440-448); the window can last a whole epoch if a page keeps reverting
(delay, not risk); zero balance → `withdrawIdle(MAX)`/`claim(MAX)` revert `ZeroAmount`, so the builder must omit them from
a FRESH read; non-owner → `NotPlanOwner`; prune permissionless but only for empty plans; reentrancy → all four entries
guarded, separate txs; paused/delisted → all four work while paused; illiquid Morpho → unboost and `withdrawIdle(MAX)`
revert wholesale, partial `withdrawIdle(planId, usdgIdle)` still works; blocked feeRecipient (accepted L-06) → only that leg blocks.

Migration/redeploy: none. Weakness: still 2–4 wallet prompts; non-atomic; "empty but still indexed" residual after a failed prune.

## Option (b) — EIP-5792 batching
Feasible on the installed stack [confirmed]: wagmi 2.19.5 / viem 2.56.8 ship `useSendCalls`, `useCapabilities`,
`useCallsStatus`, `useWaitForCallsStatus`; viem sends `atomicRequired: forceAtomic`; capability `atomic.status ∈
{supported, ready, unsupported}`. Nothing in `apps/web` uses it.

Atomicity limits: `supported` + `forceAtomic` → one prompt, a revert anywhere (e.g. prune `EpochInProgress`) rolls back the
withdrawal too — nothing moves (mitigation: pre-read `isEpochPending` and omit prune); `ready` → EIP-7702 upgrade prompt the
user may reject; `unsupported` → error; both need the `useTxSequence` fallback. Non-atomic: never use viem's
`experimental_fallback` (continues past a rejected call); the mock connector runs `wallet_sendCalls` as a sequential
`eth_sendTransaction` loop with no receipt wait, reports `atomic:false`, and advertises no capability for 31337 → the
atomic path is untestable on the app's own test wallet. `waitForCallsStatus` must branch on `status === 'failure'` and
check every receipt. Partial execution under non-atomic batching = today's mined-prefix state (funds in wallet, plan
listed); no ordering strands funds. Non-owner bundles revert `NotPlanOwner`; reentrancy guard is per call. [hypothesis]
EIP-7702 delegated EOA keeps its own `msg.sender` on the specific wallet.

Migration/redeploy: none; kill switch `NEXT_PUBLIC_BATCH_CALLS`. Why not primary: MetaMask 7702/5792 on Robinhood Chain
4663 is unverified; at launch it may deliver exactly today's N-prompt flow plus a young wallet-dependent surface; it removes
the prompt but not the `EpochInProgress` coupling or the un-pruned residual; it needs every safeguard from (a) anyway.
Verdict: optional progressive enhancement, gated on a real wallet reporting `supported` on 4663.

## Option (c) — contract change
Design: `closePlan(uint256 planId) external nonReentrant onlyPlanOwner` (no `whenNotPaused`, no `_requireFundable`):
(1) if `p.boosted` → `BoostLib.setPlanBoost(_boost, p, planId, false)` in the VAULT stub (as at 379-380; avoids a
library→library link); (2) `PlanExitLib.close(...)`: withdraw all idle (fee, USDG to `msg.sender`, `IdleWithdrawn`) if
`usdgIdle>0`; claim all (fee unless perk, stock to `p.recipient`, `Claimed`) if `stockAccrued>0`; if `!epochPending`
unindex (`PlanIndexed(false)`) else `p.paused = true` + `PlanPausedSet` and leave the index; emit `PlanClosed(planId,
owner, usdgOut, stockOut, unindexed)`. `withdrawIdle`/`claim`/`claimAll`/`prunePlan` become thin stubs. Immutables cannot be
read by a delegatecalled library → pass `usdg` and pre-computed `isAutoDistribute(p.owner)` as args (pattern
`VaultAdminLib.sol:23-32`); `totalUsdgIdle` delta returned and applied in the stub. No Plan struct change (reuse `paused`).

Why a library [confirmed]: vaults have 83–85 B of headroom; `AUDIT.md:398` already says the next vault change must move
code into a linked library. **Byte savings from moving `withdrawIdle`/`_claim`/`_unindex` are UNMEASURED [hypothesis]** →
Phase 2 step 1 is a throwaway measurement spike (move the three bodies into a stub library on a scratch branch, add a
`closePlan` stub, `forge build --sizes`, discard). Go/no-go criterion: MonthlyVault margin ≥ ~400 B after the stub;
fallback: also move `claimAll`'s loop and `setPlanPaused/Amount/Recipient`.

Funds safety [confirmed by reading the legs it composes]: atomic — any revert undoes everything; effects before
interactions in every leg; payout destinations and fees identical to today; deferred-unindex state (empty + paused +
indexed) is skipped by `_collect` (verify `PlanVault.sol:~504-508`). Delta-return for `totalUsdgIdle` is safe only under
`nonReentrant` — the library function must be unreachable via an unguarded vault entry.

Edge cases: partial execution impossible; mid-execution → withdraw+claim proceed, unindex deferred, `PlanClosed(...,false)`,
`prunePlan` later (must NOT mirror prune's `EpochInProgress` revert — a pending page can last an epoch); filled this epoch →
debit and credit happen in the same page, close claims the stock; zero balance → legs gated, empty/already-pruned plans close
idempotently, never-boosted plans emit no `PlanBoostSet`; dust `boostShares` fixed by always unboosting first (`_burn`
divides by `held`, keep the `boostShares>0` guard); non-owner/unknown id → `NotPlanOwner`; reentrancy → guard shared by
delegatecalled code, tokens plain ERC-20 (`AUDIT.md:6`; USDG on 4663 [hypothesis]); paused/delisted → works; illiquid
Morpho → reverts wholesale, UI falls back to partial `withdrawIdle`; **L-06 amplified**: a blocked `feeRecipient` on EITHER
token reverts the whole close (today the other leg pays) → keep the separate entries, UI fallback to the sequence, runbook:
FeeReceiver allowlisted on every stock and USDG (`audit/AUDIT-FeeReceiver.md` R-05); custom recipient unchanged.

Migration of existing deployed plans: production — none exists (only `31337.json`; `addresses.rh.json` all zero; no
proxies). Local — `pnpm fork` on a private port redeploys everything (all addresses change; plan storage does not carry
over; the user's :8545 stack is untouched). If ever shipped after a Robinhood deploy: new vaults + `PlanExitLib`
(auto-linked by `forge script`), `directory.set(Entry)`, `keeper.addJob` per (vault, stock), `boostStrategy.setDepositor`,
`pause()` old vaults and let users self-migrate.

Redeploy impact: ABI regeneration in both apps (`closePlan`, `PlanClosed`); `31337.json` records no library addresses
(note `--libraries` for manual verification); docs `README.md:147/286/358`, `SECURITY.md:70/76`, `AUDIT.md:398`; frontend
step builder collapses to `[closePlan]` with fallback to the Phase-1 sequence on revert; hide on `PlanClosed`
(`useLogs.ts:198-219` keys only on `PlanIndexed` today); scheduler: optional post-epoch prune sweep (closed-but-indexed
plans cost ~9k gas/epoch, `SECURITY.md:71`).

## Recommendation
Judge panel scores (funds safety / UX / effort / risk, 1–5): (a) 5/2/5/5 = 17; (b) 4/3/3/3 = 13; (c) 4/5/1/2 = 12.
**Phase 1 — ship (a) now as the interim safeguard**: fixes every confirmed defect, zero contract/redeploy/audit cost,
every line survives Phase 2. **Phase 2 — (c) `closePlan` in `PlanExitLib` as the end state**, because it is the only option
that meets the literal ask (one signature) and the cheapest moment is before any Robinhood deployment; gated on Q2/Q6/Q7
and the size spike. (b) not adopted; revisit only after a real wallet on 4663 reports `atomic.status === 'supported'`.
Honesty on the report: on-chain fund loss is refuted; the UX diagnosis is a code-reading hypothesis until reproduced.

## Interim UI safeguard (ship now) — Phase 1
0. **Repro task (30 min, first)**: on the fork with the mock wallet and the latency proxy, dismiss the Remove modal
   mid-sequence, reject the prune (`?reject=1` on step 4), re-click; record what the row shows; attach to this section.
1. `useTx.ts`: `retry(steps?: TxStep[])` (replace `runRef.current.steps` for indices ≥ `failedAt`, keep done phases via
   the existing logic at 90) — additive only; `errorName` comes from 02's `describeTxError` (no local decoder).
2. `TxFlowDialog.tsx`: a trailing `detail` slot per `FlowStep` for the per-step amounts (`plans/page.tsx:646-650`).
3. `plans/page.tsx`: store the plan KEY in dialog state (34, 272) and resolve `p = positions.find(...) ?? snapshot`;
   render `RemoveForm` through `TxFlowDialog` (non-closable while running; "Try again" = `seq.retry(rebuiltSteps)`, never
   `seq.run`); on open `readContract` `getPlan(planId)` + `isEpochPending(p.stock)` and build steps from them —
   `setPlanBoost(false)` if `p.boosted`, `withdrawIdle(MAX)` if `usdgIdle + boostValue > 0`, `claim(MAX)` if
   `stockAccrued > 0`, `prunePlan` unless pending (row "Delete later — funds already withdrawn" + "Finish delete" once the
   poll reports settled); primary "Withdraw & remove · N confirmations"; in `onDone` re-read `getPlan` and call
   `onRemoved()` only when `usdgIdle == stockAccrued == boostShares == 0`, else keep the dialog open with the remaining
   balance; replace `epochBusy` (632) with `describeTxError(err).errorName === "EpochInProgress" && withdrawStep.phase ===
   "done"`; copy (636, 657, 666): withdraw fee, stock claimed to `<recipient>` (show the address when ≠ signer),
   boosted-liquidity notice mirroring 605-607 with a "Withdraw available part" fallback (`withdrawIdle(planId, usdgIdle)`);
   menu 420 → "Withdraw & remove plan", disabled while a `removing: Set<string>` (lifted next to `hidden` at 55) contains the key.
4. `onRemoved` (63-66): "Plan removed" via `useToast` (02).
5. Optional: `apps/web/src/lib/removeSteps.ts` and `visiblePositions.ts` as pure functions for unit tests.
6. `README.md:358` one-line update.

## Proposed approach (Phase 2, after GO)
1. Size spike (above) → report the MonthlyVault margin → owner go/no-go.
2. NEW `contracts/src/libraries/PlanExitLib.sol` (pattern `BoostLib.sol:13-17`, `VaultAdminLib.sol:23-32`): move bodies
   of `withdrawIdle` (338-348), `_claim` (971-989), `_unindex` (998-1009); add `close(...)`; reuse `FeeMath.split`.
3. `PlanVault.sol`: stubs + `closePlan` with the unboost leg inline, then `totalUsdgIdle -= fromIdle`.
4. `IPlanVault.sol`: `closePlan` + `event PlanClosed(uint256 indexed planId, address indexed owner, uint256 usdgOut, uint256 stockOut, bool unindexed)`.
5. Size discipline: all four vaults ≤ 24,576 B with the measured margin recorded in `AUDIT.md`.
6. Tests below; `forge test` green; regenerate both apps' ABIs in this PR; `pnpm fork` on a private port; docs; audit-style review of `PlanExitLib`.
7. Frontend collapse: step builder → `[closePlan]`; hide on `PlanClosed`; fall back to the Phase-1 sequence when `closePlan` reverts.

Alternatives: (c′) revert `EpochInProgress` like prune — can block a close for a whole epoch; (c″) never unindex —
every close costs keeper gas until pruned; (d) trusted PlanCloser periphery — needs vault storage the vault has no bytes
for and would custody USDG. Deferred-unindex picked.

## Files likely to change
Phase 1: `apps/web/src/app/app/plans/page.tsx`; `apps/web/src/hooks/useTx.ts` (additive `retry`); `apps/web/src/components/app/TxFlowDialog.tsx` (`detail`); optional `apps/web/src/lib/removeSteps.ts`, `visiblePositions.ts`; `README.md:358`.
Phase 2: `contracts/src/libraries/PlanExitLib.sol` (new); `contracts/src/vault/PlanVault.sol`; `contracts/src/interfaces/IPlanVault.sol`; `contracts/test/unit/PlanVault.Close.t.sol` (new); `contracts/test/invariant/VaultHandler.sol`, `VaultInvariants.t.sol`; `contracts/test/audit/v0.4/Audit4.ClosePlan.*.t.sol` (new); `contracts/test/bench/GasBench.t.sol`; both `abi/PlanVault.ts` (regenerated); `contracts/deployments/31337.json` + both `.env.local` (rewritten by `pnpm fork` in the worktree); `apps/web/src/hooks/useLogs.ts`; `README.md`, `SECURITY.md`, `AUDIT.md`. `Deploy*.s.sol`: no change needed (forge auto-links), but currently uncommitted.

## Acceptance criteria
Phase 1: AC1 while any step is signing/mining, Escape/backdrop/X do not close the dialog. AC2 after a failed/rejected
step, "Try again" sends only steps from the failed one; an emptied plan never triggers a second `withdrawIdle`. AC3 opening
the dialog on a plan whose balances changed shows steps matching a fresh `getPlan`; with `isEpochPending == true` the
prune row reads "Delete later — funds already withdrawn" and no `prunePlan` is sent. AC4 the row disappears (and "Plan
removed" toasts) only after a post-sequence `getPlan` returns all three balances zero; otherwise the dialog shows the
remaining balance. AC5 a plan with `planBalance > 0` or `stockAccrued > 0` is never absent from My plans. AC6 menu reads
"Withdraw & remove plan" and is disabled while that plan's sequence runs; button reads "Withdraw & remove · N
confirmations"; copy names the fee and the claim recipient. AC7 an `EpochInProgress` revert renders the friendly notice
only when the withdraw step is done; any other revert shows the decoded error name, never `The contract function
"prunePlan" reverted.` AC8 web typecheck passes; `forge test` unchanged and green.
Phase 2: AC9 `closePlan` on a plain plan with idle USDG and accrued stock: owner USDG += idle − fee, `feeRecipient` gets
both fees, `p.recipient` gets stock − claimFee (0 for a perk holder), balances zero, `stockPlanCount` −1, `PlanIndexed(false)`
and `PlanClosed(...,true)`. AC10 boosted plan: `boostShares == 0`, `boosted == false`, USDG out == idle + boost value − fee
(±2 wei), invariants hold. AC11 non-owner/unknown id revert `NotPlanOwner`; prune semantics unchanged. AC12 empty plan closes
without `ZeroAmount`; already-pruned closes idempotently; never-boosted emits no `PlanBoostSet`. AC13 works while paused and
after delisting. AC14 mid-epoch (3 plans, `advanceEpoch(limit=1)`): funds out, `paused == true`, still indexed,
`PlanClosed(...,false)`; next page completes with no `PlanFilled` for it; `prunePlan` succeeds after the epoch. AC15 illiquid
Morpho: reverts with identical state; partial `withdrawIdle` works; succeeds after `mockRepay`. AC16 blocked `feeRecipient`
on the stock reverts with state unchanged; with `claimFeeBps = 0` it succeeds. AC17 re-entry into any guarded entry reverts
`ReentrancyGuardReentrantCall`. AC18 `forge build --sizes`: every vault ≤ 24,576 B, margin recorded; `PlanExitLib` in the
broadcast `libraries`. AC19 after `pnpm fork`, `cast call <daily> 'closePlan(uint256)'` resolves; non-owner reverts; both
apps typecheck after ABI regeneration.

## Tests to add
Contract, Phase 1 (pin existing behaviour): `PlanVault.Plans.t.sol` `test_removeSequence_plain` (withdraw → claim after
one fill → prune; deltas net of fees; `PlanIndexed(false)`; count −1); `PlanVault.Boost.t.sol`
`test_removeSequence_boostedDustShares` (withdraw(MAX) alone leaves `boostShares > 0` and prune reverts `PlanNotEmpty`;
unboost then prune succeeds); `test_removeSequence_illiquidThenPartial` (`mockBorrow`/`mockRepay` pattern at
`Boost.t.sol:349,466-470`); `test_removeSequence_midEpoch`; `test_removeSequence_whilePausedAndDelisted`; `test_removeSequence_nonOwner`.
Contract, Phase 2: NEW `PlanVault.Close.t.sol` (happy path; boosted after `vm.warp(30 days)` + fill; dust shares; access;
zero/already-pruned; paused/delisted; mid-epoch deferred unindex; filled-this-epoch; perk holder; illiquidity
revert-and-recover; `testFuzz_closeNeverCreatesValue` mirroring `Boost.t.sol:710`); NEW audit PoCs
`Audit4.ClosePlan.BlockedFeeRecipient` (`Audit.L06` pattern + a USDG-side blocking mock), `Audit4.ClosePlan.Reentrancy`
(reentrant recipient / `MockStrategy` subclass; selector audit that `PlanExitLib.close` is unreachable unguarded),
`Audit4.ClosePlan.MidEpoch`; invariants: `VaultHandler.close(uint256)` next to `prune`, count `boostShares > 0` as
non-empty, add "closed ⇒ balances zero && (unindexed || paused)"; `GasBench` row for `closePlan` plain/boosted.
Unit (web, if vitest): `removeSteps.test.ts`, `visiblePositions.test.ts` (never hides a funded plan), `useTx.test.ts` (`retry(steps)` resumes at `failedAt`).
E2E-manual: rows E5–E6 of the checklist (funded plan on the 2-minute TestVault; Escape during mining → stays open; reject
the prune → "Try again" sends only `prunePlan`; multi-page epoch → prune deferred then "Finish delete"); Phase 2: create →
fill → closePlan plain/boosted/mid-page.

## Dependencies and conflicts
- Phase 1 branches after 02 merges (consumes `describeTxError`, `useToast`; `plans/page.tsx` regions 34-78, 434-674, 420 after 02's PlanRow edit).
- Phase 2 shares the contracts worktree with 04 (both extend `BaseTest.sol`, edit `Deploy*.s.sol`, regenerate the same ABIs): order 03-P2 → 04. Requires the FeeReceiver hunks committed first.
- Docs (`README.md`, `SECURITY.md`, `AUDIT.md`) also edited by 01 and 04 — append-only.
- Scheduler: no change for correctness; optional prune sweep is new work.
- 02's receipt-timeout fix (RC11) matters here: today a slow receipt on "Withdraw funds" is reported as failed and a
  re-run re-sends it, which then reverts `ZeroAmount` on the emptied plan (safe, but it reads as a second failure).

## Risk
Phase 1: **low**; touches smart contracts: **no** — presentation over an already funds-safe sequence; worst case is today's flow.
Phase 2: **high**; touches smart contracts: **yes** — fund-moving code moves into a delegatecalled library at the EIP-170
edge with unmeasured byte savings, atomic revert amplifies accepted L-06, full local redeploy and ABI churn in two apps,
audit-style review warranted.

## Open questions
Overview Q2, Q5, Q6, Q7, Q3, Q4; plus: permanent `closed` bit (ABI change) vs today's re-index-on-deposit semantics
(recommended: keep, reuse `paused`); wallets to support on 4663 and whether MetaMask's 7702 delegator exists there (only if
(b) is revisited); Robinhood Chain block time vs `LOG_LOOKBACK = 200000` (`config.ts:21`) — if under a day, add an
`isPlanIndexed` view in Phase 2 or persist removed keys client-side.
