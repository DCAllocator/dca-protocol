"use client";

import Link from "next/link";
import { useDirectory, useBuyDcaRoute } from "@/hooks/useProtocol";
import type { Address } from "viem";
import { Notice, Icon } from "@/components/ui";
import { AddToWalletButton } from "@/components/app/AddToWalletButton";
import { BUY_DCA_EXTERNAL } from "@/components/BuyDcaLink";
import { CreateTabs } from "@/components/app/create/CreateTabs";
import { BuyDcaCard } from "@/components/app/create/BuyDcaCard";
import { NotConfigured } from "@/components/app/create/blocks";
import { BUY_DCA_URL, isZero } from "@/lib/config";

/**
 * /app/buy — the "Buy $DCA" tab. Hybrid: when the router can route USDG or ETH into $DCA on this chain
 * (`useBuyDcaRoute`), the in-app swap card is shown, paid in either and smart-routed whichever token $DCA is paired
 * with — USDG, WETH or both (see `BuyDcaCard`) — opening on the pay token the probe answered for. When it cannot and
 * BUY_DCA_URL points off-site (the Pons listing) a hand-off card takes over: that is also the case for a native-ETH
 * Uniswap v4 launch pool, which the router cannot route at all. Otherwise a "no route yet" notice that points to Start
 * a plan. The tab strip above is shared with /app/create and /app/create/2 and navigates client-side, so the wallet
 * stays connected. Every in-site "Buy $DCA" (landing, sidebar, token page) lands here; the in-app ones only link while
 * `useBuyDcaAvailable` says there is something to buy, the hand-off is only ever off-site, and the notice never points
 * back at a "Buy $DCA".
 */
export default function BuyDcaPage() {
  const { dir, configured, isLoading } = useDirectory();
  const route = useBuyDcaRoute(dir);
  if (!configured) return <NotConfigured />;

  let body: React.ReactNode;
  if (isLoading || route.isLoading) {
    body = (
      <div className="rounded-2xl border border-line bg-surface-2 p-4 sm:p-5" aria-busy>
        <div className="h-24 animate-pulse rounded-xl bg-surface-3" />
        <div className="mt-3 h-24 animate-pulse rounded-xl bg-surface-3" />
        <p className="mt-3 text-center text-[12.5px] text-ink-3">Checking routes…</p>
      </div>
    );
  } else if (route.available && dir) {
    body = <BuyDcaCard dir={dir} initialPay={route.payWith} />;
  } else if (BUY_DCA_EXTERNAL) {
    body = <PonsHandoff dca={dir && !isZero(dir.dca) ? dir.dca : undefined} />;
  } else {
    body = (
      <>
        <Notice kind="info">No route to $DCA on this chain yet.</Notice>
        <p className="mt-3 text-center text-[12.5px] text-ink-3">
          Until a pool is approved on the router there is nothing to buy in-app.{" "}
          <Link href="/app/create" className="text-lime hover:underline">
            Start a plan instead →
          </Link>
        </p>
      </>
    );
  }

  return (
    <div className="mx-auto max-w-[480px] pt-1 sm:pt-6">
      <CreateTabs />
      {body}
    </div>
  );
}

/** Shown when the router has no in-app route but the token is listed off-site: send people there (and offer "Add to MetaMask"). */
function PonsHandoff({ dca }: { dca?: Address }) {
  const host = (() => {
    try {
      return new URL(BUY_DCA_URL).host;
    } catch {
      return BUY_DCA_URL;
    }
  })();
  return (
    <div className="rounded-2xl border border-line bg-surface-2 p-5 text-center sm:p-6">
      <h2 className="text-[18px] font-semibold tracking-tight text-ink">$DCA trades on Pons</h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
        The protocol&apos;s router has no route from USDG or ETH to $DCA on this chain yet, so buying in-app is off. The token is listed on Pons; the link
        opens in a new tab.
      </p>
      <div className="mt-5 grid gap-2">
        <a href={BUY_DCA_URL} target="_blank" rel="noreferrer" className="btn-primary btn-lg w-full rounded-xl">
          Buy on Pons
          <Icon name="external" size={13} className="ml-1.5" />
        </a>
        <Link href="/app/create" className="btn-ghost w-full">
          Start a plan instead
        </Link>
        {dca && <AddToWalletButton address={dca} symbol="DCA" decimals={18} className="justify-self-center" />}
      </div>
      <p className="mt-3 text-[11.5px] text-ink-3">{host}</p>
    </div>
  );
}
