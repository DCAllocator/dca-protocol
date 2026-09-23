"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatEther, formatUnits, parseEther, parseEventLogs, parseUnits, toFunctionSelector, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import {
  useDirectory,
  usePositions,
  useStocks,
  useVaults,
  useUser,
  useQuote,
  usePrices,
  useBoostApys,
  boostAvailable,
  planBalance,
  boostEarnings,
  kindOf,
  vaultList,
  type Position,
  type VaultInfo,
} from "@/hooks/useProtocol";
import { useTx, useTxSequence, type TxStep } from "@/hooks/useTx";
import { usePlanIndex, planKey } from "@/hooks/useLogs";
import { PlanVaultAbi, ERC20Abi } from "@/abi";
import { PageHeader, Card, Notice, Spinner, StockAvatar, Dot, Empty, Modal, Menu, Slider, AmountInput, Segmented, KV, Countdown, SearchInput, SortTh, Icon, HashLink } from "@/components/ui";
import { ConnectButton } from "@/components/ConnectButton";
import { useToast } from "@/components/Toast";
import { TxFlowDialog } from "@/components/app/TxFlowDialog";
import { AddToWalletButton } from "@/components/app/AddToWalletButton";
import { fmtUsd, fmtUnits, fmtBps, fmtPct, feeOf, valueOf } from "@/lib/format";
import { VAULT_META, VAULT_KINDS, MAX_UINT256, USDG_DECIMALS, BOOST, type VaultKind } from "@/lib/config";
import { tickerName } from "@/lib/tickers";
import { describeTxError, REJECTED_COPY } from "@/lib/txErrors";
import { visiblePositions } from "@/lib/visiblePositions";
import {
  buildRemoveOrder,
  buildCloseOrder,
  buildPartialWithdraw,
  isEmptyPlan,
  recipientCopy,
  DEFER_COPY,
  STEP_UNBOOST,
  STEP_WITHDRAW,
  STEP_CLOSE,
  type CloseProbe,
  type FreshPlan,
  type RemoveOrder,
} from "@/lib/removeSteps";

const keyOf = (p: Position) => planKey(p.vault, p.planId);
/**
 * An open dialog remembers the plan by KEY and resolves the live `Position` on every render, so balances that
 * change while it is open (a mined step, the positions poll) reach the form; `plan` is the click-time snapshot,
 * used only until the live list has the key (or after the plan left it).
 */
type Dialog = { kind: "deposit" | "withdraw" | "remove"; key: string; plan: Position } | null;

type SortKey = "plan" | "per" | "balance" | "stock" | "next" | "status";
type Sort = { key: SortKey; dir: 1 | -1 };

