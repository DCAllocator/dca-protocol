"use client";

import { usePerkThresholds } from "@/hooks/useProtocol";
import { fmtUnits, fmtUnitsCompact } from "@/lib/format";

/**
 * The $DCA balance that unlocks a perk, e.g. "100,000 $DCA" (`compact`: "100k $DCA"). Live from the vaults, deploy
 * default until the chain responds — so server-rendered copy never goes stale when the owner moves a threshold.
 */
export function PerkThreshold({ perk, compact }: { perk: "autoDistribute" | "feeHalve"; compact?: boolean }) {
  const t = usePerkThresholds();
  return <>{compact ? fmtUnitsCompact(t[perk], 18) : fmtUnits(t[perk], 18, 0)} $DCA</>;
}
