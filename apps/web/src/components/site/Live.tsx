"use client";

import { useDirectory, useVaults, useStocks, usePerkThresholds, isDcaToken } from "@/hooks/useProtocol";
import { Countdown, StockAvatar } from "@/components/ui";
import { fmtUsd, fmtBps, fmtUnits, fmtUnitsCompact } from "@/lib/format";
import { PRODUCTION_VAULT_KINDS, VAULT_META, type ProductionVaultKind } from "@/lib/config";

/** Stats strip under the hero. Degrades to placeholders when the app is not configured. */
export function LiveStats() {
  const { dir, vaults, configured } = useDirectory();
  const { infos } = useVaults(vaults);
  const { stocks } = useStocks(dir?.registry);
  // Vaults hold USDG only (ETH is converted on deposit), so "waiting to buy" is the idle USDG plus what boosted
  // plans have lent out on Morpho (`boostAssets`), which is not in `totalUsdgIdle`.
  const usdgIdle = infos.reduce((a, v) => a + (v.totalUsdgIdle ?? 0n) + (v.boostAssets ?? 0n), 0n);
  const notional = infos.reduce((a, v) => a + (v.totalNotionalUsdg ?? 0n), 0n);
  const epochs = infos.reduce((a, v) => a + (v.epochsCompleted ?? 0n), 0n);
  const ready = configured && infos.length > 0;
  const items: [string, string][] = [
    ["Capital waiting to buy", ready ? fmtUsd(usdgIdle) : "—"],
    ["Stock bought to date", ready ? fmtUsd(notional) : "—"],
    ["Epochs executed", ready ? epochs.toString() : "—"],
    ["Stocks listed", ready ? String(stocks.filter((s) => !isDcaToken(dir, s.address)).length) : "—"],
  ];
  return (
    <div className="grid grid-cols-2 divide-line border-y border-line md:grid-cols-4 md:divide-x">
      {items.map(([k, v]) => (
        <div key={k} className="px-6 py-5">
          <div className="text-[12px] text-ink-3">{k}</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-ink">{v}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * The $DCA balance that unlocks a perk, e.g. "100,000 $DCA" (`compact`: "100k $DCA"). Live from the vaults, deploy
 * default until the chain responds — so server-rendered copy never goes stale when the owner moves a threshold.
 */
export function PerkThreshold({ perk, compact }: { perk: "autoDistribute" | "feeHalve"; compact?: boolean }) {
  const t = usePerkThresholds();
  return <>{compact ? fmtUnitsCompact(t[perk], 18) : fmtUnits(t[perk], 18, 0)} $DCA</>;
}

/** Live fee table (falls back to config defaults before the chain responds). */
export function FeeTable() {
  const { vaults } = useDirectory();
  const { byKind } = useVaults(vaults);
  const { autoDistribute } = usePerkThresholds();
  const rows = [
    ["Purchase fee, per buy", (k: ProductionVaultKind) => byKind[k]?.fees?.purchaseFeeBps ?? VAULT_META[k].defaultFeeBps],
    ["Deposit", (k: ProductionVaultKind) => byKind[k]?.fees?.depositFeeBps ?? 0],
    ["Withdraw idle funds", (k: ProductionVaultKind) => byKind[k]?.fees?.withdrawFeeBps ?? 25],
    [`Claim (free with ${fmtUnitsCompact(autoDistribute, 18)} $DCA)`, (k: ProductionVaultKind) => byKind[k]?.fees?.claimFeeBps ?? 25],
  ] as const;
  // Five columns (four vaults + labels) overflow a phone: the label column wraps and the table scrolls inside
  // its own box rather than widening the page.
  return (
    <div className="overflow-x-auto">
      <table className="tbl w-full">
        <thead>
          <tr>
            <th>Fee</th>
            {PRODUCTION_VAULT_KINDS.map((k) => (
              <th key={k} className="text-right">
                {VAULT_META[k].label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, get]) => (
            <tr key={label}>
              <td className="min-w-[140px] whitespace-normal text-ink-2">{label}</td>
              {PRODUCTION_VAULT_KINDS.map((k) => (
                <td key={k} className="num text-right text-ink">
                  {fmtBps(get(k))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** CSS-only product preview for the hero: a slice of the real dashboard with live countdowns when available. */
export function ProductMock() {
  const { vaults } = useDirectory();
  const { byKind } = useVaults(vaults);
  const rows = [
    { sym: "NVDA", vault: "weekly" as const, per: "$100.00", idle: "$1,800.00", acc: "0.397324" },
    { sym: "AAPL", vault: "daily" as const, per: "$50.00", idle: "$1,450.00", acc: "0.261397" },
    { sym: "SPY", vault: "monthly" as const, per: "$250.00", idle: "$3,000.00", acc: "1.108210" },
  ];
  return (
    <div className="panel shadow-[0_24px_80px_-24px_rgba(198,255,0,0.25)]">
      <div className="flex h-9 items-center gap-3 border-b border-line bg-surface-0 px-3 text-[12px]">
        <span className="flex gap-1">
          <i className="h-2.5 w-2.5 rounded-full bg-surface-4" />
          <i className="h-2.5 w-2.5 rounded-full bg-surface-4" />
          <i className="h-2.5 w-2.5 rounded-full bg-surface-4" />
        </span>
        <span className="font-semibold text-ink">My plans</span>
        <span className="text-ink-3">·</span>
        <span className="text-ink-3">3 active</span>
        <span className="ml-auto chip-lime">preview</span>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Stock</th>
            <th>Vault</th>
            <th className="text-right">Per buy</th>
            <th className="text-right hidden sm:table-cell">Balance</th>
            <th className="text-right">Bought</th>
            <th>Next buy</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sym}>
              <td>
                <span className="flex items-center gap-2 font-semibold text-ink">

                  <StockAvatar symbol={r.sym} size={26} />
                  {r.sym}
                </span>
              </td>
              <td>{VAULT_META[r.vault].label}</td>
              <td className="num text-right">{r.per}</td>
              <td className="num text-right hidden sm:table-cell">{r.idle}</td>
              <td className="num text-right">{r.acc}</td>
              <td>
                <Countdown target={byKind[r.vault]?.nextEpochStart ?? Math.floor(Date.now() / 1000) + 86_400 * (r.vault === "daily" ? 1 : r.vault === "weekly" ? 4 : 19)} className="text-ink" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-4 border-t border-line bg-surface-0 px-3 py-1.5 text-[11px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <i className="h-1.5 w-1.5 rounded-full bg-good" /> Robinhood Chain
        </span>
        <span>best route: Uniswap V3 · 0.05%</span>
        <span className="ml-auto">non-custodial</span>
      </div>
    </div>
  );
}
