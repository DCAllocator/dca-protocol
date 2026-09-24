"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { formatEther, formatUnits, parseEther, parseEventLogs, parseUnits, toFunctionSelector, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useReadContract, useTransactionReceipt } from "wagmi";
import {
  useDirectory,
  usePositions,
  useStocks,
  useBuyable,
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
  isDcaToken,
  type Directory,
  type Position,
  type VaultInfo,
} from "@/hooks/useProtocol";
import { useTxSequence } from "@/hooks/useTx";
import { usePlanIndex, planKey } from "@/hooks/useLogs";
import { PlanVaultAbi, ERC20Abi } from "@/abi";
import { PageHeader, Card, Notice, Spinner, Dot, Empty, Modal, Menu, Slider, AmountInput, Segmented, Countdown, SearchInput, SortTh, Icon, Tip } from "@/components/ui";
import { ConnectButton } from "@/components/ConnectButton";
import { useToast } from "@/components/Toast";
import { FlowTimeline, TxFlowDialog } from "@/components/app/TxFlowDialog";
import { AddToWalletButton } from "@/components/app/AddToWalletButton";
import { PlanFlowSummary } from "@/components/app/PlanFlowSummary";
import { BoostCelebration, BoostPowerDown } from "@/components/app/BoostCelebration";
import { FormSummary, FundsNote, type SummaryRow } from "@/components/app/plans/FormParts";
import { ChoiceAvatar, choiceLabel } from "@/components/app/create/fields";
import { fmtUsd, fmtUnits, fmtBps, fmtPct, feeOf, valueOf } from "@/lib/format";
import { VAULT_META, VAULT_KINDS, USDG_DECIMALS, BOOST, type VaultKind } from "@/lib/config";
import { describeTxError, REJECTED_COPY, STILL_PENDING_COPY } from "@/lib/txErrors";
import { visiblePositions } from "@/lib/visiblePositions";
import { USDG_DUST, coverageCopy, depositFor, depositShortCopy, fundsLevel, rowFundsCopy, withdrawLeftCopy } from "@/lib/planFunds";
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
import {
  buildBoostOrder,
  buildClaimOrder,
  buildDepositOrder,
  buildPauseOrder,
  buildUnboostOrder,
  buildWithdrawOrder,
  boostLent,
  planErrorHint,
  planFlowDoneLine,
  planFlowTitles,
  planOutcomeLine,
  settledWithdraw,
  type BoostOrder,
  type ClaimOrder,
  type DepositOrder,
  type PauseOrder,
  type PlanOrder,
  type PlanRef,
  type UnboostOrder,
  type WithdrawOrder,
} from "@/lib/planSteps";

const keyOf = (p: Position) => planKey(p.vault, p.planId);
/**
 * An open dialog remembers the plan by KEY and resolves the live `Position` on every render, so balances that
 * change while it is open (a mined step, the positions poll) reach the form; `plan` is the click-time snapshot,
 * used only until the live list has the key (or after the plan left it).
 */
type Dialog = { kind: "deposit" | "withdraw" | "remove"; key: string; plan: Position } | null;
/** A one-click row action (claim, boost, unboost, pause, resume) being followed in its flow dialog: the plan's key and the order as sent. */
type RowFlow = { key: string; planLabel: string; order: ClaimOrder | BoostOrder | UnboostOrder | PauseOrder } | null;

/** "Daily · #3": how a flow dialog names the plan. */
const planLabelOf = (kind: VaultKind | undefined, planId: bigint) => `${kind ? VAULT_META[kind].label : "?"} · #${planId.toString()}`;

/**
 * How a plan's stock is named everywhere on the page: our own token (told apart by address, `isDcaToken`) as "$DCA" /
 * "DCA Token" under our mark, the way create names it (`choiceLabel`); a Stock Token by its registry ticker.
 */
const stockLabelOf = (dir: Directory | undefined, address: Address, registrySymbol: string | undefined) =>
  choiceLabel({ address, symbol: registrySymbol ?? "?" }, isDcaToken(dir, address) ? address : undefined);

type SortKey = "plan" | "per" | "balance" | "stock" | "next" | "status";
type Sort = { key: SortKey; dir: 1 | -1 };

