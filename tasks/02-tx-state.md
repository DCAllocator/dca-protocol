# 02 — tx-state: per-action transaction state + toast feedback

## Summary
Items 1 and 2 are one defect with two symptoms. Each `PlanRow` owns a single `useTx()` whose one `pending` boolean is read
by Claim, Boost/Unboost and the Pause menu item, so any in-flight write spins every button in the row; the same instance's
`error` (viem `shortMessage`, e.g. "User rejected the request.") renders inline under the row and never clears because
nothing calls `reset`. Fix is frontend-only: a global `ToastProvider` (none exists), a keyed per-action `useTx` that emits
success/error toasts with product copy, and one shared error describer that `useTxSequence` and the other workstreams
consume. Covers list items: 1, 2.

## Root cause
- **RC1 [confirmed] one hook, one `pending`, three actions.** `useTx.ts:46` `pending: w.isPending || r.isLoading`;
  `plans/page.tsx:331` `const tx = useTx(onChange)`, dispatcher `call()` at 337-338; readers Claim 397-398, Unboost
  401-402, Boost 408/412, Pause 419 (`disabled: tx.pending`). A `setPlanPaused` write renders a Spinner inside Claim and Boost.
- **RC2 [confirmed] Pause has no indicator of its own** — only `disabled` (419) and `Menu` closes on click
  (`ui.tsx:320-323`); removing the wrong spinners without adding one leaves Pause with zero feedback.
- **RC3 [confirmed] rejection text lands in the row and never clears.** `useTx.ts:37,48` → `plans/page.tsx:424`.
  viem maps RPC 4001 to `UserRejectedRequestError` wrapped in `TransactionExecutionError` → `ContractFunctionExecutionError`,
  each inheriting `cause.shortMessage`. Tanstack clears a mutation's error only on the next `mutate()` or `reset()`;
  `reset` is exposed (`useTx.ts:49`) but never called. `refresh()` (57-62) only refetches reads.
- **RC4 [confirmed] no action identity on success.** `useTx.ts:33-36` fires `onSuccess` with nothing about which
  function was written, so "Boosted" vs "Paused" cannot be labelled.
- **RC5 [confirmed] no toast primitive** (`Notice` is inline; only `Menu` and `ConnectButton` use portals).
- **RC6 [confirmed] unhandled promise rejections.** `useTx.write` returns `writeContractAsync` (rethrows); `call`
  (337-338) and Withdraw (598) never catch. [hypothesis] this also raises the Next dev overlay.
- **RC7 [confirmed] gas-estimation gap.** `useTx.ts:40` awaits `gasWithBuffer` before the mutation starts, so
  `pending` is false during the estimate round-trip and a double-click can send twice. `useTxSequence` sets
  `phase:"signing"` first (96-98) and has no gap.
- **RC8 [confirmed] no cross-row sharing.** Each `useWriteContract` is its own mutation; rows keyed `vault:planId`.
  "Pause, Claim and Boost appear to be linked" is fully explained by RC1.
- **RC9 [confirmed] dialogs unaffected by RC1** (own hooks at 496/572/615) but show raw `seq.error`/`tx.error`
  (549/592/655-659) and close on success so no confirmation survives; generic `Modal` has no in-flight guard.
- **RC10 [confirmed]** custom-error names live in viem `metaMessages`, not `shortMessage` (`viem/_esm/errors/contract.js:142-199`);
  owned by 03 (its `EpochInProgress` string match), the describer here must expose `errorName`.
- **RC11 [confirmed] a slow receipt is reported as a failure.** `useTxSequence` waits with
  `client.waitForTransactionReceipt({ hash })` (`useTx.ts:100`), i.e. viem's default `timeout = 180_000`
  (`viem/_esm/actions/public/waitForTransactionReceipt.js:53,69-75`). The `WaitForTransactionReceiptTimeoutError` lands in
  the catch (103-109), the step turns "error", and TxFlowDialog says "Nothing else was sent. You can pick up where it
  stopped." (`TxFlowDialog.tsx:97`) while the tx is still pending. The 2026-09-23 latency-proxy run saw the first
  `createPlan` land later and "Try again" send a second one (it reverted only because the approval was exact-amount):
  a duplicate-funding risk on every sequence (create, deposit, remove).
- **RC12 [confirmed] a dropped tx spins forever.** `useTx`'s `useWaitForTransactionReceipt` (`useTx.ts:32`) goes through
  wagmi's action, which defaults `timeout = 0` (`@wagmi/core/dist/esm/actions/waitForTransactionReceipt.js:5`); viem arms
  no timer for 0 (lines 69-75), so a dropped or never-mined row action keeps `pending` true and every sibling button
  disabled until reload. This is the other half of item 2.
