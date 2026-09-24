import Link from "next/link";
import { Wordmark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PRODUCTION_VAULT_KINDS, VAULT_META } from "@/lib/config";
import { PerkThreshold } from "@/components/site/Live";

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface-0/85 backdrop-blur">
      <div className="container-x flex h-14 items-center">
        <Link href="/">
          <Wordmark size={24} />
        </Link>
        <nav className="ml-8 hidden items-center gap-6 text-[13px] text-ink-2 md:flex">
          <a href="#how" className="hover:text-ink">
            How it works
          </a>
          <a href="#vaults" className="hover:text-ink">
            Vaults
          </a>
          <a href="#fees" className="hover:text-ink">
            Fees
          </a>
          <a href="#faq" className="hover:text-ink">
            FAQ
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/app/create" className="btn-primary">
            Launch app
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

export function HowItWorks() {
  const steps = [
    {
      n: "01",
      t: "Pick a stock and a rhythm",
      d: "NVDA, AAPL, TSLA, SPY, QQQ and more. Choose hourly, daily, weekly or monthly buys and how much to spend each time.",
    },
    {
      n: "02",
      t: "Deposit once",
      d: "Fund the plan with USDG, or with ETH and it is converted to USDG on the spot (at least $10 to start). Top up or withdraw idle funds whenever you like — it never leaves your control.",
    },
    {
      n: "03",
      t: "We buy on the clock",
      d: "Every epoch your plan buys at the best price across Uniswap and Ramses. Claim your stock, or hold $DCA and have it sent automatically.",
    },
  ];
  return (
    <section id="how" className="container-x py-20">
      <p className="eyebrow">How it works</p>
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
    </section>
  );
}

