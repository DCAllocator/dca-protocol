"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatUnits } from "viem";
import { useReadContract } from "wagmi";
import { useUser, useQuote, type Directory } from "@/hooks/useProtocol";
import { useTxSequence, type TxStep } from "@/hooks/useTx";
import { AggregatorRouterAbi, ERC20Abi } from "@/abi";
import { Spinner } from "@/components/ui";
import { TxFlowDialog, type FlowStep } from "@/components/app/TxFlowDialog";
import { ConnectButton } from "@/components/ConnectButton";
import { fmtUsd, fmtUnits, fmtBps } from "@/lib/format";
import { USDG_DECIMALS } from "@/lib/config";
import { Box, Coin, Detail, clean, safeParse } from "./fields";

/** minOut = quote × (1 − 0.5%). The router re-quotes at execution and reverts above its own impact cap anyway. */
export const BUY_SLIPPAGE_BPS = 50n;

/** What "Buy" was pressed with, frozen for the dialog so a re-quote cannot reshape it mid-flight. */
type BuyOrder = { flow: FlowStep[]; amountIn: bigint; quoted: bigint; minOut: bigint };

/**
 * In-app USDG → $DCA swap over the router's public `swap()` (it pulls `amountIn` from the caller, so no
 * contract change is needed). The quote is for the user's REAL amount — not one unit scaled — so what is
 * shown is what the router will try to deliver; `minOut` is that quote minus 0.5%. Steps: Approve USDG
 * (skipped when the router's allowance already covers it) → Buy $DCA, through the same `useTxSequence` +
 * `TxFlowDialog` the create card uses. USDG only: ETH → $DCA is not routable today (the router only searches
 * two-hop routes when neither side is WETH, and the Zap is ETH ↔ USDG).
 */
