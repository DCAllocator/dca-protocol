"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { useDirectory, usePositions, useStocks, kindOf, vaultList, isDcaToken } from "@/hooks/useProtocol";
import { useEpochLogs } from "@/hooks/useLogs";
import { PageHeader, Card, Notice, Empty, Segmented } from "@/components/ui";
import { ConnectButton } from "@/components/ConnectButton";
import { ChoiceAvatar, choiceLabel } from "@/components/app/create/fields";
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
  // Our own token (told apart by address) reads "$DCA" under our mark, as on My plans; a Stock Token by its ticker.
  // No `symbol` for a token the registry does not list (yet).
  const labelOf = (address: Address | undefined): { symbol?: string; dca: boolean } => {
    const s = address ? byAddress[address.toLowerCase()] : undefined;
    const dca = isDcaToken(dir, address);
    if (!address || (!s && !dca)) return { dca: false };
    return choiceLabel({ address, symbol: s?.symbol ?? "" }, dca ? address : undefined);
  };

  if (!configured) return <Notice kind="warn">App is not configured.</Notice>;

  const mine = new Set(positions.map((p) => `${p.vault.toLowerCase()}:${p.planId}`));
  const inFilter = (vault: `0x${string}`) => filter === "all" || kindOf(vaults, vault) === filter;
  const isMine = (vault: `0x${string}`, planId: bigint) => mine.has(`${vault.toLowerCase()}:${planId}`);
  const newestFirst = (a: { block: bigint; idx: number }, b: { block: bigint; idx: number }) =>
    a.block === b.block ? b.idx - a.idx : a.block < b.block ? 1 : -1;
  // "Why didn't my buy happen?" gets an answer inline with the fills. A page that cannot be bought at all leaves
  // no trace on-chain (it reverts and the keeper retries it), so the only per-plan miss is `PlanTooLarge`: the
  // plan's spend alone is above the stock's page notional cap, so it sat the epoch out uncharged.
  const myBuys = [
    ...(logs.data?.fills ?? [])
      .filter((f) => isMine(f.vault, f.planId) && inFilter(f.vault))
      .map((f) => ({ kind: "fill" as const, key: `${f.txHash}-${f.logIndex}`, block: f.blockNumber, idx: f.logIndex, f })),
    ...(logs.data?.tooLarge ?? [])
      .filter((t) => isMine(t.vault, t.planId) && inFilter(t.vault))
      .map((t) => ({ kind: "tooLarge" as const, key: `${t.txHash}-${t.logIndex}`, block: t.blockNumber, idx: t.logIndex, t })),
  ].sort(newestFirst);
  const epochs = (logs.data?.epochs ?? []).filter((e) => inFilter(e.vault));
  // Pages whose boosted spend the boost strategy could not pay out (lending market fully utilised): the boosted
  // plans on that page sat it out uncharged while everyone else was filled. Every row of `all` sorts newest first.
  const boostSkips = (logs.data?.boostSkips ?? []).filter((e) => inFilter(e.vault));
  const all = [
    ...epochs.filter((e) => e.plansFilled > 0).map((e) => ({ kind: "fill" as const, key: `${e.txHash}-${e.logIndex}`, block: e.blockNumber, idx: e.logIndex, e })),
    ...boostSkips.map((e) => ({ kind: "boostSkip" as const, key: `${e.txHash}-${e.logIndex}`, block: e.blockNumber, idx: e.logIndex, e })),
  ].sort(newestFirst);
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
          <div className="flex flex-wrap justify-end gap-1">
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
          ) : myBuys.length === 0 ? (
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
                {myBuys.slice(0, 100).map((row) => {
                  const l = row.kind === "fill" ? row.f : row.t;
                  const pos = positions.find((p) => p.vault.toLowerCase() === l.vault.toLowerCase() && p.planId === l.planId);
                  const stock = pos ? byAddress[pos.stock.toLowerCase()] : undefined;
                  const label = labelOf(pos?.stock);
                  const kind = kindOf(vaults, l.vault);
                  const lead = (
                    <>
                      <td className="text-[12px] text-ink-2">{l.timestamp ? tsToShort(l.timestamp) : `block ${l.blockNumber}`}</td>
                      <td>
                        <span className="flex items-center gap-2 font-semibold text-ink">
                          <ChoiceAvatar symbol={label.symbol ?? "?"} dca={label.dca} size={24} />
                          {label.symbol ?? "?"}
                        </span>
                      </td>
                      <td className="text-ink-2">{kind ? VAULT_META[kind].label : short(l.vault)}</td>
                    </>
                  );
                  if (row.kind === "tooLarge") {
                    const t = row.t;
                    return (
                      <tr key={row.key}>
                        {lead}
                        <td colSpan={3} className="text-[12px] text-warn">
                          Sat out — {fmtUsd(t.spend)} per buy is above this stock&apos;s {fmtUsd(t.cap)} page cap. You were not charged; lower
                          the amount per buy to resume.
                        </td>
                        <td className="text-right">{txLink(t.txHash)}</td>
                      </tr>
                    );
                  }
                  const f = row.f;
                  return (
                    <tr key={row.key}>
                      {lead}
                      <td className="num text-right">{fmtUsd(f.spendUsdg)}</td>
                      <td className="num text-right">
                        {fmtUnits(f.stockShare, stock?.decimals ?? 18, 6)} <span className="text-[11px] text-ink-3">{label.symbol}</span>
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
                const label = labelOf(e.stock);
                const kind = kindOf(vaults, e.vault);
                if (row.kind === "boostSkip") {
                  return (
                    <tr key={row.key}>
                      <td className="text-[12px] text-ink-2">{e.timestamp ? tsToShort(e.timestamp) : `block ${e.blockNumber}`}</td>
                      <td>
                        <span className="flex items-center gap-2 font-semibold text-ink">
                          <ChoiceAvatar symbol={label.symbol ?? "?"} dca={label.dca} size={24} />
                          {label.symbol ?? short(e.stock)}
                        </span>
                      </td>
                      <td className="text-ink-2">{kind ? VAULT_META[kind].label : short(e.vault)}</td>
                      <td colSpan={3} className="text-[12px] text-warn">
                        Boosted plans sat this buy out — {row.e.reason}. They were not charged ({fmtUsd(row.e.usdgRequested)} stayed lent out);
                        unboosted plans were filled as usual.
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
                        <ChoiceAvatar symbol={label.symbol ?? "?"} dca={label.dca} size={24} />
                        {label.symbol ?? short(e.stock)}
                      </span>
                    </td>
                    <td className="text-ink-2">{kind ? VAULT_META[kind].label : short(e.vault)}</td>
                    <td className="num text-right">{fmtUsd(f.netUsdg)}</td>
                    <td className="num text-right">
                      {fmtUnits(f.stockOut, stock?.decimals ?? 18, 6)} <span className="text-[11px] text-ink-3">{label.symbol}</span>
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