export function Vaults() {
  const copy = {
    hourly: { tag: "Fastest", who: "The finest averaging there is: a small buy every hour, around the clock." },
    daily: { tag: "Smoothest", who: "For people who never want to think about entry price again." },
    weekly: { tag: "Most popular", who: "The classic pay-day cadence. One buy a week, fee in the middle." },
    monthly: { tag: "Lowest fee", who: "Bigger, rarer buys at the lowest fee we offer." },
  } as const;
  return (
    <section id="vaults" className="border-y border-line bg-surface-2">
      <div className="container-x py-20">
        <p className="eyebrow">Vaults</p>
        <h2 className="h-section mt-3 max-w-xl">Choose how often. We handle the rest.</h2>
        <p className="lede mt-3 max-w-2xl">Four vaults, one job each. The fee is taken per buy — nothing on the way in, and never a surprise.</p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PRODUCTION_VAULT_KINDS.map((k) => (
            <div key={k} className={`rounded-lg border p-6 ${k === "weekly" ? "border-lime bg-surface-3" : "border-line bg-surface-3"}`}>
              <div className="flex items-center justify-between">
                <span className="text-xl font-semibold text-ink">{VAULT_META[k].label}</span>
                <span className={k === "weekly" ? "chip-lime" : "chip"}>{copy[k].tag}</span>
              </div>
              <div className="mt-5 flex items-baseline gap-1">
                <span className="text-4xl font-semibold tracking-tight text-ink">{(VAULT_META[k].defaultFeeBps / 100).toFixed(2)}%</span>
                <span className="text-[13px] text-ink-3">per buy</span>
              </div>
              <div className="mt-1 text-[13px] text-ink-3">{VAULT_META[k].cadence}</div>
              <p className="mt-4 text-[14px] leading-relaxed text-ink-2">{copy[k].who}</p>
              <Link href="/app/create" className={`${k === "weekly" ? "btn-primary" : "btn-secondary"} mt-6 w-full`}>
                Start a {VAULT_META[k].label.toLowerCase()} plan
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Benefits() {
  const items = [
    ["No market timing", "Buying on a fixed schedule averages your entry price over time. Boring by design."],
    ["Your keys, your stock", "Plans live in a smart contract you control. Pause, top up or withdraw idle funds at any moment."],
    ["Best price, automatically", "Every buy is routed across Uniswap V3, V4 and Ramses and capped at 1.5% price impact."],
    ["Fees you can see", "One fee per buy, shown before you sign. Hard-capped at 0.90% in the code."],
  ];
  return (
    <section className="container-x py-20">
      <p className="eyebrow">Why DCA</p>
      <h2 className="h-section mt-3 max-w-xl">Built for people, not traders.</h2>
      <div className="mt-10 grid gap-x-10 gap-y-8 md:grid-cols-2">
        {items.map(([t, d]) => (
          <div key={t} className="flex gap-4">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-sm bg-lime" />
            <div>
              <h3 className="text-[16px] font-semibold text-ink">{t}</h3>
              <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{d}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Perks() {
  return (
    <section className="border-y border-line bg-surface-2">
      <div className="container-x grid gap-8 py-20 md:grid-cols-[1fr_1.2fr] md:items-center">
        <div>
          <p className="eyebrow">$DCA holders</p>
          <h2 className="h-section mt-3">Hold $DCA, pay less.</h2>
          <p className="lede mt-3">Perks read your wallet balance at the moment each buy executes. No staking, no lock-ups.</p>
        </div>
        <div className="grid gap-3">
          <div className="rounded-lg border border-line bg-surface-3 p-5">
            <div className="flex items-center gap-2">
              <span className="chip-lime">
                <PerkThreshold perk="autoDistribute" />
              </span>
              <span className="text-[16px] font-semibold text-ink">Auto-send, free claims</span>
            </div>
            <p className="mt-2 text-[14px] text-ink-2">Stock goes straight to your wallet every epoch. The 0.25% claim fee disappears.</p>
          </div>
          <div className="rounded-lg border border-line bg-surface-3 p-5">
            <div className="flex items-center gap-2">
              <span className="chip-lime">
                <PerkThreshold perk="feeHalve" />
              </span>
              <span className="text-[16px] font-semibold text-ink">Half the purchase fee</span>
            </div>
            <p className="mt-2 text-[14px] text-ink-2">0.90% becomes 0.45%, 0.75% becomes 0.37%, 0.50% becomes 0.25%, 0.25% becomes 0.12% — on every buy, in every vault.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Faq() {
  const qa = [
    ["What am I actually buying?", "Robinhood Stock Tokens: on-chain tokens that track the price of a listed stock. They give you economic exposure to the stock, not shares or shareholder rights."],
    ["When do purchases happen?", "Hourly plans buy every hour on the hour (UTC), around the clock, daily plans at 00:00 UTC every day, weekly plans on Monday 00:00 UTC, monthly plans every 30 days. If a buy is ever missed it is skipped — you are never charged twice."],
    ["What does it cost?", "One fee per buy: 0.90% hourly, 0.75% daily, 0.50% weekly, 0.25% monthly. Withdrawing idle funds or claiming stock costs 0.25%. Depositing is free. Every fee is capped at 0.90% in the contract."],
    ["Can I stop or get my money back?", "Yes. Pause a plan, change the amount, or withdraw idle USDG at any time. Stock you have already bought is yours to claim."],
    ["Can I pay with ETH?", "Yes. ETH is converted to USDG the moment you deposit it, with a 0.5% price tolerance, so the plan always holds USDG. Withdrawals are paid in USDG."],
    ["Is there a minimum?", "The amount per buy is at least $10 (a plan's final buy can be smaller), and a plan needs at least $10 to start (or to top up). That keeps tiny plans from clogging the shared buy for everyone."],
    ["Who can use DCA?", "DCA is not available to US persons or in the United Kingdom, Canada, Australia and sanctioned regions. The contracts are public; this interface is not offered there."],
    ["Is it audited?", "Not yet. The code is open, fully tested and documented, but you should treat it as early software and only use funds you can afford to lose."],
  ];
  return (
    <section id="faq" className="container-x py-20">
      <p className="eyebrow">FAQ</p>
      <h2 className="h-section mt-3">Straight answers.</h2>
      <div className="mt-8 divide-y divide-line border-y border-line">
        {qa.map(([q, a]) => (
          <details key={q} className="group py-4">
            <summary className="flex items-center justify-between gap-4 text-[16px] font-medium text-ink">
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

export function FinalCta() {
  return (
    <section className="border-t border-line bg-surface-2">
      <div className="container-x flex flex-col items-start gap-6 py-20 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="h-section">Your first buy is one deposit away.</h2>
          <p className="lede mt-2">Set the plan today. Own a little more every epoch.</p>
        </div>
        <Link href="/app/create" className="btn-primary btn-lg">
          Start a plan
        </Link>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface-0">
      <div className="container-x grid gap-8 py-12 md:grid-cols-[1fr_auto]">
        <div className="max-w-2xl">
          <Wordmark />
          <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
            Robinhood Stock Tokens are not offered to US persons. This interface is unavailable in the United States, United Kingdom, Canada,
            Australia and sanctioned regions. Stock Tokens provide economic exposure to the underlying, not shareholder rights. Nothing on
            this site is investment advice. Smart contracts are unaudited software; use at your own risk. DCA is independent software and is
            not affiliated with or endorsed by Robinhood.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-10 gap-y-2 text-[13px] text-ink-2">
          <Link href="/app" className="hover:text-ink">
            App
          </Link>
          <a href="#how" className="hover:text-ink">
            How it works
          </a>
          <a href="#fees" className="hover:text-ink">
            Fees
          </a>
          <a href="#faq" className="hover:text-ink">
            FAQ
          </a>
          <a href="https://github.com" target="_blank" rel="noreferrer" className="hover:text-ink">
            GitHub
          </a>
          <a href="https://github.com" target="_blank" rel="noreferrer" className="hover:text-ink">
            Security
          </a>
        </div>
      </div>
    </footer>
  );
}