- Minor [confirmed]: global `refetchInterval: 15_000` (`Providers.tsx:10`) keeps re-polling a row's last receipt until its next write; `w.reset()` stops it.

## Proposed approach
1. **`apps/web/src/lib/txErrors.ts`** (owned here; 03 and 05 import it): `describeTxError(err): { kind: "warn"|"error";
   title; detail?; errorName? }`. Walk the cause chain with `err instanceof BaseError && err.walk(e => e instanceof
   UserRejectedRequestError)` (top-level `name` is `ContractFunctionExecutionError`, so never check `name`). Map:
   rejection → warn "You rejected this in your wallet." (move `friendly()` from `TxFlowDialog.tsx:216-221`, keep its
   regex fallback for MetaMask "User denied"); `ContractFunctionRevertedError` → `data?.errorName ?? reason`;
   other BaseError → `shortMessage`; plain Error → `message || "Transaction reverted"`.
2. **`apps/web/src/components/Toast.tsx`**: context + `createPortal(…, document.body)` (Menu pattern `ui.tsx:310-330`);
   host `fixed bottom-4 right-4 z-[70]` (above overlay z-50 / menu z-[60]), `role="status" aria-live="polite"`, stacked,
   dismiss button, auto-dismiss ok/info ~5 s, warn/error ~8 s; class map copied from `Notice` (`ui.tsx:409-417`) so
   light theme works; `toast-in` keyframes + `anim-toast-in` next to `anim-dialog-in` in `globals.css` and registered in the
   reduced-motion block (delimited block). Export `useToast()`; mount inside `Providers.tsx` under `QueryClientProvider`.
   Export `HashLink` from `TxFlowDialog.tsx:200-214` for ok toasts.
3. **Keyed `useTx`** (`useTx.ts:28-51`): `write(params, meta?: { key; success? })`; set `busyKey` BEFORE awaiting
   `gasWithBuffer` (closes RC7); wrap `writeContractAsync` in try/catch (closes RC6): on throw → `toast(describeTxError(e))`,
   `w.reset()`, clear `busyKey`; stash the hash in a ref; success effect → `toast({kind:"ok", title: meta.success, hash})`,
   `onSuccess?.()`, `w.reset()`; `r.error` → error toast + reset. Return shape additive: keep `write, hash, pending,
   success, error, reset`, add `pendingKey`. Keep `gasWithBuffer` as is.
4. **PlanRow** (`plans/page.tsx:331-424`): `call(fn, args, key, success)` — Claim `"claim"`/"Claimed"; Boost `"boost"`/
   `BOOST.chip` ("Boosted", `config.ts:34`), unboost "Boost off" (Q19); Pause `"pause"`/"Plan paused"|"Plan resumed".
   Spinners keyed (`tx.pendingKey === "claim"` at 398, `"boost"` at 402/412); siblings stay `disabled={tx.pending}` (Q20);
   Pause indicator: Spinner in the Status cell (383-388) or as the `Menu` `label` (`ui.tsx:273,308`) while
   `pendingKey === "pause"` (Q18). Delete the inline error line at 424.
5. **`useTxSequence` catch** (`useTx.ts:103-109`): `const d = describeTxError(e); msg = d.title` (keeps the `${label}:
   ${msg}` format TxFlowDialog consumes at 139) and add `errorName` to `TxStepState` (additive). Dialog success callbacks
   (496-499, 572-575, 615-618) toast "Deposited …"/"Withdrawn …"/"Plan removed" before `onClose()`.
6. Optional: `closable?: boolean` on `Modal` (`ui.tsx:246-255`), passed `!seq.running`/`!tx.pending` from `PlanDialog` (Q: scope).

7. **Receipt timeouts mean "still pending", never "failed"** (RC11/RC12). `useTxSequence`: catch
   `WaitForTransactionReceiptTimeoutError` separately — keep the step in "mining", show "Still waiting for the network…"
   with the hash, and offer "Keep waiting" (re-wait on the SAME hash) instead of "Try again"; mark "error" only on a mined
   revert, a rejection or a replacement. `useTx`: pass an explicit `timeout` to `useWaitForTransactionReceipt` (value per
   open question); on timeout toast a warn "Still pending — check your wallet or the explorer" with the hash and clear
   `pendingKey`; the 15 s positions poll reconciles the row when the tx lands. Never resend automatically.

Alternative considered: three `useTx()` instances per row — smallest diff, but triples mutation/receipt queries, still no
labels, and allows two concurrent writes from one wallet. Rejected unless siblings must stay clickable.

