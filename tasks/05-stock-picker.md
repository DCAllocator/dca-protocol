# 05 — Stock picker: why prices are missing, remove them, add "Add to wallet"

> F-numbers (e.g. F15) refer to the verified facts ledger at the end of `tasks/00-overview.md`.

## Summary
The "missing prices" are confirmed by on-chain reproduction, not a frontend defect: on the testing stack `DeployLocal.s.sol`
lists 142 stocks but seeds a pool and approves router hops for 16, so `AggregatorRouter.quote` reverts `NoRoute` for the
other 126 and `usePrices` maps the rejection to `undefined` → "—". Production will behave the same by design (the router
quotes only owner-approved hops) with two production-only hypotheses on top. Recommended: remove prices from the picker
and create card only (drop `usePrices` from `useRankedStocks`), keep USD values on /app, /app/plans, /app/token; add an
`AddToWalletButton` on wagmi's `useWatchAsset` (EIP-747 `wallet_watchAsset`) on the create card's selected-stock line and
the plan-row symbol cell. No contracts change. Covers list items: 5.

## Root cause
- **RC1 [confirmed] 126 of 142 listed stocks have no approved route locally.** `DeployLocal.s.sol:51-54` says so explicitly;
  16 `_liquid(...)` at 83-98 get `createPool` + `_approveBoth` (275-286); the long tail only `registry.listStock` (287-294).
  `AggregatorRouter.sol:164-175` falls through to `revert NoRoute` (selector `0x81fff07f`). `cast` sweep over all 142
  approved stocks: 16 ok / 126 `NoRoute` / 0 other; `approvedHops(ADBE, USDG)` and `(ADBE, WETH)` empty; SPCX likewise.
  Behaviour dates from the first commit (`git log -S'_other('`).
- **RC2 [confirmed] the frontend swallows the revert.** `useProtocol.ts:414-443` (`retry:false`, 60 s refetch,
  `Promise.allSettled`, line 437 maps rejections to `undefined`); `create/page.tsx:575,594` renders "—"; legacy 464/483 identical.
  No-hop, impact-cap and RPC failures are indistinguishable.
- **RC3 [confirmed code; that testers saw it is a hypothesis] loading looks like no-route.** One `allSettled` over 142
  swap-simulating `eth_call`s; the map is empty until the slowest settles, so on first paint even the 16 liquid stocks show "—".
- **RC4 [confirmed] ruled out locally:** impact cap (`maxPriceImpactBps = 150`; `MockV3` is constant-price, NVDA quote impact
  30 bps); decimals (all 142 mocks are 18); RPC (anvil, all calls succeed).
- **RC5 [confirmed from scripts] production is the same mechanism by design:** `Deploy.s.sol:38-40,131-134` — listing and
  route approval are independent; a Chainlink feed is required by default (`REQUIRE_PRICE_FEED`) but a route never is.
- **RC6 [hypothesis] production-only: impact cap / partial fill on one whole token** of a high-priced or thin stock
  (`AggregatorRouter.sol:271-285`; `UniV3Adapter.sol:113-117` reports `(0,0)` when liquidity is exhausted).
- **RC7 [no-batching confirmed; rate limiting hypothesis]** `wagmi.ts:34` `http()` without `batch` → 142 separate
  JSON-RPC POSTs per refetch per tab: /app/create, / (F28), /app, /app/plans (`plans/page.tsx:48-49` quotes all stocks)
  each 142/min. A public RPC may rate-limit → "—" until the next refetch.
- **Add-to-wallet current state [confirmed]:** none exists; wagmi exports `useWatchAsset` → viem `wallet_watchAsset`
  (`retryCount: 0`, returns boolean) with `{ type: 'ERC20', options: { address, symbol ≤ 11 chars, decimals, image? } }`.
  The mock connector resolves `true` silently (F11) — it does not throw. Registry `symbol` is "NVDA" while the local
  ERC-20 `symbol()` is "NVDAst" (`DeployLocal.s.sol:277`); production token symbol format unknown [hypothesis]. Icons are
  SVG only (`tickers.ts:159-162`; `public/tickers` has no PNG); MetaMask SVG acceptance unverified [hypothesis]. Picker
  rows are `<button role="option">` (577-580) — a nested button is invalid HTML, so the button lives on the selected-stock
  line (`create/page.tsx:258-272`) and the PlanRow symbol cell (`plans/page.tsx:344-355`).

## Proposed approach
Alternatives: (B) keep prices and seed pools for all 142 locally + batch/cache — contradicts the request, ~126 extra
pools/feeds/jobs, production gaps remain; (C) show the static CoinGecko snapshot — stale, not the executable price next to
a buy form. Pick (A):
1. `useProtocol.ts:458-472` `useRankedStocks`: delete the `tokens` memo and the `usePrices` call, remove `prices` from the
   return and deps (ranking uses only `STOCK_MARKET_CAPS`; `ranked`/`top` unchanged; also stops the 60 s identity churn).
   Leave `usePrices`, `useTvl`, `useDcaToken`, plans-page consumer untouched.
2. `create/page.tsx`: drop `PriceMap` import (7), `prices` destructure (35), `stockPrice` (57), the " · $price" fragment
   (262-267), `prices={prices}` (273); `StockPill` (547-603): remove the prop, line 575 and the price span at 594.
