"use client";

import type { ReactNode } from "react";
import { Countdown, Icon } from "@/components/ui";
import { ChoiceAvatar } from "@/components/app/create/fields";
import { fmtBps, fmtPct, fmtUnits, fmtUsd, short } from "@/lib/format";
import { tickerName } from "@/lib/tickers";
import { BOOST } from "@/lib/config";
import type { PlanOrder } from "@/lib/planSteps";

/**
 * The tile above the timeline of a single-plan flow (deposit, withdraw, claim, boost, unboost): which plan, the
 * amount that moves, and a few lines on where it goes and what it costs — read from the order snapshot, so it
 * describes what was sent even after the live row has moved on.
 */
export function PlanFlowSummary({ order, planLabel }: { order: PlanOrder; /** "Daily · #3" */ planLabel: string }) {
  const name = order.name ?? tickerName(order.symbol);
  const { headline, sub, rows, tone, footnote } = describe(order);
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${tone === "boost" ? "boost-summary border-lime/40 bg-surface-3" : "border-line bg-surface-3"}`}>
      <div className="flex items-center gap-3">
        <ChoiceAvatar symbol={order.symbol} dca={order.dca} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-[14px] font-medium text-ink">
            {order.symbol}
            {name !== order.symbol && <span className="truncate text-[12.5px] font-normal text-ink-3">{name}</span>}
          </div>
          <div className="text-[12.5px] text-ink-3">{planLabel}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-[15px] font-medium text-ink ${typeof headline === "string" && /\d/.test(headline) ? "num" : ""}`}>{headline}</div>
          {sub && <div className="text-[11.5px] text-ink-3">{sub}</div>}
        </div>
      </div>
      {rows.length > 0 && (
        <dl className="mt-3 grid gap-1 border-t border-line pt-2.5 text-[12.5px]">
          {rows.map(([k, v, text]) => (
            <div key={k} className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-3">{k}</dt>
              <dd className={`text-right text-ink-2 ${text ? "" : "num"}`}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {footnote && <p className="mt-2 text-[11.5px] leading-normal text-ink-3">{footnote}</p>}
    </div>
  );
}

/** A detail line: label, value, and `true` when the value is words rather than a figure (not set in the mono face). */
type Row = [string, ReactNode] | [string, ReactNode, true];
type Described = { headline: ReactNode; sub?: ReactNode; rows: Row[]; tone?: "boost"; footnote?: ReactNode };

function describe(o: PlanOrder): Described {
  const stock = (v: bigint) => `${fmtUnits(v, o.stockDecimals, 4)} ${o.symbol}`;
  switch (o.kind) {
    case "deposit":
      return {
        headline: `+${o.pay === "USDG" ? fmtUsd(o.amount) : `${fmtUnits(o.amount, 18)} ETH`}`,
        sub: o.pay === "ETH" && o.credited !== undefined ? `≈ ${fmtUsd(o.credited)} USDG` : "into the plan",
        rows: [
          ...(o.balanceAfter !== undefined ? ([["Plan balance after", `≈ ${fmtUsd(o.balanceAfter)}`]] as Row[]) : []),
          ...(o.boosted
            ? ([
                [
                  BOOST.chip,
                  <span key="b" className="inline-flex items-center gap-1 text-lime">
                    <Icon name="bolt" size={11} /> lent on Morpho Blue as it lands
                  </span>,
                  true,
                ],
              ] as Row[])
            : []),
        ],
      };
    case "withdraw":
      return {
        headline: `−${fmtUsd(o.amount)}`,
        sub: o.all ? "everything in the plan" : "out of the plan",
        rows: [
          ...(o.fromBoost > 0n ? ([["From Morpho Blue", fmtUsd(o.fromBoost)]] as Row[]) : []),
          ["Withdrawal fee", fmtBps(o.feeBps)],
          // Read off the receipt once mined (`settled`); the click-time estimate until then.
          ["You receive", `${o.settled ? "" : "≈ "}${fmtUsd(o.receive)}`],
          ["Plan balance after", `${o.settled ? "" : "≈ "}${fmtUsd(o.balanceAfter)}`],
        ],
      };
    case "claim":
      return {
        headline: stock(o.amount),
        sub: o.usd !== undefined ? `≈ ${fmtUsd(o.usd)} · held for you` : "held for you",
        rows: [
          o.feeBps > 0 ? ["Claim fee", fmtBps(o.feeBps)] : ["Claim fee", o.perk ? "Free — you hold enough $DCA" : "None", true],
          [o.toSelf ? "To your wallet" : `To ${short(o.recipient)}`, stock(o.receive)],
        ],
      };
    case "boost":
      return {
        headline: o.lend > 0n ? fmtUsd(o.lend) : "Future deposits",
        sub: "lent on Morpho Blue",
        tone: "boost",
        rows: [
          o.apy !== undefined ? ["Earning", `${fmtPct(o.apy, true)} APY`] : ["Earning", "Morpho Blue supply rate", true],
          ["Pulled back", "automatically at each buy", true],
        ],
        footnote: "The rate moves with the market. Lending has its own risks: the market can run short of liquidity or take on bad debt.",
      };
    case "unboost":
      return {
        headline: fmtUsd(o.back),
        sub: "back into the plan",
        rows: o.earned > 0n ? [["Earned while boosted", `+${fmtUsd(o.earned)}`]] : [],
      };
    case "pause":
      return {
        headline: fmtUsd(o.balance),
        sub: o.pause ? "stays in the plan" : "in the plan",
        rows: o.pause
          ? [["Buys", "on hold until you resume", true], ...(o.boosted ? ([[BOOST.chip, "keeps earning while paused", true]] as Row[]) : [])]
          : [
              ["Per buy", fmtUsd(o.perBuy)],
              ...(o.nextBuy !== undefined ? ([["Next buy", <Countdown key="n" target={o.nextBuy} />]] as Row[]) : []),
            ],
      };
  }
}
