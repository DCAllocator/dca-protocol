"use client";

import Link from "next/link";
import { Notice, Spinner, StockAvatar, Countdown, Icon } from "@/components/ui";
import { BoostCard } from "@/components/app/BoostCard";
import { TxFlowDialog } from "@/components/app/TxFlowDialog";
import { ConnectButton } from "@/components/ConnectButton";
import { AddToWalletButton } from "@/components/app/AddToWalletButton";
import { fmtUsd, fmtUnits, fmtBps, tsToShort } from "@/lib/format";
import { tickerName } from "@/lib/tickers";
import { VAULT_KINDS, DOCS_PATH } from "@/lib/config";
import { ZAP_SLIPPAGE_BPS, type CreatePlanModel, type Pay } from "./useCreatePlan";
import { Box, Coin, Detail, Dropdown, OrderSummary, StockPicker, clean, everyLabel } from "./fields";

/*
 * The create card, cut into blocks. A page is a list of these in some order, all fed the same model `m`
 * from `useCreatePlan()`; nothing in a block changes what is sent — only how the form reads. `/app/create`
 * is the swap-card order (fund → buy → every | per buy); `/app/create/2` is the sentence order
 * (buy X every Y → of → fund with).
 */

type Props = { m: CreatePlanModel };

/** When each buy actually happens; used to be a (false) randomisation claim — the scheduler fires at the boundary. */
const EVERY_TIP = "Each buy runs shortly after its period starts (UTC).";

/** Shown instead of any card when the app has no VaultDirectory address. */
export function NotConfigured() {
  return <Notice kind="warn">App is not configured: set NEXT_PUBLIC_DIRECTORY.</Notice>;
}

/**
 * Funding: the big amount, the USDG / ETH pill, the ≈ USDG line and the balance with HALF / MAX. `coverage`
 * adds the "covers N buys" hint under the balance line — variant B enters the funding last, so that is
 * where the hint belongs there; variant A shows it under the per-buy amount instead.
 */
export function FundWithBox({ m, label = "Fund with", coverage = false, className = "" }: Props & { label?: string; coverage?: boolean; className?: string }) {
  const { pay, setPay, upfront, setUpfront, upfrontWei, zapQuote, address, usdgBal, ethBal, fundMax, fundShare, fundHint } = m;
  return (
    <Box label={label} error={fundHint} className={className}>
      <div className="flex items-center gap-3">
        <input
          className="amount-input swap-input text-[30px]"
          inputMode="decimal"
          value={upfront}
          onChange={(e) => setUpfront(clean(e.target.value))}
          placeholder="0"
          aria-label={`Amount of ${pay} to fund the plan with`}
        />
        <Dropdown
          trigger={
            <>
              <Coin unit={pay} />
              {pay}
            </>
          }
          width="w-60"
        >
          {(close) =>
            (["USDG", "ETH"] as Pay[]).map((p) => (
              <button
                key={p}
                type="button"
                role="option"
                aria-selected={p === pay}
                className={`menu-item gap-2.5 ${p === pay ? "bg-surface-4 text-ink" : ""}`}
                onClick={() => {
                  setPay(p);
                  setUpfront("");
                  close();
                }}
              >
                <Coin unit={p} />
                <span className="text-[13px] font-medium text-ink">{p}</span>
                <span className="ml-auto text-[12px] whitespace-nowrap text-ink-3">{p === "ETH" ? "swapped to USDG" : "plan currency"}</span>
              </button>
            ))
          }
        </Dropdown>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
        <span className="num">
          {pay === "ETH" && upfrontWei && upfrontWei > 0n ? (zapQuote.data ? `≈ ${fmtUsd(zapQuote.data.amountOut)} USDG` : "≈ …") : `≈ ${fmtUsd(upfrontWei ?? 0n)}`}
        </span>
        <span className="flex items-center gap-1.5">
          <span>
            Balance <span className="num text-ink-2">{address ? (pay === "USDG" ? fmtUsd(usdgBal) : `${fmtUnits(ethBal, 18)} ETH`) : "—"}</span>
          </span>
          {[50, 100].map((pct) => (
            <button key={pct} type="button" disabled={!address || fundMax === 0n} onClick={() => setUpfront(fundShare(pct))} className="quick">
              {pct === 100 ? "MAX" : "HALF"}
            </button>
          ))}
        </span>
      </div>
      {coverage && m.coverage && <div className="mt-1.5 text-[12px] text-ink-3">{m.coverage}</div>}
    </Box>
  );
}

