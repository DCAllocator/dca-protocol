import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui";
import { DOCS_PATH } from "@/lib/config";
import { BRIDGE_URL } from "./config";
import { BuybackLink, PerksSplit, Threshold } from "./shared";
import "./faq-final.css";

/*
 * The FAQ ("Straight answers."): the last objections in the order a newcomer has them (product, stock delivery,
 * $DCA, cost, onboarding, safety). A server component; the only client pieces are the islands that read the chain
 * (the live perk thresholds and the fee receiver's explorer link), so the answers are in the HTML before any script.
 * No fee percentage is printed here: the cost answer points at the docs, which carry the live table.
 */

const LINK = "text-lime-text hover:underline";

/* Answers that link out are split around the link, so the page and the JSON-LD are built from the same strings. */
const A5_HEAD = "A share of every purchase fee buys $DCA on-chain. As the protocol is used, $DCA is bought back over time, and every buyback is a transaction you can find on ";
const A5_LINK = "the explorer";
const A5_TAIL = ". $DCA is a protocol utility token: it is not equity, not a dividend and not a claim on any stock, and it gives no right to protocol fees.";

const A7_HEAD =
  "You need a browser wallet, such as MetaMask or Rabby, with a little ETH on Robinhood Chain for gas, and USDG or ETH to fund your plan. Open the app and connect; if your wallet is on another network, the app asks it to switch. ";
const A7_NO_BRIDGE = "If your funds are on another network, bridge them to Robinhood Chain first.";
const A7_TAIL = " Your first buy is due at the next scheduled buy time for your buy interval.";

const A10_HEAD =
  "Fees can only move within a hard cap compiled into the contract, and only your wallet can withdraw from or claim a plan. The owner does choose which stocks, trading routes and Boost lending market the vaults use, and there is no timelock on those changes yet, so a compromised owner key could misroute scheduled buys or move boosted balances into a bad lending market. The risks are set out in ";
const A10_LINK = "the docs";

type Qa = {
  q: string;
  a: ReactNode;
  /** The answer as plain text for the FAQPage JSON-LD. Left out where the answer shows a live threshold (q3, q4, q6),
   *  so structured data never freezes a number the owner can move. */
  ld?: string;
};

/** A plain-text answer that goes into the JSON-LD as written. */
const plain = (q: string, a: string): Qa => ({ q, a, ld: a });