export default function Plans() {
  const { address } = useAccount();
  const { dir, vaults, configured } = useDirectory();
  const { byAddress } = useStocks(dir?.registry);
  const { positions: all, isLoading, refetch } = usePositions(vaults);
  const index = usePlanIndex(vaults ? vaultList(vaults) : undefined);
  const { infos, byKind, refetch: refetchVaults } = useVaults(vaults);
  const { apyOf } = useBoostApys(infos);
  const user = useUser(dir);
  // Quote only the stocks this wallet actually holds plans in (one `quote` eth_call each per refetch) instead of every
  // registry stock. The resulting map is still keyed by lower-cased address, which is all the row values and the Stock
  // sort read; a stock missing from the registry snapshot falls back to 18 decimals like the rows do. Keyed on the
  // sorted address list so a positions poll that returns the same stocks keeps the memo (and the query key) stable.
  const heldStocks = useMemo(() => [...new Set(all.map((p) => p.stock.toLowerCase()))].sort().join(","), [all]);
  const priceTokens = useMemo(
    () =>
      heldStocks
        ? heldStocks.split(",").map((a) => {
            const s = byAddress[a];
            return { address: (s?.address ?? a) as Address, decimals: s?.decimals ?? 18 };
          })
        : [],
    [heldStocks, byAddress],
  );
  const { prices } = usePrices(dir?.router, dir?.usdg, priceTokens);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [query, setQuery] = useState("");
  const [freq, setFreq] = useState<VaultKind | "all">("all");
  const [sort, setSort] = useState<Sort>({ key: "next", dir: 1 });
  // Plans removed in this session are hidden immediately, before the log scan catches up.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  // Plans whose withdraw-and-remove sequence is in flight: their row's menu entry is disabled meanwhile.
  const [removing, setRemoving] = useState<Set<string>>(() => new Set());
  const setRemovingKey = useCallback(
    (key: string, busy: boolean) =>
      setRemoving((r) => {
        if (r.has(key) === busy) return r;
        const next = new Set(r);
        if (busy) next.add(key);
        else next.delete(key);
        return next;
      }),
    [],
  );
  const dialogKey = dialog?.key;
  const onDialogBusy = useCallback(
    (busy: boolean) => {
      if (dialogKey) setRemovingKey(dialogKey, busy);
    },
    [dialogKey, setRemovingKey],
  );

  const refresh = () => {
    refetch();
    refetchVaults();
    index.refetch();
    user.refetch();
  };
  // Only called once a post-sequence `getPlan` confirmed the plan is empty and pruned (RemoveForm).
  const onRemoved = (key: string) => {
    setHidden((h) => new Set(h).add(key));
    refresh();
  };

  // A removed plan is one the vault unindexed and that holds nothing (`visiblePositions` never hides value).
  // A later deposit re-indexes it, so it reappears on its own.
  const positions = useMemo(() => visiblePositions(all, index.data, hidden, keyOf), [all, index.data, hidden]);
  const livePlan = dialog ? (all.find((p) => keyOf(p) === dialog.key) ?? dialog.plan) : null;

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
          active: !p.paused && planBalance(p) > 0n,
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
          return Number(planBalance(r.p));
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

  const waiting = rows.reduce((a, r) => a + planBalance(r.p), 0n);
  const boosted = rows.reduce((a, r) => a + (r.p.boosted ? r.p.boostValue : 0n), 0n);
  const earned = rows.reduce((a, r) => a + boostEarnings(r.p), 0n);
  const boostedCount = rows.filter((r) => r.p.boosted).length;
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
            <span className="stat-label">USD Balance</span>
            <span className="stat-num">{fmtUsd(waiting)}</span>
            {(boostedCount > 0 || earned > 0n) && (
              <span className="text-[12px] text-ink-2">
                {boostedCount > 0 && (
                  <>
                    <span className="text-good">{fmtUsd(boosted)}</span> boosted ·{" "}
                  </>
                )}
                <span className="text-good">+{fmtUsd(earned)}</span> earned{boostedCount === 0 ? ` from ${BOOST.name.toLowerCase()}` : ""}
              </span>
            )}
          </div>
          <div className="stat-cell">
            <span className="stat-label">Purchased Stock Value</span>
            <span className="stat-num">{rows.length === 0 ? "—" : fmtUsd(stockUsd)}</span>
          </div>
          <div className="stat-cell">
            <span className="stat-label">Plans</span>
            <span className="stat-num">
              {rows.length}
              {rows.length > 0 && <span className="ml-2 text-[13px] text-ink-2">{activeCount} active</span>}
            </span>
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
                <SortTh k="stock" label="Purchase value" sort={sort} onSort={toggleSort} right />
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
                    apy={apyOf(r.info?.boostStrategy)}
                    symbol={r.symbol}
                    name={r.name}
                    stockDecimals={r.decimals}
                    stockUsd={r.stockUsd}
                    removing={removing.has(keyOf(r.p))}
                    onDialog={(d) => setDialog({ kind: d, key: keyOf(r.p), plan: r.p })}
                    onChange={refresh}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {dialog && livePlan && dir && (
        <PlanDialog
          dialog={{ ...dialog, plan: livePlan }}
          symbol={byAddress[livePlan.stock.toLowerCase()]?.symbol ?? "?"}
          stockDecimals={byAddress[livePlan.stock.toLowerCase()]?.decimals ?? 18}
          info={(() => {
            const k = kindOf(vaults, livePlan.vault);
            return k ? byKind[k] : undefined;
          })()}
          usdg={dir.usdg}
          weth={dir.weth}
          router={dir.router}
          balances={{ usdg: user.usdg ?? 0n, eth: user.eth ?? 0n }}
          onClose={() => setDialog(null)}
          onChange={refresh}
          onRemoved={() => onRemoved(dialog.key)}
          onBusy={onDialogBusy}
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
  apy,
  symbol,
  name,
  stockDecimals,
  stockUsd,
  removing,
  onDialog,
  onChange,
}: {
  p: Position;
  kind?: VaultKind;
  info?: VaultInfo;
  apy?: number;
  symbol: string;
  name: string;
  stockDecimals: number;
  stockUsd?: bigint;
  /** This plan's withdraw-and-remove sequence is running: its menu entry is disabled so a second one cannot start. */
  removing?: boolean;
  onDialog: (d: "deposit" | "withdraw" | "remove") => void;
  onChange: () => void;
}) {
  // One write at a time per row. `pendingKey` names the action in flight so only its own button spins;
  // the siblings stay disabled (one wallet, one nonce) but keep their labels. Outcomes are toasted by the hook.
  const tx = useTx(onChange);
  const balance = planBalance(p);
  const funded = balance > 0n;
  const earned = boostEarnings(p);
  const canBoost = boostAvailable(info);
  const status = p.paused ? (["Paused", "warn"] as const) : funded ? (["Active", "good"] as const) : (["Needs funds", "muted"] as const);
  const call = (functionName: "setPlanPaused" | "claim" | "setPlanBoost", args: readonly unknown[], key: "pause" | "claim" | "boost", success: string) =>
    void tx.write({ address: p.vault, abi: PlanVaultAbi, functionName, args } as never, { key, success });
  // One click each way: boost lends the idle balance on Morpho, unboost pulls it back (yield included).
  const toggleBoost = () => call("setPlanBoost", [p.planId, !p.boosted], "boost", p.boosted ? "Unboosted" : BOOST.chip);
  const togglePause = () => call("setPlanPaused", [p.planId, !p.paused], "pause", p.paused ? "Plan resumed" : "Plan paused");
  const claim = () => call("claim", [p.planId, MAX_UINT256], "claim", `Claimed ${symbol}`);
  const busy = (key: "pause" | "claim" | "boost") => tx.pendingKey === key;

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
            <AddToWalletButton address={p.stock} symbol={symbol} decimals={stockDecimals} className="mt-0.5" />
          </span>
        </span>
      </td>
      <td className="num text-right">
        {fmtUsd(p.amountPerEpoch)}
        {kind && <span className="block text-[11.5px] text-ink-2">per {VAULT_META[kind].per}</span>}
      </td>
      <td className="num text-right">
        {fmtUsd(balance)}
        {(p.boosted || earned > 0n) && (
          <span
            className={`mt-0.5 flex items-center justify-end gap-1 text-[11.5px] ${p.boosted ? "text-good" : "text-ink-2"}`}
            title={
              p.boosted
                ? `${BOOST.chip}: lifetime earnings from lending on Morpho Blue${apy !== undefined ? ` (now ${fmtPct(apy, true)} APY)` : ""}`
                : "Earned while this plan was boosted"
            }
          >
            {p.boosted && <Icon name="bolt" size={11} className="text-lime" />}+{fmtUsd(earned)} earned
          </span>
        )}
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
        <span className="inline-flex items-center justify-end gap-0.5">
          <button type="button" className="btn-secondary btn-xs px-2.5" onClick={() => onDialog("deposit")}>
            Deposit
          </button>
          <button type="button" className="btn-ghost btn-xs px-2.5" disabled={!funded} onClick={() => onDialog("withdraw")}>
            Withdraw
          </button>
          <button type="button" className="btn-ghost btn-xs px-2.5" disabled={p.stockAccrued === 0n || tx.pending} onClick={claim}>
            {busy("claim") ? <Spinner /> : "Claim"}
          </button>
          {p.boosted ? (
            <button type="button" className="btn-ghost btn-xs px-2.5" disabled={tx.pending} onClick={toggleBoost} title={`Pull the boosted balance back into the plan (${fmtUsd(p.boostValue)}, earnings included)`}>
              {busy("boost") ? <Spinner /> : BOOST.off}
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary btn-xs gap-1 border-lime/40 px-2.5 text-lime hover:border-lime hover:bg-lime/10"
              disabled={!canBoost || tx.pending}
              onClick={toggleBoost}
              title={canBoost ? `Lend the idle balance on Morpho Blue at ${fmtPct(apy, true)} APY until each buy` : "Boost is not available on this frequency yet"}
            >
              {busy("boost") ? <Spinner /> : <Icon name="bolt" size={12} />}
              {BOOST.on}
              {canBoost && apy !== undefined && <span className="hidden font-normal text-ink-2 2xl:inline">{fmtPct(apy)}</span>}
            </button>
          )}
          {/* The menu closes on click, so the pause write shows its progress where the trigger was. */}
          <Menu
            label={busy("pause") ? <Spinner /> : undefined}
            items={[
              { label: p.paused ? "Resume plan" : "Pause plan", onClick: togglePause, disabled: tx.pending },
              { label: "Withdraw & remove plan", onClick: () => onDialog("remove"), danger: true, disabled: removing },
            ]}
          />
        </span>
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
  /** Forms report whether a write is in flight so the modal can refuse to close mid-transaction. */
  onBusy?: (busy: boolean) => void;
}) {
  const { dialog } = props;
  const [busy, setBusy] = useState(false);
  // Remove hosts its own dialogs (a preview Modal, then the step-by-step TxFlowDialog) and reports its
  // in-flight state up through `onBusy` so the row's menu entry stays disabled meanwhile.
  if (dialog.kind === "remove") return <RemoveForm {...props} />;
  const title = { deposit: "Deposit", withdraw: "Withdraw" }[dialog.kind];
  return (
    <Modal open closable={!busy} onClose={props.onClose} title={`${title} · ${props.symbol} #${dialog.plan.planId.toString()}`}>
      {dialog.kind === "deposit" && <DepositForm {...props} onBusy={setBusy} />}
      {dialog.kind === "withdraw" && <WithdrawForm {...props} onBusy={setBusy} />}
    </Modal>
  );
}

