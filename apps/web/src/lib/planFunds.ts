import { fmtUsd } from "@/lib/format";
import { USDG_DECIMALS } from "@/lib/config";

/**
 * How a plan's balance compares with its per-buy amount, and the copy that says what the vault does about it. The
 * vault never skips an underfunded plan: each buy spends `min(balance, amountPerEpoch)`, so a plan holding less than
 * one buy makes one smaller buy that takes everything, then buys nothing until it is topped up. A paused plan buys
 * nothing at all until it is resumed. Pure, like `planSteps.ts`.
 */

/**
 * One cent (10_000 raw USDG), the smallest step `fmtUsd` shows. A remainder under it reads as "$0.00" everywhere yet
 * still counts on chain — one more sub-cent buy, and `PlanNotEmpty` on delete — so a withdrawal that would leave less
 * than this behind is sent as "everything" (the vault's MAX sentinel), and a row holding only this much says so.
 */
export const USDG_DUST = 10n ** BigInt(USDG_DECIMALS - 2);

/** `empty`: nothing left · `dust`: under a cent · `short`: less than one buy · `ok`: at least one full buy. */
export type FundsLevel = "empty" | "dust" | "short" | "ok";

export function fundsLevel(balance: bigint, perBuy: bigint): FundsLevel {
  if (balance === 0n) return "empty";
  if (balance < USDG_DUST) return "dust";
  return balance < perBuy ? "short" : "ok";
}

/**
 * "3 buys" / "3 buys + a $50.00 final buy" / "less than one buy": how far `balance` goes at `perBuy` a buy (what
 * follows "covers"). Each buy spends `min(balance, perBuy)`, so a remainder of a cent or more is one smaller last buy.
 * The create flow words its "covers …" line the same way.
 */
export function coverageCopy(balance: bigint, perBuy: bigint): string {
  if (perBuy === 0n) return "—";
  const full = balance / perBuy;
  const rest = balance - full * perBuy;
  if (full === 0n) return "less than one buy";
  return `${full.toLocaleString("en-US")} ${full === 1n ? "buy" : "buys"}${rest >= USDG_DUST ? ` + a ${fmtUsd(rest)} final buy` : ""}`;
}

/**
 * A USDG deposit that credits at least `net` once the deposit fee is taken, rounded up to the cent so the figure
 * `fmtUsd` shows is itself enough (it rounds half up, which could otherwise land a hair short).
 */
export function depositFor(net: bigint, feeBps: number): bigint {
  const keep = 10_000n - BigInt(feeBps);
  const gross = keep > 0n ? (net * 10_000n + keep - 1n) / keep : net;
  return ((gross + USDG_DUST - 1n) / USDG_DUST) * USDG_DUST;
}

/** How the next buy is introduced: a paused plan only buys again once it is resumed. */
const nextBuy = (paused: boolean) => (paused ? "Once you resume the plan, its next buy" : "The next buy");

/**
 * Deposit form: the plan would still hold less than one buy after this deposit. `after` is the balance once it lands
 * (`approx` for an ETH quote); `topUp` is the extra that makes one full buy, already worded for the pay currency.
 */
export function depositShortCopy(i: { after: bigint; perBuy: bigint; paused: boolean; approx: boolean; topUp?: string }): string {
  const after = `${i.approx ? "≈ " : ""}${fmtUsd(i.after)}`;
  return `After this deposit the plan holds ${after} — less than one ${fmtUsd(i.perBuy)} buy. ${nextBuy(i.paused)} spends all ${after}, then the plan stops until you top it up.${
    i.topUp ? ` ${i.topUp}` : ""
  }`;
}

/**
 * Withdraw form: what the plan is left with. `undefined` when it still covers a full buy, or when it never buys anyway
 * (`bought === false`) and emptying it changes nothing but the balance.
 */
export function withdrawLeftCopy(i: { remaining: bigint; perBuy: bigint; paused: boolean; bought?: boolean }): { tone: "warn" | "info"; text: string } | undefined {
  if (i.remaining === 0n) {
    const stops = i.bought === false ? "" : i.paused ? " It stays paused and buys nothing until you deposit and resume it." : " It stops buying until you deposit again.";
    return { tone: "info", text: `This empties the plan.${stops} Stock already bought stays claimable.` };
  }
  if (i.bought === false || i.remaining >= i.perBuy) return undefined;
  return {
    tone: "warn",
    text: `This leaves ${fmtUsd(i.remaining)} — less than one ${fmtUsd(i.perBuy)} buy. ${nextBuy(i.paused)} spends all of it, then the plan stops buying.`,
  };
}

/**
 * The notice under a plan's row on My plans when it holds less than one buy; `undefined` when it holds at least one.
 * A warning only for a running plan that is out of funds (or down to dust): it has stopped buying, or all but.
 * A paused plan is told how to buy again — or, empty, that it can go (a close that had to park it lands here too).
 */
export function rowFundsCopy(i: { balance: bigint; perBuy: bigint; paused: boolean }): { tone: "warn" | "info"; text: string } | undefined {
  switch (fundsLevel(i.balance, i.perBuy)) {
    case "ok":
      return undefined;
    case "empty":
      return i.paused
        ? { tone: "info", text: "Paused and out of funds. Deposit and resume it to buy again, or remove it from the plan's menu." }
        : { tone: "warn", text: "Out of funds — this plan has stopped buying. Deposit to keep it going." };
    case "dust":
      return i.paused
        ? { tone: "info", text: "Paused with less than $0.01 left. Deposit and resume it to buy again, or remove it from the plan's menu." }
        : { tone: "warn", text: "Less than $0.01 is left: the next buy spends it, then the plan stops. Deposit to keep it going." };
    case "short":
      return i.paused
        ? {
            tone: "info",
            text: `Paused with ${fmtUsd(i.balance)} — less than one ${fmtUsd(i.perBuy)} buy. Once you resume it, its next buy spends all of it, then the plan stops.`,
          }
        : { tone: "info", text: `Last buy: the next buy spends the remaining ${fmtUsd(i.balance)}, then the plan stops. Deposit to keep it going.` };
  }
}