## Files likely to change
- `apps/web/src/hooks/useTx.ts` — keyed write, `pendingKey`, internal catch + reset, toasts, describer in the sequence catch
- `apps/web/src/app/app/plans/page.tsx` — PlanRow 397-424 (spinners, Pause indicator, remove inline error); dialog success toasts
- `apps/web/src/components/Toast.tsx`, `apps/web/src/lib/txErrors.ts` — new
- `apps/web/src/components/Providers.tsx` — mount provider
- `apps/web/src/components/app/TxFlowDialog.tsx` — import `friendly`, export `HashLink`, "still waiting" state with a Keep-waiting action
- `apps/web/src/components/ui.tsx` — optional `closable`; `apps/web/src/app/globals.css` — toast block
- `apps/web/package.json` — only if vitest is approved

## Acceptance criteria
Setup: latency proxy `pnpm latency` (:8555 → anvil) + `pnpm dev:latency` (:3004) if the baseline commit lands; else the
in-page fetch patch. Connect MetaMask with test1 imported (RPC → :8545 or the proxy) on /app/plans; the proxy's
`sign`/`reject`/`revert` only reach `eth_sendTransaction` senders (`cast send --unlocked`), so with MetaMask hold or reject
the prompt yourself.
- AC1 `sign=4000`, click "Pause plan": for 4 s Claim shows "Claim" and Boost shows its label (no Spinner in either); a pause indicator spins; other rows unchanged.
- AC2 `sign=4000`, click Boost: spinner only inside Boost.
- AC3 successful Boost: within 2 s of the receipt a toast containing "Boosted" appears outside the `<tr>`, auto-dismisses ≤ ~6 s or on its control; row shows boosted after refetch.
- AC4 Unboost/Pause/Resume/Claim each toast their configured label.
- AC5 `reject=1` on Boost/Claim/Pause: toast "You rejected this in your wallet."; nothing inside the row matches `/rejected|denied/i`; button re-enabled within 1 s; no unhandled rejection in the console.
- AC6 After AC5, filter change and back does not re-show the stale error; a following Boost shows exactly one "Boosted" toast.
- AC7 `revert=1`: error toast with the decoded reason or "reverted"; no inline row error.
- AC8 Pause in row A then Boost in row B: independent spinners (RC8 guard).
- AC9 double-click Boost with `sign=4000`: exactly one `eth_sendTransaction` reaches the proxy (RC7 closed).
- AC10 Withdraw modal with `reject=1` shows the product copy, never "User rejected the request." (Remove modal criterion lives in 03).
- AC11 After Deposit/Withdraw/Remove success the modal closes and an ok toast is visible.
- AC12 Toast is visible above an open modal (z ≥ 70). AC13 theme toggle: toasts use theme tokens; host has `role=status` + `aria-live=polite`.
- AC14 `pnpm --filter @dca/web typecheck` passes; `useTxSequence` fields unchanged (additive only).
- AC15 With `blockTime=manual` and no block mined for longer than the receipt timeout, a create or remove sequence never shows "Nothing else was sent" and never offers a resend; mining the block (`/__latency/mine`) completes the step.
- AC16 With `drop=1` on a row action, the row does not stay disabled: after the timeout a warn toast with the hash appears and the buttons re-enable.

## Tests to add
- contract: none.
- unit (if vitest approved): `lib/txErrors.test.ts` (hand-built viem chains → rejection copy; `ContractFunctionRevertedError`
  with `EpochInProgress` data from `PlanVaultAbi` → `errorName`; plain `Error("")` → "Transaction reverted"; MetaMask
  "User denied" string); `hooks/useTx.test.tsx` (pendingKey set before estimation resolves; one toast per hash; thrown
  error → one toast + reset; `write()` never rejects); `components/Toast.test.tsx` (stacking, timers, a11y attrs).
- e2e-manual: AC1–AC13 through the latency proxy in a browser with MetaMask (rows E1–E4 of the checklist).

## Dependencies and conflicts
- Depends on 01 (branch base). Produces `useToast` and `describeTxError` for 03 and 05 — lands first.
- `plans/page.tsx` sequential: 02 (PlanRow) → 03-P1 → 05. `useTx.ts`: additive only; 03 adds `retry(steps?)` after this merges.
- Parallel-safe with 04 and with 05's price-removal half; trivial rebase on `globals.css`/`ui.tsx`.

## Risk
Medium. Touches smart contracts: no. Frontend only, but RC11 sits on the funds path: a false failure invites a duplicate `createPlan`/deposit. Only two `useTx` and four `useTxSequence` consumers (enumerated). Guard: never silently
swallow an error after adding the internal try/catch; never change the `useTxSequence` return shape.

## Open questions
Overview Q17–Q20, Q4; plus: Deposit/Withdraw/Remove toasts after close and a "Plan started" toast for the create flow?
toast placement/limits; `Modal closable` in scope? receipt timeout for row actions, and should a sequence ever stop waiting on its own?
