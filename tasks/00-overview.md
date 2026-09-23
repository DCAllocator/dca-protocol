# Post-testing changes — overview

Date: 2026-09-23. Baseline commit at planning time: `5ec278c` (main) plus a large uncommitted tree (see "Step 0").

## Workstreams (grouped by shared code and root cause)

| # | Workstream | Covers | Touches contracts | Risk |
|---|-----------|--------|-------------------|------|
| 01 | test-infra — gates, ABI sync, worktree recipe, size guard, e2e harness | prerequisite for all | no (adds a size-guard test) | medium |
| 02 | tx-state — per-action tx state + toast | items 1, 2 | no | medium |
| 03 | delete-withdraw — one-click remove; options a/b/c; interim safeguard | item 3 | Phase 1 no; Phase 2 yes | P1 low / P2 high |
| 04 | hourly-vault | item 4 | yes | medium |
| 05 | stock-picker — prices root cause + removal; add-to-wallet | item 5 | no | low |
| 06 | create-widget — A/B variant at /app/create/2; Buy $DCA tab + /app/buy | items 6, 7 | no | medium |

Grouping verdict: items 1+2 share one root cause (a single `useTx` per plan row whose one `pending`/`error` feeds three
buttons — `plans/page.tsx:331,397-424`) → one workstream. Items 6+7 both live in `create/page.tsx` (631 lines, every helper
module-local) and item 7's tab must render on every create variant → one workstream. Correction to the naive split:
item 5 also edits `create/page.tsx` (price at 262-267 and 594) and the plan row (add-to-wallet), so 05 is sequenced
before 06 and after 02/03 on `plans/page.tsx`. 01 exists because the committed ABIs lag the contracts (`EpochPageSkipped`
drift) and the uncommitted tree would be missing from every worktree.

## Step 0 — owner decisions that block everything

1. **Commit the uncommitted tree as baseline commit(s)** (FeeReceiver set; latency proxy + package scripts; Splash + site/v2;
   research contracts). Every worktree branches from a commit; without this, 02's acceptance criteria (latency proxy) and
   06's typecheck baseline (Splash edits to `layout.tsx`/`globals.css`) cannot be met in a worktree. Memory rule: ask before
   committing — this is that ask. Fallback if declined: 02 uses the in-page fetch patch instead of the proxy; 06 drops the
   Splash baseline requirement; 04 and 03-P2 rebase onto the dirty `Deploy*.s.sol` hunks by hand.
2. **Item 3 acceptance**: is "one wallet confirmation" required (→ Phase 2 contract work) or is one click + one
   non-dismissible dialog with N prompts acceptable now (→ Phase 1 only)? Also approve a 1–2 h size-measurement spike
   before deciding (see 03).
3. **Is `contracts/test/research/PlanAccount.sol` (one plan = one clone, any cadence) a direction being weighed?** If yes,
   both HourlyVault (04) and closePlan (03-P2) may be throwaway. A 2026-09-23 fork study already recommended keeping the
   pooled vault (per-plan buy ≈ 391k gas vs 34–45k per plan inside a vault page); confirm so 03-P2 and 04 proceed on the vault design.
4. **Test infrastructure**: may vitest (+ @testing-library/react) and optionally Playwright be added to `apps/web`, and a CI
   workflow (`forge build --sizes`, `forge test`, `abi:check`, both typechecks)? Otherwise verification = typecheck +
   contract tests + the manual e2e checklist.
5. **Item 7 definitions** ("nom dev", "valid pool", what `/app/buy` is) — defaults are stated in 06 so work is not blocked.

## Execution order

```
0  Owner decisions above
1  01 test-infra (main, sequential): baseline commit(s) → ABI-sync commit → both typechecks green  ← branch base for all
   ∥ 01 extras (abi-check script, ContractSizes.t.sol, ci.yml, e2e-checklist.md) — parallel with everything
2  Wave A (parallel worktrees from the ABI-sync commit):
     W1 02 tx-state
     W2 05 stock-picker: price removal + AddToWalletButton component (plan-row insertion deferred)
     W3 contracts worktree, private anvil port:
          Phase-2 NO-GO → 04 hourly starts now
          Phase-2 GO    → size spike → 03 Phase 2 → 04 hourly (same worktree, sequential)
3  After W1 merges: W5 03 Phase 1 (rebased on tx-state; starts with the 30-min repro task)
4  After W2 merges: W4 06 create-widget (branch from the commit that removed picker prices). W4 ∥ W5.
5  After W5 merges: 05 plan-row AddToWalletButton insertion (small follow-up commit)
6  Contract PRs merge with their own ABI regeneration; open frontend branches rebase at merge time only
7  Final: e2e checklist filled per user-facing workstream; `pnpm abi:check`, `forge build --sizes`, `forge test`,
   both typechecks green on main
```

