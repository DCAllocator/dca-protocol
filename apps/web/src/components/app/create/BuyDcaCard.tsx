"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { formatEther, formatUnits, type Address } from "viem";
import { usePublicClient, useReadContract } from "wagmi";
import { useUser, useBestRoute, readBestRoute, BUY_DCA_PROBE, type BestRoute, type Directory, type RouteHop } from "@/hooks/useProtocol";
import { useTxSequence, type TxStep } from "@/hooks/useTx";
import { AggregatorRouterAbi, ERC20Abi } from "@/abi";
import { Notice, Spinner } from "@/components/ui";
import { TxFlowDialog, type FlowStep } from "@/components/app/TxFlowDialog";
import { AddToWalletButton } from "@/components/app/AddToWalletButton";
import { ConnectButton } from "@/components/ConnectButton";
import { Logo } from "@/components/Logo";
import { fmtUsd, fmtUnits, fmtBps, short } from "@/lib/format";
import { USDG_DECIMALS } from "@/lib/config";
import { Box, Coin, Detail, Dropdown, clean, safeParse, safeParseEth, trimEth } from "./fields";
import { ETH_GAS_RESERVE, type Pay } from "./useCreatePlan";

/**
 * minOut = quote × (1 − 0.5%). Both pay tokens buy through `swapWithRoute` on the path frozen at click time, which does
 * not re-check the router's impact cap, so this one floor is the guard for the whole trip, however many hops it takes.
 */
export const BUY_SLIPPAGE_BPS = 50n;

/** WETH9's `deposit()`: wraps the ETH sent with it 1:1. Not in the generated ABIs (the app has no WETH contract of its own). */
const WethDepositAbi = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }] as const;

const withSlippage = (quoted: bigint) => (quoted * (10_000n - BUY_SLIPPAGE_BPS)) / 10_000n;

/** The ETH flow's wrap step, by label: the post-failure note looks it up in the sequence rather than by position. */
const WRAP_LABEL = "Wrap ETH";

/**
 * What "Buy" was pressed with, frozen for the dialog so the card's own 20 s re-quote cannot reshape it mid-flight.
 * `steps` is what is sent, kept so "Try again" can rebuild the last step (the buy) from a fresh quote (see `retryOrder`);
 * `tokens` is the route that buy takes, for the summary; `id` tells that re-quote, once its read is back, whether its
 * order is still the open one. `requoting` is set while that read is out; `repriced` holds the floor the user had seen
 * when the re-quote came back below it, until the next "Try again" accepts the new figures.
 */
type BuyOrder = {
  id: number;
  pay: Pay;
  flow: FlowStep[];
  steps: TxStep[];
  amountIn: bigint;
  quoted: bigint;
  minOut: bigint;
  tokens: readonly Address[];
  requoting?: boolean;
  repriced?: bigint;
};

/** What an order spends, as the summary and the notes say it: "$100.00" or "0.1 ETH". */
const payAmount = (pay: Pay, amountIn: bigint) => (pay === "ETH" ? `${fmtUnits(amountIn, 18)} ETH` : fmtUsd(amountIn));

