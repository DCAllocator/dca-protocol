"use client";

import Link from "next/link";
import { useDirectory, useVaults, useUser, useDcaToken, vaultList } from "@/hooks/useProtocol";
import { useEpochLogs, sumLastDays } from "@/hooks/useLogs";
import { PageHeader, StatCard, Card, Notice, Dot, KV } from "@/components/ui";
import { AddToWalletButton } from "@/components/app/AddToWalletButton";
import { BuyDcaButton } from "@/components/app/create/CreateTabs";
import { fmtUsd, fmtUsdCompact, fmtUnits, fmtBps, short } from "@/lib/format";
import { VAULT_META, DOCS_PATH, isZero } from "@/lib/config";
import { activeChain } from "@/lib/chain";

export default function TokenPage() {
  const { dir, vaults, configured, isLoading } = useDirectory();
  const { infos } = useVaults(vaults);
  const user = useUser(dir, vaults?.daily);
  const token = useDcaToken(dir);
  const logs = useEpochLogs(vaults ? vaultList(vaults) : undefined);

  if (!configured) return <Notice kind="warn">App is not configured.</Notice>;
  if (isLoading) return <p className="text-[13px] text-ink-3">Loading…</p>;
  if (!dir) return <Notice kind="error">Could not read the VaultDirectory.</Notice>;

  const volume = infos.reduce((a, v) => a + (v.totalNotionalUsdg ?? 0n), 0n);
  const volume30 = sumLastDays(logs.data?.epochs, 30);
  const purchaseFees = (logs.data?.fills ?? []).reduce((a, f) => a + f.feeUsdg, 0n);
  const withdrawFees = (logs.data?.withdrawals ?? []).reduce((a, w) => a + w.usdgFee, 0n);
  const fees = purchaseFees + withdrawFees;
  const auto = infos[0]?.autoDistributeThreshold;
  const halve = infos[0]?.feeHalveThreshold;
  const dcaBal = user.dca ?? 0n;
  const explorer = activeChain.blockExplorers?.default.url;
  const noToken = isZero(dir.dca);

  return (
    <>
      <PageHeader
        title="DCA Token"
        description="$DCA is the protocol token. Holding it changes how your plans behave — no staking, no lock-ups."
        right={
          noToken ? undefined : (
            <>
              {user.address && (
                <div className="text-right">
                  <div className="text-[12px] text-ink-3">Your balance</div>
                  <div className="text-[22px] font-semibold tracking-tight text-ink">
                    {fmtUnits(dcaBal, 18, 0)} <span className="text-[14px] text-ink-3">$DCA</span>
                  </div>
                  <AddToWalletButton address={dir.dca} symbol="DCA" decimals={18} />
                </div>
              )}
              <BuyDcaButton className="btn-primary" />
            </>
          )
        }
      />

      {noToken && <Notice kind="warn">$DCA is not configured on this deployment, so holder perks are inactive.</Notice>}

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Price" value={token.price !== undefined ? fmtUsd(token.price) : "—"} hint={token.price === undefined ? "No $DCA/USDG route on this chain yet." : "Router quote, 1 $DCA."} />
        <StatCard label="Market cap" value={token.marketCap !== undefined ? fmtUsdCompact(token.marketCap) : "—"} hint={token.totalSupply !== undefined ? `${fmtUnits(token.totalSupply, 18, 0)} $DCA supply` : "Total supply unavailable."} />
        <StatCard label="Protocol volume" value={fmtUsdCompact(volume)} delta={volume30 > 0n ? `+${fmtUsdCompact(volume30)} 30d` : undefined} hint="USDG turned into stock, all time." />
        <StatCard label="Fees accrued" value={fmtUsdCompact(fees)} hint="Purchase + withdrawal fees in USDG, from the scanned window. Claim fees are paid in stock." />
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Card title="Holder perks">
          <div className="space-y-3">
            <Perk
              ok={!!user.autoDistribute}
              connected={!!user.address}
              threshold={auto}
              title="Stock sent straight to your wallet"
              desc="Every buy is delivered to your wallet automatically, and claiming is free."
            />
            <Perk
              ok={halve !== undefined && dcaBal >= halve}
              connected={!!user.address}
              threshold={halve}
              title="Half the purchase fee"
              desc="The per-buy fee is halved on every plan, in every frequency."
            />
            <p className="pt-1 text-[12px] leading-relaxed text-ink-3">
              Perks read your wallet balance at the moment each buy executes and when you claim — not when you create a plan.{" "}
              <Link href={`${DOCS_PATH}#dca`} className="text-lime hover:underline">
                Read the docs →
              </Link>
            </p>
          </div>
        </Card>

        <Card title="Tokenomics">
          <div className="rounded-lg border border-dashed border-line-strong bg-surface-2 p-4 text-[13px] leading-relaxed text-ink-3">
            Allocation, emissions and the fee-to-holder model go here. <span className="text-ink-2">Placeholder — fill in once the token design is final.</span>
          </div>
          <div className="mt-4">
            <KV k="Token" v={noToken ? "not deployed" : explorer ? <a className="hover:underline" href={`${explorer}/address/${dir.dca}`} target="_blank" rel="noreferrer">{short(dir.dca)}</a> : short(dir.dca)} />
            <KV k="Total supply" v={token.totalSupply !== undefined ? fmtUnits(token.totalSupply, 18, 0) : "—"} />
            <KV k="Auto-send threshold" v={auto !== undefined ? `${fmtUnits(auto, 18, 0)} $DCA` : "—"} />
            <KV k="Fee-halving threshold" v={halve !== undefined ? `${fmtUnits(halve, 18, 0)} $DCA` : "—"} />
          </div>
        </Card>
      </div>

      <Card title="Fee schedule" className="mt-4" flush>
        <table className="tbl">
          <thead>
            <tr>
              <th>Fee</th>
              {infos.map((v) => (
                <th key={v.kind} className="text-right">
                  {VAULT_META[v.kind].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Purchase, per buy", "purchaseFeeBps"],
                ["Deposit", "depositFeeBps"],
                ["Withdraw funds", "withdrawFeeBps"],
                ["Claim stock (free for holders)", "claimFeeBps"],
              ] as const
            ).map(([label, key]) => (
              <tr key={key}>
                <td className="text-ink-2">{label}</td>
                {infos.map((v) => (
                  <td key={v.kind} className="num text-right">
                    {fmtBps(v.fees?.[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-line px-5 py-3 text-[11px] text-ink-3">Every fee is hard-capped at 0.90% in the contracts. Fees fund the treasury.</div>
      </Card>
    </>
  );
}

function Perk({ ok, connected, threshold, title, desc }: { ok: boolean; connected: boolean; threshold?: bigint; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-2 p-4">
      <span className="mt-1.5">
        <Dot tone={ok ? "good" : "muted"} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-semibold text-ink">{title}</span>
          <span className="chip-lime">≥ {threshold !== undefined ? fmtUnits(threshold, 18, 0) : "—"} $DCA</span>
        </div>
        <div className="mt-1 text-[13px] text-ink-2">{desc}</div>
      </div>
      {connected && <span className={`text-[12px] ${ok ? "text-good" : "text-ink-3"}`}>{ok ? "Active" : "Inactive"}</span>}
    </div>
  );
}