const ETH_GAS_RESERVE = parseEther("0.01");
/** Slippage applied to the ETH → USDG conversion quote on deposit. */
const ZAP_SLIPPAGE_BPS = 50n;
const MIN_DEPOSIT_FALLBACK = 10n * 10n ** BigInt(USDG_DECIMALS);

function DepositForm({ dialog, info, usdg, weth, router, balances, onClose, onChange, onBusy }: Parameters<typeof PlanDialog>[0]) {
  const p = dialog.plan;
  const { address } = useAccount();
  const { toast } = useToast();
  const [pay, setPay] = useState<"USDG" | "ETH">("USDG");
  const [amount, setAmount] = useState("");
  const wei = pay === "USDG" ? safeParse(amount, USDG_DECIMALS) : safeParse(amount, 18);
  const ethMax = balances.eth > ETH_GAS_RESERVE ? balances.eth - ETH_GAS_RESERVE : 0n;
  const max = pay === "USDG" ? balances.usdg : ethMax;
  const sliderMax = pay === "USDG" ? Math.floor(Number(formatUnits(balances.usdg, USDG_DECIMALS))) : Number(formatEther(ethMax));

  // The vault converts ETH net of any deposit fee; quote exactly that amount so minOut cannot over-demand.
  const depositFeeBps = info?.fees?.depositFeeBps ?? 0;
  const ethNet = pay === "ETH" && wei ? wei - feeOf(wei, depositFeeBps) : undefined;
  const quote = useQuote(router, weth, usdg, ethNet && ethNet > 0n ? ethNet : undefined);
  const minDeposit = info?.minDeposit ?? MIN_DEPOSIT_FALLBACK;
  // What the vault will credit, in the worst case: USDG net of fee, or the ETH quote minus the slippage tolerance.
  const creditedFloor =
    pay === "USDG"
      ? wei !== undefined
        ? wei - feeOf(wei, depositFeeBps)
        : undefined
      : quote.data
        ? (quote.data.amountOut * (10_000n - ZAP_SLIPPAGE_BPS)) / 10_000n
        : undefined;
  const tooSmall = !!wei && wei > 0n && creditedFloor !== undefined && creditedFloor < minDeposit;
  const allowance = useReadContract({
    address: usdg,
    abi: ERC20Abi,
    functionName: "allowance",
    args: address ? [address, p.vault] : undefined,
    query: { enabled: !!address && pay === "USDG" },
  });
  const needsApproval = pay === "USDG" && !!wei && wei > 0n && (allowance.data ?? 0n) < wei;
  // The modal closes on success and the confirmation survives as a toast, hash included.
  const seq = useTxSequence((hash) => {
    onChange();
    onClose();
    toast({ kind: "ok", title: `Deposited ${pay === "USDG" ? fmtUsd(wei) : `${fmtUnits(wei ?? 0n, 18)} ETH`}`, hash });
  });
  useEffect(() => onBusy?.(seq.running), [seq.running, onBusy]);
  const insufficient = !!wei && wei > (pay === "USDG" ? balances.usdg : balances.eth);
  const quoteMissing = pay === "ETH" && !!wei && wei > 0n && quote.data === undefined;
  const ok = !!wei && wei > 0n && !insufficient && !quoteMissing && !tooSmall && !seq.running;

  const submit = () => {
    if (!wei) return;
    const steps: TxStep[] = [];
    if (needsApproval) steps.push({ label: "Approve USDG", params: { address: usdg, abi: ERC20Abi, functionName: "approve", args: [p.vault, wei] } });
    if (pay === "USDG") steps.push({ label: "Deposit", params: { address: p.vault, abi: PlanVaultAbi, functionName: "depositUSDG", args: [p.planId, wei] } });
    else {
      // ETH is swapped to USDG inside depositETH; the quote minus 0.5% is the least the vault may credit.
      const minOut = quote.data ? (quote.data.amountOut * (10_000n - ZAP_SLIPPAGE_BPS)) / 10_000n : 0n;
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
          Converted to <span className="num text-ink-2">{quote.data ? `≈ ${fmtUsd(quote.data.amountOut)}` : "…"}</span> USDG on deposit — the plan holds USDG,
          never ETH. The swap has a {fmtBps(Number(ZAP_SLIPPAGE_BPS))} tolerance; any sliver of ETH the pool cannot fill comes straight back to your wallet.
        </p>
      )}
      {tooSmall && <Notice kind="error">The smallest deposit is {fmtUsd(minDeposit)}{pay === "ETH" ? " worth of ETH" : ""}.</Notice>}
      {insufficient && <Notice kind="error">Not enough {pay} in your wallet.</Notice>}
      {seq.error && <Notice kind="error">{seq.error}</Notice>}
      {seq.waiting && (
        <Notice kind="warn">
          <span className="flex items-center justify-between gap-3">
            <span>
              Still waiting for the network — the transaction is sent and may still land. Nothing else will be sent.
              {seq.steps[seq.step]?.hash && (
                <>
                  {" "}
                  <HashLink hash={seq.steps[seq.step].hash!} />
                </>
              )}
            </span>
            <button type="button" className="btn-secondary btn-xs shrink-0" onClick={() => seq.keepWaiting()}>
              Keep waiting
            </button>
          </span>
        </Notice>
      )}
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

function WithdrawForm({ dialog, info, onClose, onChange, onBusy }: Parameters<typeof PlanDialog>[0]) {
  const p = dialog.plan;
  const available = planBalance(p);
  const [amount, setAmount] = useState("");
  const wei = safeParse(amount, USDG_DECIMALS) ?? 0n;
  const all = wei >= available;
  const usdgOut = all ? available : wei;
  // Errors and the "Withdrew …" confirmation are toasted by the hook; the modal only closes on success.
  const tx = useTx(() => {
    onChange();
    onClose();
  });
  useEffect(() => onBusy?.(tx.pending), [tx.pending, onBusy]);
  const feeBps = info?.fees?.withdrawFeeBps ?? 0;
  const ok = usdgOut > 0n && !tx.pending;

  return (
    <div className="space-y-4">
      <AmountInput value={amount} onChange={setAmount} unit="USDG" large onMax={() => setAmount(formatUnits(available, USDG_DECIMALS))} />
      <div>
        <Slider value={Number(amount) || 0} min={0} max={Number(formatUnits(available, USDG_DECIMALS))} step={1} onChange={(v) => setAmount(String(v))} ariaLabel="Withdraw amount" />
        <div className="flex justify-between text-[11px] text-ink-3">
          <span>0</span>
          <span>In plan: {fmtUsd(available)}</span>
        </div>
      </div>
      <div className="rounded-lg bg-surface-2 px-3">
        <KV k="You receive" v={usdgOut > 0n ? fmtUsd(usdgOut - feeOf(usdgOut, feeBps)) : "—"} />
      </div>
      <button
        type="button"
        className="btn-primary h-10 w-full"
        disabled={!ok}
        // "All" uses the vault's sentinel so a boosted balance that grew a hair since this render still clears out.
        onClick={() =>
          void tx.write(
            { address: p.vault, abi: PlanVaultAbi, functionName: "withdrawIdle", args: [p.planId, all ? MAX_UINT256 : usdgOut] },
            { key: "withdraw", success: `Withdrew ${fmtUsd(usdgOut)}` },
          )
        }
      >
        {tx.pending ? <Spinner /> : "Withdraw"}
      </button>
      <p className="text-[11px] text-ink-3">
        A {fmtBps(feeBps)} fee applies to withdrawn funds. Withdrawals are paid in USDG (ETH deposits were converted when they came in). Stock you have already
        bought stays claimable.
        {p.boosted && p.boostValue > 0n
          ? ` ${fmtUsd(p.boostValue)} of this plan is lent on Morpho Blue and is pulled back as part of the withdrawal (earnings included); if the market is short of liquidity the withdrawal fails and nothing moves.`
          : ""}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Withdraw & remove                                                    */
/* ------------------------------------------------------------------ */

/** The reads every decision in `RemoveForm` is made from; never the click-time row. */
type FreshRead = { plan: FreshPlan; epochPending: boolean; close: CloseProbe };
/**
 * `preview`: the fresh read and the steps it implies, behind a closable Modal. `flow`: the sequence runs in a
 * `TxFlowDialog` that cannot be closed while a step is in flight. `deferred`: everything is out but a buy is
 * running, so the delete waits behind "Finish delete".
 */
type RemovePhase = "preview" | "flow" | "deferred";
/**
 * How the plan is emptied and removed. `auto`: `closePlan` when the vault has it and the simulation passes,
 * the single legs otherwise. `sequence`: the single legs because the user asked for them (or picked them after
 * a failed close). `close`: `closePlan` regardless of the probe — only for "Try again" on a failed close.
 */
type RemoveMode = "auto" | "close" | "sequence";

const CLOSE_SELECTOR = toFunctionSelector("closePlan(uint256)");
/** The step-by-step path's own promise, repeated wherever the fallback is offered. */
const STEPWISE_COPY = "Each step moves what it can; if one fails, nothing after it is sent and you can pick up where it stopped.";

/** Product copy for why `closePlan` would revert, from the simulated error. */
function closeRevertReason(e: unknown, boosted: boolean): string {
  const d = describeTxError(e);
  switch (d.errorName) {
    case "NotPlanOwner":
      return "the connected wallet does not own this plan";
    case "ERC4626ExceededMaxWithdraw":
    case "ERC4626ExceededMaxRedeem":
      return "Morpho Blue is short of liquidity for the boosted balance";
    default:
      // A nested revert (the strategy, a token refusing the fee recipient) reaches viem undecoded.
      return d.errorName || d.title !== "Transaction reverted" ? d.title : boosted ? "it reverted — usually Morpho Blue being short of liquidity for the boosted balance" : "it reverted";
  }
}

/**
 * Withdraw & remove plan. Preferred path: ONE owner-signed `closePlan(planId)` — it unboosts, pays the USDG out
 * (withdraw fee, to the signer), claims the stock (claim fee, to the recipient) and drops the plan, atomically.
 * Whether that is possible is decided from a FRESH read when the dialog opens (and again on every retry): the
 * vault's bytecode must dispatch the selector (older local deployments do not) and a simulation as the owner
 * must pass; otherwise — Morpho short of liquidity, a token refusing the fee recipient, anything else — the
 * preview says so and offers the Phase-1 sequence `setPlanBoost(false)` → `withdrawIdle(MAX)` → `claim(MAX)` →
 * `prunePlan` instead, built by `buildRemoveOrder` from the same read and rebuilt from another on every "Try
 * again", so a mined leg is never sent twice (`ZeroAmount`) and none is skipped (`PlanNotEmpty`). A close that
 * reverts at send time gets the same offer inside the flow dialog ("Continue step by step"). The user can also
 * pick the single steps by hand.
 *
 * After the last step a third read decides the outcome: all three balances zero and the plan out of the index →
 * "Plan removed"; zero but a buy page was open for the stock → the close PARKED the plan (paused, still indexed,
 * `PlanClosed(..., false)`; read off the receipt) or the sequence held the prune back — either way "Finish
 * delete" once the buy is over; anything left → back to the preview with the remainder and the steps that clear
 * it. The row is never hidden on trust.
 */
function RemoveForm({ dialog, symbol, stockDecimals, info, onClose, onRemoved, onBusy }: Parameters<typeof PlanDialog>[0]) {
  const p = dialog.plan;
  const { address } = useAccount();
  const client = usePublicClient();
  const { toast } = useToast();
  const title = `Withdraw & remove · ${symbol} #${p.planId.toString()}`;
  const wdFee = info?.fees?.withdrawFeeBps ?? 0;
  const claimFee = info?.fees?.claimFeeBps ?? 0;

  /* ---- fresh reads ---------------------------------------------------- */
  const [fresh, setFresh] = useState<FreshRead | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  // ClaimHelper's boosted value rides along with the live row; `getPlan` only has the shares.
  const boostValueRef = useRef(p.boostValue);
  boostValueRef.current = p.boostValue;
  // Runtime bytecode is immutable: fetched once per vault, then only the simulation is repeated.
  const codeRef = useRef<string | null>(null);
  const readFresh = useCallback(async (): Promise<FreshRead | null> => {
    if (!client) return null;
    try {
      const [plan, epochPending] = await Promise.all([
        client.readContract({ address: p.vault, abi: PlanVaultAbi, functionName: "getPlan", args: [p.planId] }),
        client.readContract({ address: p.vault, abi: PlanVaultAbi, functionName: "isEpochPending", args: [p.stock] }),
      ]);
      // Can this vault close the plan in one transaction right now? Never assumed from the ABI alone.
      let close: CloseProbe;
      if (!address) close = { available: false, kind: "reverted", reason: "no wallet is connected" };
      else {
        codeRef.current ??= (await client.getCode({ address: p.vault })) ?? "0x";
        if (!codeRef.current.toLowerCase().includes(CLOSE_SELECTOR.slice(2).toLowerCase())) {
          close = { available: false, kind: "missing", reason: "this vault predates the one-transaction close" };
        } else {
          try {
            await client.simulateContract({ address: p.vault, abi: PlanVaultAbi, functionName: "closePlan", args: [p.planId], account: address });
            close = { available: true };
          } catch (e) {
            close = { available: false, kind: "reverted", reason: closeRevertReason(e, plan.boosted) };
          }
        }
      }
      const f: FreshRead = {
        plan: {
          owner: plan.owner,
          recipient: plan.recipient,
          boosted: plan.boosted,
          usdgIdle: plan.usdgIdle,
          stockAccrued: plan.stockAccrued,
          boostShares: plan.boostShares,
          boostValue: plan.boostShares > 0n ? boostValueRef.current : 0n,
        },
        epochPending,
        close,
      };
      setFresh(f);
      setReadError(null);
      return f;
    } catch (e) {
      // A stale read must not drive the steps: the preview shows the error and its button stays disabled.
      setFresh(null);
      setReadError(describeTxError(e).title);
      return null;
    }
  }, [client, address, p.vault, p.planId, p.stock]);
  useEffect(() => {
    void readFresh();
  }, [readFresh]);

  // The user's standing choice: `auto` (one transaction when possible) or the single steps.
  const [mode, setMode] = useState<Exclude<RemoveMode, "close">>("auto");
  // The single branch point for how a plan is emptied and removed: `closePlan` or the Phase-1 sequence.
  const orderFor = useCallback(
    (f: FreshRead, m: RemoveMode = mode): RemoveOrder => {
      const input = {
        vault: p.vault,
        planId: p.planId,
        plan: f.plan,
        epochPending: f.epochPending,
        symbol,
        stockDecimals,
        withdrawFeeBps: wdFee,
        claimFeeBps: claimFee,
        signer: address,
      };
      const close = m === "close" || (m === "auto" && f.close.available);
      return close ? buildCloseOrder(input) : buildRemoveOrder(input);
    },
    [mode, p.vault, p.planId, symbol, stockDecimals, wdFee, claimFee, address],
  );
  const preview = useMemo(() => (fresh ? orderFor(fresh) : null), [fresh, orderFor]);
  // How many confirmations the step-by-step path would take, for the offers that name it.
  const stepwiseCount = useMemo(() => (fresh ? orderFor(fresh, "sequence").steps.length : 0), [fresh, orderFor]);

  /* ---- the run ----------------------------------------------------------- */
  const [phase, setPhase] = useState<RemovePhase>("preview");
  // Rows shown in the flow dialog; a retry keeps the mined rows and appends the rebuilt tail.
  const [order, setOrder] = useState<RemoveOrder | null>(null);
  // Set when a run ended with value still in the plan: the preview then says so and lists what clears it.
  const [remaining, setRemaining] = useState<FreshPlan | null>(null);
  // Set when a `closePlan` paid everything out but PARKED the plan (a buy page was open): the deferred view says so.
  const [parked, setParked] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const onDoneRef = useRef<(hash?: Hash) => void>(() => {});
  const seq = useTxSequence((hash) => onDoneRef.current(hash));

  // The row's menu entry stays disabled while this runs; released on unmount whatever the state.
  useEffect(() => {
    onBusy?.(seq.running);
  }, [seq.running, onBusy]);
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => () => onBusyRef.current?.(false), []);

  /**
   * Did the run take the plan out of the index? For the sequence that is whether `prunePlan` was sent; for
   * `closePlan` it is the `unindexed` flag of the `PlanClosed` it emitted (the epoch may have ended between
   * the read and the mine). Falls back to the build-time answer when the receipt cannot be read.
   */
  const unindexedBy = async (o: RemoveOrder, hash?: Hash): Promise<boolean> => {
    if (o.kind !== "close" || !hash || !client) return o.prune === "sent";
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      const closed = parseEventLogs({ abi: PlanVaultAbi, eventName: "PlanClosed", logs: receipt.logs, args: { planId: p.planId } });
      return closed.length > 0 ? closed[closed.length - 1].args.unindexed : o.prune === "sent";
    } catch {
      return o.prune === "sent";
    }
  };

  /**
   * After the last step: trust the chain, not the sequence. The plan is removed only when `getPlan` shows
   * `usdgIdle == stockAccrued == boostShares == 0` AND it left the index; empty but still listed → "Finish
   * delete" (a close that parked the plan keeps its row too, so the menu can finish the delete); anything left →
   * preview with the remainder. A failed read keeps the dialog open.
   */
  const verify = async (hash?: Hash) => {
    setVerifying(true);
    const f = await readFresh();
    const unindexed = order ? await unindexedBy(order, hash) : false;
    setVerifying(false);
    seq.reset();
    if (!f) {
      setPhase("preview");
      toast({ kind: "warn", title: "Could not confirm the plan's state — check the row before trying again." });
      return;
    }
    if (!isEmptyPlan(f.plan)) {
      setRemaining(f.plan);
      setPhase("preview");
      return;
    }
    if (unindexed) {
      toast({ kind: "ok", title: "Plan removed", hash });
      onRemoved();
      onClose();
      return;
    }
    if (order?.kind === "close" && order.steps.length > 0) {
      // Funds are out and the plan is parked (paused, still indexed) in the vault. Its row stays listed as an
      // empty paused plan so "Finish delete" is reachable from the menu after this dialog closes.
      setParked(true);
    }
    setPhase("deferred");
  };
  onDoneRef.current = (hash) => void verify(hash);

  const start = (o: RemoveOrder) => {
    // Nothing to send but a deferred prune: the plan is already empty, only the delete waits.
    if (o.steps.length === 0) {
      setPhase("deferred");
      return;
    }
    setOrder(o);
    setRemaining(null);
    setPhase("flow");
    void seq.run(o.steps);
  };
  // An already-empty plan opened while a buy runs goes straight to "Finish delete".
  useEffect(() => {
    if (phase === "preview" && preview && preview.steps.length === 0 && !remaining) setPhase("deferred");
  }, [phase, preview, remaining]);

  const failedAt = seq.steps.findIndex((s) => s.phase === "error");
  const failed = failedAt >= 0 ? seq.steps[failedAt] : undefined;
  /** Replaces the flow from the failed step with a tail rebuilt from a fresh read and resumes there. */
  const resumeWith = async (build: (f: FreshRead) => RemoveOrder) => {
    if (failedAt < 0 || !order) return;
    const f = await readFresh();
    if (!f) {
      toast({ kind: "error", title: "Could not re-read the plan. Nothing was sent." });
      return;
    }
    const o = build(f);
    setOrder({ ...o, flow: [...order.flow.slice(0, failedAt), ...o.flow] });
    return seq.retry(o.steps);
  };
  /**
   * "Try again": the tail is rebuilt from a fresh read, never re-run from the click-time snapshot. A failed
   * `closePlan` is retried AS a close (the step-by-step fallback is its own, explicit offer next to it).
   */
  const retry = async () => {
    if (seq.waiting) return seq.retry();
    return resumeWith((f) => orderFor(f, failed?.label === STEP_CLOSE && mode === "auto" ? "close" : mode));
  };
  /** The fallback after a failed close: the same work as single legs, from here on and for any later retry. */
  const continueStepwise = async () => {
    setMode("sequence");
    return resumeWith((f) => orderFor(f, "sequence"));
  };
  /** Morpho short of liquidity: move only the part that is not lent out, keep the rest for later. */
  const withdrawAvailable = async () => {
    if (failedAt < 0 || !order) return;
    const f = await readFresh();
    if (!f || f.plan.usdgIdle === 0n) return;
    const o = buildPartialWithdraw(p.vault, p.planId, f.plan.usdgIdle, wdFee);
    setOrder({ ...o, flow: [...order.flow.slice(0, failedAt), ...o.flow] });
    return seq.retry(o.steps);
  };
  const finishDelete = async () => {
    const f = await readFresh();
    if (!f) return;
    if (!isEmptyPlan(f.plan)) {
      setRemaining(f.plan);
      setPhase("preview");
      return;
    }
    start(orderFor(f));
  };

  // While the prune is deferred, watch for the buy to finish so "Finish delete" lights up on its own.
  const pendingPoll = useReadContract({
    address: p.vault,
    abi: PlanVaultAbi,
    functionName: "isEpochPending",
    args: [p.stock],
    query: { enabled: phase === "deferred", refetchInterval: 15_000 },
  });
  const settled = pendingPoll.data === false;

  /* ---- flow: the sequence, non-closable while running -------------------- */
  if (phase === "flow" && order) {
    // Only meaningful once the USDG is out (or there was none): the funds legs run before the prune.
    const fundsOut = order.withdrawIndex < 0 || seq.steps[order.withdrawIndex]?.phase === "done";
    const epochBusy = failed?.errorName === "EpochInProgress" && fundsOut;
    // A close that reverted (not one the user declined in the wallet): nothing moved, offer the single legs.
    const closeFailed = !!failed && failed.label === STEP_CLOSE && failed.error !== REJECTED_COPY;
    // The unboost / full withdrawal / close is the leg Morpho illiquidity can block; offer the idle part alone.
    const liquidity =
      !!failed && !epochBusy && (failed.label === STEP_UNBOOST || failed.label === STEP_WITHDRAW || failed.label === STEP_CLOSE) && !!fresh?.plan.boosted && (fresh?.plan.usdgIdle ?? 0n) > 0n;
    return (
      <TxFlowDialog
        open
        titles={{ running: "Withdrawing & removing", done: "All steps confirmed", error: "Not finished" }}
        summary={
          epochBusy ? (
            <Notice kind="warn">
              A {symbol} buy is running right now, so the plan cannot be deleted yet. {order.withdrawIndex < 0 ? "Nothing is left in it" : "Your funds are out"}; try again in a few minutes, or close
              this and finish later from the plan&apos;s menu.
            </Notice>
          ) : closeFailed ? (
            <Notice kind="warn">
              <span className="flex flex-col gap-2">
                <span>
                  The one-transaction close did not go through{failed?.error ? ` — ${failed.error}` : ""}. Nothing moved. You can do the same thing step by step instead ({stepwiseCount}{" "}
                  separate {stepwiseCount === 1 ? "confirmation" : "confirmations"}), or try the single transaction again. {STEPWISE_COPY}
                  {liquidity ? ` ${fmtUsd(fresh!.plan.boostValue)} of this plan is lent on Morpho Blue; when the market is short of liquidity, only the ${fmtUsd(fresh!.plan.usdgIdle)} that is not lent out can move now.` : ""}
                </span>
                <span className="flex flex-wrap gap-2">
                  <button type="button" className="btn-secondary btn-xs" onClick={() => void continueStepwise()}>
                    Continue step by step
                  </button>
                  {liquidity && (
                    <button type="button" className="btn-secondary btn-xs" onClick={() => void withdrawAvailable()}>
                      Withdraw available part
                    </button>
                  )}
                </span>
              </span>
            </Notice>
          ) : liquidity ? (
            <Notice kind="warn">
              <span className="flex flex-col gap-2">
                <span>
                  {fmtUsd(fresh!.plan.boostValue)} of this plan is lent on Morpho Blue; when the market is short of liquidity that step fails and nothing moves. You can withdraw the{" "}
                  {fmtUsd(fresh!.plan.usdgIdle)} that is not lent out now and try the rest later.
                </span>
                <button type="button" className="btn-secondary btn-xs self-start" onClick={() => void withdrawAvailable()}>
                  Withdraw available part
                </button>
              </span>
            </Notice>
          ) : undefined
        }
        flow={order.flow}
        seq={{ ...seq, retry }}
        onClose={() => {
          seq.reset();
          setPhase("preview");
          void readFresh();
        }}
        doneActions={
          verifying ? (
            <p className="flex items-center justify-center gap-2 text-center text-[11.5px] text-ink-3">
              <Spinner /> Checking the plan on chain…
            </p>
          ) : undefined
        }
      />
    );
  }

  /* ---- deferred: empty, the delete waits for the buy to finish -------------- */
  if (phase === "deferred") {
    return (
      <Modal open onClose={onClose} title={title}>
        <div className="space-y-4">
          {parked ? (
            <>
              <Notice kind="ok">Your funds are out of the plan.</Notice>
              <p className="text-[13px] leading-relaxed text-ink-2">
                A {symbol} buy was running when the plan closed, so the vault kept the empty plan paused instead of dropping it; it will not buy again. Once the buy has finished, one more
                confirmation deletes it. Until then it stays in My plans as an empty, paused plan. Closing this is safe: you can finish from the plan&apos;s menu at any time.
              </p>
            </>
          ) : (
            <>
              {settled ? (
                <Notice kind="ok">The {symbol} buy has finished. One more confirmation deletes the empty plan.</Notice>
              ) : (
                <Notice kind="warn">
                  A {symbol} buy is running right now, so the empty plan cannot be deleted yet. {DEFER_COPY}.
                </Notice>
              )}
              <p className="text-[13px] leading-relaxed text-ink-2">
                Nothing is left in the plan. The delete needs one more confirmation{settled ? "" : " once the buy has finished"}; until then the plan stays listed as “Needs funds”. Closing this is
                safe — you can finish from the plan&apos;s menu at any time.
              </p>
            </>
          )}
          <button type="button" className="btn-primary h-10 w-full" disabled={!settled} onClick={() => void finishDelete()}>
            {settled ? (
              "Finish delete · 1 confirmation"
            ) : (
              <>
                <Spinner /> Waiting for the buy to finish…
              </>
            )}
          </button>
          <button type="button" className="btn-ghost w-full" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }

  /* ---- preview: what will be sent, from the fresh read ---------------------- */
  const recipient = fresh?.plan.recipient ?? p.recipient;
  const n = preview?.steps.length ?? 0;
  const oneTx = preview?.kind === "close";
  const probe = fresh?.close;
  return (
    <Modal open onClose={onClose} title={title}>
      <div className="space-y-4">
        {remaining && (
          <Notice kind="warn">
            Still in the plan after the last run:{" "}
            {[
              remaining.usdgIdle + remaining.boostValue > 0n ? fmtUsd(remaining.usdgIdle + remaining.boostValue) : "",
              remaining.stockAccrued > 0n ? `${fmtUnits(remaining.stockAccrued, stockDecimals, 4)} ${symbol}` : "",
              remaining.boostShares > 0n && remaining.boostValue === 0n ? "a boosted residue" : "",
            ]
              .filter(Boolean)
              .join(" · ")}
            . The steps below clear it.
          </Notice>
        )}
        <p className="text-[13px] leading-relaxed text-ink-2">
          Withdraws everything in the plan and deletes it{oneTx ? " in one transaction" : ""}. USDG goes to the wallet you sign with, minus the {fmtBps(wdFee)} withdrawal fee; {symbol} goes to{" "}
          {recipientCopy(recipient, address)}
          {claimFee > 0 ? `, minus the ${fmtBps(claimFee)} claim fee (free for $DCA holders)` : ""}. Deleting cannot be undone.
        </p>
        {!fresh && !readError && (
          <p className="flex items-center gap-2 text-[13px] text-ink-2">
            <Spinner /> Checking the plan on chain…
          </p>
        )}
        {readError && (
          <Notice kind="error">
            <span className="flex items-center justify-between gap-3">
              <span>Could not read the plan: {readError}</span>
              <button type="button" className="btn-secondary btn-xs shrink-0" onClick={() => void readFresh()}>
                Retry
              </button>
            </span>
          </Notice>
        )}
        {/* The fallback is never silent: when the one-transaction close is off the table, the preview says why. */}
        {preview && probe && !probe.available && mode === "auto" && n > 0 && (
          <Notice kind={probe.kind === "missing" ? "info" : "warn"}>
            {probe.kind === "missing"
              ? `This vault has no one-transaction close, so the plan is emptied and removed step by step: ${n} ${n === 1 ? "confirmation" : "confirmations"}, one after the other. `
              : `The one-transaction close would fail right now (${probe.reason}), so this uses the single steps instead — ${n} ${n === 1 ? "confirmation" : "confirmations"}. `}
            {STEPWISE_COPY}
          </Notice>
        )}
        {preview && fresh?.epochPending && n > 0 && (
          <Notice kind="warn">
            A {symbol} buy is running right now.{" "}
            {oneTx
              ? "Your funds come out immediately; the empty plan is paused and dropped from the vault with one more confirmation once the buy has finished."
              : "Your funds come out now; the delete itself waits until the buy has finished (“Finish delete”, one more confirmation)."}
          </Notice>
        )}
        {preview && (
          <ol className="space-y-2">
            {preview.flow.map((f, i) => {
              // A held-back row (the delete that waits for a running buy) is listed but not sent in this run.
              const held = f.deferred ?? f.skipped;
              return (
                <li key={f.label} className={`flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2 text-[13px] ${held ? "text-ink-3" : ""}`}>
                  <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${held ? "bg-surface-3 text-ink-3" : "bg-surface-4 text-ink-2"}`}>
                    {held ? "–" : i + 1}
                  </span>
                  <span className={held ? "text-ink-3" : "text-ink"}>{f.label}</span>
                  <span className="ml-auto num text-right text-[12px] text-ink-3">{held ?? f.trailing}</span>
                </li>
              );
            })}
          </ol>
        )}
        {fresh?.plan.boosted && fresh.plan.boostValue > 0n && (
          <p className="text-[12px] text-ink-3">
            {fmtUsd(fresh.plan.boostValue)} of this plan is lent on Morpho Blue and is pulled back first, earnings included. If the market is short of liquidity{" "}
            {oneTx ? "the transaction fails and nothing moves — you can then fall back to separate steps and" : "that step fails and nothing moves — you can then"} withdraw the part that is not
            lent out and try the rest later.
          </p>
        )}
        <button type="button" className="btn-primary h-10 w-full bg-bad text-ink hover:bg-bad/90" disabled={!preview || n === 0} onClick={() => preview && start(preview)}>
          {`Withdraw & remove · ${n} ${n === 1 ? "confirmation" : "confirmations"}`}
        </button>
        {/* The other path is always one click away, so the choice is the user's, not the probe's alone. */}
        {preview && probe?.available && n > 0 && (
          <button type="button" className="btn-ghost w-full text-[12px] text-ink-2" onClick={() => setMode(mode === "auto" ? "sequence" : "auto")}>
            {mode === "auto" ? `Use separate steps instead (${stepwiseCount} ${stepwiseCount === 1 ? "confirmation" : "confirmations"})` : "Use one transaction instead"}
          </button>
        )}
        <p className="text-[11px] text-ink-3">
          Withdrawals carry a {fmtBps(wdFee)} fee and claims {fmtBps(claimFee)} (free for $DCA holders).{" "}
          {oneTx ? "Everything happens in one transaction: if it cannot complete, nothing moves and you can fall back to separate steps." : `Each step is a separate confirmation in your wallet; if one fails, nothing after it is sent and you can pick up where it stopped.`}
        </p>
      </div>
    </Modal>
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
