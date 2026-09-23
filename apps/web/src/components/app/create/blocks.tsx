"use client";

import { useState } from "react";
import Link from "next/link";
import { Notice, Spinner, StockAvatar, Countdown, Icon, Tip } from "@/components/ui";
import { BoostCard } from "@/components/app/BoostCard";
import { TxFlowDialog } from "@/components/app/TxFlowDialog";
import { ConnectButton } from "@/components/ConnectButton";
import { AddToWalletButton, useAddToWalletVisible } from "@/components/app/AddToWalletButton";
import { usePerkThresholds } from "@/hooks/useProtocol";
import { fmtUsd, fmtUnits, fmtUnitsCompact, fmtBps, tsToShort } from "@/lib/format";
import { tickerName } from "@/lib/tickers";
import { VAULT_KINDS, DOCS_PATH, isZero, type VaultKind } from "@/lib/config";
import { ZAP_SLIPPAGE_BPS, type CreatePlanModel, type Pay } from "./useCreatePlan";
import { Box, Coin, Detail, Dropdown, OrderSummary, StockPicker, StockPickerDialog, clean, everyLabel } from "./fields";

/*
 * The create card, cut into blocks. A page is a list of these in some order, all fed the same model `m`
 * from `useCreatePlan()`; nothing in a block changes what is sent — only how the form reads. `/app/create`
 * is the swap-card order (fund → buy → every | per buy); `/app/create/2` is the sentence order
 * (spend X every Y → on → fund plan → summary).
 */

type Props = { m: CreatePlanModel };

/** When each buy actually happens (/app/create). */
const EVERY_TIP = "Each buy runs shortly after its period starts (UTC).";
/**
 * The ⓘ by the frequency on /app/create/2, worded as the product asked for. CAUTION: it is only true once the
 * scheduler randomises when it fires; as of this change apps/scheduler runs every due job at boundary + 3 s
 * (BOUNDARY_GRACE_SECONDS) with no jitter (tasks/00-overview.md Q28). Ship jitter first, or reword.
 */
const FILL_TIMING_TIP = "Fill timing includes randomization to mitigate frontrunning risk.";

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
  return (
    <Box label={label} error={m.fundHint} className={className}>
      <FundAmountFields m={m} />
      {coverage && m.coverage && !m.underfunded && <div className="mt-1.5 text-[12px] text-ink-3">{m.coverage}</div>}
      <UnderfundedWarning m={m} />
    </Box>
  );
}

/** The funding amount itself: the big input, the USDG / ETH pill, the ≈ USDG line and the balance with HALF / MAX. */
function FundAmountFields({ m }: Props) {
  const { pay, setPay, upfront, setUpfront, upfrontWei, zapQuote, address, usdgBal, ethBal, fundMax, fundShare } = m;
  return (
    <>
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
    </>
  );
}

/**
 * /app/create/2's funding box: the amount (USDG or ETH), then how many times the plan runs on it — or, when it is less
 * than one buy, the warning that says what happens instead.
 */
export function FundPlanBox({ m, className = "" }: Props & { className?: string }) {
  return (
    <Box label="Fund plan" error={m.fundHint} className={className}>
      <FundAmountFields m={m} />
      <RunsLine m={m} />
      <UnderfundedWarning m={m} />
    </Box>
  );
}

/**
 * Shown under the funding when it covers less than one buy (`underfunded`). Spells out what the vault will actually do
 * — one smaller buy that takes everything, then nothing until a top-up — rather than blocking the plan, which is valid.
 */
export function UnderfundedWarning({ m }: Props) {
  const { underfunded, upfrontUsdg, perBuyWei, pay } = m;
  if (!underfunded) return null;
  const approx = pay === "ETH" ? "≈ " : "";
  return (
    <div role="status" className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-line bg-amber-bg px-3 py-2 text-[12px] leading-snug text-warn">
      <Icon name="info" size={14} className="mt-px shrink-0" />
      <span>
        That&apos;s less than one buy. Your first buy will spend all {approx}
        {fmtUsd(upfrontUsdg)} instead of {fmtUsd(perBuyWei)}, then the plan buys nothing more until you top it up from My plans.
      </span>
    </div>
  );
}