export function BuyDcaCard({ dir }: { dir: Directory }) {
  const user = useUser(dir);
  const { address } = user;
  const [amount, setAmount] = useState("");
  const [order, setOrder] = useState<BuyOrder | null>(null);

  // The token's own decimals and symbol: do not assume 18 / "$DCA" (locally the token is mDCA).
  const decimalsQ = useReadContract({ address: dir.dca, abi: ERC20Abi, functionName: "decimals", query: { staleTime: Infinity } });
  const symbolQ = useReadContract({ address: dir.dca, abi: ERC20Abi, functionName: "symbol", query: { staleTime: Infinity } });
  const decimals = decimalsQ.data ?? 18;
  const symbol = symbolQ.data ?? "$DCA";

  const amountWei = safeParse(amount, USDG_DECIMALS);
  const hasAmount = !!amountWei && amountWei > 0n;
  const quote = useQuote(dir.router, dir.usdg, dir.dca, hasAmount ? amountWei : undefined);
  const quoted = quote.data?.amountOut;
  const minOut = quoted !== undefined ? (quoted * (10_000n - BUY_SLIPPAGE_BPS)) / 10_000n : undefined;

  const usdgBal = user.usdg ?? 0n;
  const insufficient = hasAmount && amountWei > usdgBal;
  // The router quotes through `simulateContract`; a revert (no route, or above the impact cap) leaves `data` undefined.
  const quoteFailed = hasAmount && !quote.isLoading && !quote.isFetching && quoted === undefined;

  const allowance = useReadContract({
    address: dir.usdg,
    abi: ERC20Abi,
    functionName: "allowance",
    args: address ? [address, dir.router] : undefined,
    query: { enabled: !!address },
  });
  const needsApproval = hasAmount && (allowance.data ?? 0n) < amountWei;

  const seq = useTxSequence(() => {
    user.refetch();
    allowance.refetch();
  });
  // Any input change after a success or failure starts a fresh order.
  useEffect(() => {
    if (seq.done || seq.error) seq.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount]);

  const canSubmit = !!address && hasAmount && !insufficient && minOut !== undefined && !seq.running;

  const submit = async () => {
    if (!address || !amountWei || quoted === undefined || minOut === undefined) return;
    const steps: TxStep[] = [];
    if (needsApproval) steps.push({ label: "Approve USDG", params: { address: dir.usdg, abi: ERC20Abi, functionName: "approve", args: [dir.router, amountWei] } });
    steps.push({
      label: `Buy ${symbol}`,
      params: { address: dir.router, abi: AggregatorRouterAbi, functionName: "swap", args: [dir.usdg, dir.dca, amountWei, minOut, address] },
    });
    // Both halves are always listed so the flow reads the same whether or not the approval is needed.
    const flow: FlowStep[] = [
      {
        label: "Approve USDG",
        detail: `Lets the router take ${fmtUsd(amountWei)} from your wallet.`,
        done: "Approved",
        skipped: needsApproval ? undefined : "Already approved — the router can take this amount.",
      },
      {
        label: `Buy ${symbol}`,
        detail: `Swaps ${fmtUsd(amountWei)} for at least ${fmtUnits(minOut, decimals)} ${symbol}, sent to your wallet.`,
        done: "Bought",
      },
    ];
    setOrder({ flow, amountIn: amountWei, quoted, minOut });
    await seq.run(steps);
  };
  /** Closing the dialog ends the order; after a success the amount is cleared so the next buy starts fresh. */
  const closeFlow = () => {
    const wasDone = seq.done;
    setOrder(null);
    seq.reset();
    if (wasDone) setAmount("");
  };

  const hint = insufficient ? "Not enough USDG in your wallet." : quoteFailed ? "No quote for this amount — the route may be too thin. Try a smaller amount." : undefined;
  // 1 USDG → x tokens at the quoted rate, for the details line.
  const rate = quoted !== undefined && amountWei ? (quoted * 10n ** BigInt(USDG_DECIMALS)) / amountWei : undefined;

  return (
    <>
      <div className="rounded-2xl border border-line bg-surface-2 p-4 sm:p-5">
        <Box label="Pay" error={hint}>
          <div className="flex items-center gap-3">
            <input
              className="amount-input swap-input text-[30px]"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(clean(e.target.value))}
              placeholder="0"
              aria-label="Amount of USDG to spend"
            />
            <span className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-line-strong bg-surface-4 pr-3 pl-1.5 text-[14px] font-semibold text-ink">
              <Coin unit="USDG" />
              USDG
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
            <span className="num">≈ {fmtUsd(amountWei ?? 0n)}</span>
            <span className="flex items-center gap-1.5">
              <span>
                Balance <span className="num text-ink-2">{address ? fmtUsd(usdgBal) : "—"}</span>
              </span>
              {[50, 100].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  disabled={!address || usdgBal === 0n}
                  onClick={() => setAmount(formatUnits((usdgBal * BigInt(pct)) / 100n, USDG_DECIMALS))}
                  className="quick"
                >
                  {pct === 100 ? "MAX" : "HALF"}
                </button>
              ))}
            </span>
          </div>
        </Box>

        <Box label="Receive" className="mt-3">
          <div className="flex items-center gap-3">
            <span className={`num min-w-0 flex-1 truncate text-[30px] font-medium ${quoted !== undefined ? "text-ink" : "text-ink-3"}`}>
              {hasAmount ? (quoted !== undefined ? `≈ ${fmtUnits(quoted, decimals)}` : quoteFailed ? "—" : "…") : "0"}
            </span>
            <span className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-line-strong bg-surface-4 px-3 text-[14px] font-semibold text-ink">{symbol}</span>
          </div>
          <div className="mt-1.5 text-[12.5px] text-ink-3">
            Balance <span className="num text-ink-2">{address ? `${fmtUnits(user.dca, decimals)} ${symbol}` : "—"}</span>
          </div>
        </Box>

        <div className="mt-3 grid gap-2">
          {!address ? (
            <ConnectButton className="btn-lg w-full rounded-xl" />
          ) : (
            <button type="button" className="btn-primary btn-lg w-full rounded-xl" disabled={!canSubmit} onClick={submit}>
              {seq.running ? (
                <>
                  <Spinner /> {seq.label}
                  {seq.total > 1 ? ` (${seq.step + 1}/${seq.total})` : ""}
                </>
              ) : needsApproval ? (
                `Approve & buy ${symbol}`
              ) : (
                `Buy ${symbol}`
              )}
            </button>
          )}
        </div>

        <div className="mt-4 grid gap-1.5 text-[12.5px]">
          <Detail k="Rate">{rate !== undefined ? `1 USDG ≈ ${fmtUnits(rate, decimals)} ${symbol}` : "—"}</Detail>
          <Detail k="Minimum received">{minOut !== undefined ? `${fmtUnits(minOut, decimals)} ${symbol}` : "—"}</Detail>
          <Detail k="Max slippage">{fmtBps(Number(BUY_SLIPPAGE_BPS))}</Detail>
        </div>
      </div>

      <TxFlowDialog
        open={order !== null}
        titles={{ running: `Buying ${symbol}`, done: `Bought ${symbol}`, error: "Not bought" }}
        summary={
          order && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-3 px-3.5 py-3 text-[14px] font-medium text-ink">
              <span className="num">{fmtUsd(order.amountIn)}</span>
              <span className="text-ink-3">→</span>
              <span className="num">
                ≈ {fmtUnits(order.quoted, decimals)} {symbol}
              </span>
            </div>
          )
        }
        flow={order?.flow ?? []}
        seq={seq}
        onClose={closeFlow}
        doneActions={
          <div className="grid gap-2">
            <Link href="/app/create" className="btn-primary btn-lg w-full rounded-xl">
              Start a plan
            </Link>
            <button type="button" className="btn-ghost w-full" onClick={closeFlow}>
              Buy more
            </button>
          </div>
        }
      />

      <p className="mt-3 px-2 text-center text-[11.5px] leading-normal text-ink-3">
        Swapped on the protocol&apos;s own router through its approved pools. $DCA is a protocol utility token, not equity or a promise of returns.
      </p>
    </>
  );
}