## Parallel worktrees vs sequential — file ownership

| File / region | Owner (order) | Notes |
|---------------|---------------|-------|
| `apps/web/src/hooks/useTx.ts` | 02 (rewrite `useTx`, `useTxSequence` catch) → 03-P1 (additive `retry(steps?)` only) → 06 consumes unchanged | never rename/remove `useTxSequence` fields (TxFlowDialog + create pages depend on them) |
| `apps/web/src/lib/txErrors.ts` (new) | 02 owns (`describeTxError`, `friendly` moved here) | 03 and 05 import; nobody else defines an error decoder |
| `apps/web/src/components/Toast.tsx`, `Providers.tsx`, `globals.css` toast block | 02 | 05 and 03 consume `useToast` |
| `apps/web/src/components/app/TxFlowDialog.tsx` | 02 (import `friendly`, export `HashLink`) → 03-P1 (`detail` slot per step) | 06 consumes unchanged |
| `apps/web/src/app/app/plans/page.tsx` | 02 (PlanRow 308-428) → 03-P1 (Plans state 34-78, PlanDialog/RemoveForm 434-674, menu item 420) → 05 (symbol cell 344-355) → 04 (VAULT_KINDS sites, trivial) | strictly sequential |
| `apps/web/src/app/app/create/page.tsx`, `create/legacy/page.tsx` | 05 (deletions) → 06 (extraction) | never in parallel |
| `apps/web/src/hooks/useProtocol.ts` | 05 (`useRankedStocks` 458-472) ∥ 04 (`Directory`/`VaultMap` 17-26, 44) ∥ 06 (new `useBuyDcaRoute` near 384-401) | disjoint regions, trivial rebase |
| `apps/web/src/lib/config.ts` | 04 (:40, :71-79) ∥ 06 (export `flagOn`, `BUY_DCA_TAB_FORCED`) | disjoint, trivial rebase |
| `contracts/**` | one worktree, one private anvil port, order: ABI-sync → [03-P2 if GO] → 04 | both extend `BaseTest.sol`, both edit `Deploy*.s.sol`, both regenerate the same ABI files |
| `apps/web/src/abi/*.ts`, `apps/scheduler/src/abi/*.ts` | generated only (01 ABI-sync, then each contract PR) | never hand-merged |
| `README.md`, `SECURITY.md`, `AUDIT.md` | dirty; edited by 01, 03, 04 | append-only; expect textual conflicts |

