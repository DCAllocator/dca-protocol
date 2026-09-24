import Link from "next/link";
import { Wordmark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PerkThreshold } from "@/components/site/Live";
import { BoostTeaser, LaunchAppLink, PlansPreview, StockGrid } from "@/components/site/LandingLive";
import { BuyDcaLink as BuyDca } from "@/components/BuyDcaLink";
import { SocialLinks } from "@/components/SocialLinks";
import { DOCS_PATH, PRODUCTION_VAULT_KINDS, VAULT_META } from "@/lib/config";
import { frequencyHref, startPlanLabel } from "@/lib/createLinks";

/*
 * Token-first landing page. The old product-first page lives on at /legacy (components/site/Sections.tsx).
 * Copy rules agreed for this page: no fee percentages, no buyback amounts, no buyback timing.
 * "Buy $DCA" is the shared components/BuyDcaLink.tsx: always /app/buy, which hands off to Pons when it cannot swap in-app.
 */

export function LandingNav() {
  const links: [string, string][] = [
    ["#token", "$DCA"],
    ["#flywheel", "Buyback"],
    ["#protocol", "Protocol"],
    ["#stocks", "Stocks"],
    ["#faq", "FAQ"],
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface-0/85 backdrop-blur">
      <div className="container-x flex h-14 items-center">
        <Link href="/">
          <Wordmark size={24} />
        </Link>
        <nav className="ml-8 hidden items-center gap-6 text-[13px] text-ink-2 md:flex">
          {links.map(([href, label]) => (
            <a key={href} href={href} className="hover:text-ink">
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <SocialLinks className="mr-1 hidden lg:flex" />
          <LaunchAppLink className="btn-secondary hidden sm:inline-flex">Launch app</LaunchAppLink>
          <BuyDca />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

export function Hero() {
  return (
    <section id="token" className="relative overflow-hidden">
      <div className="grid-fade pointer-events-none absolute inset-0" />
      <div className="container-x relative grid gap-12 py-20 md:py-24 lg:grid-cols-[1fr_1.1fr] lg:items-center">
        <div className="min-w-0">
          <p className="eyebrow">$DCA · Robinhood Chain</p>
          <h1 className="mt-4 text-5xl font-semibold leading-[1.02] tracking-tight text-ink md:text-6xl">
            The token that <span className="whitespace-nowrap text-lime">$DCA's</span> itself.
            <br />
          </h1>
          <p className="mt-5 text-[22px] font-semibold tracking-tight text-ink">Wall street stocks, automatically bought on-chain.</p>
          <p className="lede mt-3 max-w-lg">
            DCA is an execution protocol for Robinhood stock tokens. Pick a stock and a frequency; it buys for you on-chain and sends the stock directly to
            your wallet.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <BuyDca className="btn-primary btn-lg" />
            <Link href="/app/create" className="btn-secondary btn-lg">
              Start a stock plan
            </Link>
          </div>
          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-ink-3">
            {["Non-custodial", "Permissionless", "Open source"].map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-lime" />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          <PlansPreview />
        </div>
      </div>
    </section>
  );
}

export function Pillars() {
  const items = [
    {
      tag: "01 · The asset",
      t: "Wall Street stocks, bought on-chain",
      d: "Robinhood puts real stocks on-chain as tokens: NVDA, SPY, TSLA, GLD and many more. DCA buys them for you, on a schedule, at the best available price.",
      fact: ["Every listed ticker", "best price across Uniswap and Ramses"],
    },
    {
      tag: "02 · The token",
      t: "A token that DCAs into itself",
      d: "Every buy pays a small fee to the protocol. The protocol uses its fees to buy $DCA back — on-chain, where anyone can check.",
      fact: ["Fees in → $DCA out", "verifiable on the explorer"],
    },
    {
      tag: "03 · The product",
      t: "Set it once. It lands in your wallet.",
      d: "Pick a stock, a rhythm and an amount. Deposit once. From then on the vault buys for you and sends the stock to your wallet. Pause, top up or withdraw whenever you like.",
      fact: ["From $10 per buy", "pay in USDG or ETH · non-custodial"],
    },
  ];
  return (
    <section className="container-x py-20">
      <p className="eyebrow">Why $DCA</p>
      <h2 className="h-section mt-3 max-w-xl">One token. Three reasons it isn&apos;t just another ticker.</h2>
      <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
        {items.map((it) => (
          <div key={it.tag} className="flex flex-col gap-3 bg-surface-2 p-6">
            <div className="num text-[11px] font-medium uppercase tracking-[0.08em] text-lime">{it.tag}</div>
            <h3 className="text-xl font-semibold leading-tight text-ink">{it.t}</h3>
            <p className="text-[14.5px] leading-relaxed text-ink-2">{it.d}</p>
            <div className="mt-auto border-t border-line pt-3.5 text-[12.5px] text-ink-3">
              <strong className="font-semibold text-ink">{it.fact[0]}</strong> · {it.fact[1]}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** HTML cards over an SVG ring, so labels wrap instead of clipping at any width. */
export function Flywheel() {
  const node = "absolute w-[36%] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-3 text-center max-[560px]:w-[40%] max-[560px]:p-2.5";
  const plain = `${node} border-line-strong bg-surface-3`;
  const hot = `${node} border-lime bg-lime`;
  const arrow = "M-2.6 -2.2 L2.6 0 L-2.6 2.2 Z";
  const flow: [string, string | null, string, boolean][] = [
    ["Purchase fee, per buy + trading fees", "a fraction of every stock buy, and of every $DCA trade", "→ Protocol treasury", false],
    ["Treasury", "on the protocol's own rails, through approved pools only", "→ Buys $DCA back", true],
    ["Route", null, "USDG → $DCA", false],
    ["Every buyback", "a transaction on Robinhood Chain, not a tweet", "On-chain, verifiable", false],
  ];
  return (
    <section id="flywheel" className="border-y border-line bg-surface-2">
      <div className="container-x py-20">
        <p className="eyebrow">The flywheel</p>
        <h2 className="h-section mt-3 max-w-xl">Fees in. $DCA out.</h2>
        <p className="lede mt-3 max-w-2xl">
          The buyback is not a treasury policy. It is a DCA plan — the same contract every user runs — whose stock is $DCA and whose deposits are the
          protocol&apos;s fees. It runs on the protocol&apos;s own rails, through the same approved routes, and every buy is on-chain. If the protocol
          is used, $DCA is bought.
        </p>

        <div className="mt-10 grid items-center gap-12 lg:grid-cols-[1.1fr_1fr]">
          <div
            className="relative mx-auto aspect-square w-full max-w-[540px]"
            role="img"
            aria-label="Flywheel: plans buy stock, fees are collected, the treasury buys $DCA back, holders pay less, which drives more plans"
          >
            <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
              <circle cx="50" cy="50" r="33" fill="none" stroke="var(--color-lime-text)" strokeOpacity=".5" strokeWidth=".6" strokeDasharray="1.2 2" />
              {/* clockwise arrowheads at 45° / 135° / 225° / 315° */}
              <g fill="var(--color-lime-text)">
                <path d={arrow} transform="translate(73.33 26.67) rotate(45)" />
                <path d={arrow} transform="translate(73.33 73.33) rotate(135)" />
                <path d={arrow} transform="translate(26.67 73.33) rotate(225)" />
                <path d={arrow} transform="translate(26.67 26.67) rotate(315)" />
              </g>
            </svg>
            <div className="num absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-[11px] leading-[1.7] tracking-[0.18em] text-ink-3">
              SAME RAILS
              <br />
              ON-CHAIN
            </div>
            <div className={`${plain} top-[17%] left-1/2`}>
              <div className="text-[14px] font-semibold leading-tight text-ink max-[560px]:text-[12.5px]">Plans buy stock</div>
              <div className="mt-1 text-[12px] leading-snug text-ink-2 max-[560px]:text-[11px]">NVDA · SPY · GLD · TSLA</div>
            </div>
            <div className={`${plain} top-1/2 left-[83%]`}>
              <div className="text-[14px] font-semibold leading-tight text-ink max-[560px]:text-[12.5px]">Fees collected</div>
              <div className="mt-1 text-[12px] leading-snug text-ink-2 max-[560px]:text-[11px]">purchase fees + $DCA trading fees</div>
            </div>
            <div className={`${hot} top-[83%] left-1/2`}>
              <div className="text-[14px] font-bold leading-tight text-lime-ink max-[560px]:text-[12.5px]">Treasury buys $DCA back</div>
              <div className="mt-1 text-[12px] leading-snug text-lime-ink max-[560px]:text-[11px]">on-chain · verifiable</div>
            </div>
            <div className={`${plain} top-1/2 left-[17%]`}>
              <div className="text-[14px] font-semibold leading-tight text-ink max-[560px]:text-[12.5px]">Holders pay less</div>
              <div className="mt-1 text-[12px] leading-snug text-ink-2 max-[560px]:text-[11px]">auto-delivery · half fees</div>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-line bg-surface-3">
            {flow.map(([k, sub, v, lime]) => (
              <div key={k} className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-line px-4 py-3.5 last:border-b-0">
                <div className="text-[13.5px] text-ink-2">
                  {k}
                  {sub && <span className="mt-0.5 block text-[11.5px] text-ink-3">{sub}</span>}
                </div>
                <div className={`text-right font-semibold whitespace-nowrap ${lime ? "text-lime" : "text-ink"}`}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function HoldPerk() {
  return (
    <section className="container-x grid gap-10 py-20 md:grid-cols-[1fr_1.2fr] md:items-center">
      <div>
        <p className="eyebrow">Hold $DCA</p>
        <h2 className="h-section mt-3">Hold $DCA. Pay less.</h2>
        <p className="lede mt-3">
          No staking, no lock-ups. Perks read your wallet balance at the moment each buy executes — hold the token and they&apos;re on.
        </p>
      </div>
      <div className="rounded-xl border border-line bg-surface-3 p-6">
        <div className="flex flex-wrap items-center gap-2.5 text-[18px] font-semibold text-ink">
          <span className="chip-lime num">
            ≥ <PerkThreshold perk="autoDistribute" />
          </span>
          Stocks delivered automatically. Fees halved.
        </div>
        <p className="mt-2.5 text-[14.5px] leading-relaxed text-ink-2">
          Every buy lands in your wallet the moment it executes, no claiming, no claim fee — and your purchase fee is cut in half on every plan, in
          every vault.
        </p>
        <div className="mt-4 rounded-r-lg border-l-[3px] border-lime bg-surface-2 px-4 py-3.5 text-[17px] font-semibold leading-snug tracking-tight text-ink">
          Set the recipient to a cold wallet and never touch the app again.
        </div>
      </div>
    </section>
  );
}

export function Protocol() {
  const steps = [
    {
      n: "01",
      t: "Pick a stock and a rhythm",
      d: "NVDA, AAPL, TSLA, SPY, GLD and many more. Hourly, daily, weekly or monthly buys, and how much to spend each time (from $10).",
    },
    {
      n: "02",
      t: "Deposit once",
      d: "Fund the plan with USDG, or with ETH and it converts to USDG on the spot. Top up or withdraw idle funds whenever you like — it never leaves your control.",
    },
    {
      n: "03",
      t: "It buys on the clock",
      d: "Every epoch the vault pools everyone's buy, routes one swap at the best approved price and credits your share. Hold $DCA and it lands in your wallet automatically.",
    },
  ];
  const vaults = {
    hourly: { when: "every hour", who: "The finest averaging there is: a small buy every hour, around the clock." },
    daily: { when: "every day", who: "For people who never want to think about entry price again." },
    weekly: { when: "every Monday", who: "The classic pay-day cadence. One buy a week." },
    monthly: { when: "every 30 days", who: "Bigger, rarer buys at the lowest fee." },
  } as const;
  return (
    <section id="protocol" className="border-y border-line bg-surface-2">
      <div className="container-x py-20">
        <p className="eyebrow">The protocol</p>
        <h2 className="h-section mt-3 max-w-xl">Three steps. Then it runs itself.</h2>
        <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.n} className="bg-surface-1 p-6">
              <div className="num text-[12px] font-semibold text-lime">{s.n}</div>
              <h3 className="mt-3 text-lg font-semibold text-ink">{s.t}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{s.d}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="panel bg-surface-1">
            <div className="flex h-10 items-center gap-2 border-b border-line bg-surface-0 px-3.5 text-[12px]">
              <span className="font-semibold text-ink">Vaults</span>
              <span className="text-ink-3">·</span>
              <span className="text-ink-3">one per rhythm</span>
            </div>
            {/*
              Each row opens Create plan on its frequency (`frequencyHref`): the "Start" link's ::after stretches over the
              whole row, so the frequency's name and blurb are one click target with it — and still one tab stop.
            */}
            {PRODUCTION_VAULT_KINDS.map((k) => (
              <div
                key={k}
                className="group relative grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3.5 transition-colors last:border-b-0 hover:bg-surface-2 focus-within:bg-surface-2 sm:grid-cols-[96px_1fr_auto]"
              >
                <div>
                  <div className="text-[16px] font-semibold text-ink">
                    <span className="underline-offset-4 group-hover:underline">{VAULT_META[k].label}</span>
                    {k === "weekly" && <span className="chip-lime ml-2 align-[2px]">popular</span>}
                    {k === "hourly" && <span className="chip ml-2 align-[2px]">fastest</span>}
                  </div>
                  <div className="text-[11.5px] text-ink-3">{vaults[k].when}</div>
                </div>
                <div className="col-span-2 text-[13.5px] text-ink-2 sm:col-span-1">{vaults[k].who}</div>
                <Link
                  href={frequencyHref(k)}
                  aria-label={startPlanLabel(k)}
                  className={`${k === "weekly" ? "btn-primary" : "btn-secondary"} btn-xs col-start-2 row-start-1 after:absolute after:inset-0 sm:col-start-auto sm:row-start-auto`}
                >
                  Start
                </Link>
              </div>
            ))}
            <div className="flex items-center gap-4 border-t border-line bg-surface-0 px-3.5 py-1.5 text-[11px] text-ink-3">
              <span className="flex items-center gap-1.5">
                <i className="h-1.5 w-1.5 rounded-full bg-good" /> Robinhood Chain
              </span>
              <span>one pooled swap per epoch</span>
              <span className="ml-auto">non-custodial</span>
            </div>
          </div>
          <BoostTeaser />
        </div>
      </div>
    </section>
  );
}

export function Stocks() {
  return (
    <section id="stocks" className="container-x py-20">
      <p className="eyebrow">Stocks</p>
      <h2 className="h-section mt-3 max-w-xl">Every Robinhood stock token. On a schedule.</h2>
      <p className="lede mt-3 max-w-2xl">Ranked by on-chain market cap. When Robinhood lists a token, it can be added the same day.</p>
      <StockGrid />
    </section>
  );
}

export function LandingFaq() {
  const qa = [
    [
      "What am I actually getting when I buy $DCA?",
      "A protocol token with two on-chain jobs. First, it is what the protocol's fees buy back, through a plan anyone can watch on the explorer — so protocol usage translates directly into on-chain demand for $DCA. Second, holding it changes how the product treats you: stock delivered to your wallet automatically, and half the purchase fee. It is not equity, not a dividend, and not a claim on any stock.",
    ],
    [
      "Where does the buyback money come from?",
      "From a small fee on every stock buy, and from trading fees on $DCA itself. Fees flow to the protocol treasury, which buys $DCA back on-chain through the same approved pools user plans use. Every buyback is a transaction you can find on the explorer.",
    ],
    [
      "What is a Robinhood stock token?",
      "An ERC-20 on Robinhood Chain that tracks the price of a listed stock or ETF. It gives you economic exposure to the underlying — not shares, voting rights or dividends. DCA buys them from public liquidity pools; it does not issue them.",
    ],
    [
      "Can the team change the fees, or take my funds?",
      "Fees can be adjusted by the owner, but only within a hard cap compiled into the contract. Nothing in the vault can move a user's balance except the user; pausing only stops new plans and new buys — withdrawing idle funds and claiming bought stock always work.",
    ],
    [
      "Who can use it?",
      "Robinhood stock tokens are not offered to US persons. This interface is unavailable in the United States, United Kingdom, Canada, Australia and sanctioned regions. The contracts themselves are public and permissionless.",
    ],
    [
      "Is it audited?",
      "The code is open source and has been through two internal review rounds with regression tests for every finding. It has not yet had an external audit. Treat it as early software and only use funds you can afford to lose.",
    ],
    ["Is there a minimum?", "The amount per buy is at least $10 (a plan's final buy can be smaller), and a plan needs at least $10 to start or top up. That keeps dust plans from clogging the shared buy for everyone."],
  ];
  return (
    <section id="faq" className="container-x py-20">
      <p className="eyebrow">FAQ</p>
      <h2 className="h-section mt-3">Straight answers.</h2>
      <div className="mt-8 divide-y divide-line border-y border-line">
        {qa.map(([q, a], i) => (
          <details key={q} className="group py-4" open={i === 0}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[16px] font-medium text-ink [&::-webkit-details-marker]:hidden">
              {q}
              <span className="text-ink-3 transition-transform group-open:rotate-45">+</span>
            </summary>
            <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-ink-2">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

export function LandingCta() {
  return (
    <section className="border-t border-line bg-surface-2">
      <div className="container-x flex flex-col items-start gap-6 py-20 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="h-section">Two ways in.</h2>
          <p className="lede mt-2">Hold the token the protocol buys. Or run the plan the protocol runs. Or both.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/app/create" className="btn-secondary btn-lg">
            Start a stock plan
          </Link>
          <BuyDca className="btn-primary btn-lg" />
        </div>
      </div>
    </section>
  );
}

export function LandingFooter() {
  return (
    <footer className="border-t border-line bg-surface-0">
      <div className="container-x grid gap-8 py-12 md:grid-cols-[1fr_auto]">
        <div className="max-w-2xl">
          <Wordmark />
          <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
            Robinhood Stock Tokens are not offered to US persons. This interface is unavailable in the United States, United Kingdom, Canada,
            Australia and sanctioned regions. Stock Tokens provide economic exposure to the underlying, not shareholder rights. $DCA is a protocol
            utility token; it is not equity, a security, or a promise of returns. Nothing on this site is investment advice. Smart contracts are
            unaudited software; use at your own risk. DCA is independent software and is not affiliated with or endorsed by Robinhood.
          </p>
          <SocialLinks className="-ml-2 mt-5" size={18} />
        </div>
        <div className="grid content-start grid-cols-2 gap-x-10 gap-y-2 text-[13px] text-ink-2">
          <LaunchAppLink className="hover:text-ink">App</LaunchAppLink>
          <a href="#flywheel" className="hover:text-ink">
            Buyback
          </a>
          <a href="#protocol" className="hover:text-ink">
            Protocol
          </a>
          <a href="#stocks" className="hover:text-ink">
            Stocks
          </a>
          <Link href={DOCS_PATH} className="hover:text-ink">
            Docs
          </Link>
          <a href="#faq" className="hover:text-ink">
            FAQ
          </a>
        </div>
      </div>
    </footer>
  );
}
