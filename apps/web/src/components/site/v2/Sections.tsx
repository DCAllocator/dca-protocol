import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DOCS_PATH } from "@/lib/config";
import {
  AddressRow,
  BoostApy,
  CaChip,
  ConstantsStrip,
  CopyLine,
  FeeReceiverCard,
  IconExt,
  LatestBurns,
  LaunchAppLink,
  MiniCounter,
  PlanSummaryLine,
  StockTape,
  StocksLive,
  Threshold,
  ThresholdShare,
  TraceABuy,
  VaultTable,
  WatchBurnLink,
} from "./Live";
import { V2, TRADE_BURN_PCT, CHAIN_ID, pct, repoFile } from "./config";

/*
 * /v2 — token-first door, protocol-first floor. Every $DCA sentence is a supply or fee-routing fact; the token is
 * never sold on price. One lime button per section ("Buy $DCA on Pons"); "Start a plan" is a text or outline link.
 * Copy that a previous iteration kept off the page on purpose (fee percentages, the 70/30 split) is printed here
 * because it is compiled into the contracts and on the explorer anyway — see the FAQ for the reasoning.
 */

const RISK = "$DCA carries no right to revenue or any distribution. Burns are programmed, not promised. It may lose its value in part or in full.";
const GEO = "Interface not available in the US, UK, Canada, Australia or sanctioned regions.";
const AFFILIATION = "This project is not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.";

function BuyDca({ className = "btn-primary", children = "Buy $DCA on Pons" }: { className?: string; children?: ReactNode }) {
  return V2.buyIsExternal ? (
    <a href={V2.buyUrl} target="_blank" rel="noreferrer" className={className}>
      {children} <IconExt />
    </a>
  ) : (
    <Link href={V2.buyUrl} className={className}>
      {children}
    </Link>
  );
}

/** Mono source chip: a link to the file when the repository URL is configured, plain text until then. */
function Src({ file, line }: { file: string; line?: string }) {
  const href = repoFile(file);
  const text = line ? `${file.split("/").pop()} · ${line}` : file.split("/").pop();
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="v2-num inline-flex h-6 items-center gap-1 rounded-sm border border-line px-1.5 text-[11px] text-ink-2 whitespace-nowrap hover:border-ink hover:text-ink">
      {text} <IconExt size={10} />
    </a>
  ) : (
    <span className="v2-num inline-flex h-6 items-center rounded-sm border border-line px-1.5 text-[11px] text-ink-3 whitespace-nowrap" title="Source is published at launch">
      {text}
    </span>
  );
}

