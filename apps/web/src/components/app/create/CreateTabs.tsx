"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDirectory, useBuyDcaRoute } from "@/hooks/useProtocol";
import { BUY_DCA_TAB_FORCED } from "@/lib/config";

/**
 * "Start a plan" | "Buy $DCA" strip above the create card and the buy card. Styled like `Segmented`, but the
 * options are `next/link`s: client-side navigation keeps the wallet session (the local test wallet drops on a
 * full reload), and the active tab follows the URL rather than local state. "Start a plan" points back at
 * whichever create variant the visitor came from (/app/create/2 stays on /app/create/2).
 *
 * The "Buy $DCA" tab shows when BUY_DCA_TAB_FORCED (local anvil, or NEXT_PUBLIC_ENABLE_BUY_TAB) or when the
 * router quotes USDG → $DCA (`useBuyDcaRoute`). While that first probe is in flight the slot is reserved
 * with a muted placeholder so the strip does not jump; it disappears only on a settled failure. On /app/buy
 * itself the tab is always there — the page is what explains that nothing can be bought yet.
 */
export function CreateTabs() {
  const path = usePathname() ?? "";
  const { dir } = useDirectory();
  const route = useBuyDcaRoute(dir);

  const onBuy = path === "/app/buy";
  const startHref = path.startsWith("/app/create/2") ? "/app/create/2" : "/app/create";
  const buyEnabled = onBuy || BUY_DCA_TAB_FORCED || route.available;
  const buyPending = !buyEnabled && route.isLoading;

  const cls = (active: boolean) =>
    `inline-flex h-[30px] items-center rounded-[7px] px-3 text-[13px] font-medium transition-colors ${active ? "bg-ink text-surface-0" : "text-ink-2 hover:text-ink"}`;

  return (
    <nav aria-label="Create or buy" className="mb-3 flex justify-center">
      <div className="inline-flex gap-0.5 rounded-lg border border-line bg-surface-3 p-[3px]">
        <Link href={startHref} className={cls(!onBuy)} aria-current={!onBuy ? "page" : undefined}>
          Start a plan
        </Link>
        {buyEnabled ? (
          <Link href="/app/buy" className={cls(onBuy)} aria-current={onBuy ? "page" : undefined}>
            Buy $DCA
          </Link>
        ) : buyPending ? (
          <span className={`${cls(false)} text-ink-3`} aria-hidden>
            Buy $DCA
          </span>
        ) : null}
      </div>
    </nav>
  );
}
