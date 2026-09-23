"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDirectory, useBuyDcaRoute } from "@/hooks/useProtocol";
import { BUY_DCA_TAB_FORCED } from "@/lib/config";

/**
 * "Start a plan" | "Buy $DCA" strip above the create card and the buy card. Plain text tabs, the active one on a
 * faint fill; the options are `next/link`s: client-side navigation keeps the wallet session, and the active tab
 * follows the URL rather than local state. "Start a plan" points back at whichever create variant the visitor
 * came from (/app/create/2 stays on /app/create/2).
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

  // Deliberately quiet (no track, no border, no inverted pill): the strip is wayfinding, not a control competing
  // with the card's one lime button.
  const cls = (active: boolean) =>
    `inline-flex h-[28px] items-center rounded-md px-2.5 text-[13px] font-medium transition-colors ${active ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2"}`;

  return (
    <nav aria-label="Create or buy" className="mb-3 flex justify-center">
      <div className="inline-flex gap-1">
        <Link href={startHref} className={cls(!onBuy)} aria-current={!onBuy ? "page" : undefined}>
          Start a plan
        </Link>
        {buyEnabled ? (
          <Link href="/app/buy" className={cls(onBuy)} aria-current={onBuy ? "page" : undefined}>
            Buy $DCA
          </Link>
        ) : buyPending ? (
          <span className={`${cls(false)} opacity-50`} aria-hidden>
            Buy $DCA
          </span>
        ) : null}
      </div>
    </nav>
  );
}