function Socials({ className = "" }: { className?: string }) {
  const links: [string, string | undefined, ReactNode][] = [
    [
      "X",
      V2.xUrl,
      <svg key="x" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M18.9 2H22l-7.2 8.3L23 22h-6.7l-5.2-6.8L5 22H1.9l7.7-8.8L1 2h6.8l4.7 6.2L18.9 2zm-1.2 18h1.8L7.4 3.9H5.5L17.7 20z" />
      </svg>,
    ],
    [
      "Telegram",
      V2.telegramUrl,
      <svg key="tg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M9.4 15.6 9 20.4c.5 0 .8-.2 1.1-.5l2.6-2.5 5.4 4c1 .5 1.7.3 2-.9L23.6 3.6c.3-1.4-.5-2-1.5-1.6L1.7 9.8c-1.4.5-1.4 1.3-.2 1.7l5.2 1.6L18.7 5.5c.6-.4 1.1-.2.7.2L9.4 15.6z" />
      </svg>,
    ],
    ["Chart", V2.chartUrl, <span key="c">Chart</span>],
  ];
  const shown = links.filter(([, href]) => !!href);
  if (shown.length === 0) return null;
  return (
    <span className={`flex items-center gap-1 ${className}`}>
      {shown.map(([label, href, icon]) => (
        <a key={label} href={href} target="_blank" rel="noreferrer" aria-label={label} title={label} className="inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-[12px] text-ink-2 hover:bg-hover hover:text-ink">
          {icon}
        </a>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ nav */

export function V2Nav() {
  const links: [string, string][] = [
    ["#burn", "Burn"],
    ["#hold", "Hold"],
    ["#protocol", "Protocol"],
    ["#stocks", "Stocks"],
    ["#verify", "Verify"],
    ["#faq", "FAQ"],
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface-0/85 backdrop-blur">
      <div className="container-x flex h-14 items-center gap-3">
        <Link href="/v2" className="flex items-center gap-1.5">
          <Wordmark size={24} />
          <i className="h-1.5 w-1.5 rounded-full bg-lime" />
        </Link>
        <nav className="ml-5 hidden items-center gap-5 text-[13px] text-ink-2 lg:flex">
          {links.map(([href, label]) => (
            <a key={href} href={href} className="hover:text-ink">
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden sm:inline-flex">
            <CaChip />
          </span>
          <Socials className="hidden md:flex" />
          <LaunchAppLink className="btn-ghost hidden md:inline-flex">Launch app →</LaunchAppLink>
          <BuyDca />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ hero */

export function V2Hero() {
  const chips = [
    `${V2.split.buybackBps / 100}% of every fee → burned, same tx`,
    `Fee cap ${pct(V2.maxFeeBps)}, in code`,
    "1,000,000,000 fixed · no mint",
    `Pons curve · ${V2.launch.graduationEth} ETH graduation · LP locked`,
    "No proxies · no withdraw function",
    "Owner can't touch user funds",
  ];
  return (
    <section id="top" className="relative overflow-hidden">
      <div className="v2-grid pointer-events-none absolute inset-0" />
      <div className="container-x relative grid gap-10 py-16 md:py-20 lg:grid-cols-[7fr_5fr] lg:items-center">
        <div className="min-w-0">
          <p className="v2-num text-[12px] tracking-[0.1em] text-ink-3 uppercase">$DCA · Robinhood Chain · launching on Pons</p>
          <h1 className="mt-4 text-[44px] leading-[1.02] font-semibold tracking-tight text-ink sm:text-[56px] md:text-[64px]">
            Every fee <span className="text-lime">burns $DCA.</span>
            <br />
            <span className="text-ink-2">Wall Street, bought on a clock.</span>
          </h1>
          <p className="mt-5 text-[20px] leading-snug font-semibold tracking-tight text-ink md:text-[22px]">
            {V2.split.buybackBps / 100}% of every fee, swapped into $DCA and burned. Same transaction. Public counter.
          </p>
          <p className="lede mt-3 max-w-xl">
            DCA buys Robinhood Stock Tokens on a schedule and sends them to your wallet. Every buy pays a fee. Use it and $DCA burns. Hold{" "}
            <Threshold /> and you pay half.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
            <BuyDca className="btn-primary btn-lg" />
            <Link href="/app/create" className="text-[14.5px] font-medium text-ink hover:underline">
              Start a plan →
            </Link>
            <WatchBurnLink className="text-[14.5px] font-medium text-ink-2 hover:text-ink hover:underline" />
          </div>
          <p className="mt-4 max-w-xl text-[13px] leading-relaxed text-ink-3">
            {RISK} {GEO}
          </p>
          <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2">
            {chips.map((c) => (
              <li key={c} className="v2-num flex items-center gap-1.5 text-[12px] text-ink-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-lime" />
                {c}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[12px] text-ink-3">Built on Robinhood Chain. Not built by Robinhood. {AFFILIATION}</p>
        </div>
        <div className="min-w-0">
          <FeeReceiverCard />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ manifesto */

export function V2Manifesto() {
  const lines: [string, string, string][] = [
    ["01", "Boomer assets. Degen rails.", "NVDA, SPY, TSLA, GLD, bought from a wallet on an L2. Wall Street closes at 4. The daily vault buys at 00:00 UTC, Sundays included."],
    ["02", "A DCA plan with a burn address.", `At each distribution ${V2.split.buybackBps / 100}% of the fees go to a reserve. The reserve leaves one way: swapped into $DCA and burned, same transaction. Nothing is parked.`],
    ["03", "Fees you can read.", `0.75% daily. 0.50% weekly. 0.25% monthly. Hard-capped at ${pct(V2.maxFeeBps)} in code. No key can set one past it.`],
    ["04", "Skipped, not charged.", "Can't fill inside the price caps? The page waits or is skipped and nobody pays. Missed epochs are never double-charged."],
  ];
  return (
    <section>
      <StockTape label="Boomer assets ·" />
      <div className="container-x grid gap-x-12 gap-y-7 py-14 md:grid-cols-2">
        {lines.map(([n, h, f]) => (
          <div key={n} className="flex items-start gap-4">
            <span className="v2-num mt-1 text-[12px] font-semibold text-lime">{n}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-[20px] leading-tight font-semibold tracking-tight text-ink">{h}</h3>
                <CopyLine headline={h} fact={f} />
              </div>
              <p className="mt-1.5 text-[15px] leading-relaxed text-ink-2">{f}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ constants */

export function V2Constants() {
  return (
    <section className="container-x pb-6">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <p className="eyebrow">In the bytecode</p>
        <p className="text-[12px] text-ink-3">Constants, not promises. The strip switches to live usage once there is usage worth showing.</p>
      </div>
      <ConstantsStrip />
    </section>
  );
}

/* ------------------------------------------------------------------ burn */

export function V2Burn() {
  const pipe: [string, string, boolean][] = [
    ["Every fee → FeeReceiver", "no withdraw, rescue or sweep function", false],
    ["Each distribution → 70% treasury · 30% reserve", "TREASURY_BPS = 7_000 · BUYBACK_BPS = 3_000", false],
    ["Reserve → $DCA → burned, same tx", "burn() or 0x…dEaD", true],
    ["Price guard", `floor = quote − max slippage (≤ ${V2.split.maxSlippageCapBps / 100}%) · ${V2.split.guardMinutes}-minute TWAP`, false],
    ["Counter", "totalBurned(), public", false],
  ];
  return (
    <section id="burn" className="border-y border-line bg-surface-2">
      <div className="container-x py-20">
        <p className="eyebrow">The burn · live</p>
        <h2 className="h-section mt-3 max-w-xl">Burned, not parked.</h2>
        <p className="lede mt-4 max-w-3xl">
          Not a policy. A contract. Every protocol fee is sent to the FeeReceiver. At each distribution it splits: 70% to the treasury that runs the
          protocol, 30% to a reserve. The reserve leaves one way: swapped into $DCA through the protocol&apos;s router and burned in the same
          transaction. <span className="v2-num text-ink">TREASURY_BPS</span> and <span className="v2-num text-ink">BUYBACK_BPS</span> are compiled
          constants. There is no withdraw function. There is no rescue function. <span className="v2-num text-ink">totalBurned()</span> is public. Every
          burn is a transaction on Robinhood Chain, not a tweet.
        </p>
        <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-ink-3">
          Every swap is floored at the router&apos;s quote minus max slippage (default {V2.split.defaultSlippageBps / 100}%, capped at {V2.split.maxSlippageCapBps / 100}% in
          code) and checked against a {V2.split.guardMinutes}-minute TWAP on the pools that have one. Pushed price? The swap reverts and nothing leaves.
        </p>

        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <div className="grid content-start gap-5">
            <div className="panel">
              {pipe.map(([k, v, hot]) => (
                <div key={k} className={`grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-line px-4 py-3 last:border-b-0 ${hot ? "bg-lime/5" : ""}`}>
                  <div className={`text-[13.5px] ${hot ? "font-semibold text-ink" : "text-ink-2"}`}>{k}</div>
                  <div className={`v2-num text-right text-[12px] ${hot ? "text-lime" : "text-ink-3"}`}>{v}</div>
                </div>
              ))}
            </div>
            <TraceABuy />
          </div>
          <div className="grid content-start gap-5">
            <LatestBurns />
            <AddressRow />
            <div className="panel">
              <div className="border-b border-line bg-surface-0 px-4 py-2.5 text-[12px] font-semibold text-ink">Two fee engines. One pipe.</div>
              <div className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-3 px-4 py-4 text-[13.5px]">
                <span className="v2-num text-[12px] font-semibold text-lime">A</span>
                <p className="text-ink-2">
                  <b className="font-semibold text-ink">Stock plans.</b> 0.25% to 0.75% per buy → FeeReceiver.
                </p>
                <span className="v2-num text-[12px] font-semibold text-lime">B</span>
                <p className="text-ink-2">
                  <b className="font-semibold text-ink">$DCA trades on Pons.</b> {V2.launch.tradeFeePct}% per trade: {V2.launch.creatorSharePct}% to the creator address,{" "}
                  {V2.launch.ponsSharePct}% to Pons. The creator address is the FeeReceiver, so trade fees take the same 70/30 split and the same burn:{" "}
                  <b className="v2-num font-semibold text-ink">{TRADE_BURN_PCT}% of every $DCA trade, burned.</b> Creator tax: {V2.launch.creatorTaxPct}%, fixed at launch.
                </p>
              </div>
              <div className="border-t border-line bg-surface-0 px-4 py-2 text-[11.5px] text-ink-3">One contract. One split. One counter.</div>
            </div>
          </div>
        </div>

        <div className="v2-num mt-6 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-ink-2">
          {["1,000,000,000 on the Pons curve", "no presale", "no team allocation", "no VC", "no unlocks", `graduates at ${V2.launch.graduationEth} ETH`, "LP locked at graduation"].map((t) => (
            <span key={t} className="flex items-center gap-1.5">
              <span className="h-1 w-1 rounded-full bg-lime" />
              {t}
            </span>
          ))}
        </div>

        <div className="mt-8 grid gap-5 md:grid-cols-[1fr_auto] md:items-center">
          <div className="rounded-xl border border-line bg-surface-1 p-5">
            <div className="text-[12px] font-semibold tracking-[0.08em] text-ink-3 uppercase">What $DCA is not</div>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
              $DCA carries no right to revenue or any distribution. Burns are programmed in the FeeReceiver, not promised by anyone; the counter on this
              page describes historical on-chain activity only. Supply only moves one way. Where price goes, nobody can tell you. Including us. It may
              lose its value in part or in full.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Src file="contracts/src/treasury/FeeReceiver.sol" />
            <a href="#faq" className="text-[13.5px] text-ink-2 hover:text-ink hover:underline">
              Why 30%? ↓
            </a>
            <BuyDca className="btn-primary" />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ hold */

export function V2Hold() {
  return (
    <section id="hold" className="container-x py-20">
      <div className="grid gap-10 md:grid-cols-[1fr_1.3fr] md:items-start">
        <div>
          <p className="eyebrow">
            Hold <Threshold compact={false} /> $DCA
          </p>
          <h2 className="h-section mt-3">The cheapest way to use the protocol is to hold it.</h2>
          <p className="lede mt-4">
            Hold <Threshold compact={false} /> $DCA in the wallet that runs the plan. That is <ThresholdShare /> of supply. No staking. No lock-up. No claim
            step. The vault reads the balance at each buy; above the line, the perks are on, on every plan, in every vault.
          </p>
          <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">
            <Threshold compact={false} /> is the current threshold, read live from the vault. It is owner-settable; a change is an on-chain event and never
            touches fees already charged.{" "}
            <a href="#faq" className="hover:text-ink hover:underline">
              Details in the FAQ.
            </a>
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface-2 p-5 md:p-6">
          <span className="v2-num inline-flex h-7 items-center rounded-md border border-lime/60 bg-lime/10 px-2.5 text-[12px] font-medium text-lime">
            ≥ <Threshold compact={false} /> $DCA · <ThresholdShare /> of supply · current threshold
          </span>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface-3 p-4">
              <div className="text-[17px] font-semibold text-ink">Half the fee.</div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">Every purchase fee, on every plan, in every vault, halved. The right-hand column of the vault table below.</p>
            </div>
            <div className="rounded-lg border border-line bg-surface-3 p-4">
              <div className="text-[17px] font-semibold text-ink">Straight to your wallet.</div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">Every buy is delivered automatically. No claim transaction. No 0.25% claim fee.</p>
            </div>
          </div>
          <div className="mt-4 rounded-r-lg border-l-[3px] border-lime bg-surface-3 px-4 py-3 text-[17px] leading-snug font-semibold tracking-tight text-ink">
            Set the recipient to a cold wallet and never touch the app again.
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
            <BuyDca className="btn-primary" />
            <Link href="/app/create" className="text-[13.5px] font-medium text-ink hover:underline">
              See a plan at half fee →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ protocol */

export function V2Protocol() {
  const steps: [string, string, string][] = [
    ["01", "Pick a Stock Token and an amount.", "Any token in Robinhood's registry, from $10 a buy."],
    ["02", "Pick a rhythm.", "Daily at 00:00 UTC. Weekly on Monday 00:00 UTC. Monthly every 30 days."],
    ["03", "Deposit once.", "USDG, or ETH converted to USDG on deposit. Minimum $10. No deposit fee."],
  ];
  const safes = [
    "one swap per epoch, for everyone",
    "Uniswap V3 · V4 · Ramses, approved pools only",
    `impact cap ${V2.impactCapBps / 100}%`,
    "Chainlink reference floor where a feed is set",
    "skipped, not charged",
    "never double-charged",
  ];
  return (
    <section id="protocol" className="border-y border-line bg-surface-2">
      <div className="container-x py-20">
        <p className="eyebrow">The protocol</p>
        <h2 className="h-section mt-3 max-w-xl">Three steps. Then a contract runs it.</h2>
        <div className="mt-10 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-3">
          {steps.map(([n, t, d]) => (
            <div key={n} className="bg-surface-1 p-6">
              <div className="v2-num text-[12px] font-semibold text-lime">{n}</div>
              <h3 className="mt-3 text-lg font-semibold text-ink">{t}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{d}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 max-w-3xl text-[15px] leading-relaxed text-ink-2">
          From then on the vault buys for you. Each epoch, everyone&apos;s buy for a stock is one swap, routed across Uniswap V3, V4 and Ramses through
          owner-approved pools only. Best price wins. Price impact is capped at {V2.impactCapBps / 100}%. Can&apos;t fill? The page waits or is skipped and
          nobody is charged. Stock Tokens land in the wallet you name. Withdraw idle USDG whenever you like: pausing can stop new buys, it can never stop
          a withdrawal or a claim.
        </p>
        <div className="mt-6">
          <PlanSummaryLine />
        </div>
        <div className="mt-4">
          <VaultTable />
        </div>
        <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-ink-2">
          {safes.map((s) => (
            <li key={s} className="flex items-center gap-1.5">
              <span className="text-lime">✓</span>
              {s}
            </li>
          ))}
        </ul>
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Link href="/app/create" className="btn-secondary">
            Start a plan
          </Link>
          <Link href={DOCS_PATH} className="text-[13.5px] text-ink-2 hover:text-ink hover:underline">
            How a buy executes →
          </Link>
        </div>

        <div className="mt-14 grid gap-6 border-t border-line pt-10 md:grid-cols-[1fr_auto] md:items-center">
          <div className="max-w-2xl">
            <h3 className="flex flex-wrap items-center gap-2.5 text-[18px] font-semibold text-ink">
              Earn while you wait. <span className="chip">Boost · optional · per plan</span>
            </h3>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
              Idle USDG between buys is lent on Morpho Blue at the market&apos;s supply rate and pulled back automatically at every buy or withdrawal. No fee
              on the yield. Variable. Carries Morpho market risk.
            </p>
          </div>
          <div className="rounded-xl border border-line bg-surface-1 px-5 py-4">
            <div className="text-[11.5px] font-medium tracking-[0.08em] text-ink-3 uppercase">Morpho USDG supply rate</div>
            <div className="v2-num mt-1 text-[26px] leading-none font-semibold text-good">
              <BoostApy />
            </div>
            <div className="mt-1.5 text-[11.5px] text-ink-3">variable · live</div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ stocks */

export function V2Stocks() {
  return (
    <section id="stocks" className="container-x py-20">
      <p className="eyebrow">The engine</p>
      <h2 className="h-section mt-3 max-w-xl">Every Stock Token Robinhood lists. On a schedule.</h2>
      <p className="lede mt-4 max-w-3xl">
        ERC-20s issued by Robinhood that track a listed stock or ETF, read live from the registry and added as they list. Price exposure to the
        ticker: not shares, not votes, not dividends. Not appropriate for everyone. We say that plainly. DCA buys them from public liquidity pools; it
        does not issue them.
      </p>
      <StocksLive />
      <p className="mt-6 text-[12px] text-ink-3">Stock Tokens are issued by Robinhood. {AFFILIATION}</p>
    </section>
  );
}

/* ------------------------------------------------------------------ trust */

export function V2Trust() {
  const fixed: [string, ReactNode][] = [
    ["1,000,000,000 supply. Fixed. No mint function.", <span key="a" className="v2-num text-[11px] text-ink-3">token contract</span>],
    ["LP locked at graduation, by Pons.", <span key="b" className="v2-num text-[11px] text-ink-3">Pons</span>],
    ["No proxies. No upgrades. What you read is what runs.", <Src key="c" file="contracts/src" />],
    ["FeeReceiver: no withdraw, rescue or sweep function. 70/30 is a compiled constant.", <Src key="d" file="contracts/src/treasury/FeeReceiver.sol" line="TREASURY_BPS = 7_000 · BUYBACK_BPS = 3_000" />],
    [`Every fee hard-capped at ${pct(V2.maxFeeBps)}.`, <Src key="e" file="contracts/src/libraries/FeeMath.sol" line="MAX_FEE_BPS = 90" />],
    ["Owner can't touch user funds. Nothing moves a balance except its owner.", <Src key="f" file="contracts/src/vault/PlanVault.sol" />],
    ["Pause can stop new buys. It can never stop a withdrawal or a claim.", <Src key="g" file="contracts/src/vault/PlanVault.sol" />],
  ];
  const levers: [string, ReactNode][] = [
    [
      `FeeReceiver: treasury address, router, operators, max slippage (≤ ${V2.split.maxSlippageCapBps / 100}% in code), TWAP guard window.`,
      <Src key="h" file="contracts/src/treasury/FeeReceiver.sol" />,
    ],
    [
      `Vaults: fee recipient, router and approved pools, price feeds, Boost strategy, perk thresholds, minimums. Fees, by the fee manager, only within the ${pct(V2.maxFeeBps)} cap.`,
      <Src key="i" file="contracts/src/vault/PlanVault.sol" />,
    ],
    ["Owner roles use two-step ownership transfer and are meant for a multisig. No timelock yet. Every change is an on-chain event; this page reads the live values.", <Src key="j" file="SECURITY.md" />],
  ];
  const security: [string, ReactNode][] = [
    [
      "Security reviews v0.1, v0.2 and v0.3 of the vaults and a review of the FeeReceiver: internal, published in the repository, with regression tests for the remediated findings. No external audit yet.",
      <Src key="k" file="audit" />,
    ],
    ["Open source. Contracts verified on the explorer.", <Src key="l" file="contracts" />],
    ["Boost is optional and carries Morpho Blue market risk.", <span key="m" className="v2-num text-[11px] text-ink-3">SECURITY.md §11</span>],
  ];
  const List = ({ title, rows, glyph }: { title: string; rows: [string, ReactNode][]; glyph: ReactNode }) => (
    <div className="panel">
      <div className="border-b border-line bg-surface-0 px-4 py-2.5 text-[11.5px] font-medium tracking-[0.08em] text-ink-2 uppercase">{title}</div>
      {rows.map(([t, s]) => (
        <div key={t} className="grid grid-cols-[auto_1fr_auto] items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
          <span className="mt-0.5 w-4 text-center">{glyph}</span>
          <span className="text-[14.5px] leading-relaxed text-ink">{t}</span>
          <span className="hidden sm:inline-flex">{s}</span>
        </div>
      ))}
    </div>
  );
  return (
    <section id="verify" className="border-y border-line bg-surface-2">
      <div className="container-x py-20">
        <p className="eyebrow">Verify it yourself</p>
        <h2 className="h-section mt-3 max-w-2xl">No external audit yet. Read the code before you read the hype.</h2>
        <p className="lede mt-4 max-w-3xl">Everything below is in the code or on the explorer. Click through; don&apos;t take our word for any of it.</p>
        <div className="mt-10 grid gap-5">
          <List title="What no key can change" rows={fixed} glyph={<span className="text-lime">✓</span>} />
          <List
            title="What the owner keys can change"
            rows={levers}
            glyph={
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="text-ink-3" aria-hidden>
                <circle cx="5.5" cy="8" r="3" />
                <path d="M8.5 8h5.5M12 8v2.5M14 8v2" />
              </svg>
            }
          />
          <List title="Security" rows={security} glyph={<span className="text-ink-3">·</span>} />
        </div>
        <p className="mt-6 text-[15px] text-ink">Early software. Only use funds you can afford to lose.</p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ faq */

export function V2Faq() {
  const qa: [string, ReactNode][] = [
    [
      "Is the burn a promise or code?",
      <>
        Code. Every protocol fee is sent to the FeeReceiver, a contract with no withdraw, rescue or sweep function. Each distribution splits it 70% to the
        treasury and 30% to a reserve; <span className="v2-num text-ink">TREASURY_BPS = 7_000</span> and <span className="v2-num text-ink">BUYBACK_BPS = 3_000</span>{" "}
        are compiled constants. The reserve leaves one way: swapped into $DCA through the protocol&apos;s router and burned in the same transaction.{" "}
        <span className="v2-num text-ink">totalBurned()</span> counts every burn. What nobody can promise is timing: distributions and buybacks are
        operator-triggered, so watch the counter, not a calendar.
      </>,
    ],
    [
      "Supply, liquidity, tax?",
      <>
        1,000,000,000 $DCA, fixed, no mint function. It launches on Pons on a constant-product bonding curve with the whole supply on the curve, and graduates
        at {V2.launch.graduationEth} ETH into a Uniswap v4 pool the launchpad locks permanently. No presale, no team allocation, no VC, no unlocks. Every
        trade pays {V2.launch.tradeFeePct}%: {V2.launch.creatorSharePct}% to the creator address, which is the FeeReceiver, and {V2.launch.ponsSharePct}% to
        Pons. Creator tax: {V2.launch.creatorTaxPct}%, fixed at launch.
      </>,
    ],
    [
      "Can the team change fees or take funds?",
      <>
        Fees, within a cap: every fee is hard-capped at {pct(V2.maxFeeBps)} in the contract (<span className="v2-num text-ink">MAX_FEE_BPS = 90</span>) and no
        role can set one past it. Funds, no: the vaults are immutable and non-custodial, no proxies, no upgrade path, and the owner cannot touch user funds.
        Pausing can stop new buys; it never blocks a withdrawal or a claim. The FeeReceiver has no withdraw function at all. What the owner keys can change
        is listed under Verify it yourself: the FeeReceiver&apos;s treasury address, router, operators, slippage and guard, and the vaults&apos; fee
        recipient, router, feeds, Boost strategy, thresholds and minimums. Every change is an on-chain event.
      </>,
    ],
    [
      "Why 30% and not more?",
      <>
        Because the other 70% is what keeps the protocol running: keepers and gas for every epoch, development, security work. There is no VC, no vesting
        and no unlock to fund, so the split is the whole budget. It is a constant, not a policy: nobody can change it, up or down, without deploying a new
        contract.
      </>,
    ],
    [
      "What am I actually getting when I buy $DCA?",
      <>
        A token with two on-chain jobs. It is what 30% of every protocol fee is swapped into and burned. And holding <Threshold compact={false} /> of it changes how
        the product treats you: fees halved on every plan, every buy delivered to your wallet with no claim step and no claim fee. It is not equity, not a
        share of revenue, not a claim on any stock, and it may lose its value in part or in full.
      </>,
    ],
    [
      "Can the holder threshold change?",
      <>
        Yes. Perks read the spot $DCA balance of the plan&apos;s wallet at each buy and each claim; no staking, no lock-up, nothing of yours is ever locked.
        The thresholds are set by the owner, with no upper bound in the contract; this page and the app print the live value, labelled current threshold,
        and every change is an on-chain event. A change never touches fees already charged.
      </>,
    ],
    [
      "What do I get when the vault buys NVDA?",
      <>
        Robinhood&apos;s NVDA Stock Token: an ERC-20 on Robinhood Chain that tracks the price of NVDA. Economic exposure, not shares, not votes, not
        dividends. It sits in your wallet; hold it, sell it or move it like any token. Issued by Robinhood; we are not affiliated with Robinhood.
      </>,
    ],
    [
      "Is it audited?",
      <>
        Not externally, not yet. Security reviews v0.1, v0.2 and v0.3 of the vaults and a review of the FeeReceiver, internal and published in the
        repository, with regression tests for the remediated findings. The contracts are immutable and non-custodial: what you read on the explorer is what
        runs. Treat it as early software.
      </>,
    ],
    [
      "What if a buy can't execute?",
      <>
        Each epoch pools everyone&apos;s buy for a stock into one swap with price impact capped at {V2.impactCapBps / 100}% and, where a Chainlink feed is set, a
        floor at the reference price. If it can&apos;t fill, the page waits or is skipped and nobody is charged. Missed epochs are never double-charged.
      </>,
    ],
    [
      "What is Boost and what can go wrong?",
      <>
        Optional, per plan. Idle USDG waiting for the next buy is lent on Morpho Blue at the market&apos;s supply rate and pulled back automatically at every
        buy or withdrawal. No fee on the yield. The rate is variable, and lending carries Morpho market risk: that market can run short of liquidity or
        take on bad debt.
      </>,
    ],
    [
      "Who can use it, and what's the minimum?",
      <>
        The interface is not available in the US, UK, Canada, Australia or sanctioned regions; the contracts are permissionless. $10 per buy and $10 per
        deposit. Pay in USDG, or ETH converted to USDG on deposit.
      </>,
    ],
  ];
  return (
    <section id="faq" className="container-x py-20">
      <p className="eyebrow">FAQ</p>
      <h2 className="h-section mt-3">Straight answers.</h2>
      <div className="mt-8 divide-y divide-line border-y border-line">
        {qa.map(([q, a], i) => (
          <details key={q} className="group py-4" open={i < 3}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[16px] font-medium text-ink [&::-webkit-details-marker]:hidden">
              {q}
              <span className="text-ink-3 transition-transform group-open:rotate-45">+</span>
            </summary>
            <p className="mt-2 max-w-3xl text-[14.5px] leading-relaxed text-ink-2">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ cta + footer */

export function V2Cta() {
  return (
    <section className="border-t border-line bg-surface-2">
      <div className="container-x flex flex-col items-center py-20 text-center">
        <h2 className="h-section">Buy the token the protocol burns.</h2>
        <p className="lede mt-2">Or run a plan and burn some yourself.</p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
          <BuyDca className="btn-primary btn-lg" />
          <Link href="/app/create" className="text-[14.5px] font-medium text-ink hover:underline">
            Start a plan →
          </Link>
          <MiniCounter />
        </div>
        <div className="mt-4">
          <CaChip />
        </div>
        <p className="mt-5 max-w-2xl text-[13px] leading-relaxed text-ink-3">
          {RISK} {GEO} Contracts are permissionless.
        </p>
      </div>
    </section>
  );
}

export function V2Footer() {
  const links: [string, string | undefined, boolean][] = [
    ["Code", V2.repoUrl, true],
    ["Security reviews", repoFile("audit"), true],
    ["Explorer", V2.explorer, true],
    ["Pons", V2.ponsUrl, true],
    ["Chart", V2.chartUrl, true],
    ["X", V2.xUrl, true],
    ["Telegram", V2.telegramUrl, true],
    ["Docs", DOCS_PATH, false],
    ["Current landing", "/", false],
    ["Legacy landing", "/legacy", false],
  ];
  return (
    <footer className="border-t border-line bg-surface-0">
      <div className="container-x py-12">
        <div className="grid gap-10 md:grid-cols-[1fr_auto]">
          <div className="max-w-2xl">
            <Wordmark />
            <p className="mt-4 text-[13px] font-medium text-ink">Built on Robinhood Chain. Not built by Robinhood.</p>
            <div className="mt-3 grid gap-2 text-[12.5px] leading-relaxed text-ink-2">
              <p>{AFFILIATION}</p>
              <p>
                Stock Tokens are ERC-20 tokens issued by Robinhood that provide economic exposure to the price of a listed stock or ETF. They are not shares and
                carry no voting or dividend rights. Not appropriate for all investors.
              </p>
              <p>
                $DCA is a fixed-supply protocol token. It carries no right to revenue or any distribution; burns are programmed, not promised, and describe
                historical on-chain activity only. It may lose its value in part or in full.
              </p>
              <p>
                The interface is not available in the United States, United Kingdom, Canada, Australia or sanctioned jurisdictions; the contracts are
                permissionless. Boost lends idle USDG on Morpho Blue and carries Morpho market risk. No external audit has been performed. Nothing on this
                page is an offer or advice.
              </p>
            </div>
          </div>
          <div className="grid content-start gap-x-10 gap-y-2 text-[13px] text-ink-2 sm:grid-cols-2">
            {links
              .filter(([, href]) => !!href)
              .map(([label, href, ext]) =>
                ext ? (
                  <a key={label} href={href} target="_blank" rel="noreferrer" className="hover:text-ink">
                    {label} ↗
                  </a>
                ) : (
                  <Link key={label} href={href!} className="hover:text-ink">
                    {label}
                  </Link>
                ),
              )}
            {!V2.repoUrl && <span className="text-ink-3">Source published at launch</span>}
          </div>
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-6">
          <AddressRow compact />
          <span className="chip ml-auto">Robinhood Chain · chain id {CHAIN_ID}</span>
        </div>
        <div className="mt-6 flex items-center justify-between text-[12px] text-ink-3">
          <span>DCA and chill.</span>
          <span>© DCA</span>
        </div>
      </div>
    </footer>
  );
}
