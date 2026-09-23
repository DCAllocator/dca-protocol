# 06 — Create widget: A/B variant at /app/create/2, Buy $DCA tab + /app/buy

> F-numbers (e.g. F15) refer to the verified facts ledger at the end of `tasks/00-overview.md`.

## Summary
Items 6 and 7 both live in `create/page.tsx` (631 lines, one default export, every helper module-local). A straight copy at
`/app/create/2` (like `create/legacy`, F22) would be the wrong shape: item 7's tab must render on every variant and item 5
edits the same picker code. Recommended: extract `useCreatePlan()` + block components under
`apps/web/src/components/app/create/`, make `/app/create` and `/app/create/2` thin compositions differing only in block
order and labels, add a route-aware `CreateTabs` strip ("Start a plan" | "Buy $DCA") rendered by both variants and by a new
`/app/buy` page. `/app/buy` = in-app USDG → $DCA swap over the existing `AggregatorRouter.swap` (F30) with a "Buy on Pons"
hand-off when no route exists and `BUY_DCA_URL` is external (hybrid; Q23). No contract changes. Covers list items: 6, 7.

## Current state
- Monolith [confirmed]: state 38-46, derived 48-90, validation 103-114, `submit` 116-161, `closeFlow` 163-168; JSX blocks
  "Fund with" 184-246, arrow 248-253, stock 256-297, Every/per-buy grid 300-358, monthly line 359-363, BoostCard 365-368,
  CTA 370-388, details 390-399, `TxFlowDialog` 402-425, footnote 427-433; helpers `Box` 439, `Detail` 452, `OrderSummary`
  462, `Coin` 487, `Dropdown` 505, `StockPill` 547, utils 606-631.
- The transaction is independent of block order [confirmed]: `createPlan` args at 130 and the frozen `Order` (152-159)
  depend only on state; `OrderSummary` copy at 473 already reads "{perBuy} every {kind} · funded with {funded}".