export default function Plans() {
  const { address } = useAccount();
  const { dir, vaults, configured } = useDirectory();
  const { byAddress } = useStocks(dir?.registry);
  // Plans on a stock their vault never buys (no keeper job, or no price feed where one is required) are flagged, not hidden.
  const { isBuyable } = useBuyable();
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

  /*
   * Claim, Boost / Unboost and Pause / Resume: one confirmation each, sent straight from the row's click (never from an effect, so a
   * dev double-mount cannot send twice) and followed in a TxFlowDialog like every other write. One at a time: the
   * dialog cannot close while its step is in flight and the row buttons check `rowSeq.running`.
   */
  const [rowFlow, setRowFlow] = useState<RowFlow>(null);
  const rowSeq = useTxSequence(() => refresh());
  // The plan whose boost just confirmed: its row plays the "just boosted" flash once the dialog closes over it.
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const startRowFlow = (key: string, planLabel: string, order: NonNullable<RowFlow>["order"]) => {
    if (rowSeq.running) return;
    setFlashKey(null);
    setRowFlow({ key, planLabel, order });
    void rowSeq.run(order.steps);
  };
  const closeRowFlow = () => {
    if (rowFlow?.order.kind === "boost" && rowSeq.done) setFlashKey(rowFlow.key);
    // Closed while still waiting on the network: nothing more is sent; the positions poll picks it up when it lands.
    if (rowSeq.waiting) refresh();
    setRowFlow(null);
    rowSeq.reset();
  };
  // The row clears its flash on the flash's own animationend (which fires with reduced motion too). This backstop covers
  // a row that never plays it: filtered out of the table, or a positions refetch that has not shown the boost in time.
  useEffect(() => {
    if (!flashKey) return;
    const t = window.setTimeout(() => setFlashKey(null), 6000);
    return () => window.clearTimeout(t);
  }, [flashKey]);

  // A removed plan is one the vault unindexed and that holds nothing (`visiblePositions` never hides value).
  // A later deposit re-indexes it, so it reappears on its own.
  const positions = useMemo(() => visiblePositions(all, index.data, hidden, keyOf), [all, index.data, hidden]);
  const livePlan = dialog ? (all.find((p) => keyOf(p) === dialog.key) ?? dialog.plan) : null;

  // `symbol` / `name` / `dca`: how the page names the stock (`stockLabelOf`); `tokenSymbol`: the registry's ticker, for the wallet.
  type Row = {
    p: Position;
    kind?: VaultKind;
    info?: VaultInfo;
    symbol: string;
    name: string;
    dca: boolean;
    tokenSymbol: string;
    decimals: number;
    stockUsd?: bigint;
    bought?: boolean;
    active: boolean;
  };
  const rows = useMemo<Row[]>(
    () =>
      positions.map((p) => {
        const kind = kindOf(vaults, p.vault);
        const stock = byAddress[p.stock.toLowerCase()];
        const label = stockLabelOf(dir, p.stock, stock?.symbol);
        const decimals = stock?.decimals ?? 18;
        const bought = isBuyable(p.vault, p.stock);
        return {
          p,
          kind,
          info: kind ? byKind[kind] : undefined,
          symbol: label.symbol,
          name: label.name,
          dca: label.dca,
          tokenSymbol: stock?.symbol ?? label.symbol,
          decimals,
          stockUsd: p.stockAccrued === 0n ? 0n : valueOf(p.stockAccrued, prices[p.stock.toLowerCase()], decimals),
          bought,
          active: !p.paused && planBalance(p) > 0n && bought !== false,
        };
      }),
    [positions, vaults, dir, byAddress, byKind, prices, isBuyable],
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
          return r.bought === false ? 3 : r.p.paused ? 2 : r.active ? 0 : 1;
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
  // Running plans with nothing left, or under a cent: the rows `rowFundsCopy` warns on (and washes amber); the Plans
  // tile counts them.
  const outOfFunds = rows.filter((r) => {
    if (r.bought === false || r.p.paused || removing.has(keyOf(r.p))) return false;
    const level = fundsLevel(planBalance(r.p), r.p.amountPerEpoch);
    return level === "empty" || level === "dust";
  }).length;
  const cols = 7;
  const dialogStock = livePlan ? stockLabelOf(dir, livePlan.stock, byAddress[livePlan.stock.toLowerCase()]?.symbol) : undefined;

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
            {outOfFunds > 0 && (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
                {/* the rows' own mark, so the tile reads as their legend (an amber dot is Paused in the Status column) */}
                <Icon name="info" size={12} className="shrink-0 text-warn" />
                {outOfFunds} out of funds
              </span>
            )}
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
        <div className="tbl-scroll overflow-x-auto">
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
                sorted.map((r) => {
                  const key = keyOf(r.p);
                  const ref: PlanRef = { vault: r.p.vault, planId: r.p.planId, symbol: r.symbol, stockDecimals: r.decimals, name: r.name, dca: r.dca };
                  const planLabel = planLabelOf(r.kind, r.p.planId);
                  // The claim fee is waived while the owner holds the auto-distribute amount of $DCA (the vault's `_perks`).
                  const perk = user.dca !== undefined && r.info?.autoDistributeThreshold !== undefined && user.dca >= r.info.autoDistributeThreshold;
                  return (
                    <PlanRow
                      key={key}
                      planKey={key}
                      cols={cols}
                      p={r.p}
                      kind={r.kind}
                      info={r.info}
                      apy={apyOf(r.info?.boostStrategy)}
                      symbol={r.symbol}
                      name={r.name}
                      dca={r.dca}
                      tokenSymbol={r.tokenSymbol}
                      stockDecimals={r.decimals}
                      stockUsd={r.stockUsd}
                      bought={r.bought}
                      removing={removing.has(key)}
                      flowBusy={rowSeq.running}
                      flash={flashKey === key}
                      onFlashEnd={() => setFlashKey((k) => (k === key ? null : k))}
                      // One form at a time: a row button reached behind an open dialog (keyboard) does not swap its plan.
                      onDialog={(d) => setDialog((cur) => cur ?? { kind: d, key, plan: r.p })}
                      onClaim={() =>
                        startRowFlow(
                          key,
                          planLabel,
                          buildClaimOrder({
                            ref,
                            stock: r.p.stock,
                            amount: r.p.stockAccrued,
                            usd: r.stockUsd,
                            feeBps: perk ? 0 : (r.info?.fees?.claimFeeBps ?? 0),
                            perk,
                            perkThreshold: r.info?.autoDistributeThreshold,
                            recipient: r.p.recipient,
                            signer: address,
                          }),
                        )
                      }
                      onBoost={() =>
                        startRowFlow(
                          key,
                          planLabel,
                          r.p.boosted
                            ? buildUnboostOrder({ ref, boostValue: r.p.boostValue, earned: boostEarnings(r.p) })
                            : buildBoostOrder({ ref, usdgIdle: r.p.usdgIdle, apy: apyOf(r.info?.boostStrategy) }),
                        )
                      }
                      onPause={() =>
                        startRowFlow(
                          key,
                          planLabel,
                          buildPauseOrder({
                            ref,
                            pause: !r.p.paused,
                            balance: planBalance(r.p),
                            boosted: r.p.boosted,
                            perBuy: r.p.amountPerEpoch,
                            nextBuy: r.info?.nextEpochStart,
                          }),
                        )
                      }
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {dialog && livePlan && dialogStock && dir && (
        <PlanDialog
          // A fresh form per plan and action: nothing typed for one plan carries over to another.
          key={`${dialog.kind}:${dialog.key}`}
          dialog={{ ...dialog, plan: livePlan }}
          symbol={dialogStock.symbol}
          name={dialogStock.name}
          dca={dialogStock.dca}
          stockDecimals={byAddress[livePlan.stock.toLowerCase()]?.decimals ?? 18}
          info={(() => {
            const k = kindOf(vaults, livePlan.vault);
            return k ? byKind[k] : undefined;
          })()}
          bought={isBuyable(livePlan.vault, livePlan.stock)}
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

      {rowFlow && (
        <PlanFlowDialog
          order={rowFlow.order}
          planLabel={rowFlow.planLabel}
          seq={rowSeq}
          onClose={closeRowFlow}
          extraDoneActions={
            rowFlow.order.kind === "claim" && rowFlow.order.toSelf ? (
              <AddToWalletButton
                address={rowFlow.order.stock}
                symbol={byAddress[rowFlow.order.stock.toLowerCase()]?.symbol ?? rowFlow.order.symbol}
                decimals={rowFlow.order.stockDecimals}
                className="justify-self-center"
              />
            ) : undefined
          }
        />
      )}
    </>
  );
}

/**
 * The step-by-step dialog for one single-plan order (deposit, withdraw, claim, boost, unboost): the order's own
 * headings, the summary tile, its rows, and a "Done" that closes it. A confirmed boost lands on the celebration.
 * It can be closed while a sent step is still waiting on the network — a toast keeps the hash, and the caller must
 * then close the whole flow (not reopen a form that could resend the same amount).
 */
function PlanFlowDialog({
  order,
  planLabel,
  seq,
  onClose,
  extraDoneActions,
}: {
  order: PlanOrder;
  planLabel: string;
  seq: ReturnType<typeof useTxSequence>;
  onClose: () => void;
  extraDoneActions?: ReactNode;
}) {
  // Once done, the last receipt's events give the confirmed figures for the line under the heading.
  const lastHash = seq.done ? seq.steps.at(-1)?.hash : undefined;
  const receipt = useTransactionReceipt({ hash: lastHash, query: { enabled: !!lastHash } });
  const outcome = receipt.data ? planOutcomeLine(order, receipt.data.logs) : undefined;
  // Boost: the hero's line shows what the receipt says was lent (no BoostDeposited: nothing was idle), and the
  // click-time idle balance until the receipt is read.
  const boost = order.kind === "boost" ? order : undefined;
  const lent = boost ? (receipt.data ? (boostLent(boost, receipt.data.logs) ?? 0n) : boost.lend) : 0n;
  // Withdraw everything: the MAX sentinel pays the balance at execution, so once the receipt is read the tile and the
  // step show what the vault paid (a boosted plan earns after the click); the click-time estimate until then.
  const shown = order.kind === "withdraw" && order.all && receipt.data ? settledWithdraw(order, receipt.data.logs) : order;
  const failed = seq.steps.find((s) => s.phase === "error");
  const hint = failed ? planErrorHint(order, failed.errorName) : undefined;
  const { toast } = useToast();
  const close = () => {
    if (seq.waiting) toast({ kind: "warn", title: STILL_PENDING_COPY, hash: seq.steps[seq.step]?.hash });
    onClose();
  };
  return (
    <TxFlowDialog
      open
      // Only once the step that does the work is the one waiting: a deposit still waiting on its approval stays open.
      closableWhileWaiting={seq.step >= seq.total - 1}
      announceReady={!lastHash || receipt.isFetched || receipt.isError}
      titles={planFlowTitles(order)}
      subtitle={outcome ?? planFlowDoneLine(order)}
      summary={
        <>
          <PlanFlowSummary order={shown} planLabel={planLabel} />
          {hint && <Notice kind="warn">{hint}</Notice>}
        </>
      }
      flow={shown.flow}
      seq={seq}
      onClose={close}
      hero={boost ? (h) => <BoostCelebration {...h} apy={boost.apy} amount={lent > 0n ? fmtUsd(lent) : undefined} /> : undefined}
      doneMark={order.kind === "unboost" ? <BoostPowerDown /> : undefined}
      doneActions={
        <div className="grid gap-2">
          <button type="button" className="btn-primary btn-lg w-full rounded-xl" onClick={close}>
            Done
          </button>
          {extraDoneActions}
        </div>
      }
    />
  );
}

/* ------------------------------------------------------------------ */
/* Row                                                                  */
/* ------------------------------------------------------------------ */

function PlanRow({
  planKey,
  cols,
  p,
  kind,
  info,
  apy,
  symbol,
  name,
  dca,
  tokenSymbol,
  stockDecimals,
  stockUsd,
  bought,
  removing,
  flowBusy,
  flash,
  onFlashEnd,
  onDialog,
  onClaim,
  onBoost,
  onPause,
}: {
  /** The plan's key, on the row (`data-plan`) so focus can come back to it once a dialog closes. */
  planKey: string;
  /** Columns of the table, for the notice row under a plan that is short of funds. */
  cols: number;
  p: Position;
  kind?: VaultKind;
  info?: VaultInfo;
  apy?: number;
  /** How the page names the stock: "$DCA" / "DCA Token" for our own token (`dca`), the ticker otherwise. */
  symbol: string;
  name: string;
  dca: boolean;
  /** The registry's ticker, which the wallet is given. */
  tokenSymbol: string;
  stockDecimals: number;
  stockUsd?: bigint;
  /** false: the plan's vault never buys its stock (see `useBuyable`), so it spends nothing; undefined while loading. */
  bought?: boolean;
  /** This plan's withdraw-and-remove sequence is running: its menu entry is disabled so a second one cannot start. */
  removing?: boolean;
  /** A claim / boost / unboost / pause flow is in flight (any row): one wallet, one nonce, so this row's writes wait. */
  flowBusy?: boolean;
  /** This plan's boost just confirmed: the row plays its one-shot "just boosted" flash. */
  flash?: boolean;
  onFlashEnd?: () => void;
  onDialog: (d: "deposit" | "withdraw" | "remove") => void;
  /** Claim, Boost / Unboost and Pause / Resume each open a flow dialog that sends from this click. */
  onClaim: () => void;
  onBoost: () => void;
  onPause: () => void;
}) {
  const balance = planBalance(p);
  const funded = balance > 0n;
  const earned = boostEarnings(p);
  const canBoost = boostAvailable(info);
  const notBought = bought === false;
  const status = notBought
    ? (["Not being bought", "bad"] as const)
    : p.paused
      ? (["Paused", "warn"] as const)
      : funded
        ? (["Active", "good"] as const)
        : (["Needs funds", "muted"] as const);
  const locked = !!flowBusy;
  // The flash waits for the refetched row to show the boost, so it never plays on a row that is not yet highlighted.
  const flashing = !!flash && p.boosted;
  // Less than one buy left: a line under the row says what the next buy does, with Deposit beside it. Not for a plan
  // being removed, nor for one that is never bought (its status already says it spends nothing). A warning (out of
  // funds, or down to dust) also washes the row and its line amber: an indicator, not an alert.
  const fundsNote = notBought || removing ? undefined : rowFundsCopy({ balance, perBuy: p.amountPerEpoch, paused: p.paused });
  const noteTone = fundsNote?.tone === "warn" ? "note-warn" : "";

  return (
    <>
      <tr
        data-plan={planKey}
        className={`${p.boosted ? "boost-row" : ""} ${flashing ? "boost-row-flash" : ""} ${fundsNote ? "has-note" : ""} ${noteTone}`}
        onAnimationEnd={(e) => {
          if (flashing && e.animationName === "boost-row-flash") onFlashEnd?.();
        }}
      >
        <td>
          <span className="flex items-center gap-3">
            <span className="relative inline-flex shrink-0">
              <ChoiceAvatar symbol={symbol} dca={dca} size={30} />
              {p.boosted && (
                <span className="boost-badge" aria-hidden>
                  <Icon name="bolt" size={9} />
                </span>
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-medium text-ink">
                {symbol} <span className="font-normal text-ink-2">{name !== symbol ? name : ""}</span>
                {p.boosted && <span className="sr-only">, {BOOST.chip.toLowerCase()}</span>}
              </span>
              <span className="block text-[12px] text-ink-2">
                {kind ? VAULT_META[kind].label : "?"} · #{p.planId.toString()}
              </span>
              <AddToWalletButton address={p.stock} symbol={tokenSymbol} decimals={stockDecimals} className="mt-0.5" />
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
          {p.paused || !funded || notBought ? <span className="text-ink-3">—</span> : <Countdown target={info?.nextEpochStart} className="text-ink" />}
        </td>
        <td>
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink">
            <Dot tone={status[1]} />
            {status[0]}
            {notBought && (
              <Tip
                text={`${symbol} isn't available for ${kind ? VAULT_META[kind].label.toLowerCase() : "this frequency's"} plans, so this plan never buys and spends nothing. Your balance stays in the plan: withdraw it or remove the plan.`}
              />
            )}
            {/* The same chip the create flow's summary gives a boosted plan; decorative (the ticker cell says it for screen readers). */}
            {p.boosted && (
              <span className="chip-lime ml-1 gap-1" aria-hidden>
                <Icon name="bolt" size={11} />
                {BOOST.chip}
              </span>
            )}
          </span>
        </td>
        <td className="stick-r text-right">
          <span className="inline-flex items-center justify-end gap-0.5">
            <button type="button" data-action="deposit" className="btn-secondary btn-xs px-2.5" disabled={locked || notBought} onClick={() => onDialog("deposit")}>
              Deposit
            </button>
            <button type="button" className="btn-ghost btn-xs px-2.5" disabled={!funded || locked} onClick={() => onDialog("withdraw")}>
              Withdraw
            </button>
            <button type="button" className="btn-ghost btn-xs px-2.5" disabled={p.stockAccrued === 0n || locked} onClick={onClaim}>
              Claim
            </button>
            {p.boosted ? (
              <button type="button" className="btn-ghost btn-xs px-2.5" disabled={locked} onClick={onBoost} title={`Pull the boosted balance back into the plan (${fmtUsd(p.boostValue)}, earnings included)`}>
                {BOOST.off}
              </button>
            ) : (
              <button
                type="button"
                className="btn-secondary btn-xs gap-1 border-lime/40 px-2.5 text-lime hover:border-lime hover:bg-lime/10"
                disabled={!canBoost || locked}
                onClick={onBoost}
                title={canBoost ? `Lend the idle balance on Morpho Blue at ${fmtPct(apy, true)} APY until each buy` : "Boost is not available on this frequency yet"}
              >
                <Icon name="bolt" size={12} />
                {BOOST.on}
                {canBoost && apy !== undefined && <span className="hidden font-normal text-ink-2 2xl:inline">{fmtPct(apy)}</span>}
              </button>
            )}
            <Menu
              items={[
                { label: p.paused ? "Resume plan" : "Pause plan", onClick: onPause, disabled: locked },
                { label: "Withdraw & remove plan", onClick: () => onDialog("remove"), danger: true, disabled: removing },
              ]}
            />
          </span>
        </td>
      </tr>
      {fundsNote && (
        <tr className={`row-note ${noteTone}`}>
          <td colSpan={cols}>
            <div className="row-note-body flex items-start gap-1.5 text-[12px] leading-snug text-ink-2">
              <Icon name="info" size={13} className={`mt-px shrink-0 ${fundsNote.tone === "warn" ? "text-warn" : "text-ink-3"}`} />
              <span>
                {fundsNote.text}{" "}
                <button type="button" className="row-note-action" disabled={locked} onClick={() => onDialog("deposit")}>
                  Deposit
                </button>
              </span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                              */
/* ------------------------------------------------------------------ */

function PlanDialog(props: {
  dialog: NonNullable<Dialog>;
  /** How the page names the stock (`stockLabelOf`): "$DCA" / "DCA Token" for our own token (`dca`). */
  symbol: string;
  name: string;
  dca: boolean;
  stockDecimals: number;
  info?: VaultInfo;
  /** false: the plan's vault never buys its stock (see `useBuyable`), so the forms say nothing about buys. */
  bought?: boolean;
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
  // Back to the row button that opened it once the whole dialog goes (the form's own button is gone by then). When
  // that button is gone too (the note row under a plan short of funds, once a deposit tops it up) or disabled, the
  // plan's own row takes it: its Deposit, else its first enabled button. Keyed per plan, so `dialog.key` is fixed.
  const planKeyOpen = dialog.key;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      if (opener?.isConnected && !opener.matches(":disabled")) {
        opener.focus();
        return;
      }
      const row = document.querySelector<HTMLElement>(`tr[data-plan="${planKeyOpen}"]`);
      (row?.querySelector<HTMLElement>('[data-action="deposit"]:not(:disabled)') ?? row?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
    };
  }, [planKeyOpen]);
  // Each form hosts its own dialogs: the form in a Modal, then — once sent — the step-by-step TxFlowDialog, which
  // cannot be closed while a step is in flight. Remove also reports its in-flight state up through `onBusy` so the
  // row's menu entry stays disabled meanwhile.
  if (dialog.kind === "remove") return <RemoveForm {...props} />;
  if (dialog.kind === "deposit") return <DepositForm {...props} />;
  return <WithdrawForm {...props} />;
}

/** `PlanRef` + "Daily · #3" for the plan a form dialog is open on. */
function planRefOf({ dialog, symbol, name, dca, stockDecimals, info }: Parameters<typeof PlanDialog>[0]): { ref: PlanRef; planLabel: string } {
  const p = dialog.plan;
  return { ref: { vault: p.vault, planId: p.planId, symbol, stockDecimals, name, dca }, planLabel: planLabelOf(info?.kind, p.planId) };
}

const ETH_GAS_RESERVE = parseEther("0.01");
/** Slippage applied to the ETH → USDG conversion quote on deposit. */
const ZAP_SLIPPAGE_BPS = 50n;
const MIN_DEPOSIT_FALLBACK = 10n * 10n ** BigInt(USDG_DECIMALS);

/** "1 confirmation" / "2 confirmations", for the buttons that send. */
const confirmations = (n: number) => `${n} ${n === 1 ? "confirmation" : "confirmations"}`;

function DepositForm(props: Parameters<typeof PlanDialog>[0]) {
  const { dialog, symbol, info, bought, usdg, weth, router, balances, onClose, onChange } = props;
  const p = dialog.plan;
  const { ref, planLabel } = planRefOf(props);
  const { address } = useAccount();
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
  // The order as sent: setting it swaps the form for the flow dialog; clearing it (after a failure) brings the form back.
  const [order, setOrder] = useState<DepositOrder | null>(null);
  const seq = useTxSequence(() => {
    onChange();
    void allowance.refetch();
  });
  const insufficient = !!wei && wei > (pay === "USDG" ? balances.usdg : balances.eth);
  const quoteMissing = pay === "ETH" && !!wei && wei > 0n && quote.data === undefined;
  const ok = !!wei && wei > 0n && !insufficient && !quoteMissing && !tooSmall && !seq.running;

  // What the plan holds once this lands (an estimate for ETH, from the quote) and how far that goes at its per-buy
  // amount. A plan left under one buy is not refused — its next buy spends everything it has — but the form says so.
  const balance = planBalance(p);
  const perBuy = p.amountPerEpoch;
  const credited = pay === "USDG" ? (wei !== undefined ? wei - feeOf(wei, depositFeeBps) : undefined) : quote.data?.amountOut;
  const after = credited !== undefined ? balance + credited : undefined;
  const buys = bought !== false;
  const short = buys && after !== undefined && after < perBuy;
  // The USDG deposit that makes one full buy from here, never under the vault's minimum.
  const shortfall = perBuy > balance ? perBuy - balance : 0n;
  const fullBuy = depositFor(shortfall > minDeposit ? shortfall : minDeposit, depositFeeBps);
  // Paid in ETH: the same, grossed up for the swap's tolerance (the credited floor `tooSmall` checks). The pool's own
  // fee comes on top, so the hint says "a little over".
  const fullBuyEth = depositFor(fullBuy, Number(ZAP_SLIPPAGE_BPS));

  // The steps this deposit sends, drawn the way the flow dialog draws them; the order on screen at the click is the one sent.
  // ETH is swapped to USDG inside depositETH; the quote minus 0.5% is the least the vault may credit.
  const minOut = quote.data ? (quote.data.amountOut * (10_000n - ZAP_SLIPPAGE_BPS)) / 10_000n : 0n;
  const preview =
    wei && wei > 0n
      ? buildDepositOrder({
          ref,
          usdg,
          pay,
          amount: wei,
          needsApproval,
          minUsdgOut: pay === "ETH" ? minOut : undefined,
          toleranceBps: pay === "ETH" ? Number(ZAP_SLIPPAGE_BPS) : undefined,
          depositFeeBps,
          credited,
          balanceBefore: balance,
          boosted: p.boosted,
          vaultName: info?.kind ? `${VAULT_META[info.kind].label.toLowerCase()} vault` : "vault",
        })
      : null;
  const summary: SummaryRow[] = [];
  if (preview) {
    summary.push({ k: "You deposit", v: pay === "USDG" ? fmtUsd(preview.amount) : `${fmtUnits(preview.amount, 18)} ETH` });
    if (depositFeeBps > 0) summary.push({ k: "Deposit fee", v: fmtBps(depositFeeBps) });
    summary.push({ k: "Plan after", v: after !== undefined ? `${pay === "ETH" ? "≈ " : ""}${fmtUsd(after)}` : "…", tone: "strong" });
    if (buys && after !== undefined) summary.push({ k: "Covers", v: `${coverageCopy(after, perBuy)}${p.paused ? " once resumed" : ""}`, tone: short ? "warn" : undefined, words: true });
  }

  const submit = () => {
    if (!preview || seq.running) return;
    setOrder(preview);
    void seq.run(preview.steps);
  };
  // Done closes the whole dialog; after a failure, closing goes back to the form with the amount kept — and a fresh
  // allowance, so an approval that did land is not asked for again.
  const closeFlow = () => {
    // Done, or closed while still waiting on the network: the whole dialog goes, so the amount cannot be sent twice.
    if (seq.done || seq.waiting) {
      if (seq.waiting) onChange();
      return onClose();
    }
    setOrder(null);
    seq.reset();
    void allowance.refetch();
  };

  if (order) return <PlanFlowDialog order={order} planLabel={planLabel} seq={seq} onClose={closeFlow} />;
  return (
    <Modal open onClose={onClose} title={`Deposit · ${symbol} #${p.planId.toString()}`}>
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
            never ETH. The swap has a {fmtBps(Number(ZAP_SLIPPAGE_BPS))} tolerance; if the pool cannot fill it in full, the deposit fails and nothing moves.
          </p>
        )}
        {tooSmall && <Notice kind="error">The smallest deposit is {fmtUsd(minDeposit)}{pay === "ETH" ? " worth of ETH" : ""}.</Notice>}
        {insufficient && <Notice kind="error">Not enough {pay} in your wallet.</Notice>}
        {/* Before an amount is in: how much tops a plan under one buy back up to a full one. */}
        {!preview && buys && balance < perBuy && (
          <p className="text-[12px] text-ink-3">
            {balance === 0n ? "The plan is empty." : `The plan holds ${fmtUsd(balance)} — less than one ${fmtUsd(perBuy)} buy.`}{" "}
            {pay === "USDG" ? (
              <>
                A deposit of <span className="num text-ink-2">{fmtUsd(fullBuy)}</span> or more makes one full buy.
              </>
            ) : (
              <>
                A little over <span className="num text-ink-2">{fmtUsd(fullBuyEth)}</span> worth of ETH makes one full buy, as the swap may credit up to{" "}
                {fmtBps(Number(ZAP_SLIPPAGE_BPS))} less.
              </>
            )}
          </p>
        )}
        {preview && <FormSummary rows={summary} />}
        {short && (
          <FundsNote>
            {depositShortCopy({
              after: after!,
              perBuy,
              paused: p.paused,
              approx: pay === "ETH",
              topUp: pay === "USDG" ? `Deposit ${fmtUsd(fullBuy)} or more for one full buy.` : `About ${fmtUsd(perBuy - after!)} more makes one full buy.`,
            })}
          </FundsNote>
        )}
        {preview && <FlowTimeline flow={preview.flow} />}
        {p.boosted && (
          <p className="flex items-start gap-1.5 text-[12px] text-ink-3">
            <Icon name="bolt" size={12} className="mt-0.5 shrink-0 text-lime" />
            This plan is boosted: the deposit is lent on Morpho Blue as it lands and earns until each buy.
          </p>
        )}
        <button type="button" className="btn-primary h-10 w-full" disabled={!ok} onClick={submit}>
          {preview ? `${needsApproval ? "Approve & deposit" : "Deposit"} · ${confirmations(preview.steps.length)}` : "Enter an amount"}
        </button>
      </div>
    </Modal>
  );
}

function WithdrawForm(props: Parameters<typeof PlanDialog>[0]) {
  const { dialog, symbol, info, bought, onClose, onChange } = props;
  const p = dialog.plan;
  const { ref, planLabel } = planRefOf(props);
  const available = planBalance(p);
  const perBuy = p.amountPerEpoch;
  const [amount, setAmount] = useState("");
  // "Everything": set by MAX or by sliding to the end, dropped as soon as the amount is edited. While it holds, the
  // amount shown follows the live balance (a boosted plan keeps earning while the form is open, and the positions poll
  // brings that in) and the withdrawal goes out as the vault's MAX sentinel, so nothing gained after the click is left
  // behind for a second withdrawal.
  const [everything, setEverything] = useState(false);
  const typed = safeParse(amount, USDG_DECIMALS) ?? 0n;
  // A typed amount that would leave less than a cent behind (or asks for more than there is) is everything too.
  const all = available > 0n && (everything || (typed > 0n && typed + USDG_DUST > available));
  const usdgOut = all ? available : typed;
  const remaining = available > usdgOut ? available - usdgOut : 0n;
  const edit = (v: string) => {
    setEverything(false);
    setAmount(v);
  };
  // Whole dollars, with the end stop rounded up past the balance so the slider can land on all of it.
  const sliderMax = Math.ceil(Number(formatUnits(available, USDG_DECIMALS)));
  const feeBps = info?.fees?.withdrawFeeBps ?? 0;
  // The step this sends, drawn the way the flow dialog draws it; the order on screen at the click is the one sent.
  const preview = usdgOut > 0n && usdgOut <= available ? buildWithdrawOrder({ ref, amount: usdgOut, all, feeBps, usdgIdle: p.usdgIdle, balanceBefore: available }) : null;
  const left = preview ? withdrawLeftCopy({ remaining, perBuy, paused: p.paused, bought }) : undefined;
  const summary: SummaryRow[] = [];
  if (preview) {
    summary.push({ k: "You withdraw", v: all ? `Everything · ${fmtUsd(usdgOut)}` : fmtUsd(usdgOut), words: all });
    summary.push({ k: "Withdrawal fee", v: `${fmtBps(feeBps)} · ${fmtUsd(feeOf(usdgOut, feeBps))}` });
    // A boosted balance still moves until the withdrawal lands, so "everything" is an estimate there.
    summary.push({ k: "You receive", v: `${all && p.boosted ? "≈ " : ""}${fmtUsd(preview.receive)}`, tone: "strong" });
    summary.push({ k: "Plan after", v: fmtUsd(remaining) });
    if (bought !== false && remaining > 0n) summary.push({ k: "Covers", v: `${coverageCopy(remaining, perBuy)}${p.paused ? " once resumed" : ""}`, tone: remaining < perBuy ? "warn" : undefined, words: true });
  }
  // The order as sent: setting it swaps the form for the flow dialog; clearing it (after a failure) brings the form back.
  const [order, setOrder] = useState<WithdrawOrder | null>(null);
  const seq = useTxSequence(() => onChange());
  const ok = !!preview && !seq.running;
  const submit = () => {
    if (!preview || seq.running) return;
    setOrder(preview);
    void seq.run(preview.steps);
  };
  const closeFlow = () => {
    // Done, or closed while still waiting on the network: the whole dialog goes, so the amount cannot be sent twice.
    if (seq.done || seq.waiting) {
      if (seq.waiting) onChange();
      return onClose();
    }
    setOrder(null);
    seq.reset();
  };

  if (order) return <PlanFlowDialog order={order} planLabel={planLabel} seq={seq} onClose={closeFlow} />;
  return (
    <Modal open onClose={onClose} title={`Withdraw · ${symbol} #${p.planId.toString()}`}>
      <div className="space-y-4">
        <AmountInput value={everything ? formatUnits(available, USDG_DECIMALS) : amount} onChange={edit} unit="USDG" large onMax={() => setEverything(true)} />
        <div>
          <Slider
            value={all ? sliderMax : Number(amount) || 0}
            min={0}
            max={sliderMax}
            step={1}
            onChange={(v) => (v >= sliderMax ? setEverything(true) : edit(String(v)))}
            ariaLabel="Withdraw amount"
          />
          <div className="flex justify-between text-[11px] text-ink-3">
            <span>0</span>
            <span>In plan: {fmtUsd(available)}</span>
          </div>
        </div>
        {available === 0n && <Notice kind="info">Nothing is left in the plan to withdraw.</Notice>}
        {preview && <FormSummary rows={summary} />}
        {left && <FundsNote tone={left.tone}>{left.text}</FundsNote>}
        {preview && <FlowTimeline flow={preview.flow} />}
        <button type="button" className="btn-primary h-10 w-full" disabled={!ok} onClick={submit}>
          {preview ? `${all ? "Withdraw everything" : "Withdraw"} · ${confirmations(preview.steps.length)}` : available === 0n ? "Nothing to withdraw" : "Enter an amount"}
        </button>
        <p className="text-[11px] text-ink-3">
          A {fmtBps(feeBps)} fee applies to withdrawn funds. Withdrawals are paid in USDG (ETH deposits were converted when they came in).
          {all ? "" : " Stock you have already bought stays claimable."}
          {p.boosted && p.boostValue > 0n
            ? ` ${fmtUsd(p.boostValue)} of this plan is lent on Morpho Blue and is pulled back as part of the withdrawal (earnings included); if the market is short of liquidity the withdrawal fails and nothing moves.`
            : ""}
        </p>
      </div>
    </Modal>
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
