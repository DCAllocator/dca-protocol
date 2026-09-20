"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { useDirectory, useStocks, useVaults, useUser, useQuote, usePrices, type Stock, type PriceMap } from "@/hooks/useProtocol";
import { useTxSequence, type TxStep } from "@/hooks/useTx";
import { PlanVaultAbi, ERC20Abi } from "@/abi";
import { PageHeader, Card, Notice, Spinner, StockAvatar, Slider, AmountInput, Segmented, KV, Countdown, Icon } from "@/components/ui";
import { ConnectButton } from "@/components/ConnectButton";
import { fmtUsd, fmtUnits, fmtBps, tsToShort, valueOf } from "@/lib/format";
import { tickerName } from "@/lib/tickers";
import { VAULT_KINDS, VAULT_META, ZERO, DOCS_PATH, USDG_DECIMALS, cadenceOf, buysPerMonthOf, type VaultKind } from "@/lib/config";

type Pay = "USDG" | "ETH";

const PER_MIN = 10;
const PER_MAX = 1000;
const ETH_GAS_RESERVE = parseEther("0.01");

export default function CreatePlan() {
  const { address } = useAccount();
  const { dir, vaults, configured } = useDirectory();
  const { stocks } = useStocks(dir?.registry);
  const { byKind, refetch: refetchVaults } = useVaults(vaults);

  const [stock, setStock] = useState<string>("");
  const [kind, setKind] = useState<VaultKind>("weekly");
  const [perBuy, setPerBuy] = useState("100");
  const [pay, setPay] = useState<Pay>("USDG");
  const [upfront, setUpfront] = useState("");

  const vault = vaults?.[kind];
  const info = byKind[kind];
  const user = useUser(dir, vault);
  const stockObj = stocks.find((s) => s.address === stock) ?? stocks[0];
  const stockAddr = stockObj?.address;

  const priceTokens = useMemo(() => stocks.map((s) => ({ address: s.address, decimals: s.decimals })), [stocks]);
  const { prices } = usePrices(dir?.router, dir?.usdg, priceTokens);

  // Rank by on-chain market cap (total supply × router price); stocks with no route yet sort last.
  const rankedStocks = useMemo(() => {
    const marketCapOf = (s: Stock) => valueOf(s.totalSupply, prices[s.address.toLowerCase()], s.decimals) ?? 0n;
    return [...stocks].sort((a, b) => {
      const diff = marketCapOf(b) - marketCapOf(a);
      return diff > 0n ? 1 : diff < 0n ? -1 : a.symbol.localeCompare(b.symbol);
    });
  }, [stocks, prices]);
  const topStocks = rankedStocks.slice(0, 5);

  const perBuyWei = safeParse(perBuy, USDG_DECIMALS);
  const upfrontWei = pay === "USDG" ? safeParse(upfront, USDG_DECIMALS) : safeParseEth(upfront);

  // Balances → slider ranges
  const usdgBal = user.usdg ?? 0n;
  const ethBal = user.eth ?? 0n;
  const ethMax = ethBal > ETH_GAS_RESERVE ? ethBal - ETH_GAS_RESERVE : 0n;
  const sliderMax = pay === "USDG" ? Math.floor(Number(formatUnits(usdgBal, USDG_DECIMALS))) : Number(formatEther(ethMax));
  const sliderStep = pay === "USDG" ? 1 : 0.001;
  const sliderVal = Number(upfront) || 0;

  // ETH → USDG preview (also used for minOut)
  const zapQuote = useQuote(dir?.router, dir?.weth, dir?.usdg, pay === "ETH" ? upfrontWei : undefined);
  const upfrontUsdg = pay === "USDG" ? upfrontWei : zapQuote.data?.amountOut;
  const buysCovered = upfrontUsdg !== undefined && perBuyWei && perBuyWei > 0n ? Number(upfrontUsdg / perBuyWei) : undefined;

  const allowance = useReadContract({
    address: dir?.usdg,
    abi: ERC20Abi,
    functionName: "allowance",
    args: address && vault ? [address, vault] : undefined,
    query: { enabled: !!dir && !!address && !!vault && pay === "USDG" },
  });
  const needsApproval = pay === "USDG" && !!upfrontWei && upfrontWei > 0n && (allowance.data ?? 0n) < upfrontWei;

  const seq = useTxSequence(() => {
    refetchVaults();
    user.refetch();
    allowance.refetch();
  });
  // Any input change after a success starts a fresh order.
  useEffect(() => {
    if (seq.done || seq.error) seq.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock, kind, perBuy, pay, upfront]);

  const walletBal = pay === "USDG" ? usdgBal : ethBal;
  const insufficient = upfrontWei !== undefined && upfrontWei > walletBal;
  const perBuyOk = !!perBuyWei && perBuyWei > 0n;
  const quoteMissing = pay === "ETH" && !!upfrontWei && upfrontWei > 0n && zapQuote.data === undefined;
  const canSubmit = !!address && !!vault && !!stockAddr && perBuyOk && !insufficient && !quoteMissing && !seq.running;

  const submit = async () => {
    if (!vault || !stockAddr || !perBuyWei || !dir) return;
    const usdgAmount = pay === "USDG" ? (upfrontWei ?? 0n) : 0n;
    const value = pay === "ETH" ? (upfrontWei ?? 0n) : 0n;
    const minOut = pay === "ETH" && zapQuote.data ? (zapQuote.data.amountOut * 9_950n) / 10_000n : 0n;
    const steps: TxStep[] = [];
    if (needsApproval) steps.push({ label: "Approve USDG", params: { address: dir.usdg, abi: ERC20Abi, functionName: "approve", args: [vault, usdgAmount] } });
    steps.push({
      label: "Start plan",
      params: { address: vault, abi: PlanVaultAbi, functionName: "createPlan", args: [stockAddr, perBuyWei, false, ZERO, usdgAmount, 0n, minOut], value },
    });
    await seq.run(steps);
  };

  if (!configured) return <Notice kind="warn">App is not configured: set NEXT_PUBLIC_DIRECTORY.</Notice>;

  const monthly = perBuyWei ? (perBuyWei * BigInt(Math.round(buysPerMonthOf(kind, info?.epochLength) * 100))) / 100n : 0n;
  const feeBps = user.effectiveFeeBps ?? info?.fees?.purchaseFeeBps;

  return (
    <>
      <PageHeader title="Create a plan" description="Pick a stock, choose how often to buy, and fund it. The rest runs itself." />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          {/* 1 · Stock */}
          <Step n={1} title="Choose a stock" right={<span className="text-[12px] text-ink-3">{stocks.length} supported</span>}>
            {stocks.length === 0 ? (
              <p className="text-[13px] text-ink-3">No stocks are listed yet.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-ink-3 items-center flex">Top stocks:</span>
                {topStocks.map((s) => {
                  const p = prices[s.address.toLowerCase()];
                  const active = stockAddr === s.address;
                  return (
                    <button
                      key={s.address}
                      type="button"
                      onClick={() => setStock(s.address)}
                      className={`inline-flex h-8 items-center gap-2 rounded-full border pr-3 pl-1.5 text-[13px] font-semibold transition-colors ${
                        active ? "border-lime bg-lime/10 text-ink" : "border-line-strong bg-surface-3 text-ink-2 hover:border-ink hover:text-ink"
                      }`}
                    >
                      <StockAvatar symbol={s.symbol} size={26} />
                      {s.symbol}
                      {/* <span className="font-normal text-ink-3">{p !== undefined ? fmtUsd(p) : "—"}</span> */}
                      {active && <Icon name="check" size={14} className="text-lime" />}
                    </button>
                  );
                })}
                <div className="ml-auto w-full sm:w-60">
                  <StockSearch stocks={rankedStocks} prices={prices} value={stockAddr ?? ""} onSelect={setStock} />
                </div>
              </div>
            )}
          </Step>

          {/* 2 · Frequency */}
          <Step n={2} title="How often">
            <div className={`grid gap-2 ${VAULT_KINDS.length > 3 ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3"}`}>
              {VAULT_KINDS.map((k) => {
                const active = kind === k;
                return (
                  <button key={k} type="button" onClick={() => setKind(k)} className={`tile px-4 py-4 ${active ? "tile-active" : ""}`}>
                    <span className="flex h-5 items-center justify-between">
                      <span className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                        {VAULT_META[k].label}
                        {k === "test" && <span className="chip-dev">dev</span>}
                      </span>
                      {active && <Icon name="check" className="text-lime" />}
                    </span>
                    {/* <span className="mt-1 block text-[12px] text-ink-3">{cadenceOf(k, byKind[k]?.epochLength)}</span> */}
                    <span className="mt-2 block text-[12px] text-ink-2">{VAULT_META[k].blurb}</span>
                  </button>
                );
              })}
            </div>
          </Step>

          {/* 3 · Amount per buy */}
          <Step n={3} title={`Amount per ${VAULT_META[kind].per}`}>
            <AmountInput value={perBuy} onChange={setPerBuy} unit="USDG" large placeholder="100" />
            <div className="mt-3">
              <Slider value={Number(perBuy) || PER_MIN} min={PER_MIN} max={PER_MAX} step={10} onChange={(v) => setPerBuy(String(v))} ariaLabel="Amount per buy" />
              <div className="flex justify-between text-[11px] text-ink-3">
                <span>${PER_MIN}</span>
                <span>${PER_MAX.toLocaleString()}+</span>
              </div>
            </div>
            <p className="mt-3 text-[12px] text-ink-3">
              {perBuyOk ? (
                <>
                  About <span className="num text-ink-2">{fmtUsd(monthly)}</span> a month, spent while the plan has funds. Change it any time.
                </>
              ) : (
                "Enter how much USDG to spend on each buy."
              )}
            </p>
          </Step>

          {/* 4 · Fund upfront */}
          <Step
            n={4}
            title="Fund the plan"
            right={
              <Segmented<Pay>
                value={pay}
                onChange={(p) => {
                  setPay(p);
                  setUpfront("");
                }}
                options={[
                  { value: "USDG", label: "USDG" },
                  { value: "ETH", label: "ETH" },
                ]}
              />
            }
          >
            <AmountInput
              value={upfront}
              onChange={setUpfront}
              unit={pay}
              large
              placeholder="0"
              onMax={address ? () => setUpfront(pay === "USDG" ? formatUnits(usdgBal, USDG_DECIMALS) : formatEther(ethMax)) : undefined}
            />
            <div className="mt-3">
              <Slider value={sliderVal} min={0} max={sliderMax} step={sliderStep} onChange={(v) => setUpfront(pay === "USDG" ? String(v) : v.toFixed(3))} disabled={!address} ariaLabel="Upfront amount" />
              <div className="flex justify-between text-[11px] text-ink-3">
                <span>0</span>
                <span>
                  Balance: {address ? (pay === "USDG" ? fmtUsd(usdgBal) : `${fmtUnits(ethBal, 18)} ETH`) : "—"}
                </span>
              </div>
            </div>
            <p className="mt-3 text-[12px] text-ink-3">
              {pay === "ETH" && upfrontWei && upfrontWei > 0n ? (
                <>
                  Converted to <span className="num text-ink-2">{zapQuote.data ? `≈ ${fmtUsd(zapQuote.data.amountOut)}` : "…"}</span> USDG when you start the plan.{" "}
                </>
              ) : null}
              {buysCovered !== undefined && buysCovered > 0 ? (
                <>
                  Covers <span className="text-ink-2">{buysCovered.toLocaleString()}</span> {buysCovered === 1 ? "buy" : "buys"}.
                </>
              ) : (
                "Optional now — you can top up later from My plans."
              )}
            </p>
          </Step>
        </div>

        {/* Summary */}
        <div className="xl:sticky xl:top-4 xl:self-start">
          <Card title="Your plan">
            {seq.done ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-lime text-lime-ink">
                    <Icon name="check" size={18} />
                  </span>
                  <div>
                    <div className="text-[15px] font-semibold text-ink">Plan started</div>
                    <div className="text-[12px] text-ink-3">First buy at the next {kind === "test" ? "epoch" : VAULT_META[kind].label.toLowerCase()} boundary.</div>
                  </div>
                </div>
                <Link href="/app/plans" className="btn-primary w-full">
                  View my plans
                </Link>
                <button type="button" className="btn-ghost w-full" onClick={() => seq.reset()}>
                  Create another
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 border-b border-line pb-4">
                  <StockAvatar symbol={stockObj?.symbol ?? "?"} size={36} />
                  <div>
                    <div className="text-[16px] font-semibold text-ink">{stockObj?.symbol ?? "—"}</div>
                    <div className="text-[12px] text-ink-3">
                      {fmtUsd(perBuyWei ?? 0n)} every {VAULT_META[kind].per}
                    </div>
                  </div>
                </div>
                <div className="pt-2">
                  <KV k="Frequency" v={VAULT_META[kind].label} mono={false} />
                  <KV k="Per buy" v={fmtUsd(perBuyWei ?? 0n)} />
                  <KV k="Upfront" v={upfrontWei && upfrontWei > 0n ? `${upfront} ${pay}` : "None"} />
                  {pay === "ETH" && upfrontWei && upfrontWei > 0n && <KV k="As USDG" v={zapQuote.data ? `≈ ${fmtUsd(zapQuote.data.amountOut)}` : "…"} />}
                  <KV k="First buy" v={<Countdown target={info?.nextEpochStart} />} />
                  {info?.nextEpochStart && <div className="-mt-1 text-right text-[11px] text-ink-3">{tsToShort(info.nextEpochStart)}</div>}
                </div>

                <div className="mt-4 flex items-start gap-3 rounded-xl border border-lime/20 bg-lime/5 p-4">
                  <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-lime text-[11px] font-bold text-lime-ink">$</span>
                  <div className="text-[13px] leading-relaxed text-ink-2">
                    <b className="text-ink">Hold $DCA</b> for automatic stock distributions to your wallet, and with lower fees on every plan.{" "}<br/>
                    <Link href={`${DOCS_PATH}#dca`} className="font-semibold text-lime hover:underline">
                      Find out more →
                    </Link>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  {!address ? (
                    <ConnectButton className="w-full" />
                  ) : (
                    <button type="button" className="btn-primary h-10 w-full" disabled={!canSubmit} onClick={submit}>
                      {seq.running ? (
                        <>
                          <Spinner /> {seq.label}
                          {seq.total > 1 ? ` (${seq.step + 1}/${seq.total})` : ""}
                        </>
                      ) : needsApproval ? (
                        "Approve & start plan"
                      ) : (
                        "Start plan"
                      )}
                    </button>
                  )}
                  {insufficient && <Notice kind="error">Not enough {pay} in your wallet.</Notice>}
                  {seq.error && <Notice kind="error">{seq.error}</Notice>}
                </div>

                <p className="mt-4 text-[11px] leading-relaxed text-ink-3">
                  A purchase fee of {fmtBps(feeBps)} is taken on each buy before the swap
                  {info?.fees ? `; claiming stock costs ${fmtBps(info.fees.claimFeeBps)} (free for $DCA holders)` : ""}. Buys route through on-chain
                  liquidity with a {fmtBps(info?.fees?.swapSlippageBps)} slippage tolerance. Stock Tokens are economic exposure, not shareholder rights.
                </p>
              </>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

/** Searchable stock picker — matches name or symbol; shows the current selection once made. */
function StockSearch({
  stocks,
  prices,
  value,
  onSelect,
}: {
  stocks: Stock[];
  prices: PriceMap;
  value: string;
  onSelect: (address: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = q ? stocks.filter((s) => s.symbol.toLowerCase().includes(q) || tickerName(s.symbol).toLowerCase().includes(q)) : stocks;
  const selected = stocks.find((s) => s.address === value);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`tile flex h-10 w-full items-center gap-3 px-3 py-1.5 ${selected ? "tile-active" : ""}`}
      >
        {selected ? (
          <>
            <StockAvatar symbol={selected.symbol} size={24} />
            <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{selected.symbol}</span>
          </>
        ) : (
          <span className="text-[13px] text-ink-3">Search by name</span>
        )}
        <Icon name="chevron" size={14} className={`ml-auto shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="menu absolute inset-x-0 top-[calc(100%+6px)] z-10 max-h-72 overflow-y-auto">
          <div className="sticky top-0 border-b border-line bg-surface-3 p-2">
            <input
              autoFocus
              className="input h-9"
              placeholder="Search by name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-ink-3">No stocks match &ldquo;{query}&rdquo;.</div>
          ) : (
            filtered.map((s) => {
              const p = prices[s.address.toLowerCase()];
              return (
                <button
                  key={s.address}
                  type="button"
                  onClick={() => {
                    onSelect(s.address);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={`menu-item gap-3 ${s.address === value ? "bg-surface-4 text-ink" : ""}`}
                >
                  <StockAvatar symbol={s.symbol} size={22} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block text-[13px] font-semibold text-ink">{s.symbol}</span>
                    <span className="block truncate text-[11px] text-ink-3">{tickerName(s.symbol)}</span>
                  </span>
                  <span className="shrink-0 text-[12px] text-ink-3">{p !== undefined ? fmtUsd(p) : "—"}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function Step({ n, title, right, children }: { n: number; title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-1">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-surface-3 text-[12px] font-semibold text-ink-2">{n}</span>
          {title}
        </span>
      }
      actions={right}
    >
      {children}
    </Card>
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
function safeParseEth(v: string): bigint | undefined {
  try {
    if (!v.trim()) return undefined;
    return parseEther(v.trim());
  } catch {
    return undefined;
  }
}