Worktree recipe (full version in 01): `git worktree add ../DCA-<slug> -b <slug> <abi-sync-commit>` →
`git submodule update --init --recursive` → `pnpm install --frozen-lockfile` → frontend-only work: copy the gitignored
`apps/web/.env.local`, `apps/scheduler/.env.local`, `contracts/deployments/31337.json` from the main checkout (reads/writes
against the user's :8545 without redeploying); contract work: `PORT=<free 854x> pnpm fork` inside the worktree →
`cd contracts && forge build`. Rules: probe ports with `lsof -nP -iTCP:<port> -sTCP:LISTEN` at spawn; never
`forge script --broadcast` against :8545; never point the latency proxy at :8545 (its `blockTime` knob changes anvil's
mining mode node-wide); stop your own anvil by port only; revert `apps/web/next-env.d.ts` / `apps/web/tsconfig.json`
churn before every commit (each `NEXT_DIST_DIR` rewrites them).

## Model and effort per workstream

| Workstream | Model | Effort | Why |
|-----------|-------|--------|-----|
| 01 test-infra | Opus 5.5 | medium | mechanical regen/scripts/CI; one scheduler typing fix |
| 02 tx-state | Fable 5.1 | medium | hook redesign three other streams consume; viem error-chain subtleties |
| 03 Phase 1 | Fable 5.1 | medium | funds-adjacent UX; fresh-read step builder; must not regress today's flow |
| 03 Phase 2 (if GO) | Fable 5.1 | high | fund-moving code into a delegatecalled library at the EIP-170 edge; audit-style review |
| 04 hourly-vault | Fable 5.1 | high | contracts + breaking directory ABI + deploy fan-out + irreversible economics |
| 05 stock-picker | Opus 5.5 | low | deletions in three files + one wagmi-hook component |
| 06 create-widget | Fable 5.1 | medium | ~600-line extraction of the main conversion page with calldata-parity check, plus a user-facing swap card. Opus 5.5 is fine if `/app/buy` becomes a Pons hand-off only |

## Open questions (need your input before implementation)

Blocking (Step 0): Q1 baseline commit; Q2 item-3 acceptance + size spike; Q3 PlanAccount research direction; Q4 vitest/CI.

Item 3: Q5 what did the tester observe (wallet, tx hashes, dialog closed mid-sequence, custom recipient)? On-chain fund
loss is refuted (`PlanVault.sol:403`); Q6 Phase-2 mid-epoch semantics (revert / deferred unindex [recommended] / never
unindex) and whether the scheduler gains a prune sweep; Q7 fresh audit-style review of `PlanExitLib` before it hits the
shared test env?

Item 4: Q8 fee tier — 90 bps is exactly the inclusive cap and unraisable per vault; ship hourly alone or with the
projections re-tier (weekly 60 / monthly 45 vs repo 50 / 25)? Q9 display/struct order (`[hourly, daily, weekly,
monthly]` vs append); Q10 keep the 10 USDG per-buy minimum (≥ 7,200 USDG / 30 days per hourly plan) or add a
`setMinimums` deploy step; Q11 24/7 hourly or market-hours-only? A 2026-09-23 investigation found Robinhood
Chain equity feeds are 24/5 (~52 h weekend gap) and proposed hourly = market hours (≈ 125 buys/month); if 24/7, tight hourly
`maxStaleness` or the 25 h default; Q12 production from day one or dev-first behind `NEXT_PUBLIC_SHOW_HOURLY`; Q13 provide
`RH_RPC` so `gas-sim.sh` prices hourly with real gas before the fee decision.

Item 5: Q14 remove prices from picker rows only, or also the selected-stock "· $price" line and the legacy tile (spec
assumes all three; USD values on /app, /app/plans, /app/token stay); Q15 symbol sent to MetaMask: registry ticker
("NVDA") or on-chain `symbol()` (local mocks are "NVDAst"); Q16 hide the button for the local test wallet or show a
"test wallet" toast.

Items 1/2: Q17 rejection toast tone (warn vs error); Q18 Pause indicator location (Status cell vs menu trigger); Q19 copy
("Boost off" vs "Unboosted", "Plan paused"/"Plan resumed", "Claimed" vs "Claimed 0.0123 NVDA"); Q20 keep sibling row
buttons disabled while one write is in flight (recommended).

Items 6/7: Q21 "nom dev" = `pnpm dev` on anvil 31337 (assumed) or a hosted staging on 4663? Q22 "existing, valid pool" =
router-routable `quote(usdg→dca)` (detectable in-app; default) or the Pons/Uniswap-v4 ETH-paired pool existing at all
(not detectable from the router; V4 native-ETH pools cannot be registered on `UniV4Adapter`)? Q23 what is `/app/buy`:
in-app USDG→$DCA router swap, Pons hand-off, or hybrid (default)? Q24 A/B mechanics: comparison URL only (default) or a
traffic split with a metric (no analytics stack exists)? Q25 variant-B default frequency (daily, as the card) and where
the boost switch / "covers N buys" hint sit; Q26 should `/app/create/legacy` get the tab, be migrated, or deleted? Q28 the create page's "randomized fill timing"
tooltip is false (the scheduler fires at boundary + 3 s): remove or reword it now, or add scheduler jitter first?

Environment: Q27 which of :3000/:3001/:3003 (and :3004/:8546/:8556) are yours? Agents will probe and take :3005+/:8547+/
:8557+ and never broadcast against :8545.

## Verified facts ledger (F-numbers cited by the specs)

| # | Fact | Evidence |
|---|------|----------|
| F1 | One `useTx` per plan row; its single `pending` gates Claim, Boost/Unboost and Pause; its single `error` renders in the row | `apps/web/src/app/app/plans/page.tsx:331,397-398,401-402,408-412,419,424`; `apps/web/src/hooks/useTx.ts:28-51` |
| F2 | `useTx.error` = `shortMessage ?? message` of `w.error ?? r.error`; cleared only by `reset` (no caller) or the next write | `useTx.ts:37,48-49`; grep: `reset` unused outside `seq.reset` |
| F3 | No toast primitive; `Notice` is inline; `Menu`/`Modal` use `createPortal`/overlay; `Modal` has no in-flight guard | `apps/web/src/components/ui.tsx:246-333,409-417` |
| F4 | `TxFlowDialog.friendly()` already maps wallet rejection to product copy, but is module-private | `apps/web/src/components/app/TxFlowDialog.tsx:216-221` |
| F5 | `prunePlan` is permissionless, reverts `PlanNotEmpty` when `usdgIdle>0 \|\| stockAccrued>0 \|\| boostShares>0`, reverts `EpochInProgress` while a page cursor is open, then `_unindex` (swap-and-pop); `_unindex` has no other caller | `contracts/src/vault/PlanVault.sol:400-406,998-1014` |
| F6 | Remove dialog sequences Unboost → Withdraw(MAX) → Claim(MAX) → prune; `onRemoved` fires only from `onDone`, reached only after every step mined | `plans/page.tsx:613-629`; `useTx.ts:101-113` |
| F7 | A plan is hidden only if empty AND (unindexed per `PlanIndexed` logs OR removed this session) | `plans/page.tsx:68-78`; `apps/web/src/hooks/useLogs.ts:198-219` |
| F8 | EIP-170 headroom: Daily 85 B, Weekly 84 B, Monthly 83 B, TestVault 128 B; BoostLib/VaultAdminLib/PriceGuardLib are linked external libraries for that reason. `README.md:286` "~1 KB" and `AUDIT.md:41` are stale | `forge build --sizes` 2026-09-23; `BoostLib.sol:13-18`; `VaultAdminLib.sol:12-15` |
| F9 | `withdrawIdle`/`claim`/`setPlanBoost`/`prunePlan` are `nonReentrant`; withdraw and claim work while paused; USDG goes to `msg.sender`, stock to `p.recipient`; fees default 25 bps each | `PlanVault.sol:338-381,971-989`; `BoostLib.sol:70-113`; `VaultTypes.sol:57-58` |
| F10 | Only deployment is local anvil 31337; Robinhood Chain config is all zero/TODO. The anvil on :8545 is that deployment (with the uncommitted FeeReceiver), started by the user's `scripts/fork.sh` | `contracts/deployments/`; `contracts/config/addresses.rh.json`; `cast call directory.get()`; `lsof` |
| F11 | wagmi 2.19.5 / viem 2.56.8 export `useSendCalls`, `useCapabilities`, `useCallsStatus`, `useWaitForCallsStatus`, `useWatchAsset`. Mock connector: `wallet_sendCalls` = sequential `eth_sendTransaction`, `atomic:false`, capabilities only for Base chain ids; `wallet_watchAsset` resolves `true` silently | `node_modules/wagmi/dist/esm/exports/index.js`; `@wagmi/core/dist/esm/connectors/mock.js:121-230` |
| F12 | Frequency vaults are 25-line subclasses; `EpochLib` has `alignToDay`/`alignToMonday` only; `VaultDirectory.Entry` is fixed `{daily,weekly,monthly,…}`, `vaults()` → `address[3]`; `Deploy.s.sol` uses `PlanVault[3]` and per-kind fee keys | `DailyVault.sol`; `EpochLib.sol:37-47`; `VaultDirectory.sol:12-42`; `Deploy.s.sol:146-235`; `config/fees.json` |
| F13 | Fee cap inclusive `[0, 90]` bps; perk holders pay `bps/2` | `contracts/src/libraries/FeeMath.sol:12-19,35-37` |
| F14 | Vault constructor requires `origin ≤ now < origin + epochLength` (`BadOrigin`) | `PlanVault.sol:186-188` |
| F15 | Scheduler discovers vaults from keeper jobs, reads `epochLength`/`origin`/`vaultKind` on chain, sleeps `min(30 s, next boundary + 3 s)`; cadence-generic | `apps/scheduler/src/scheduler.ts:117-127,345-370,384-393,423-424` |
| F16 | `isEpochDue` is false for a stock with no indexed plans (empty jobs cost a view call only) | `PlanVault.sol:816-819` |
| F17 | Gas per `EpochKeeper.run` page (accrue path): 1 plan 246,617; 10: 335,439; 50: 730,429; 150: 1,719,632; first epoch of a stock 543,587; empty page 48,741 | `forge test --match-contract GasBench -vv` 2026-09-23 |
| F18 | Prices = `router.quote(token, usdg, 1 whole token)` simulated per token every 60 s, `retry:false`, rejection → `undefined` → "—". Locally 16 `SYMBOLS` get pools + hops, 126 `OTHER_SYMBOLS` are registry-listed with no pool, by design; `cast` sweep: 16 ok / 126 `NoRoute` | `useProtocol.ts:407-443`; `create/page.tsx:575,594`; `DeployLocal.s.sol:51-54,83-98,275-293`; `AggregatorRouter.sol:164-175` |
| F19 | A DCA/USDG pool is seeded and approved both ways locally; `quote(usdg→dca, 100 USDG)` ≈ 997 mDCA; `quote(weth→dca)` reverts `NoRoute` | `DeployLocal.s.sol:264-269`; `cast call` |
| F20 | No `/app/buy` route; `BUY_DCA_URL = NEXT_PUBLIC_BUY_DCA_URL ?? "/app/token"`; token page is stats only | `config.ts:111-116`; `token/page.tsx:53` |
| F21 | Debug leftover `bg-red-500` on the "Every" box | `create/page.tsx:302` |
| F22 | `create/legacy/page.tsx` is a 550-line copy, shares nothing with `create/page.tsx` | `legacy/page.tsx:1-40` |
| F23 | Web has no test runner and no ESLint config; `pnpm --filter @dca/web typecheck` is the gate; contracts gate is `forge test` + `forge build --sizes`; CI has only the market-cap snapshot workflow | `apps/web/package.json`; `.github/workflows/` |
| F24 | Committed ABIs lag the contracts: `EpochPageSkipped` is still exported by both apps' `PlanVault.ts` and consumed at `scheduler.ts:282` and `useLogs.ts:17`, but no longer exists under `contracts/src` | grep 2026-09-23 |
| F25 | viem puts a decoded custom error's name in `metaMessages`; `reason` is set only for `Error`/`Panic`; `shortMessage` becomes `The contract function "prunePlan" reverted.` → `seq.error?.includes("EpochInProgress")` at `plans/page.tsx:632` cannot match | `viem/_esm/errors/contract.js:142-199` |
| F26 | The uncommitted tree grew during this session: 12 modified + 12 untracked paths (FeeReceiver set, `scripts/rpc-latency.mjs` + `latency`/`dev:latency` scripts, `Splash.tsx`/`site/v2/`/`splash.ts`, `useFeeReceiver.ts`, `contracts/test/research/{PlanAccount,PerPlan.Fork}.sol`, `globals.css`, `layout.tsx`, `tsconfig.json`). No stash, no other worktrees | `git status --short` (end of session) |
| F27 | Marketing copy maps are `as const` keyed by the three kinds; widening `VaultKind` fails typecheck there (a useful guard) | `Sections.tsx:75-79`; `Landing.tsx:266-270` |
| F28 | Landing page also calls `useRankedStocks` (so it quotes every stock each minute and shows none) | `LandingLive.tsx:190` |
| F29 | `Sections.tsx:174` states fees "0.75% daily, 0.50% weekly, 0.25% monthly"; `fees.json` has 75/50/25; the owner's projections memory uses hourly 0.9 / weekly 0.6 / monthly 0.45 | `Sections.tsx:174`; `config/fees.json:5-7` |
| F30 | The router's `swap()` is callable by any EOA (pulls `amountIn` from `msg.sender`) — a user-facing $DCA swap needs no contract change | `AggregatorRouter.sol:208-214,245-246` |
