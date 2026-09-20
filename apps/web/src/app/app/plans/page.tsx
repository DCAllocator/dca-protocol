"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { useDirectory, usePositions, useStocks, useVaults, useUser, useQuote, usePrices, kindOf, vaultList, type Position, type VaultInfo } from "@/hooks/useProtocol";
import { useTx, useTxSequence, type TxStep } from "@/hooks/useTx";
import { usePlanIndex, planKey } from "@/hooks/useLogs";
import { PlanVaultAbi, ERC20Abi } from "@/abi";
import { PageHeader, Card, Notice, Spinner, StockAvatar, Dot, Empty, Modal, Menu, Slider, AmountInput, Segmented, KV, Countdown, SearchInput, SortTh } from "@/components/ui";
import { ConnectButton } from "@/components/ConnectButton";
import { fmtUsd, fmtUnits, fmtBps, feeOf, valueOf } from "@/lib/format";
import { VAULT_META, VAULT_KINDS, MAX_UINT256, USDG_DECIMALS, type VaultKind } from "@/lib/config";
import { tickerName } from "@/lib/tickers";

const keyOf = (p: Position) => planKey(p.vault, p.planId);
type Dialog = { kind: "deposit" | "withdraw" | "remove"; plan: Position } | null;

type SortKey = "plan" | "per" | "balance" | "stock" | "next" | "status";
type Sort = { key: SortKey; dir: 1 | -1 };