/** The down arrow between "Fund with" and "Buy" on the swap-card layout. */
export function Arrow() {
  return (
    <div className="relative z-10 -my-2.5 flex justify-center" aria-hidden>
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-ink-3">
        <Icon name="arrow" size={14} className="rotate-90" />
      </span>
    </div>
  );
}

/** The stock: company name, the searchable pill, and the "Popular" chips (skeletons until the ranking is in). */
export function StockBox({ m, label = "Buy", className = "" }: Props & { label?: string; className?: string }) {
  const { stockObj, stockAddr, ranked, top, rankReady, setStock } = m;
  return (
    <Box label={label} className={className}>
      <div className="flex items-center justify-between gap-3">
        {/* The selected-stock line: name, then "Add to wallet" where the price used to be (outside the picker's option rows). */}
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[13px] text-ink-3">{stockObj ? tickerName(stockObj.symbol) : "Pick a stock"}</span>
          {stockObj && <AddToWalletButton address={stockObj.address} symbol={stockObj.symbol} decimals={stockObj.decimals} className="shrink-0" />}
        </span>
        <StockPicker stocks={ranked} value={stockAddr ?? ""} onSelect={setStock} />
      </div>
      {(!rankReady || top.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {rankReady
            ? top.map((s) => {
                const active = stockAddr === s.address;
                return (
                  <button
                    key={s.address}
                    type="button"
                    onClick={() => setStock(s.address)}
                    className={`inline-flex h-6 items-center gap-1 rounded-full border pr-2 pl-0.5 text-[11.5px] font-medium transition-colors ${
                      active ? "border-lime bg-lime/10 text-ink" : "border-line text-ink-2 hover:border-line-strong hover:text-ink"
                    }`}
                  >
                    <StockAvatar symbol={s.symbol} size={18} />
                    {s.symbol}
                  </button>
                );
              })
            : Array.from({ length: 5 }, (_, i) => <span key={i} className="h-6 w-16 animate-pulse rounded-full bg-surface-4" aria-hidden />)}
        </div>
      )}
    </Box>
  );
}

/** Frequency dropdown (day / week / month, plus `test` locally), the same list in both variants. */
export function FrequencyDropdown({ m, width = "w-40" }: Props & { width?: string }) {
  const { kind, setKind } = m;
  return (
    <Dropdown
      plain
      width={width}
      trigger={
        <>
          {everyLabel(kind)}
          {kind === "test" && <span className="chip-dev">dev</span>}
        </>
      }
    >
      {(close) =>
        VAULT_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="option"
            aria-selected={k === kind}
            className={`menu-item gap-2 ${k === kind ? "bg-surface-4 text-ink" : ""}`}
            onClick={() => {
              setKind(k);
              close();
            }}
          >
            <span className="text-[13px] font-medium text-ink">{everyLabel(k)}</span>
            {k === "test" && <span className="chip-dev">dev</span>}
          </button>
        ))
      }
    </Dropdown>
  );
}

/** Per-buy amount input, sized for the box it sits in. */
function PerBuyInput({ m, className }: Props & { className: string }) {
  return (
    <input
      className={`amount-input swap-input ${className}`}
      inputMode="decimal"
      value={m.perBuy}
      onChange={(e) => m.setPerBuy(clean(e.target.value))}
      placeholder="100"
      aria-label="Amount per buy"
    />
  );
}

/** "min $X" in red when the amount is under the vault minimum, otherwise the minimum as a hint. */
function MinLine({ m }: Props) {
  return m.perBuyTooSmall ? <span className="text-bad">min {fmtUsd(m.minPerBuy)}</span> : <>min {fmtUsd(m.minPerBuy)}</>;
}

/** Variant A: "Every" (frequency) beside "Buy" (per-buy amount), with the coverage hint under the amount. */
export function EveryPerBuyGrid({ m }: Props) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-3">
      <Box className="flex flex-col" label="Every" tip={EVERY_TIP}>
        <FrequencyDropdown m={m} />
      </Box>
      <Box label="Buy">
        <div className="flex items-center gap-2">
          <PerBuyInput m={m} className="text-[20px] sm:text-[26px]" />
          <span className="shrink-0 text-[12.5px] font-medium text-ink-2">USDG</span>
        </div>
        <div className="mt-1.5 text-[12px] text-ink-3">{m.perBuyTooSmall || !m.coverage ? <MinLine m={m} /> : m.coverage}</div>
      </Box>
    </div>
  );
}

/**
 * Variant B: one row that reads as a sentence — "Buy [amount] USDG every [day ▾]". The coverage hint is not
 * here (it sits under "Fund plan with", which comes later on that page); the minimum stays under the amount.
 */
