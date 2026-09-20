"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useDirectory, usePositions, useStocks, kindOf, vaultList } from "@/hooks/useProtocol";
import { useEpochLogs } from "@/hooks/useLogs";
import { PageHeader, Card, Notice, Empty, Segmented, StockAvatar } from "@/components/ui";
import { ConnectButton } from "@/components/ConnectButton";
import { fmtUsd, fmtUnits, tsToShort, short } from "@/lib/format";
import { VAULT_KINDS, VAULT_META, type VaultKind } from "@/lib/config";
import { activeChain } from "@/lib/chain";

type Tab = "mine" | "all";

export default function Activity() {
  const { address } = useAccount();
  const { dir, vaults, configured } = useDirectory();
  const { byAddress } = useStocks(dir?.registry);
  const { positions } = usePositions(vaults);
  const logs = useEpochLogs(vaults ? vaultList(vaults) : undefined);
  const [tab, setTab] = useState<Tab>("mine");
  const [filter, setFilter] = useState<VaultKind | "all">("all");
  const explorer = activeChain.blockExplorers?.default.url;

  if (!configured) return <Notice kind="warn">App is not configured.</Notice>;

  const mine = new Set(positions.map((p) => `${p.vault.toLowerCase()}:${p.planId}`));
  const inFilter = (vault: `0x${string}`) => filter === "all" || kindOf(vaults, vault) === filter;
  const fills = (logs.data?.fills ?? []).filter((f) => mine.has(`${f.vault.toLowerCase()}:${f.planId}`) && inFilter(f.vault));
  const epochs = (logs.data?.epochs ?? []).filter((e) => inFilter(e.vault));
  // Pages the vault could not buy for (no route within limits, swap failed): nobody was charged. Shown inline
  // with the fills so "why didn't my buy happen?" has an answer. Every row of `all` sorts newest first.
  const skips = (logs.data?.skips ?? []).filter((e) => inFilter(e.vault));
  const all = [
    ...epochs.filter((e) => e.plansFilled > 0).map((e) => ({ kind: "fill" as const, key: `${e.txHash}-${e.logIndex}`, block: e.blockNumber, idx: e.logIndex, e })),
    ...skips.map((e) => ({ kind: "skip" as const, key: `${e.txHash}-${e.logIndex}`, block: e.blockNumber, idx: e.logIndex, e })),
  ].sort((a, b) => (a.block === b.block ? b.idx - a.idx : a.block < b.block ? 1 : -1));
  const txLink = (hash: string) => (
    <a className="num text-[12px] text-ink-3 hover:text-ink hover:underline" href={explorer ? `${explorer}/tx/${hash}` : "#"} target="_blank" rel="noreferrer">
      {short(hash)}
    </a>
  );

  return (
    <>
      <PageHeader
        title="Activity"
        description="Every buy the protocol has made — yours, and everyone's."
        right={
          <Segmented<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { value: "mine", label: "My buys" },
              { value: "all", label: "All buys" },
            ]}
          />
        }
      />

      <Card
        flush
        title={tab === "mine" ? "My buys" : "All buys"}
        actions={
          <div className="flex gap-1">
            {(["all", ...VAULT_KINDS] as const).map((k) => (
              <button key={k} type="button" onClick={() => setFilter(k)} className={`chip h-7 px-2.5 ${filter === k ? "border-lime text-lime" : ""}`}>
                {k === "all" ? "All" : VAULT_META[k].label}
              </button>
            ))}
          </div>
        }
      >
        {logs.isLoading ? (
          <Empty>Scanning recent buys…</Empty>
        ) : logs.error ? (
          <Empty>Could not fetch activity: {String(logs.error)}</Empty>
        ) : tab === "mine" ? (
          !address ? (
            <Empty>
              <ConnectButton />
              <div className="mt-3">Connect a wallet to see your buys.</div>
            </Empty>
          ) : fills.length === 0 ? (
            <Empty>No buys yet. Your first one lands at the next scheduled buy.</Empty>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Stock</th>
                  <th>Frequency</th>
                  <th className="text-right">Spent</th>
                  <th className="text-right">Received</th>
                  <th>Delivery</th>
                  <th className="text-right">Tx</th>
                </tr>
              </thead>
              <tbody>
                {fills.slice(0, 100).map((f) => {
                  const pos = positions.find((p) => p.vault.toLowerCase() === f.vault.toLowerCase() && p.planId === f.planId);
                  const stock = pos ? byAddress[pos.stock.toLowerCase()] : undefined;
                  const kind = kindOf(vaults, f.vault);
                  return (
                    <tr key={`${f.txHash}-${f.logIndex}`}>
                      <td className="text-[12px] text-ink-2">{f.timestamp ? tsToShort(f.timestamp) : `block ${f.blockNumber}`}</td>
                      <td>
                        <span className="flex items-center gap-2 font-semibold text-ink">
                          <StockAvatar symbol={stock?.symbol ?? "?"} size={24} />
                          {stock?.symbol ?? "?"}
                        </span>
                      </td>
                      <td className="text-ink-2">{kind ? VAULT_META[kind].label : short(f.vault)}</td>
                      <td className="num text-right">{fmtUsd(f.spendUsdg)}</td>
                      <td className="num text-right">
                        {fmtUnits(f.stockShare, stock?.decimals ?? 18, 6)} <span className="text-[11px] text-ink-3">{stock?.symbol}</span>
                      </td>
                      <td>{f.autoDistributed ? <span className="chip-lime">Sent to wallet</span> : <span className="chip">Held for you</span>}</td>
                      <td className="text-right">{txLink(f.txHash)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : all.length === 0 ? (
          <Empty>No buys have run yet.</Empty>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th>
                <th>Stock</th>
                <th>Frequency</th>
                <th className="text-right">USDG in</th>
                <th className="text-right">Stock out</th>
                <th className="text-right">Plans</th>
                <th className="text-right">Tx</th>
              </tr>
            </thead>
            <tbody>
              {all.slice(0, 100).map((row) => {
                const e = row.e;
                const stock = byAddress[e.stock.toLowerCase()];
                const kind = kindOf(vaults, e.vault);
                if (row.kind === "skip") {
                  return (
                    <tr key={row.key}>
                      <td className="text-[12px] text-ink-2">{e.timestamp ? tsToShort(e.timestamp) : `block ${e.blockNumber}`}</td>
                      <td>
                        <span className="flex items-center gap-2 font-semibold text-ink">
                          <StockAvatar symbol={stock?.symbol ?? "?"} size={24} />
                          {stock?.symbol ?? short(e.stock)}
                        </span>
                      </td>
                      <td className="text-ink-2">{kind ? VAULT_META[kind].label : short(e.vault)}</td>
                      <td colSpan={3} className="text-[12px] text-warn">
                        Skipped — {row.e.reason}. Nobody was charged; the plans try again next {kind ? VAULT_META[kind].per : "period"}.
                      </td>
                      <td className="text-right">{txLink(e.txHash)}</td>
                    </tr>
                  );
                }
                const f = row.e;
                return (
                  <tr key={row.key}>
                    <td className="text-[12px] text-ink-2">{e.timestamp ? tsToShort(e.timestamp) : `block ${e.blockNumber}`}</td>
                    <td>
                      <span className="flex items-center gap-2 font-semibold text-ink">
                        <StockAvatar symbol={stock?.symbol ?? "?"} size={24} />
                        {stock?.symbol ?? short(e.stock)}
                      </span>
                    </td>
                    <td className="text-ink-2">{kind ? VAULT_META[kind].label : short(e.vault)}</td>
                    <td className="num text-right">{fmtUsd(f.netUsdg)}</td>
                    <td className="num text-right">
                      {fmtUnits(f.stockOut, stock?.decimals ?? 18, 6)} <span className="text-[11px] text-ink-3">{stock?.symbol}</span>
                    </td>
                    <td className="num text-right">{f.plansFilled}</td>
                    <td className="text-right">{txLink(e.txHash)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