/**
 * In-app $DCA buy over the protocol's router, paid in USDG or ETH (the pill in the Pay box; USDG unless `initialPay`,
 * the pay token /app/buy's route probe answered for, says otherwise). Both run through the same `useTxSequence` +
 * `TxFlowDialog` the create card uses, and both are smart-routed: `useBestRoute` finds the path that delivers the most
 * $DCA for the user's REAL amount — not one unit scaled — whichever token $DCA is paired with. It weighs the router's
 * own pick (a direct hop, or two hops through WETH) against the routes through USDG the router never searches, which
 * only an ETH buy can use (see `readBestRoute`):
 *
 * - $DCA paired with USDG: USDG pays straight in; ETH goes WETH → USDG → $DCA.
 * - $DCA paired with WETH: ETH pays straight in; USDG goes USDG → WETH → $DCA.
 * - Both pools: whichever delivers more at this amount.
 *
 * Only ERC-20 pools on the router's approved adapters count: a native-ETH Uniswap v4 pool (a Pons launch pool) is not
 * routable by this router at all, with either pay token. The order freezes the winning path at click time and the buy is
 * `swapWithRoute(payToken, $DCA, amount, minOut, you, path)`, so the Route line is the route sent and one floor — the
 * quote minus 0.5% — guards it end to end.
 *
 * USDG: Approve USDG (skipped when the router's allowance already covers it) → Buy $DCA.
 *
 * ETH: Approve WETH (skipped as above) → Wrap ETH (WETH `deposit`) → Buy $DCA; the router swaps tokens, not native ETH.
 * The approval goes first because an ERC-20 approval needs no balance: a skipped one then sits at the top of the
 * timeline, as in the USDG flow, instead of drawn done between two steps still to do. This beats the Zap (ETH → USDG)
 * followed by an approve and a USDG buy: the buy's input is unknown until the Zap mines, so its step would have to be
 * rebuilt mid-flow or sized to the Zap's floor (leaving USDG behind), and the two swaps would each carry their own
 * slippage allowance; here there is one quote and one floor for the whole trip. MAX / HALF keep ETH_GAS_RESERVE back,
 * and an amount that eats into it is refused: every step is paid for in ETH, and the buy still comes after the wrap.
 *
 * "Try again" re-quotes first and never sends below the floor the user last saw (see `retryOrder`).
 *
 * "Add to MetaMask" for $DCA sits on the Receive box and again once a buy is done.
 */
