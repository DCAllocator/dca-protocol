"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";

const KEY = "dca.disclaimer.v1";

/** First-visit gate for /app. Restricted regions are redirected by middleware; this covers everyone else. */
export function DisclaimerGate({ children }: { children: React.ReactNode }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setOk(localStorage.getItem(KEY) === "1");
    } catch {
      setOk(false);
    }
  }, []);
  if (ok === null) return null;
  if (ok) return <>{children}</>;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0/90 p-4">
      <div className="panel w-full max-w-md">
        <div className="panel-head">
          <span className="flex items-center gap-2 normal-case tracking-normal text-ink">
            <Logo size={16} /> Before you continue
          </span>
        </div>
        <div className="panel-body space-y-3 text-[13px] leading-relaxed text-ink-2">
          <p>
            <b className="text-ink">Robinhood Stock Tokens are not offered to US persons.</b> This interface is unavailable in the United
            States, United Kingdom, Canada, Australia and sanctioned regions.
          </p>
          <p>
            Stock Tokens give <b className="text-ink">economic exposure, not shareholder rights</b>. You do not own NYSE or Nasdaq shares.
          </p>
          <p>
            DCA is non-custodial, unaudited software. Purchases execute on a schedule against on-chain liquidity; prices, slippage and fees
            apply. Nothing here is investment advice. $DCA perks read your spot balance at execution time.
          </p>
          <button
            className="btn-primary w-full"
            onClick={() => {
              try {
                localStorage.setItem(KEY, "1");
              } catch {}
              setOk(true);
            }}
          >
            I am not a restricted person and I understand
          </button>
        </div>
      </div>
    </div>
  );
}
