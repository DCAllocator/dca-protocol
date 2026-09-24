"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useDirectory, useBuyDcaRoute } from "@/hooks/useProtocol";
import { BUY_DCA_EXTERNAL } from "@/components/BuyDcaLink";
import { BUY_DCA_TAB_FORCED } from "@/lib/config";

/**
 * Whether /app/buy has something to offer, the one rule every in-app "Buy $DCA" (this strip, the sidebar, the token
 * page, the perks banner) goes by: BUY_DCA_TAB_FORCED (local anvil, or NEXT_PUBLIC_ENABLE_BUY_TAB), a route into $DCA
 * from USDG or, failing that, from ETH, whichever pool $DCA is paired with (`useBuyDcaRoute`), or an off-site listing to hand off to (`BUY_DCA_EXTERNAL`). Otherwise /app/buy only
 * says there is no route, so the entry points show a disabled "Buy $DCA · soon" instead of linking there. `pending` is
 * true while the directory or the first route probe is still loading, so a caller can hold a muted slot rather than flash
 * "soon".
 */
export function useBuyDcaAvailable() {
  const { dir, configured } = useDirectory();
  const always = BUY_DCA_TAB_FORCED || BUY_DCA_EXTERNAL;
  // No route probe when the answer is fixed: the sidebar renders on every app page, and a quote re-polls.
  const route = useBuyDcaRoute(always ? undefined : dir);
  const available = always || route.available;
  return { available, pending: !available && ((configured && !dir) || route.isLoading) };
}

/**
 * "Buy $DCA" as a button (sidebar, token page, perks banner): a client-side link to /app/buy while `useBuyDcaAvailable`,
 * else a disabled button, "Buy $DCA · soon" once the probe has settled. `icon` goes before the label.
 */
export function BuyDcaButton({ className = "btn-primary", icon, onClick }: { className?: string; icon?: ReactNode; onClick?: () => void }) {
  const { available, pending } = useBuyDcaAvailable();
  if (available)
    return (
      <Link href="/app/buy" onClick={onClick} className={className}>
        {icon}
        Buy $DCA
      </Link>
    );
  return (
    <button type="button" disabled aria-disabled="true" aria-busy={pending || undefined} className={className}>
      {icon}
      {pending ? "Buy $DCA" : "Buy $DCA · soon"}
    </button>
  );
}

/**
 * "Start a plan" | "Buy $DCA" strip above the create card and the buy card. Plain text tabs, the active one on a
 * faint fill; the options are `next/link`s: client-side navigation keeps the wallet session, and the active tab
 * follows the URL rather than local state. "Start a plan" points back at whichever create variant the visitor
 * came from (/app/create/2 stays on /app/create/2).
 *
 * The "Buy $DCA" tab links while `useBuyDcaAvailable`. While the directory or the first route probe is in flight the
 * slot is reserved with a muted placeholder so the strip does not jump; on a settled "no" it stays as a disabled
 * "Buy $DCA · soon". On /app/buy itself the tab is always live — the page is what explains that nothing can be bought yet.
 */
export function CreateTabs() {
  const path = usePathname() ?? "";
  const { available, pending } = useBuyDcaAvailable();

  const onBuy = path === "/app/buy";
  const startHref = path.startsWith("/app/create/2") ? "/app/create/2" : "/app/create";
  const buyEnabled = onBuy || available;

  // Deliberately quiet (no track, no border, no inverted pill): the strip is wayfinding, not a control competing
  // with the card's one lime button.
  const base = "inline-flex h-[28px] items-center rounded-md px-2.5 text-[13px] font-medium";
  const cls = (active: boolean) => `${base} transition-colors ${active ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2"}`;

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
        ) : pending ? (
          <span className={`${base} text-ink-3 opacity-50`} aria-hidden>
            Buy $DCA
          </span>
        ) : (
          <span className={`${base} cursor-not-allowed text-ink-3 opacity-50`} aria-disabled="true">
            Buy $DCA · soon
          </span>
        )}
      </div>
    </nav>
  );
}
