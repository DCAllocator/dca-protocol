import Link from "next/link";
import { SiteNav, HowItWorks, Vaults, Benefits, Perks, Faq, FinalCta, SiteFooter } from "@/components/site/Sections";
import { LiveStats, FeeTable, ProductMock } from "@/components/site/Live";

export default function Landing() {
  return (
    <main className="bg-surface-0">
      <SiteNav />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="grid-fade pointer-events-none absolute inset-0" />
        <div className="container-x relative grid gap-12 py-20 md:py-28 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div>
            <p className="eyebrow">Automated stock buying on Robinhood Chain</p>
            <h1 className="mt-4 text-5xl font-semibold leading-[1.02] tracking-tight text-ink md:text-6xl">
              Don't time the market.
              <br />
              <span className="text-lime">Autoinvest</span>.
            </h1>
            <p className="lede mt-6 max-w-lg">
              Pick a stock. Choose your frequency. <br/>DCA buys it for you on-chain directly into your wallet.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/app/create" className="btn-primary btn-lg">
                Create a plan
              </Link>
              <a href="#how" className="btn-secondary btn-lg">
                See how it works
              </a>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-ink-3">
              {["Non-custodial", "Settled in USDG", "Pay with USDG or ETH", "Minimal slippage", "Sandwich resistant"].map((t) => (
                <li key={t} className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-lime" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <ProductMock />
        </div>
      </section>

      <div className="container-x">
        <LiveStats />
      </div>

      <HowItWorks />
      <Vaults />
      <Benefits />
      <Perks />

      {/* Fees */}
      <section id="fees" className="container-x py-20">
        <div className="grid gap-10 md:grid-cols-[1fr_1.4fr] md:items-start">
          <div>
            <p className="eyebrow">Fees</p>
            <h2 className="h-section mt-3">Simple. Shown before you sign.</h2>
            <p className="lede mt-3">
              One fee per buy, taken before the swap. Nothing on deposit. Everything is capped at 0.90% in the smart contract — the team
              cannot raise it above that.
            </p>
          </div>
          <div className="panel">
            <FeeTable />
            <div className="border-t border-line px-3 py-2 text-[11px] text-ink-3">Live from the vault contracts. Read the code, not the marketing.</div>
          </div>
        </div>
      </section>

      <Faq />
      <FinalCta />
      <SiteFooter />
    </main>
  );
}