- Legacy is a frozen copy (default kind "weekly" vs the card's "daily"); extraction cannot break it, but it will not pick
  up the tab or item 5 unless edited/deleted (Q26).
- No `/app/buy`; `BUY_DCA_URL` (F20); `Landing.tsx:13-25` renders it external when https; `NEXT_PUBLIC_BUY_DCA_URL` is absent
  from `.env.local.example` and `env-from-deployment.mjs`.
- Router user swap exists (F30): `swap(tokenIn, tokenOut, amountIn, minOut, recipient)` pulls from `msg.sender`; ABI has
  `quote`/`swap`; `ERC20Abi` has `allowance`/`approve`/`decimals`. No ABI regeneration needed.
- Local anvil has a USDG/mDCA route both ways (F19); `quote(weth→dca)` reverts `NoRoute`; two-hop search only when neither
  token is WETH (`AggregatorRouter.sol:160-162`); `Zap.sol` is ETH↔USDG only; on 4663 `dir.dca` is zero → `useDcaToken().price` undefined.
- "Valid pool" source of truth is the router, not FeeReceiver (it quotes the router per swap and stores no pool) [confirmed].
  [hypothesis] the production $DCA pool may be an ETH-paired Pons/Uniswap-v4 hook pool; `UniV4Adapter.sol:77-80` rejects
  native-ETH pools, so it might exist yet not be router-routable — the gate below detects only routable pools (Q22).
- Dev convention: everything branches on `activeChain.id === 31337` (`chain.ts:23`, `AppShell.tsx:17`, `wagmi.ts:18-19`,
  `config.ts:53-54`); `flagOn` at `config.ts:45` is private. "nom dev" ≈ `pnpm dev` on 31337 [hypothesis; Q21].
- No `Tabs` primitive (`Segmented` has `onChange` only); sidebar highlights exact paths only; the mock wallet drops on full reload → tabs must use `next/link`.
- Stray `bg-red-500` at 302 (F21). No test runner (F23).
- The "Every" tooltip at 303 says "Fill timing includes randomization to mitigate frontrunning risk." That is false today:
  the scheduler fires at boundary + 3 s and `apps/scheduler/src` has no jitter (grep) [confirmed]. The extraction would carry
  it into both variants unless reworded (Q28).

## Proposed approach
1. **Extract, no behaviour change**: `apps/web/src/components/app/create/useCreatePlan.ts` returning the full model
   (state setters, derived values, `needsApproval`, `seq`, validation flags, `canSubmit`, `monthly`, `feeBps`, `fundHint`,
   `submit`, `closeFlow`, `configured`, `stocks/ranked/top/rankReady`, …) with `{ defaultKind?: VaultKind }`; keep
   `ZAP_SLIPPAGE_BPS`, `PER_MIN_FALLBACK`, `ETH_GAS_RESERVE` there; export `Order`/`Pay` types.
2. `components/app/create/fields.tsx`: `Box`, `Detail`, `OrderSummary`, `Coin`, `Dropdown`, `StockPicker` (ex `StockPill`),
   `clean`, `everyLabel`, `trimEth`, `safeParse`, `safeParseEth` — exported; the single file item 5's picker lives in afterwards.
3. `components/app/create/blocks.tsx`: `FundWithBox` (label prop, default "Fund with"), `StockBox` (label default "Buy"),
   `EveryPerBuyGrid` (variant A), `BuyEverySentence` (variant B: per-buy input + Every dropdown in one row), `MonthlyLine`,
   `CreateCta`, `CreateDetails`, `CreateFlowDialog` (wraps `TxFlowDialog` unchanged), `Footnote`. Drop `bg-red-500`; reword or remove the false fill-timing tooltip unless scheduler jitter ships first (Q28).
4. Re-render `/app/create` from the blocks in today's order; gate: typecheck + browser pass with an unchanged Start-plan dialog and identical `createPlan` calldata.
5. **`/app/create/2`** (`apps/web/src/app/app/create/2/page.tsx`): `BuyEverySentence` ("Buy [$X] USDG every [day ▾]") →
   `StockBox` label "Of" → `FundWithBox` label "Fund plan with" (no arrow) → BoostCard → CTA → details → dialog → footnote.
   Same hook, same `Order`, same steps, same calldata. Move the "covers N buys / first buy spends what is there" hint under
   `FundWithBox` in variant B (it derives from the funding amount, now entered last); keep "min $X" under the per-buy input
   (Q25). Default kind "daily" (Q25).
6. **`CreateTabs`** (`components/app/create/CreateTabs.tsx`): `Segmented`-styled strip rendering `next/link`s, active by
   `usePathname()`: "Start a plan" → `/app/create` (or `/app/create/2` when the path starts with it) and "Buy $DCA" →
   `/app/buy`; rendered by `/app/create`, `/app/create/2`, `/app/buy`. Alternative `create/layout.tsx` would not cover
   `/app/buy`; a route group would rename `create/page.tsx` (conflict with 05) — rejected.
7. **Gate rule** (default; Q21/Q22): `config.ts` export `flagOn`; `BUY_DCA_TAB_FORCED = activeChain.id === 31337 ||
   flagOn(process.env.NEXT_PUBLIC_ENABLE_BUY_TAB)`; `useProtocol.ts` `useBuyDcaRoute(dir)`: `available = !!dir &&
   !isZero(dir.dca) && useQuote(dir.router, dir.usdg, dir.dca, 1 USDG).data !== undefined` (buy direction — hops are
   directional; `useDcaToken` quotes dca→usdg). Show when `BUY_DCA_TAB_FORCED || available`; treat `isLoading` as "reserve
   the slot", hide only on a settled failure. Not `approvedHops` (no liquidity proof), not FeeReceiver. Document that an
   ETH-paired Pons/V4 pool will NOT light the tab without the env flag or a WETH-side route.
8. **`/app/buy`** (`app/app/buy/page.tsx` + `components/app/create/BuyDcaCard.tsx`): USDG amount input (HALF/MAX from
   `useUser(dir).usdg`), live `useQuote` for the user's REAL amount (router re-quotes at execution and reverts above the
   150 bps cap), allowance check on `dir.router`, steps `[Approve USDG (if needed), Buy $DCA = router.swap(usdg, dca,
   amountIn, quote × 9950 / 10000, address)]` via `useTxSequence` + `TxFlowDialog` ("Buying $DCA" / "Bought $DCA" / "Not
   bought"), `useUser().refetch()` on done; read the token's `decimals` (do not assume 18). When `!available &&
   BUY_EXTERNAL` show a "Buy on Pons" hand-off card (extract `BuyDca` from `Landing.tsx:13-25` to a shared component); when
   `!available && !BUY_EXTERNAL` show the token page's "No $DCA/USDG route on this chain yet." USDG only in v1 (ETH → $DCA
   is not routable; a periphery `Zap.swapEthForDca` would be contract work; Q: pay with ETH?).
9. `.env.local.example` gains `NEXT_PUBLIC_ENABLE_BUY_TAB` and `NEXT_PUBLIC_BUY_DCA_URL`; README routes section documents
   `/app/create/2` and `/app/buy` (append; README is dirty).

## Files likely to change
`apps/web/src/app/app/create/page.tsx` (thin composition; −~450 lines); `apps/web/src/app/app/create/2/page.tsx` (new);
`apps/web/src/app/app/buy/page.tsx` (new); `apps/web/src/components/app/create/{useCreatePlan.ts,fields.tsx,blocks.tsx,
CreateTabs.tsx,BuyDcaCard.tsx}` (new); `apps/web/src/hooks/useProtocol.ts` (`useBuyDcaRoute` near 384-401);
`apps/web/src/lib/config.ts` (export `flagOn`, `BUY_DCA_TAB_FORCED`, comment on `BUY_DCA_URL`);
`apps/web/src/components/site/Landing.tsx` (extract `BuyDca`; optionally point at `/app/buy`); `apps/web/.env.local.example`;
`apps/web/scripts/env-from-deployment.mjs` (optional commented line); `README.md`; `create/legacy/page.tsx` untouched unless Q26 says otherwise.

## Acceptance criteria
- AC1 web typecheck exits 0 (and, if accepted as a gate, `NEXT_DIST_DIR=.next-buildcheck pnpm --filter @dca/web build` for the new routes).
- AC2 /app/create renders top to bottom: tab strip, Fund with, arrow, Buy, Every | Buy grid, monthly line, BoostCard, CTA, details, footnote; no `bg-red-500` in the DOM.
- AC3 /app/create/2 renders: tab strip, one row "Buy [amount] USDG every [frequency ▾]", an "Of" block with pill + Popular chips, a "Fund plan with" block (amount, USDG/ETH selector, ≈ USDG line, Balance, HALF/MAX), BoostCard, CTA, details, footnote; no arrow.
- AC4 identical inputs on both variants → identical TxFlowDialog steps/labels and byte-identical `createPlan` calldata (`cast tx <hash> input` on the fork).
- AC5 the /app/create/2 CTA is disabled under exactly /app/create's conditions and shows the same `fundHint`/"min $X" copy.
- AC6 `grep -rn 'functionName: "createPlan"' apps/web/src` returns exactly `useCreatePlan.ts` and `create/legacy/page.tsx`.
- AC7 with `NEXT_PUBLIC_CHAIN=local` the "Buy $DCA" tab is present on /app/create, /app/create/2, /app/buy regardless of router state.
- AC8 with `NEXT_PUBLIC_CHAIN=robinhood` and a directory whose `dca` is zero (or whose router reverts `quote(usdg→dca)`), the tab is absent with no console errors; with `NEXT_PUBLIC_ENABLE_BUY_TAB=1` it is present.
- AC9 "Buy $DCA" navigates client-side to /app/buy (mock wallet stays connected); Buy is active in the strip; "Start a plan" returns client-side.
- AC10 /app/buy on the fork: 100 USDG shows ≈ 997 mDCA (`quote(usdg, dca, 100e6) = 996999999999997057815`); Buy runs "Approve USDG" (skipped when allowance suffices) then `router.swap` with `minOut = quote × 9950 / 10000`; USDG `balanceOf` −100e6, DCA `balanceOf` up by the swapped amount; balances refresh without reload.
- AC11 rejecting the swap leaves the dialog in error state with "Try again"; no spinner remains on the strip or card.
- AC12 requests to /app/create/2 and /app/buy with `x-vercel-ip-country: US` redirect to /restricted (middleware matcher `/app/:path*`).
- AC13 `.env.local.example` documents both variables; README documents both routes.

## Tests to add
- contract: none. (If "pay with ETH" is added later via a periphery function, mirror `Router.t.sol` swap cases.)
- unit (if vitest): pure `buyTabEnabled({ chainId, flag, dcaConfigured, quoteOk })` and `BuyEverySentence` label formatting.
- e2e-manual: checklist rows E9–E10 (AC2/AC3 layouts; AC4 calldata compare; AC7/AC9 tab + client-side nav; AC10 balances before/after; AC11 rejection; AC8 with a robinhood-chain env + zero-dca directory, then with the flag; AC12 via curl).

## Dependencies and conflicts
- Branch from the commit where 05 removed picker prices; `fields.tsx` never carries a `prices` prop. Never in parallel with 05 on `create/page.tsx`.
- Consumes `useTx.ts` and `TxFlowDialog.tsx` unchanged (owned by 02/03); a "Bought $DCA" toast is optional follow-up.
- `config.ts`/`useProtocol.ts` regions disjoint from 04 — trivial rebase. README append-only.
- Owner decisions before steps 6–8: Q21–Q23 (defaults stated above so work is not blocked).

## Risk
**Medium.** Touches smart contracts: **no.** The extraction moves ~600 lines of the main conversion page with no automated
regression beyond typecheck (parity relies on AC4/AC5 on the fork); the Buy card is a user-facing swap with slippage/impact
edge cases but reuses the audited router path and the existing approve → tx sequence. Production gating is safe by
construction (tab hidden when `dir.dca` is zero); the "valid pool" definition may not match the owner's intent.

## Open questions
Overview Q21–Q26, Q28, Q4; plus: pay with ETH (not routable today)? "Start a plan" from /app/buy returns to the originating
variant or always /app/create? add a "Buy $DCA" sidebar entry?