export default function Plans() {
  const { address } = useAccount();
  const { dir, vaults, configured } = useDirectory();
  const { stocks, byAddress } = useStocks(dir?.registry);
  const { positions: all, isLoading, refetch } = usePositions(vaults);
  const index = usePlanIndex(vaults ? vaultList(vaults) : undefined);
  const { byKind } = useVaults(vaults);
  const user = useUser(dir);
  const priceTokens = useMemo(() => stocks.map((s) => ({ address: s.address, decimals: s.decimals })), [stocks]);
  const { prices } = usePrices(dir?.router, dir?.usdg, priceTokens);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [query, setQuery] = useState("");
  const [freq, setFreq] = useState<VaultKind | "all">("all");
  const [sort, setSort] = useState<Sort>({ key: "next", dir: 1 });
  // Plans removed in this session are hidden immediately, before the log scan catches up.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  const refresh = () => {
    refetch();
    index.refetch();
    user.refetch();
  };
  const onRemoved = (p: Position) => {
    setHidden((h) => new Set(h).add(keyOf(p)));
    refresh();
  };

  // A removed plan is one the vault unindexed and that holds nothing. A later deposit re-indexes it,
  // so it reappears on its own.
  const positions = useMemo(
    () =>
      all.filter((p) => {
        const empty = p.usdgIdle === 0n && p.wethIdle === 0n && p.stockAccrued === 0n;
        const unindexed = index.data?.[keyOf(p)] === false;
        return !(empty && (unindexed || hidden.has(keyOf(p))));
      }),
    [all, index.data, hidden],
  );

  type Row = { p: Position; kind?: VaultKind; info?: VaultInfo; symbol: string; name: string; decimals: number; stockUsd?: bigint; active: boolean };
  const rows = useMemo<Row[]>(
    () =>
      positions.map((p) => {
        const kind = kindOf(vaults, p.vault);
        const stock = byAddress[p.stock.toLowerCase()];
        const symbol = stock?.symbol ?? "?";
        const decimals = stock?.decimals ?? 18;
        return {
          p,
          kind,
          info: kind ? byKind[kind] : undefined,
          symbol,
          name: tickerName(symbol),
          decimals,
          stockUsd: p.stockAccrued === 0n ? 0n : valueOf(p.stockAccrued, prices[p.stock.toLowerCase()], decimals),
          active: !p.paused && (p.usdgIdle > 0n || p.wethIdle > 0n),
        };
      }),
    [positions, vaults, byAddress, byKind, prices],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (freq !== "all" && r.kind !== freq) return false;
      if (!q) return true;
      return r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || `#${r.p.planId}`.includes(q) || (r.kind ?? "").includes(q);
    });
  }, [rows, query, freq]);

  const sorted = useMemo(() => {
    const val = (r: Row): number | string | undefined => {
      switch (sort.key) {
        case "plan":
          return r.symbol.toLowerCase();
        case "per":
          return Number(r.p.amountPerEpoch);
        case "balance":
          return Number(r.p.usdgIdle);
        case "stock":
          return r.stockUsd === undefined ? Number(r.p.stockAccrued) : Number(r.stockUsd);
        case "next":
          return r.active && r.info?.nextEpochStart !== undefined ? Number(r.info.nextEpochStart) : undefined;
        case "status":
          return r.p.paused ? 2 : r.active ? 0 : 1;
      }
    };
    return [...filtered].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va === undefined && vb === undefined) return 0;
      if (va === undefined) return 1; // unknowns last regardless of direction
      if (vb === undefined) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [filtered, sort]);

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "plan" || key === "next" ? 1 : -1 }));

  if (!configured) return <Notice kind="warn">App is not configured.</Notice>;

  const waiting = rows.reduce((a, r) => a + r.p.usdgIdle, 0n);
  const activeCount = rows.filter((r) => r.active).length;
  const stockUsd = rows.reduce<bigint | undefined>((a, r) => (a === undefined || r.stockUsd === undefined ? undefined : a + r.stockUsd), 0n);
  const soonest = rows.filter((r) => r.active && r.info?.nextEpochStart !== undefined).sort((a, b) => Number(a.info!.nextEpochStart! - b.info!.nextEpochStart!))[0];
  const cols = 7;

  return (
    <>
      <PageHeader
        title="My plans"
        description="Every plan you own. Deposit, withdraw or claim from the row."
        right={
          <Link href="/app/create" className="btn-primary">
            + Create new plan
          </Link>
        }
      />

      {address && (
        <div className="stat-strip mb-4">
          <div className="stat-cell stat-cell-key">
            <span className="stat-label">Waiting to buy</span>
            <span className="stat-num">{fmtUsd(waiting)}</span>
          </div>
          <div className="stat-cell">
            <span className="stat-label">Plans</span>
            <span className="stat-num">
              {rows.length}
              {rows.length > 0 && <span className="ml-2 text-[13px] text-ink-2">{activeCount} active</span>}
            </span>
          </div>
          <div className="stat-cell">
            <span className="stat-label">Stock owned</span>
            <span className="stat-num">{rows.length === 0 ? "—" : fmtUsd(stockUsd)}</span>
          </div>
          <div className="stat-cell">
            <span className="stat-label">Next buy</span>
            <span className="stat-num">{soonest ? <Countdown target={soonest.info!.nextEpochStart} className="font-sans" /> : "—"}</span>
            {soonest && (
              <span className="text-[12px] text-ink-2">
                {soonest.symbol} · {soonest.kind ? VAULT_META[soonest.kind].label : ""}
              </span>
            )}
          </div>
        </div>
      )}

      <Card flush>
        <div className="toolbar">
          <SearchInput value={query} onChange={setQuery} placeholder="Search stocks, tickers or plan ids" />
          <Segmented<VaultKind | "all">
            value={freq}
            onChange={setFreq}
            options={[{ value: "all", label: "All" }, ...VAULT_KINDS.map((k) => ({ value: k, label: VAULT_META[k].label }))]}
          />
          <span className="text-[12px] text-ink-2">
            {filtered.length} of {rows.length}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl min-w-[820px]">
            <thead>
              <tr>
                <SortTh k="plan" label="Plan" sort={sort} onSort={toggleSort} />
                <SortTh k="per" label="Per buy" sort={sort} onSort={toggleSort} right />
                <SortTh k="balance" label="Balance" sort={sort} onSort={toggleSort} right />
                <SortTh k="stock" label="Stock owned" sort={sort} onSort={toggleSort} right />
                <SortTh k="next" label="Next buy" sort={sort} onSort={toggleSort} />
                <SortTh k="status" label="Status" sort={sort} onSort={toggleSort} />
                <th className="stick-r text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!address ? (
                <tr>
                  <td colSpan={cols}>
                    <Empty>
                      <ConnectButton />
                      <div className="mt-3">Connect a wallet to see your plans.</div>
                    </Empty>
                  </td>
                </tr>
              ) : isLoading ? (
                <tr>
                  <td colSpan={cols}>
                    <Empty>Loading plans…</Empty>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={cols}>
                    <Empty>
                      No plans yet.{" "}
                      <Link href="/app/create" className="font-medium text-lime hover:underline">
                        Create your first plan →
                      </Link>
                    </Empty>
                  </td>
                </tr>
              ) : sorted.length === 0 ? (
                <tr>
                  <td colSpan={cols}>
                    <Empty>No plans match “{query}”.</Empty>
                  </td>
                </tr>
              ) : (
                sorted.map((r) => (
                  <PlanRow
                    key={keyOf(r.p)}
                    p={r.p}
                    kind={r.kind}
                    info={r.info}
                    symbol={r.symbol}
                    name={r.name}
                    stockDecimals={r.decimals}
                    stockUsd={r.stockUsd}
                    onDialog={(d) => setDialog({ kind: d, plan: r.p })}
                    onChange={refresh}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {dialog && dir && (
        <PlanDialog
          dialog={dialog}
          symbol={byAddress[dialog.plan.stock.toLowerCase()]?.symbol ?? "?"}
          stockDecimals={byAddress[dialog.plan.stock.toLowerCase()]?.decimals ?? 18}
          info={(() => {
            const k = kindOf(vaults, dialog.plan.vault);
            return k ? byKind[k] : undefined;
          })()}
          usdg={dir.usdg}
          weth={dir.weth}
          router={dir.router}
          balances={{ usdg: user.usdg ?? 0n, eth: user.eth ?? 0n }}
          onClose={() => setDialog(null)}
          onChange={refresh}
          onRemoved={() => onRemoved(dialog.plan)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Row                                                                  */
/* ------------------------------------------------------------------ */

function PlanRow({
  p,
  kind,
  info,
  symbol,
  name,
  stockDecimals,
  stockUsd,
  onDialog,
  onChange,
}: {
  p: Position;
  kind?: VaultKind;
  info?: VaultInfo;
  symbol: string;
  name: string;
  stockDecimals: number;
  stockUsd?: bigint;
  onDialog: (d: "deposit" | "withdraw" | "remove") => void;
  onChange: () => void;
}) {
  const tx = useTx(onChange);
  const funded = p.usdgIdle > 0n || p.wethIdle > 0n;
  const status = p.paused ? (["Paused", "warn"] as const) : funded ? (["Active", "good"] as const) : (["Needs funds", "muted"] as const);
  const call = (functionName: "setPlanPaused" | "claim", args: readonly unknown[]) => tx.write({ address: p.vault, abi: PlanVaultAbi, functionName, args } as never);

  return (
    <tr>
      <td>
        <span className="flex items-center gap-3">
          <StockAvatar symbol={symbol} size={30} />
          <span className="min-w-0">
            <span className="block text-[14px] font-medium text-ink">
              {symbol} <span className="font-normal text-ink-2">{name !== symbol ? name : ""}</span>
            </span>
            <span className="block text-[12px] text-ink-2">
              {kind ? VAULT_META[kind].label : "?"} · #{p.planId.toString()}
            </span>
          </span>
        </span>
      </td>
      <td className="num text-right">
        {fmtUsd(p.amountPerEpoch)}
        {kind && <span className="block text-[11.5px] text-ink-2">per {VAULT_META[kind].per}</span>}
      </td>
      <td className="num text-right">
        {fmtUsd(p.usdgIdle)}
        {p.wethIdle > 0n && <span className="block text-[11.5px] text-ink-2">+ {fmtUnits(p.wethIdle, 18)} ETH</span>}
      </td>
      <td className="num text-right">
        {fmtUnits(p.stockAccrued, stockDecimals, 4)} <span className="text-[11.5px] text-ink-2">{symbol}</span>
        {p.stockAccrued > 0n && <span className="block text-[11.5px] text-ink-2">{fmtUsd(stockUsd)}</span>}
      </td>
      <td>
        {p.paused || !funded ? <span className="text-ink-3">—</span> : <Countdown target={info?.nextEpochStart} className="text-ink" />}
      </td>
      <td>
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink">
          <Dot tone={status[1]} />
          {status[0]}
        </span>
      </td>
      <td className="stick-r text-right">
        <span className="inline-flex items-center justify-end gap-1">
          <button type="button" className="btn-secondary btn-xs" onClick={() => onDialog("deposit")}>
            Deposit
          </button>
          <button type="button" className="btn-ghost btn-xs" disabled={!funded} onClick={() => onDialog("withdraw")}>
            Withdraw
          </button>
          <button type="button" className="btn-ghost btn-xs" disabled={p.stockAccrued === 0n || tx.pending} onClick={() => call("claim", [p.planId, MAX_UINT256])}>
            {tx.pending ? <Spinner /> : "Claim"}
          </button>
          <Menu
            items={[
              { label: p.paused ? "Resume plan" : "Pause plan", onClick: () => call("setPlanPaused", [p.planId, !p.paused]), disabled: tx.pending },
              { label: "Remove plan", onClick: () => onDialog("remove"), danger: true },
            ]}
          />
        </span>
        {tx.error && <div className="mt-1 max-w-64 truncate text-[11px] text-bad">{tx.error}</div>}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                              */
/* ------------------------------------------------------------------ */

function PlanDialog(props: {
  dialog: NonNullable<Dialog>;
  symbol: string;
  stockDecimals: number;
  info?: VaultInfo;
  usdg: `0x${string}`;
  weth: `0x${string}`;
  router: `0x${string}`;
  balances: { usdg: bigint; eth: bigint };
  onClose: () => void;
  onChange: () => void;
  onRemoved: () => void;
}) {
  const { dialog } = props;
  const title = { deposit: "Deposit", withdraw: "Withdraw", remove: "Remove plan" }[dialog.kind];
  return (
    <Modal open onClose={props.onClose} title={`${title} · ${props.symbol} #${dialog.plan.planId.toString()}`}>
      {dialog.kind === "deposit" && <DepositForm {...props} />}
      {dialog.kind === "withdraw" && <WithdrawForm {...props} />}
      {dialog.kind === "remove" && <RemoveForm {...props} />}
    </Modal>
  );
}

const ETH_GAS_RESERVE = parseEther("0.01");

function DepositForm({ dialog, usdg, weth, router, balances, onClose, onChange }: Parameters<typeof PlanDialog>[0]) {
  const p = dialog.plan;
  const { address } = useAccount();
  const [pay, setPay] = useState<"USDG" | "ETH">("USDG");
  const [amount, setAmount] = useState("");
  const wei = pay === "USDG" ? safeParse(amount, USDG_DECIMALS) : safeParse(amount, 18);
  const ethMax = balances.eth > ETH_GAS_RESERVE ? balances.eth - ETH_GAS_RESERVE : 0n;
  const max = pay === "USDG" ? balances.usdg : ethMax;
  const sliderMax = pay === "USDG" ? Math.floor(Number(formatUnits(balances.usdg, USDG_DECIMALS))) : Number(formatEther(ethMax));

  const quote = useQuote(router, weth, usdg, pay === "ETH" ? wei : undefined);
  const allowance = useReadContract({
    address: usdg,
    abi: ERC20Abi,
    functionName: "allowance",
    args: address ? [address, p.vault] : undefined,
    query: { enabled: !!address && pay === "USDG" },
  });
  const needsApproval = pay === "USDG" && !!wei && wei > 0n && (allowance.data ?? 0n) < wei;
  const seq = useTxSequence(() => {
    onChange();
    onClose();
  });
  const insufficient = !!wei && wei > (pay === "USDG" ? balances.usdg : balances.eth);
  const quoteMissing = pay === "ETH" && !!wei && wei > 0n && quote.data === undefined;
  const ok = !!wei && wei > 0n && !insufficient && !quoteMissing && !seq.running;

  const submit = () => {
    if (!wei) return;
    const steps: TxStep[] = [];
    if (needsApproval) steps.push({ label: "Approve USDG", params: { address: usdg, abi: ERC20Abi, functionName: "approve", args: [p.vault, wei] } });
    if (pay === "USDG") steps.push({ label: "Deposit", params: { address: p.vault, abi: PlanVaultAbi, functionName: "depositUSDG", args: [p.planId, wei] } });
    else {
      const minOut = quote.data ? (quote.data.amountOut * 9_950n) / 10_000n : 0n;
      steps.push({ label: "Deposit", params: { address: p.vault, abi: PlanVaultAbi, functionName: "depositETH", args: [p.planId, minOut], value: wei } });
    }
    seq.run(steps);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-ink-3">Pay with</span>
        <Segmented
          value={pay}
          onChange={(v) => {
            setPay(v);
            setAmount("");
          }}
          options={[
            { value: "USDG", label: "USDG" },
            { value: "ETH", label: "ETH" },
          ]}
        />
      </div>
      <AmountInput value={amount} onChange={setAmount} unit={pay} large onMax={() => setAmount(pay === "USDG" ? formatUnits(max, USDG_DECIMALS) : formatEther(max))} />
      <div>
        <Slider value={Number(amount) || 0} min={0} max={sliderMax} step={pay === "USDG" ? 1 : 0.001} onChange={(v) => setAmount(pay === "USDG" ? String(v) : v.toFixed(3))} ariaLabel="Deposit amount" />
        <div className="flex justify-between text-[11px] text-ink-3">
          <span>0</span>
          <span>Balance: {pay === "USDG" ? fmtUsd(balances.usdg) : `${fmtUnits(balances.eth, 18)} ETH`}</span>
        </div>
      </div>
      {pay === "ETH" && wei && wei > 0n && (
        <p className="text-[12px] text-ink-3">
          Converted to <span className="num text-ink-2">{quote.data ? `≈ ${fmtUsd(quote.data.amountOut)}` : "…"}</span> USDG on deposit.
        </p>
      )}
      {insufficient && <Notice kind="error">Not enough {pay} in your wallet.</Notice>}
      {seq.error && <Notice kind="error">{seq.error}</Notice>}
      <button type="button" className="btn-primary h-10 w-full" disabled={!ok} onClick={submit}>
        {seq.running ? (
          <>
            <Spinner /> {seq.label}
          </>
        ) : needsApproval ? (
          "Approve & deposit"
        ) : (
          "Deposit"
        )}
      </button>
    </div>
  );
}

function WithdrawForm({ dialog, info, onClose, onChange }: Parameters<typeof PlanDialog>[0]) {
  const p = dialog.plan;
  const [amount, setAmount] = useState("");
  const [withEth, setWithEth] = useState(p.wethIdle > 0n);
  const wei = safeParse(amount, USDG_DECIMALS) ?? 0n;
  const usdgOut = wei > p.usdgIdle ? p.usdgIdle : wei;
  const wethOut = withEth ? p.wethIdle : 0n;
  const tx = useTx(() => {
    onChange();
    onClose();
  });
  const feeBps = info?.fees?.withdrawFeeBps ?? 0;
  const ok = (usdgOut > 0n || wethOut > 0n) && !tx.pending;

  return (
    <div className="space-y-4">
      <AmountInput value={amount} onChange={setAmount} unit="USDG" large onMax={() => setAmount(formatUnits(p.usdgIdle, USDG_DECIMALS))} />
      <div>
        <Slider value={Number(amount) || 0} min={0} max={Number(formatUnits(p.usdgIdle, USDG_DECIMALS))} step={1} onChange={(v) => setAmount(String(v))} ariaLabel="Withdraw amount" />
        <div className="flex justify-between text-[11px] text-ink-3">
          <span>0</span>
          <span>In plan: {fmtUsd(p.usdgIdle)}</span>
        </div>
      </div>
      {p.wethIdle > 0n && (
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" className="accent-lime" checked={withEth} onChange={(e) => setWithEth(e.target.checked)} />
          Also withdraw {fmtUnits(p.wethIdle, 18)} ETH
        </label>
      )}
      <div className="rounded-lg bg-surface-2 px-3">
        <KV k="You receive" v={usdgOut > 0n ? fmtUsd(usdgOut - feeOf(usdgOut, feeBps)) : "—"} />
      </div>
      {tx.error && <Notice kind="error">{tx.error}</Notice>}
      <button
        type="button"
        className="btn-primary h-10 w-full"
        disabled={!ok}
        onClick={() => tx.write({ address: p.vault, abi: PlanVaultAbi, functionName: "withdrawIdle", args: [p.planId, usdgOut, wethOut, true] })}
      >
        {tx.pending ? <Spinner /> : "Withdraw"}
      </button>
      <p className="text-[11px] text-ink-3">A {fmtBps(feeBps)} fee applies to withdrawn funds. Stock you have already bought stays claimable.</p>
    </div>
  );
}

function RemoveForm({ dialog, symbol, stockDecimals, info, onClose, onRemoved }: Parameters<typeof PlanDialog>[0]) {
  const p = dialog.plan;
  const seq = useTxSequence(() => {
    onRemoved();
    onClose();
  });
  const steps = useMemo(() => {
    const out: TxStep[] = [];
    if (p.usdgIdle > 0n || p.wethIdle > 0n)
      out.push({ label: "Withdraw funds", params: { address: p.vault, abi: PlanVaultAbi, functionName: "withdrawIdle", args: [p.planId, p.usdgIdle, p.wethIdle, true] } });
    if (p.stockAccrued > 0n) out.push({ label: `Claim ${symbol}`, params: { address: p.vault, abi: PlanVaultAbi, functionName: "claim", args: [p.planId, MAX_UINT256] } });
    out.push({ label: "Delete plan", params: { address: p.vault, abi: PlanVaultAbi, functionName: "prunePlan", args: [p.planId] } });
    return out;
  }, [p, symbol]);
  const wdFee = info?.fees?.withdrawFeeBps ?? 0;
  const claimFee = info?.fees?.claimFeeBps ?? 0;
  const epochBusy = seq.error?.includes("EpochInProgress");

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-ink-2">This sends everything in the plan back to your wallet, then deletes it. It cannot be undone.</p>
      <ol className="space-y-2">
        {steps.map((s, i) => {
          const state = seq.running && seq.step === i ? "running" : (seq.running || seq.done || seq.error) && seq.step > i ? "done" : "todo";
          return (
            <li key={s.label} className="flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
              <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${state === "done" ? "bg-lime text-lime-ink" : "bg-surface-4 text-ink-2"}`}>
                {state === "running" ? <Spinner /> : state === "done" ? "✓" : i + 1}
              </span>
              <span className="text-ink">{s.label}</span>
              <span className="ml-auto num text-[12px] text-ink-3">
                {s.label === "Withdraw funds" && (
                  <>
                    {fmtUsd(p.usdgIdle - feeOf(p.usdgIdle, wdFee))}
                    {p.wethIdle > 0n ? ` + ${fmtUnits(p.wethIdle - feeOf(p.wethIdle, wdFee), 18)} ETH` : ""}
                  </>
                )}
                {s.label.startsWith("Claim") && `${fmtUnits(p.stockAccrued - feeOf(p.stockAccrued, claimFee), stockDecimals, 4)} ${symbol}`}
              </span>
            </li>
          );
        })}
      </ol>
      {seq.error && (
        <Notice kind="error">
          {epochBusy ? `A ${symbol} buy is running right now. Your funds are out; try deleting the plan again in a few minutes.` : seq.error}
        </Notice>
      )}
      <button type="button" className="btn-primary h-10 w-full bg-bad text-ink hover:bg-bad/90" disabled={seq.running} onClick={() => seq.run(steps)}>
        {seq.running ? (
          <>
            <Spinner /> {seq.label} ({seq.step + 1}/{seq.total})
          </>
        ) : (
          `Remove plan · ${steps.length} ${steps.length === 1 ? "confirmation" : "confirmations"}`
        )}
      </button>
      <p className="text-[11px] text-ink-3">
        Withdrawals carry a {fmtBps(wdFee)} fee and claims {fmtBps(claimFee)} (free for $DCA holders).
      </p>
    </div>
  );
}

function safeParse(v: string, d: number): bigint | undefined {
  try {
    if (!v.trim()) return undefined;
    return parseUnits(v.trim(), d);
  } catch {
    return undefined;
  }
}