/** How many times the plan runs on this funding, e.g. "Runs 31 times before the funds run out: 30 × $100.00, then $50.00." */
function RunsLine({ m }: Props) {
  const { runs, buysCovered, lastBuyUsdg, perBuyWei, fundedEnough, underfunded, pay } = m;
  if (!runs || !fundedEnough || underfunded) return null;
  const approx = pay === "ETH" ? "≈ " : "";
  const partial = lastBuyUsdg !== undefined && lastBuyUsdg > 0n;
  return (
    <div className="mt-1.5 text-[12px] text-ink-3">
      {approx}Runs <span className="text-ink-2">{runs === 1 ? "once" : `${runs.toLocaleString()} times`}</span> before the funds run out
      {partial && buysCovered ? (
        <>
          : {buysCovered.toLocaleString()} × {fmtUsd(perBuyWei)}, then {fmtUsd(lastBuyUsdg)}.
        </>
      ) : (
        "."
      )}
    </div>
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

/**
 * /app/create/2's stock field: one row, the label on the left and the chosen stock on the right; the whole row opens
 * the picker dialog (search, the largest stocks as pills, price and market cap per row). Once a wallet is connected
 * the row also carries "Add to MetaMask" for the chosen stock — outside the row's button, never nested in it.
 */
export function StockRow({ m, label = "On", className = "" }: Props & { label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const walletLine = useAddToWalletVisible();
  const { stockObj, stockAddr, ranked, rankReady, setStock } = m;
  return (
    <>
      <div
        className={`relative flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-3 px-3.5 py-3.5 transition-colors hover:border-line-strong sm:px-4 ${className}`}
      >
        <span className="text-[15px] text-ink-3">{label}</span>
        <span className="flex flex-col items-end gap-1">
          {/* The ::after stretches this button over the whole row, so anywhere on it opens the picker. */}
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-label={stockObj ? `Stock: ${stockObj.symbol}, ${tickerName(stockObj.symbol)}. Change` : "Select a stock"}
            className="flex h-8 items-center gap-2 text-[17px] font-semibold text-ink after:absolute after:inset-0 after:rounded-xl"
          >
            {stockObj ? (
              <>
                <StockAvatar symbol={stockObj.symbol} size={28} />
                {stockObj.symbol}
              </>
            ) : rankReady ? (
              <span className="text-[15px] font-medium text-ink-2">Select stock</span>
            ) : (
              <span className="h-7 w-24 animate-pulse rounded-full bg-surface-4" aria-hidden />
            )}
            <Icon name="chevron" size={16} className="text-ink-3" />
          </button>
          {/* {stockObj && walletLine && <AddToWalletButton address={stockObj.address} symbol={stockObj.symbol} decimals={stockObj.decimals} className="relative z-10" />} */}
        </span>
      </div>
      <StockPickerDialog open={open} onClose={() => setOpen(false)} stocks={ranked} value={stockAddr ?? ""} onSelect={setStock} />
    </>
  );
}

/** Frequency dropdown (day / week / month, plus `test` locally), the same list in both variants. */
export function FrequencyDropdown({ m, width = "w-40", align }: Props & { width?: string; align?: "left" | "right" }) {
  const { kind, setKind } = m;
  return (
    <Dropdown
      plain
      align={align}
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
 * Variant B: one centred row that reads as a sentence — "Spend [amount] ($) USDG every [day ▾]" — with the fill-timing
 * ⓘ at the box's top right, over the frequency it describes. The amount input grows with what is typed so the
 * sentence stays together; the minimum sits centred underneath.
 */
export function SpendEverySentence({ m }: Props) {
  const width = `${Math.max((m.perBuy || "100").length, 2) + 0.35}ch`;
  return (
    <Box label="Spend" aside={<Tip text={FILL_TIMING_TIP} align="end" />}>
      <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1">
        <input
          className="amount-input swap-input max-w-[9ch] text-center text-[30px] sm:text-[34px]"
          style={{ width }}
          inputMode="decimal"
          value={m.perBuy}
          onChange={(e) => m.setPerBuy(clean(e.target.value))}
          placeholder="100"
          aria-label="Amount per buy, in USDG"
        />
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[16px] font-medium text-ink">
          <Coin unit="USDG" />
          USDG
        </span>
        <span className="shrink-0 text-[16px] text-ink-3">every</span>
        <FrequencyDropdown m={m} align="right" />
      </div>
      <div className="mt-1.5 text-center text-[12px] text-ink-3">
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

/**
 * One line recalling the plan about to be started, above the button: "$100.00 of NVDA every day · 30 buys · $3,000.00
 * total · last ≈ 22 Oct". Before the funding is known it falls back to the monthly pace. The dates assume nothing is
 * paused or topped up and come from the vault's schedule (first buy = next period start, one period per buy).
 */
export function PlanSummary({ m }: Props) {
  const { perBuyOk, perBuyWei, stockObj, kind, runs, upfrontUsdg, fundedEnough, underfunded, lastBuyAt, monthly, pay } = m;
  if (!perBuyOk || !stockObj) return null;
  const approx = pay === "ETH" ? "≈ " : "";
  const funded = !!runs && fundedEnough && upfrontUsdg !== undefined;
  return (
    <p className="mt-3 text-center text-[12.5px] leading-relaxed text-ink-3">
      <span className="num text-ink">{fmtUsd(perBuyWei)}</span> of <span className="font-medium text-ink">{stockObj.symbol}</span> every {everyLabel(kind)}
      {underfunded ? (
        <>
          {" · "}
          <span className="text-warn">
            one buy of{" "}
            <span className="num">
              {approx}
              {fmtUsd(upfrontUsdg)}
            </span>
            , then a top-up needed
          </span>
        </>
      ) : funded ? (
        <>
          {" · "}
          <span className="text-ink-2">
            {runs.toLocaleString()} {runs === 1 ? "buy" : "buys"}
          </span>
          {" · "}
          <span className="num text-ink-2">
            {approx}
            {fmtUsd(upfrontUsdg)}
          </span>{" "}
          total
          {runs > 1 && lastBuyAt !== undefined && <> · last ≈ {fmtWhen(lastBuyAt, kind)}</>}
        </>
      ) : (
        <>
          {" · ≈ "}
          <span className="num text-ink-2">{fmtUsd(monthly)}</span> a month
        </>
      )}
    </p>
  );
}

/** "22 Oct" (this year) / "22 Oct 2027"; hourly and test plans add the UTC time, since several buys share a day. */
function fmtWhen(ts: bigint, kind: VaultKind): string {
  const d = new Date(Number(ts) * 1000);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
  if (kind !== "hourly" && kind !== "test") return day;
  return `${day}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

/**
 * $DCA holder-perk banner under the create card: holding the threshold (100k $DCA by default, read live from the
 * vaults) has every buy sent straight to the wallet and halves the per-buy fee. Links to the Buy $DCA tab. A wallet
 * that already clears both thresholds sees a quiet confirmation instead; with no $DCA on this deployment, nothing.
 */
export function DcaPerksBanner({ m }: Props) {
  const t = usePerkThresholds();
  const { dir, address, dcaBal } = m;
  if (!dir || isZero(dir.dca)) return null;
  const bal = dcaBal ?? 0n;
  if (address && bal >= t.autoDistribute && bal >= t.feeHalve) {
    return (
      <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-line px-4 py-3 text-[12.5px] text-ink-2">
        <Icon name="check" size={14} className="shrink-0 text-good" />
        <span>Your $DCA is working: every buy is sent straight to your wallet and your buy fee is halved.</span>
      </div>
    );
  }
  const same = t.autoDistribute === t.feeHalve;
  return (
    <div className="mt-3 flex items-center gap-3 rounded-xl border border-lime/25 bg-lime/[0.07] px-3.5 py-3 sm:px-4">
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-lime text-lime-ink" aria-hidden>
        <Icon name="bolt" size={15} />
      </span>
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-2">
        {same ? (
          <>
            Hold <span className="font-semibold text-ink">{fmtUnitsCompact(t.feeHalve, 18)} $DCA</span> and your stock is sent straight to your wallet{" "}
            <span className="font-semibold text-ink">and</span> your fees are halved.
          </>
        ) : (
          <>
            Hold <span className="font-semibold text-ink">{fmtUnitsCompact(t.autoDistribute, 18)} $DCA</span> and your stock is sent straight to your wallet;
            hold <span className="font-semibold text-ink">{fmtUnitsCompact(t.feeHalve, 18)}</span> and your fees are halved too.
          </>
        )}
      </p>
      <Link href="/app/buy" className="btn-secondary h-8 shrink-0 rounded-lg px-3 text-[12.5px]">
        Buy $DCA
      </Link>
    </div>
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