const QA: Qa[] = [
  plain(
    "How does DCA work?",
    "Pick a Robinhood Stock Token, an amount per buy and a buy interval: hourly, daily, weekly or monthly. The amount per buy is at least $10 (a plan's final buy can be smaller). Deposit USDG, or ETH that converts to USDG on deposit. DCA then buys on schedule: plans on the same stock and buy interval go in as one trade, and each plan gets its share. A scheduled buy can be skipped, for example when a stock's price feed pauses over the weekend or the operators are down; nobody is charged for a skipped buy and it is not made up later.",
  ),
  plain(
    "Which stocks can I buy?",
    "Robinhood Stock Tokens the protocol has approved, each with a live price feed and enough on-chain liquidity: names like NVDA, TSLA and AAPL, ETFs such as SPY, and gold through GLD. New ones are added as price feeds and liquidity go live. The app always shows the current list.",
  ),
  {
    q: "Where does my stock go?",
    a: (
      <>
        If the wallet that owns the plan holds at least <Threshold perk="autoDistribute" />, each buy is sent straight to that wallet as it happens.
        Otherwise the stock waits in your plan, and you can claim it to your wallet any time from My plans, for a small claim fee. Either way, only
        your wallet can withdraw or claim.
      </>
    ),
  },
  {
    q: "What does holding $DCA do?",
    a: (
      <PerksSplit
        same={
          <>
            Hold at least <Threshold perk="autoDistribute" /> in the wallet that owns your plans and two perks switch on: half the purchase fee on every
            buy, and every buy sent straight to your wallet, so there is nothing to claim. The perks follow your wallet&apos;s balance at each buy.
          </>
        }
        split={
          <>
            Hold at least <Threshold perk="feeHalve" /> in the wallet that owns your plans for half the purchase fee on every buy, and at least{" "}
            <Threshold perk="autoDistribute" /> to have every buy sent straight to your wallet, so there is nothing to claim. The perks follow your
            wallet&apos;s balance at each buy.
          </>
        }
      />
    ),
  },
  {
    q: "How does $DCA DCA itself?",
    a: (
      <>
        {A5_HEAD}
        <BuybackLink>{A5_LINK}</BuybackLink>
        {A5_TAIL}
      </>
    ),
    ld: `${A5_HEAD}${A5_LINK}${A5_TAIL}`,
  },
  {
    q: "What does it cost?",
    a: (
      <>
        A purchase fee on each buy: the less often you buy, the lower it is, and wallets holding at least <Threshold perk="feeHalve" /> pay half.
        Withdrawals and claims carry a small fee;{" "}
        <PerksSplit
          same="claims are free for holders."
          split={
            <>
              claims are free from <Threshold perk="autoDistribute" />.
            </>
          }
        />{" "}
        The exact rates are in{" "}
        <Link href={`${DOCS_PATH}#fees`} className={LINK}>
          the docs
        </Link>
        .
      </>
    ),
  },
  {
    q: "How do I get started on Robinhood Chain?",
    a: (
      <>
        {A7_HEAD}
        {BRIDGE_URL ? (
          <>
            To move funds over, use{" "}
            <a href={BRIDGE_URL} target="_blank" rel="noreferrer" className={LINK}>
              a bridge to Robinhood Chain ↗
            </a>
            .
          </>
        ) : (
          A7_NO_BRIDGE
        )}
        {A7_TAIL}
      </>
    ),
    ld: `${A7_HEAD}${A7_NO_BRIDGE}${A7_TAIL}`,
  },
  plain(
    "Can I withdraw or stop any time?",
    "Yes. Pause a plan, withdraw idle funds or claim your stock whenever you like; there are no lock-ups. Withdrawals are paid in USDG and carry a small fee, and a boosted balance can wait on the lending market's liquidity. If the protocol is ever paused, new plans, deposits and buys stop; withdrawing and claiming still work.",
  ),
  plain(
    "What is a Robinhood Stock Token?",
    "An ERC-20 on Robinhood Chain that tracks the price of a listed stock or ETF. It gives you economic exposure to the underlying, not shares, voting rights or dividends. DCA buys them from public liquidity pools; it does not issue them.",
  ),
  {
    q: "Can the team change the fees, or take my funds?",
    a: (
      <>
        {A10_HEAD}
        <Link href={`${DOCS_PATH}#risks`} className={LINK}>
          {A10_LINK}
        </Link>
        .
      </>
    ),
    ld: `${A10_HEAD}${A10_LINK}.`,
  },
  plain(
    "Has it had an external audit?",
    "Not yet. The contracts have been through internal security reviews, and every fix has a regression test. Treat DCA as early software and only use funds you can afford to lose.",
  ),
  plain(
    "Who can use it?",
    "Robinhood Stock Tokens are not offered to US persons. This interface is unavailable in the United States, United Kingdom, Canada, Australia and sanctioned regions. The contracts themselves are public and permissionless.",
  ),
];

/** FAQPage structured data for the threshold-free answers; `<` is escaped so no answer can close the script tag. */
const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: QA.filter((x) => x.ld).map((x) => ({
    "@type": "Question",
    name: x.q,
    acceptedAnswer: { "@type": "Answer", text: x.ld },
  })),
}).replace(/</g, "\\u003c");

export function FaqV3() {
  return (
    <section id="faq" className="v3-faq container-x grid gap-10 py-20 lg:grid-cols-[4fr_8fr] lg:gap-12">
      <div className="lg:sticky lg:top-24 lg:self-start">
        <p className="eyebrow">FAQ</p>
        <h2 className="h-section mt-3">Straight answers.</h2>
        <Link href={DOCS_PATH} className="mt-4 inline-block text-[14px] text-lime-text hover:underline">
          Read the docs →
        </Link>
      </div>

      <div className="divide-y divide-line border-y border-line">
        {QA.map(({ q, a }, i) => (
          // Padding sits on the summary (not the row), so the whole question is the tap target: 50px at minimum.
          <details key={q} className="group pb-1.5" open={i === 0}>
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-sm pt-4 pb-2.5 text-[16px] font-medium text-pretty text-ink [&::-webkit-details-marker]:hidden [&:hover>span]:border-line-strong [&:hover>span]:text-ink">
              {q}
              <span
                aria-hidden
                className="grid size-7 shrink-0 place-items-center rounded-full border border-line text-ink-3 transition-[transform,border-color,color] duration-150 group-open:rotate-45 group-open:border-line-strong group-open:text-ink motion-reduce:transition-none"
              >
                <Icon name="plus" size={14} />
              </span>
            </summary>
            <div className="v3-faq-a pb-3.5">
              <p className="max-w-3xl text-[14px] leading-relaxed text-pretty text-ink-2 sm:pr-8">{a}</p>
            </div>
          </details>
        ))}
      </div>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON_LD }} />
    </section>
  );
}
