import Link from "next/link";
import { PageHeader, Card } from "@/components/ui";
import { PerkThreshold } from "@/components/site/Live";

/** Placeholder docs. Anchors (#plans, #dca, #fees, #risks) are linked from the app. */
export default function Docs() {
  return (
    <>
      <PageHeader title="Docs" description="How DCA works, in plain language. Full documentation is coming." />

      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="hidden lg:block">
          <div className="sticky top-4 space-y-0.5 text-[13px]">
            {[
              ["#what", "What is DCA?"],
              ["#plans", "Plans"],
              ["#boost", "Boost"],
              ["#dca", "$DCA holders"],
              ["#fees", "Fees"],
              ["#risks", "Risks"],
            ].map(([href, label]) => (
              <a key={href} href={href} className="side-item h-9 text-[13px]">
                {label}
              </a>
            ))}
          </div>
        </nav>

        <div className="space-y-6">
          <Section id="what" title="What is DCA?">
            <p>
              DCA buys Robinhood Stock Tokens for you on a schedule, on-chain. You pick a stock, choose daily, weekly or monthly buys, and fund the
              plan with USDG or ETH. Every buy happens automatically at the same time for everyone, at the best price across Uniswap V3, Uniswap V4 and
              Ramses.
            </p>
            <p>Your money stays in a smart contract you control. Top up, withdraw, pause or remove a plan whenever you want.</p>
          </Section>

          <Section id="plans" title="Plans">
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <b>Daily</b> plans buy every day at 00:00 UTC. <b>Weekly</b> plans buy every Monday at 00:00 UTC. <b>Monthly</b> plans buy every 30 days.
              </li>
              <li>Each buy spends the amount you set, as long as the plan has funds. If a plan runs dry it simply waits.</li>
              <li>
                ETH is converted to USDG the moment you deposit it (0.5% price tolerance; any sliver the pool cannot fill is returned to you), so the plan
                always holds USDG and withdrawals are paid in USDG.
              </li>
              <li>Each buy is at least $10, and a plan needs at least $10 to start or to top up.</li>
              <li>Stock you buy is held for you on the vault until you claim it — or is sent straight to your wallet if you hold $DCA.</li>
              <li>If a scheduled buy is ever missed it is skipped, never doubled up. You are charged at most once per period.</li>
            </ul>
          </Section>

          <Section id="boost" title="Boost — earn while you wait">
            <p>
              A plan usually holds USDG for days or weeks before it is spent. <b>Boost</b> lends that idle USDG on{" "}
              <a href="https://morpho.org" target="_blank" rel="noreferrer" className="text-lime hover:underline">
                Morpho Blue
              </a>{" "}
              in the meantime, so it earns the market&apos;s supply rate until each buy. The rate shown in the app is quoted live from the Morpho market
              and moves with borrowing demand.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Switch it on when you create a plan (&ldquo;Earn while you wait&rdquo;), or press <b>Boost</b> on any existing plan. Off by default.</li>
              <li>Every buy pulls exactly what it needs back from Morpho in the same transaction; the rest keeps earning. Withdrawals do the same.</li>
              <li>Your earnings are tracked per plan and shown next to the balance. There is no extra fee on boosted funds.</li>
              <li>
                <b>Unboost</b> pulls everything back into the plan at any time (earnings included), also while the protocol is paused.
              </li>
              <li>
                Lending has its own risks: if the market is fully borrowed there may be no liquidity to withdraw until borrowers repay (that buy or
                withdrawal simply waits — other plans are unaffected), and bad debt on the market is shared by all its lenders. Boosted USDG is
                not covered by any insurance.
              </li>
            </ul>
          </Section>

          <Section id="dca" title="$DCA holders">
            <p>$DCA is the protocol token. Holding it in your wallet changes how your plans behave. No staking, no lock-ups.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-line bg-surface-2 p-4">
                <div className="chip-lime">
                  <PerkThreshold perk="autoDistribute" />
                </div>
                <div className="mt-2 text-[15px] font-semibold text-ink">Stock sent to your wallet</div>
                <p className="mt-1 text-[13px] text-ink-2">Every buy is delivered automatically and claiming is free.</p>
              </div>
              <div className="rounded-xl border border-line bg-surface-2 p-4">
                <div className="chip-lime">
                  <PerkThreshold perk="feeHalve" />
                </div>
                <div className="mt-2 text-[15px] font-semibold text-ink">Half the purchase fee</div>
                <p className="mt-1 text-[13px] text-ink-2">The per-buy fee is halved on every plan.</p>
              </div>
            </div>
            <p>Perks are checked against your balance at the moment a buy executes and when you claim — not when you create the plan.</p>
            <p>
              <Link href="/app/token" className="text-lime hover:underline">
                See live token stats →
              </Link>
            </p>
          </Section>

          <Section id="fees" title="Fees">
            <p>One purchase fee per buy, taken before the swap. Nothing on deposit. Every fee is capped at 0.90% in the contract.</p>
            <table className="tbl -mx-5 w-[calc(100%+2.5rem)]">
              <thead>
                <tr>
                  <th>Fee</th>
                  <th className="text-right">Daily</th>
                  <th className="text-right">Weekly</th>
                  <th className="text-right">Monthly</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="text-ink-2">Purchase, per buy</td>
                  <td className="num text-right">0.75%</td>
                  <td className="num text-right">0.50%</td>
                  <td className="num text-right">0.25%</td>
                </tr>
                <tr>
                  <td className="text-ink-2">Deposit</td>
                  <td className="num text-right">0%</td>
                  <td className="num text-right">0%</td>
                  <td className="num text-right">0%</td>
                </tr>
                <tr>
                  <td className="text-ink-2">Withdraw funds</td>
                  <td className="num text-right">0.25%</td>
                  <td className="num text-right">0.25%</td>
                  <td className="num text-right">0.25%</td>
                </tr>
                <tr>
                  <td className="text-ink-2">
                    Claim stock (free with <PerkThreshold perk="autoDistribute" compact />)
                  </td>
                  <td className="num text-right">0.25%</td>
                  <td className="num text-right">0.25%</td>
                  <td className="num text-right">0.25%</td>
                </tr>
              </tbody>
            </table>
            <p className="text-[12px] text-ink-3">
              Defaults shown; live values are on the{" "}
              <Link href="/app/token" className="text-lime hover:underline">
                DCA Token
              </Link>{" "}
              page. Buys route through on-chain liquidity with a 0.50% slippage tolerance and a 1.5% price-impact cap.
            </p>
          </Section>

          <Section id="risks" title="Risks">
            <ul className="list-disc space-y-1 pl-5">
              <li>Stock Tokens are economic exposure to a stock, not shares or shareholder rights. They can trade away from the underlying price.</li>
              <li>Buys execute against on-chain liquidity. If a buy cannot be filled within the price limits it is skipped for that period and nobody is charged.</li>
              <li>Only the protocol's operators can trigger buys. No operator, no buys. Missed buys are skipped, never caught up.</li>
              <li>Early software: one round of review and remediation so far (see the repository's AUDIT.md). Only use funds you can afford to lose.</li>
              <li>Not offered to US persons or in the United Kingdom, Canada, Australia or sanctioned regions.</li>
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <h2 id={id} className="scroll-mt-6 text-[20px] font-semibold text-ink">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[14px] leading-relaxed text-ink-2">{children}</div>
    </Card>
  );
}
