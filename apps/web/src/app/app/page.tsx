"use client";

import Link from "next/link";
import { useDirectory, useVaults, useStocks, useTvl, useBoostApys, boostAvailable, vaultList } from "@/hooks/useProtocol";
import { useEpochLogs, cumulativeSeries, sumLastDays } from "@/hooks/useLogs";
import { PageHeader, StatCard, Card, Countdown, Dot, Notice, Sparkline, Composition, HeaderStat } from "@/components/ui";
import { fmtUsd, fmtUsdCompact, fmtPct, tsToShort, valueOf } from "@/lib/format";
import { VAULT_META, BOOST, cadenceOf } from "@/lib/config";

export default function Overview() {
  const { dir, vaults, configured, isLoading } = useDirectory();
  const { infos } = useVaults(vaults);
  const { stocks } = useStocks(dir?.registry);
  const tvl = useTvl(dir, vaults, infos, stocks);
  const { apyOf } = useBoostApys(infos);
  const logs = useEpochLogs(vaults ? vaultList(vaults) : undefined);

  if (!configured) return <Notice kind="warn">App is not configured: set NEXT_PUBLIC_DIRECTORY (see .env.local.example).</Notice>;
  if (isLoading) return <p className="text-[13px] text-ink-3">Loading protocol…</p>;
  if (!dir) return <Notice kind="error">Could not read the VaultDirectory. Wrong chain or RPC?</Notice>;

  const bought = infos.reduce((a, v) => a + (v.totalNotionalUsdg ?? 0n), 0n);
  const inWindow = (logs.data?.epochs ?? []).reduce((a, e) => a + e.netUsdg, 0n);
  const series = cumulativeSeries(logs.data?.epochs, bought > inWindow ? bought - inWindow : 0n);
  const last30 = sumLastDays(logs.data?.epochs, 30);

  return (
    <>
      <PageHeader
        title="Overview"
        description="What the protocol holds and what it has bought, across every plan."
        rightMobile={false}
        right={
          <>
            <HeaderStat label="Total value locked" value={tvl.ready ? fmtUsdCompact(tvl.total) : "—"} />
            <HeaderStat label="Stock bought" value={fmtUsdCompact(bought)} />
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        <StatCard
          label="Total value locked"
          value={tvl.ready ? fmtUsd(tvl.total) : "—"}
          hint={`USDG waiting to buy — on the vaults and ${BOOST.chip.toLowerCase()} on Morpho Blue — plus stock held for you on the vaults.`}
        >
          <Composition
            parts={[
              { label: `USDG ${fmtUsd(tvl.usdg)}`, value: n(tvl.usdg), tone: "bg-lime" },
              { label: `${BOOST.chip} ${fmtUsd(tvl.boosted)}`, value: n(tvl.boosted), tone: "bg-good" },
              { label: `Stocks ${fmtUsd(tvl.stockUsd)}`, value: n(tvl.stockUsd), tone: "bg-ink-3" },
            ]}
          />
        </StatCard>

        <StatCard
          label="Stock value bought"
          value={fmtUsd(bought)}
          delta={last30 > 0n ? `+${fmtUsdCompact(last30)} last 30d` : undefined}
          hint="USDG swapped into stock since launch, net of fees."
        >
          <div className="h-24">
            {series.length >= 2 ? (
              <Sparkline points={series} height={96} />
            ) : (
              <div className="flex h-full items-end text-[12px] text-ink-3">No purchases in the scanned window yet.</div>
            )}
          </div>
        </StatCard>
      </div>

      <Card title="Vaults" className="mt-8" flush actions={<Link href="/app/create" className="btn-primary">Create new plan</Link>}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Vault</th>
              <th>Next buy</th>
              <th className="text-right">Waiting to buy</th>
              <th className="hidden text-right md:table-cell">{BOOST.name} APY</th>
              <th className="hidden text-right md:table-cell">Stock on hand</th>
              <th className="hidden text-right md:table-cell">Bought to date</th>
              <th className="text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {infos.map((v) => {
              const waiting = v.totalUsdgIdle === undefined ? undefined : v.totalUsdgIdle + (v.boostAssets ?? 0n);
              const apy = apyOf(v.boostStrategy);
              const held = stocks.reduce<bigint | undefined>((acc, s) => {
                if (acc === undefined) return undefined;
                const amt = tvl.perVault[v.kind][s.address.toLowerCase()] ?? 0n;
                if (amt === 0n) return acc;
                const val = valueOf(amt, tvl.prices[s.address.toLowerCase()], s.decimals);
                return val === undefined ? undefined : acc + val;
              }, 0n);
              return (
                <tr key={v.kind}>
                  <td>
                    <div className="flex items-center gap-2 font-semibold text-ink">
                      {VAULT_META[v.kind].label}
                      {v.kind === "test" && <span className="chip-dev">dev</span>}
                    </div>
                    <div className="text-[12px] text-ink-3">{cadenceOf(v.kind, v.epochLength)}</div>
                  </td>
                  <td>
                    <Countdown target={v.nextEpochStart} className="text-ink" />
                    <div className="text-[12px] text-ink-3">{v.nextEpochStart ? tsToShort(v.nextEpochStart) : ""}</div>
                  </td>
                  <td className="num text-right">
                    {fmtUsd(waiting)}
                    {(v.boostAssets ?? 0n) > 0n && <div className="text-[12px] text-good">{fmtUsd(v.boostAssets)} {BOOST.chip.toLowerCase()}</div>}
                  </td>
                  <td className="num hidden text-right md:table-cell">{boostAvailable(v) ? <span className="text-good">{fmtPct(apy, true)}</span> : <span className="text-ink-3">—</span>}</td>
                  <td className="num hidden text-right md:table-cell">{fmtUsd(held)}</td>
                  <td className="num hidden text-right md:table-cell">{fmtUsd(v.totalNotionalUsdg)}</td>
                  <td className="text-right">
                    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
                      <Dot tone={v.paused ? "warn" : "good"} />
                      {v.paused ? "Paused" : "Live"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}

const n = (v: bigint | undefined) => (v === undefined ? 0 : Number(v) / 1e6);