export function BuyDcaCard({ dir, initialPay = "USDG" }: { dir: Directory; initialPay?: Pay }) {
  const client = usePublicClient();
  const user = useUser(dir);
  const { address } = user;
  const [pay, setPay] = useState<Pay>(initialPay);
  const [amount, setAmount] = useState("");
  const [order, setOrderState] = useState<BuyOrder | null>(null);
  // Mirrors `order` synchronously, for the checks `retryOrder` makes after its read (and against a same-tick double-click).
  const orderRef = useRef<BuyOrder | null>(null);
  const orderIds = useRef(0);
  const setOrder = (next: BuyOrder | null) => {
    orderRef.current = next;
    setOrderState(next);
  };

  // The token's own decimals and symbol: do not assume 18 / "$DCA" (locally the token is mDCA).
  const decimalsQ = useReadContract({ address: dir.dca, abi: ERC20Abi, functionName: "decimals", query: { staleTime: Infinity } });
  const symbolQ = useReadContract({ address: dir.dca, abi: ERC20Abi, functionName: "symbol", query: { staleTime: Infinity } });
  const decimals = decimalsQ.data ?? 18;
  const symbol = symbolQ.data ?? "$DCA";

  /** The token the router pulls for a pay choice: USDG itself, or for ETH the WETH the wrap step makes. */
  const payToken = (p: Pay) => (p === "ETH" ? dir.weth : dir.usdg);
  const eth = pay === "ETH";
  const amountWei = eth ? safeParseEth(amount) : safeParse(amount, USDG_DECIMALS);
  const hasAmount = !!amountWei && amountWei > 0n;
  // One finder for both pay tokens: the path from the pay token into $DCA that delivers the most for this amount.
  const routeQ = useBestRoute(dir, payToken(pay), dir.dca, hasAmount ? amountWei : undefined);
  const best = routeQ.data?.best;
  const quoted = best?.amountOut;
  const minOut = quoted !== undefined ? withSlippage(quoted) : undefined;

  const usdgBal = user.usdg ?? 0n;
  const ethBal = user.eth ?? 0n;
  // HALF / MAX of ETH leave ETH_GAS_RESERVE behind: the wrap is one of up to three transactions, and the buy follows it.
  const ethMax = ethBal > ETH_GAS_RESERVE ? ethBal - ETH_GAS_RESERVE : 0n;
  const payMax = eth ? ethMax : usdgBal;
  const insufficient = hasAmount && amountWei > (eth ? ethBal : usdgBal);
  const noGasLeft = eth && hasAmount && !insufficient && amountWei > ethMax;
  // The router quotes through eth_call; with no candidate inside its impact cap (no route, or too thin) there is no amount.
  const quotePending = routeQ.isLoading || routeQ.isFetching;
  const quoteFailed = hasAmount && !quotePending && quoted === undefined;
  // Only once an amount has come back without a quote: does this pay token route at all? Asked at /app/buy's own probe
  // size, so "no" means the other pay token is the one the page found a route for — "Try a smaller amount" would not
  // help. Keyed on the first answer (not `quoteFailed`) so the 20 s re-quote does not drop and re-ask it.
  const probeQ = useBestRoute(dir, payToken(pay), dir.dca, hasAmount && !routeQ.isLoading && quoted === undefined ? BUY_DCA_PROBE[pay] : undefined);
  const noRouteForPay = quoteFailed && probeQ.data !== undefined && !probeQ.data.best;

  const allowance = useReadContract({
    address: payToken(pay),
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
  }, [amount, pay]);

  const canSubmit = !!address && hasAmount && !insufficient && !noGasLeft && minOut !== undefined && !seq.running;

  /** How a path token reads in the copy: the directory's tokens by name ($DCA by its own symbol), anything else by address. */
  const tokenLabel = (a: Address) =>
    a.toLowerCase() === dir.weth.toLowerCase() ? "WETH" : a.toLowerCase() === dir.usdg.toLowerCase() ? "USDG" : a.toLowerCase() === dir.dca.toLowerCase() ? symbol : short(a);
  /**
   * The route as the user pays it, from the path's own tokens: "USDG → mDCA", "USDG → WETH → mDCA"; for ETH the wrap
   * leads, "ETH → WETH → mDCA" or "ETH → WETH → USDG → mDCA".
   */
  const routeLabel = (p: Pay, tokens: readonly Address[]) => [...(p === "ETH" ? ["ETH"] : []), ...tokens.map(tokenLabel)].join(" → ");
  const buyStep = (p: Pay, amountIn: bigint, min: bigint, path: readonly RouteHop[], recipient: Address): TxStep => ({
    label: `Buy ${symbol}`,
    params: { address: dir.router, abi: AggregatorRouterAbi, functionName: "swapWithRoute", args: [payToken(p), dir.dca, amountIn, min, recipient, path] },
  });
  const buyFlow = (p: Pay, amountIn: bigint, min: bigint, tokens: readonly Address[]): FlowStep => {
    // The tokens between the two ends: "through WETH", "through USDG", or nothing for a direct hop.
    const via = tokens.slice(1, -1).map(tokenLabel);
    const spend = p === "ETH" ? `${fmtUnits(amountIn, 18)} WETH` : fmtUsd(amountIn);
    return {
      label: `Buy ${symbol}`,
      detail: `Swaps ${spend} ${via.length ? `through ${via.join(" → ")} ` : ""}for at least ${fmtUnits(min, decimals)} ${symbol}, sent to your wallet.`,
      done: "Bought",
    };
  };

  const submit = async () => {
    if (!address || !amountWei || !best || minOut === undefined) return;
    const token = eth ? "WETH" : "USDG";
    const ethAmount = fmtUnits(amountWei, 18);
    const steps: TxStep[] = [];
    // Approve before the wrap: an approval needs no balance, and a skipped one then heads the timeline (see the header).
    if (needsApproval) steps.push({ label: `Approve ${token}`, params: { address: payToken(pay), abi: ERC20Abi, functionName: "approve", args: [dir.router, amountWei] } });
    if (eth) steps.push({ label: WRAP_LABEL, params: { address: dir.weth, abi: WethDepositAbi, functionName: "deposit", value: amountWei } });
    // The path shown is the path sent: frozen here, not re-found by the router at execution.
    steps.push(buyStep(pay, amountWei, minOut, best.path, address));
    // Every step is always listed so the flow reads the same whether or not the approval is needed.
    const flow: FlowStep[] = [
      {
        label: `Approve ${token}`,
        detail: eth ? `Lets the router take ${ethAmount} WETH from your wallet once it is wrapped.` : `Lets the router take ${fmtUsd(amountWei)} from your wallet.`,
        done: "Approved",
        skipped: needsApproval ? undefined : "Already approved — the router can take this amount.",
      },
      ...(eth ? [{ label: WRAP_LABEL, detail: `Wraps ${ethAmount} ETH into WETH, 1:1 — the router swaps tokens, not native ETH.`, done: "Wrapped" }] : []),
      buyFlow(pay, amountWei, minOut, best.tokens),
    ];
    setOrder({ id: ++orderIds.current, pay, flow, steps, amountIn: amountWei, quoted: best.amountOut, minOut, tokens: best.tokens });
    await seq.run(steps);
  };

  /**
   * "Try again" re-quotes the route for the same amount before anything is re-sent, whichever the pay token: the buy
   * goes along a path frozen at click time (`swapWithRoute` re-finds nothing and does not re-check impact), wallet
   * prompts can take long enough for that quote to go stale, and for ETH, once the wrap has mined the ETH is already WETH.
   *
   * - The floor the user last saw is still reachable (fresh quote ≥ it): the failed step and those after it go again
   *   (`seq.retry(remaining)`; mined steps keep their receipts), the buy rebuilt on the fresh best path — which may be a
   *   different route than before — with floor max(fresh − 0.5%, that floor): never below what was on screen.
   * - It is not (the price moved against them): nothing is sent. The tile and a "price moved" note show the new figures,
   *   and the NEXT "Try again" is the user accepting them — it re-quotes again, held to the new floor.
   *
   * With no fresh quote the order's steps go as shown, and the buy's gas estimate names what is wrong. An answer that
   * comes back after the dialog closed (or another order started) is dropped.
   */
  const retryOrder = async () => {
    const o = orderRef.current;
    const failedAt = seq.steps.findIndex((s) => s.phase === "error");
    if (!o || !client || !address || failedAt < 0) return seq.retry();
    if (o.requoting) return; // a second click while the first one's read is out
    setOrder({ ...o, requoting: true });
    let fresh: BestRoute | undefined;
    try {
      fresh = (await readBestRoute(client, dir, payToken(o.pay), dir.dca, o.amountIn)).best;
    } catch {
      fresh = undefined;
    }
    const cur = orderRef.current;
    if (!cur || cur.id !== o.id) return;
    if (!fresh) {
      setOrder({ ...cur, requoting: false, repriced: undefined });
      return seq.retry(cur.steps.slice(failedAt));
    }
    const reachable = fresh.amountOut >= cur.minOut;
    const floor = withSlippage(fresh.amountOut);
    const min = reachable && floor < cur.minOut ? cur.minOut : floor;
    const steps = [...cur.steps.slice(0, -1), buyStep(cur.pay, cur.amountIn, min, fresh.path, address)];
    setOrder({
      ...cur,
      requoting: false,
      quoted: fresh.amountOut,
      minOut: min,
      tokens: fresh.tokens,
      steps,
      flow: [...cur.flow.slice(0, -1), buyFlow(cur.pay, cur.amountIn, min, fresh.tokens)],
      repriced: reachable ? undefined : cur.minOut,
    });
    if (reachable) return seq.retry(steps.slice(failedAt));
  };

  /** Closing the dialog ends the order; after a success the amount is cleared so the next buy starts fresh. */
  const closeFlow = () => {
    const wasDone = seq.done;
    setOrder(null);
    seq.reset();
    if (wasDone) setAmount("");
  };

  /**
   * The notes under an order's tile. The price one, for either pay token: "Getting a fresh quote…" while `retryOrder`
   * reads, then — when the fresh quote came back below the floor the user had seen — the new figures, which the next
   * "Try again" accepts (nothing is sent until then). The WETH one, for ETH: a buy that failed after the wrap mined leaves
   * WETH, not ETH, in the wallet, so say so before anyone closes — without offering "Try again" when the dialog does not
   * (a failed step that may have been sent anyway: then the buy may even have gone through).
   */
  const orderNotes = (o: BuyOrder): { key: string; node: ReactNode }[] => {
    const notes: { key: string; node: ReactNode }[] = [];
    const ethAmount = fmtUnits(o.amountIn, 18);
    if (o.requoting)
      notes.push({
        key: "requoting",
        node: (
          <Notice>
            <span className="inline-flex items-center gap-2">
              <Spinner /> Getting a fresh quote…
            </span>
          </Notice>
        ),
      });
    else if (o.repriced !== undefined)
      notes.push({
        key: `repriced-${o.minOut}`,
        node: (
          <Notice kind="warn">
            Price moved: {payAmount(o.pay, o.amountIn)} now buys ≈ {fmtUnits(o.quoted, decimals)} {symbol}, at least {fmtUnits(o.minOut, decimals)} (was at
            least {fmtUnits(o.repriced, decimals)}). Nothing was sent — Try again to buy at this price.
          </Notice>
        ),
      });
    if (o.pay === "ETH" && seq.error && seq.steps.find((s) => s.label === WRAP_LABEL)?.phase === "done") {
      const maybeSent = !!seq.steps.find((s) => s.phase === "error")?.maybeSent;
      notes.push({
        key: maybeSent ? "weth-maybe" : "weth",
        node: (
          <p className="rounded-lg border border-line px-3 py-2 text-[12px] leading-snug text-ink-2">
            {maybeSent
              ? `The wrap went through. If the buy did not, ${ethAmount} WETH stays in your wallet (1:1 with ETH).`
              : `The wrap went through: ${ethAmount} WETH is in your wallet. Try again to finish the buy with it; if you close, it stays there as WETH (1:1 with ETH).`}
          </p>
        ),
      });
    }
    return notes;
  };

  const reserve = fmtUnits(ETH_GAS_RESERVE, 18);
  const hint = insufficient
    ? `Not enough ${pay} in your wallet.`
    : noGasLeft
      ? // MAX is only offered while there is something above the reserve to spend.
        ethMax > 0n
        ? `Leave ${reserve} ETH for gas — every step of the buy is paid for in ETH. MAX does this for you.`
        : `Paying with ETH needs more than ${reserve} ETH in your wallet: that much stays back for the gas of each step.`
      : noRouteForPay
        ? `No route from ${pay} to ${symbol} on this chain — pay with ${pay === "ETH" ? "USDG" : "ETH"} instead.`
        : quoteFailed
          ? // The "smaller amount" advice waits for the probe to show a route exists at all.
            probeQ.data?.best
            ? "No quote for this amount — the route may be too thin. Try a smaller amount."
            : "No quote for this amount."
          : undefined;
  // 1 USDG / 1 ETH → x tokens at the quoted rate, for the details line.
  const payUnit = 10n ** BigInt(eth ? 18 : USDG_DECIMALS);
  const rate = quoted !== undefined && amountWei ? (quoted * payUnit) / amountWei : undefined;
  // What the amount is worth in USDG: itself for USDG; for ETH the finder's own WETH → USDG leg, read anyway as the first
  // half of the path through USDG (undefined while it loads, or on a chain with no WETH → USDG hop).
  const usdValue = eth ? (hasAmount ? routeQ.data?.firstLegs[dir.usdg.toLowerCase()] : 0n) : (amountWei ?? 0n);

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
              aria-label={`Amount of ${pay} to spend`}
            />
            <Dropdown
              trigger={
                <>
                  <Coin unit={pay} />
                  {pay}
                </>
              }
              // Named like the create form's currency pill (FundWithBox), not as a bare ticker.
              label={`Pay with ${pay}. Change currency`}
              width="w-64"
            >
              {(close) =>
                (["USDG", "ETH"] as Pay[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="option"
                    aria-selected={p === pay}
                    className={`menu-item gap-2.5 ${p === pay ? "bg-surface-4 text-ink" : ""}`}
                    onClick={() => {
                      // A switch starts a fresh order: the amount means something else in the other token.
                      if (p !== pay) {
                        setPay(p);
                        setAmount("");
                      }
                      close();
                    }}
                  >
                    <Coin unit={p} />
                    <span className="text-[13px] font-medium text-ink">{p}</span>
                    <span className="ml-auto text-[12px] whitespace-nowrap text-ink-3">{p === "ETH" ? "wrapped, then swapped" : "swapped as is"}</span>
                  </button>
                ))
              }
            </Dropdown>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
            <span className="num">{usdValue !== undefined ? `≈ ${fmtUsd(usdValue)}` : quotePending ? "≈ …" : "≈ —"}</span>
            <span className="flex items-center gap-1.5">
              <span>
                Balance <span className="num text-ink-2">{address ? (eth ? `${fmtUnits(ethBal, 18)} ETH` : fmtUsd(usdgBal)) : "—"}</span>
              </span>
              {[50, 100].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  disabled={!address || payMax === 0n}
                  onClick={() => {
                    const share = (payMax * BigInt(pct)) / 100n;
                    setAmount(eth ? trimEth(formatEther(share)) : formatUnits(share, USDG_DECIMALS));
                  }}
                  className="quick"
                >
                  {pct === 100 ? "MAX" : "HALF"}
                </button>
              ))}
            </span>
          </div>
        </Box>

        <Box label="Receive" className="mt-3" aside={<AddToWalletButton address={dir.dca} symbol={symbolQ.data ?? "DCA"} decimals={decimals} />}>
          <div className="flex items-center gap-3">
            <span className={`num min-w-0 flex-1 truncate text-[30px] font-medium ${quoted !== undefined ? "text-ink" : "text-ink-3"}`}>
              {hasAmount ? (quoted !== undefined ? `≈ ${fmtUnits(quoted, decimals)}` : quoteFailed ? "—" : "…") : "0"}
            </span>
            <span className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-line-strong bg-surface-4 pr-3 pl-1.5 text-[14px] font-semibold text-ink">
              <Logo size={24} />
              {symbol}
            </span>
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
              ) : eth ? (
                needsApproval ? (
                  `Approve, wrap & buy ${symbol}`
                ) : (
                  `Wrap & buy ${symbol}`
                )
              ) : needsApproval ? (
                `Approve & buy ${symbol}`
              ) : (
                `Buy ${symbol}`
              )}
            </button>
          )}
        </div>

        <div className="mt-4 grid gap-1.5 text-[12.5px]">
          <Detail k="Rate">{rate !== undefined ? `1 ${pay} ≈ ${fmtUnits(rate, decimals)} ${symbol}` : "—"}</Detail>
          <Detail k="Route">{best ? routeLabel(pay, best.tokens) : "—"}</Detail>
          <Detail k="Minimum received">{minOut !== undefined ? `${fmtUnits(minOut, decimals)} ${symbol}` : "—"}</Detail>
          <Detail k="Max slippage">{fmtBps(Number(BUY_SLIPPAGE_BPS))}</Detail>
        </div>
      </div>

      <TxFlowDialog
        open={order !== null}
        titles={{ running: `Buying ${symbol}`, done: `Bought ${symbol}`, error: "Not bought" }}
        summary={
          order && (
            <div>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-3 px-3.5 py-3 text-[14px] font-medium text-ink">
                <span className="num">{payAmount(order.pay, order.amountIn)}</span>
                <span className="text-ink-3">→</span>
                <span className="num">
                  ≈ {fmtUnits(order.quoted, decimals)} {symbol}
                </span>
              </div>
              {/* The route the buy step sends (re-drawn if "Try again" re-quotes onto another one). */}
              <div className="mt-2 px-1 text-[12.5px]">
                <Detail k="Route">{routeLabel(order.pay, order.tokens)}</Detail>
              </div>
              {/* In the DOM from the first frame, empty until needed: a live region inserted already filled is often not read. */}
              <div aria-live="polite">
                {orderNotes(order).map(({ key, node }) => (
                  <div key={key} className="mt-2">
                    {node}
                  </div>
                ))}
              </div>
            </div>
          )
        }
        flow={order?.flow ?? []}
        seq={{ ...seq, retry: retryOrder }}
        onClose={closeFlow}
        doneActions={
          <div className="grid gap-2">
            <Link href="/app/create" className="btn-primary btn-lg w-full rounded-xl">
              Start a plan
            </Link>
            <button type="button" className="btn-ghost w-full" onClick={closeFlow}>
              Buy more
            </button>
            <AddToWalletButton address={dir.dca} symbol={symbolQ.data ?? "DCA"} decimals={decimals} className="justify-self-center" />
          </div>
        }
      />

      <p className="mt-3 px-2 text-center text-[11.5px] leading-normal text-ink-3">
        Swapped on the protocol&apos;s own router through its approved pools. $DCA is a protocol utility token, not equity or a promise of returns.
      </p>
    </>
  );
}