export function BuyEverySentence({ m }: Props) {
  return (
    <Box label="Buy" tip={EVERY_TIP}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <PerBuyInput m={m} className="min-w-0 flex-1 basis-24 text-[26px] sm:text-[30px]" />
        <span className="shrink-0 text-[14px] font-medium text-ink-2">USDG</span>
        <span className="shrink-0 text-[14px] text-ink-3">every</span>
        <FrequencyDropdown m={m} />
      </div>
      <div className="mt-1.5 text-[12px] text-ink-3">
        <MinLine m={m} />
      </div>
    </Box>
  );
}

/** "≈ $X a month" once the per-buy amount is valid. */
export function MonthlyLine({ m }: Props) {
  if (!m.perBuyOk) return null;
  return (
    <p className="mt-2 text-[12.5px] text-ink-3">
      ≈ <span className="num text-ink-2">{fmtUsd(m.monthly)}</span> a month, spent while the plan has funds.
    </p>
  );
}

/** The "Earn while you wait" switch. */
export function BoostBlock({ m }: Props) {
  return (
    <div className="mt-3">
      <BoostCard checked={m.boost} onChange={m.setBoost} apy={m.boostApy} available={m.canBoost} disabled={m.seq.running} />
    </div>
  );
}

/** Connect, or the one tall button (approve + create as one click). */
export function CreateCta({ m }: Props) {
  const { address, canSubmit, submit, seq, needsApproval } = m;
  return (
    <div className="mt-3 grid gap-2">
      {!address ? (
        <ConnectButton className="btn-lg w-full rounded-xl" />
      ) : (
        <button type="button" className="btn-primary btn-lg w-full rounded-xl" disabled={!canSubmit} onClick={submit}>
          {seq.running ? (
            <>
              <Spinner /> {seq.label}
              {seq.total > 1 ? ` (${seq.step + 1}/${seq.total})` : ""}
            </>
          ) : needsApproval ? (
            "Approve & start plan"
          ) : (
            "Start plan"
          )}
        </button>
      )}
    </div>
  );
}

/** First buy, fee and tolerances under the button. */
export function CreateDetails({ m }: Props) {
  const { info, feeBps, pay, upfrontWei } = m;
  return (
    <div className="mt-4 grid gap-1.5 text-[12.5px]">
      <Detail k="First buy">
        <Countdown target={info?.nextEpochStart} />
        {info?.nextEpochStart && <span className="block text-[11.5px] text-ink-3 sm:ml-1.5 sm:inline sm:text-[12.5px]">{tsToShort(info.nextEpochStart)}</span>}
      </Detail>
      <Detail k="Fee per buy">{fmtBps(feeBps)}</Detail>
      <Detail k="Swap tolerance">{fmtBps(info?.fees?.swapSlippageBps)}</Detail>
      {pay === "ETH" && upfrontWei && upfrontWei > 0n && <Detail k="ETH → USDG tolerance">{fmtBps(Number(ZAP_SLIPPAGE_BPS))}</Detail>}
    </div>
  );
}

/** The step-by-step transaction dialog for the order being sent. */
export function CreateFlowDialog({ m }: Props) {
  const { order, seq, closeFlow, info } = m;
  return (
    <TxFlowDialog
      open={order !== null}
      titles={{ running: "Starting your plan", done: "Plan started", error: "Plan not started" }}
      subtitle={
        <>
          First buy: <Countdown target={info?.nextEpochStart} className="text-ink-2" />
          {info?.nextEpochStart && ` · ${tsToShort(info.nextEpochStart)}`}
        </>
      }
      summary={order && <OrderSummary order={order} />}
      flow={order?.flow ?? []}
      seq={seq}
      onClose={closeFlow}
      doneActions={
        <div className="grid gap-2">
          <Link href="/app/plans" className="btn-primary btn-lg w-full rounded-xl">
            View my plans
          </Link>
          <button type="button" className="btn-ghost w-full" onClick={closeFlow}>
            Create another
          </button>
        </div>
      }
    />
  );
}

/** The small print under the card. */
export function Footnote({ m }: Props) {
  const { info } = m;
  return (
    <p className="mt-3 px-2 text-center text-[11.5px] leading-normal text-ink-3">
      Stock Tokens are economic exposure, not shareholder rights.
      {info?.fees ? ` Claiming stock costs ${fmtBps(info.fees.claimFeeBps)} (free for $DCA holders).` : ""}{" "}
      <Link href={`${DOCS_PATH}#dca`} className="text-lime hover:underline">
        About $DCA →
      </Link>
    </p>
  );
}
