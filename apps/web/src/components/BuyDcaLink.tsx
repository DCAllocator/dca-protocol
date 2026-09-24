import Link from "next/link";
import type { ReactNode } from "react";
import { BUY_DCA_URL } from "@/lib/config";

/** True when BUY_DCA_URL points off-site (the Pons listing): the only case in which /app/buy hands off to it. */
export const BUY_DCA_EXTERNAL = /^https?:\/\//.test(BUY_DCA_URL);

/**
 * "Buy $DCA" as the landing pages render it: always a client-side link to /app/buy, which swaps in-app when the router
 * can, hands off to BUY_DCA_URL (Pons) when it cannot, and otherwise says there is no route yet and points to Start a
 * plan. No hooks, so it renders from server components (the landing page) too; inside the app `BuyDcaButton`
 * (components/app/create/CreateTabs.tsx) is used instead, which is disabled while there is nothing to buy.
 */
export function BuyDcaLink({ className = "btn-primary", children = "Buy $DCA" }: { className?: string; children?: ReactNode }) {
  return (
    <Link href="/app/buy" className={className}>
      {children}
    </Link>
  );
}
