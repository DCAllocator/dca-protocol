"use client";

import { Tip, Toggle } from "@/components/ui";
import { fmtPct } from "@/lib/format";
import { BOOST } from "@/lib/config";

/**
 * "Earn while you wait" — the boost switch shown next to Start plan. Off by default. `apy` is the live Morpho
 * Blue supply APY of the vault's strategy (undefined while loading); `available` is false when the vault has
 * no strategy wired up, which disables the switch and says so.
 */
export function BoostCard({
  checked,
  onChange,
  apy,
  available,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  apy?: number;
  available: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line-strong bg-surface-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
          {BOOST.title}
          <Tip text={BOOST.tip} />
        </div>
        <p className="mt-0.5 text-[12.5px] leading-normal text-ink-2">
          {available ? (
            <>
              Earn <span className="font-semibold text-good">{fmtPct(apy, true)} APY</span> on idle USDG. The rate updates with the market.
            </>
          ) : (
            "Not available on this frequency yet."
          )}
        </p>
      </div>
      <Toggle checked={checked && available} onChange={onChange} disabled={disabled || !available} ariaLabel={BOOST.title} />
    </div>
  );
}