3. `create/legacy/page.tsx`: 7, 36, 156, `StockSelect` 413/435/447/464/483.
4. NEW `apps/web/src/components/app/AddToWalletButton.tsx` `({ address, symbol, decimals })`: render null unless
   `isConnected && chainId === activeChain.id` (guard as `ConnectButton.tsx:93`); `useWatchAsset`; params via a pure
   `watchAssetParamsFor(stock, origin)` in `apps/web/src/lib/watchAsset.ts` (`symbol.slice(0, 11)`, `image =
   origin + tickerIconUrl(symbol, "light")` when `window` exists); outcomes → `useToast` (02): `true` → "Added {symbol} to
   your wallet", `false` → "Not added", throw → `describeTxError` copy. Never inline in a row. `connector?.id ===
   TEST_WALLET_ID` → hide (default; Q16). Icon: add `"wallet"` to `IconName` (`ui.tsx:520`) or reuse `"plus"`.
5. Placement: (a) `create/page.tsx:258-272` after `tickerName(...)` where the price used to be; (b) `plans/page.tsx:344-355`
   under the symbol cell (`p.stock`, `symbol`, `stockDecimals` already in scope) — this insertion lands after 03-P1 merges.
6. Optional RPC hygiene (same PR): `plans/page.tsx:48-49` build `priceTokens` from the distinct `p.stock` of the user's
   positions instead of every registry stock (keep the map keyed by lower-cased address for 95/378). Do NOT enable viem
   `http` batching here (affects every RPC path; decide once the real Robinhood RPC limits are known).
7. Gate: `pnpm --filter @dca/web typecheck`.

## Files likely to change
`apps/web/src/hooks/useProtocol.ts` (458-472; optional `symbol()` read in `useStocks` 72-75 if Q15 picks on-chain);
`apps/web/src/app/app/create/page.tsx`; `apps/web/src/app/app/create/legacy/page.tsx`;
`apps/web/src/components/app/AddToWalletButton.tsx` (new); `apps/web/src/lib/watchAsset.ts` (new);
`apps/web/src/app/app/plans/page.tsx` (symbol cell; optional `priceTokens` narrowing); `apps/web/src/components/ui.tsx`
(`IconName`); `apps/web/public/tickers/` (PNG exports only if MetaMask rejects SVG). No `contracts/` or `apps/scheduler/` change.

## Acceptance criteria
- AC1 /app/create and /app/create/legacy render no USD price and no "—" in picker rows, trigger/tile, or the selected-stock line.
- AC2 `read_network_requests` for 90 s on /app/create, /app/create/legacy and /: zero `eth_call` with the router `quote` selector; /app and /app/plans still issue them.
- AC3 /app still shows TVL "Stocks $…" and per-vault stock-on-hand USD; /app/plans still shows per-row accrued USD (378), the summed stat (181) and the Stock sort.
- AC4 /app/token still shows the $DCA price (≈ $0.10 locally) and market cap.
- AC5 "Popular" row and picker order are byte-identical before/after.
- AC6 web typecheck passes with `PriceMap` no longer imported by either create page.
- AC7 "Add to wallet" is visible on the selected-stock line and in each /app/plans row when connected on the active chain; hidden when disconnected or on another chain.
- AC8 MetaMask on anvil 31337: click opens the add-token dialog pre-filled (address, ≤ 11-char symbol, 18 decimals); confirm → success toast; decline → "Not added"; close (4001) → rejection copy; no inline error in any path.
- AC9 with the local test wallet the click neither throws nor claims a real wallet was updated; no console errors.
- AC10 no button inside any `role="option"` row.
- AC11 (optional step 6) /app/plans with positions in 2 stocks issues 2 quote calls per refetch instead of 142.

## Tests to add
- contract: none (router tests already cover `NoRoute`/impact cap).
- unit (if vitest): `lib/watchAsset.test.ts` (`type: "ERC20"`, symbol ≤ 11, decimals passthrough, absolute light-variant image, image omitted without origin).
- typecheck gate.
- e2e-manual: checklist rows E7–E8 (picker without prices; no quote calls on /app/create and /; test-wallet button state; plan-row button; USD values unchanged) and a MetaMask-extension pass for AC8 recording whether the SVG logo renders.

## Dependencies and conflicts
- Consumes `useToast` and `describeTxError` from 02 → branch after 02 merges (price removal could start earlier but the button needs the toast).
- Must land BEFORE 06 rewrites `create/page.tsx`; 06 must not reintroduce `prices` from `useRankedStocks`.
- `plans/page.tsx` symbol-cell insertion lands after 03-P1 (sequential file). `useProtocol.ts` region disjoint from 04/06.

## Risk
Low. Touches smart contracts: no. Deletion-only in three files plus one component on an installed hook; residual risk is
MetaMask vendor behaviour (SVG logo, symbol-mismatch warning) and the mock connector's silent `true`.

## Open questions
Overview Q14–Q16; plus: narrow the plans-page price fetch and/or enable viem `http` batching (depends on the real Robinhood
RPC); keep the local 16/126 split (recommended) or seed all 142 — only relevant if prices are kept after all.
