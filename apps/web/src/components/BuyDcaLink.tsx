import Link from "next/link";
import type { ReactNode } from "react";
import { BUY_DCA_URL } from "@/lib/config";

/** True when BUY_DCA_URL points off-site (the Pons listing); false for an in-app path such as /app/token. */
export const BUY_DCA_EXTERNAL = /^https?:\/\//.test(BUY_DCA_URL);

/**
 * "Buy $DCA" as the landing page and the /app/buy hand-off render it: an off-site URL opens in a new tab, an
 * in-app path is a client-side link. No hooks, so it renders from server components (the landing page) too.
 */
export function BuyDcaLink({ className = "btn-primary", children = "Buy $DCA" }: { className?: string; children?: ReactNode }) {
  return BUY_DCA_EXTERNAL ? (
    <a href={BUY_DCA_URL} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <Link href={BUY_DCA_URL} className={className}>
      {children}
    </Link>
  );
}
