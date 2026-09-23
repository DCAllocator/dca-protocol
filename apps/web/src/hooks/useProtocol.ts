"use client";

import { useMemo } from "react";
import { useAccount, useBalance, useReadContract, useReadContracts, usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { VaultDirectoryAbi, StockRegistryAbi, PlanVaultAbi, ERC20Abi, ClaimHelperAbi, AggregatorRouterAbi, MorphoBlueStrategyAbi, IMorphoAbi } from "@/abi";
import { Market, UnsupportedMarketIrmError } from "@morpho-org/blue-sdk";
import type { PublicClient } from "viem";
import { ADDRESSES, isZero, TEST_VAULT, VAULT_KINDS, SECONDS_PER_YEAR, DCA_PERK_DEFAULTS, USDG_DECIMALS, type VaultKind } from "@/lib/config";
import { valueOf } from "@/lib/format";
import { usePersistedQuery } from "@/lib/persistedQuery";
import marketCapSnapshot from "@/data/market-caps.json";

/** Periodic CoinGecko snapshot of each Stock Token's market cap (symbol → USD), see scripts/snapshot-market-caps.mjs. */
const STOCK_MARKET_CAPS: Record<string, number> = marketCapSnapshot.marketCaps;

/** VaultDirectory.Entry, field for field (vaults first, fastest first: the on-chain `vaults()` order). */
export type Directory = {
  hourly: Address;
  daily: Address;
  weekly: Address;
  monthly: Address;
  registry: Address;
  router: Address;
  usdg: Address;
  weth: Address;
  dca: Address;
};

/** Vault address per kind. `test` is present only when the dev-only TEST_VAULT is enabled (see lib/config). */
export type VaultMap = Record<VaultKind, Address>;

/** Every shown vault's address, in VAULT_KINDS order. */
export const vaultList = (vaults: VaultMap): Address[] => VAULT_KINDS.map((k) => vaults[k]);

/**
 * VaultDirectory.get() — the single on-chain bootstrap point (plus the local test vault when enabled). Persisted across
 * page loads (lib/persistedQuery), so a reload knows every address — and can show the cached stock list — before
 * this read answers.
 */
export function useDirectory() {
  const client = usePublicClient();
  const configured = !isZero(ADDRESSES.directory);
  const q = usePersistedQuery({
    name: "directory",
    address: configured ? ADDRESSES.directory : undefined,
    enabled: !!client,
    staleTime: 60_000,
    refetchInterval: false,
    queryFn: (): Promise<Directory> => client!.readContract({ address: ADDRESSES.directory, abi: VaultDirectoryAbi, functionName: "get" }),
  });
  const dir = q.data;
  const vaults = useMemo<VaultMap | undefined>(
    () => (dir ? ({ hourly: dir.hourly, daily: dir.daily, weekly: dir.weekly, monthly: dir.monthly, ...(TEST_VAULT ? { test: TEST_VAULT } : {}) } as VaultMap) : undefined),
    [dir],
  );
  return { dir, vaults, isLoading: q.isLoading, error: q.error, configured };
}

export type Stock = {
  address: Address;
  symbol: string;
  decimals: number;
  approved: boolean;
  feeOnTransfer: boolean;
};

/**
 * approvedStocks(), then every stock's info() in the same tick: viem sends those as one Multicall3 aggregate3 where the
 * chain has it (plain eth_calls otherwise — never `client.multicall`, which throws on a chain without Multicall3).
 * All or nothing: any failed read rejects, so a partial list is never shown or persisted.
 */
async function readStockList(client: PublicClient, registry: Address): Promise<Stock[]> {
  const addrs = await client.readContract({ address: registry, abi: StockRegistryAbi, functionName: "approvedStocks" });
  const infos = await Promise.all(addrs.map((a) => client.readContract({ address: registry, abi: StockRegistryAbi, functionName: "info", args: [a] })));
  return addrs.map((address, i) => {
    const { symbol, decimals, approved, feeOnTransfer } = infos[i];
    return { address, symbol, decimals, approved, feeOnTransfer };
  });
}

/** `useStocks` until the list has loaded, so `useTvl` can tell "not loaded yet" from an empty registry. */
const NO_STOCKS: Stock[] = [];

/**
 * Approved stocks + metadata from the registry, as one query (see `readStockList`). Persisted across page loads
 * (lib/persistedQuery): a reload renders the last good list at once and revalidates it in the background.
 */
export function useStocks(registry?: Address) {
  const client = usePublicClient();
  const q = usePersistedQuery({
    name: "stockList",
    address: registry,
    enabled: !!client,
    staleTime: 60_000,
    refetchInterval: false,
    queryFn: () => readStockList(client!, registry!),
  });
  const stocks = q.data ?? NO_STOCKS;
  const bySymbol = useMemo(() => Object.fromEntries(stocks.map((s) => [s.address.toLowerCase(), s])), [stocks]);
  return { stocks, byAddress: bySymbol, isLoading: q.isLoading };
}

export type FeeConfig = {
  purchaseFeeBps: number;
  depositFeeBps: number;
  withdrawFeeBps: number;
  claimFeeBps: number;
  keeperTipBps: number;
  swapSlippageBps: number;
};

export type VaultInfo = {
  address: Address;
  kind: VaultKind;
  fees?: FeeConfig;
  nextEpochStart?: bigint;
  epochLength?: number;
  currentEpochId?: number;
  totalUsdgIdle?: bigint;
  totalNotionalUsdg?: bigint;
  epochsCompleted?: bigint;
  autoDistributeThreshold?: bigint;
  feeHalveThreshold?: bigint;
  /** Smallest `amountPerEpoch` a plan may have (USDG units). */
  minAmountPerEpoch?: bigint;
  /** Smallest USDG credit a deposit (or plan creation) must produce — ETH deposits after conversion. */
  minDeposit?: bigint;
  paused?: boolean;
  /** ERC-4626 strategy boosted plans lend through (MorphoBlueStrategy); zero address = boost unavailable. */
  boostStrategy?: Address;
  /** USDG the vault has lent out for boosted plans, yield included. */
  boostAssets?: bigint;
};

/** Whether plans on this vault can be boosted (a strategy is wired up). */
export const boostAvailable = (info?: VaultInfo) => !!info && !isZero(info.boostStrategy);

/** Static-ish vault parameters + live aggregates for every shown vault. */
export function useVaults(vaults?: VaultMap) {
  const fns = [
    "fees",
    "nextEpochStart",
    "epochLength",
    "currentEpochId",
    "totalUsdgIdle",
    "totalNotionalUsdg",
    "epochsCompleted",
    "autoDistributeThreshold",
    "feeHalveThreshold",
    "minAmountPerEpoch",
    "minDeposit",
    "paused",
    "boostStrategy",
    "boostAssets",
  ] as const;
  const contracts = vaults
    ? VAULT_KINDS.flatMap((k) => fns.map((functionName) => ({ address: vaults[k], abi: PlanVaultAbi, functionName }) as const))
    : [];
  const q = useReadContracts({ contracts, query: { enabled: !!vaults } });
  const infos: VaultInfo[] = useMemo(() => {
    if (!vaults) return [];
    return VAULT_KINDS.map((kind, vi) => {
      const get = (i: number) => q.data?.[vi * fns.length + i]?.result;
      const f = get(0) as FeeConfig | undefined;
      return {
        address: vaults[kind],
        kind,
        fees: f,
        nextEpochStart: get(1) as bigint | undefined,
        epochLength: get(2) as number | undefined,
        currentEpochId: get(3) as number | undefined,
        totalUsdgIdle: get(4) as bigint | undefined,
        totalNotionalUsdg: get(5) as bigint | undefined,
        epochsCompleted: get(6) as bigint | undefined,
        autoDistributeThreshold: get(7) as bigint | undefined,
        feeHalveThreshold: get(8) as bigint | undefined,
        minAmountPerEpoch: get(9) as bigint | undefined,
        minDeposit: get(10) as bigint | undefined,
        paused: get(11) as boolean | undefined,
        boostStrategy: get(12) as Address | undefined,
        boostAssets: get(13) as bigint | undefined,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaults, q.data]);
  return { infos, byKind: Object.fromEntries(infos.map((i) => [i.kind, i])) as Record<VaultKind, VaultInfo | undefined>, isLoading: q.isLoading, refetch: q.refetch };
}

/**
 * $DCA balances that unlock the holder perks (raw units), live from the vaults; the deploy defaults stand in
 * until the chain responds. Every vault is deployed with the same pair, so the first one is read.
 */
export function usePerkThresholds() {
  const { vaults } = useDirectory();
  const { infos } = useVaults(vaults);
  return {
    autoDistribute: infos[0]?.autoDistributeThreshold ?? DCA_PERK_DEFAULTS.autoDistribute,
    feeHalve: infos[0]?.feeHalveThreshold ?? DCA_PERK_DEFAULTS.feeHalve,
  };
}

/** Wallet balances (USDG, WETH, native ETH, $DCA) + $DCA perks for the connected account. */
export function useUser(dir?: Directory, vault?: Address) {
  const { address } = useAccount();
  const eth = useBalance({ address, query: { enabled: !!address } });
  const q = useReadContracts({
    contracts:
      dir && address
        ? ([
            { address: dir.usdg, abi: ERC20Abi, functionName: "balanceOf", args: [address] },
            { address: dir.weth, abi: ERC20Abi, functionName: "balanceOf", args: [address] },
            ...(isZero(dir.dca) ? [] : [{ address: dir.dca, abi: ERC20Abi, functionName: "balanceOf", args: [address] } as const]),
            ...(vault
              ? [
                  { address: vault, abi: PlanVaultAbi, functionName: "effectivePurchaseFeeBps", args: [address] } as const,
                  { address: vault, abi: PlanVaultAbi, functionName: "isAutoDistribute", args: [address] } as const,
                ]
              : []),
          ] as const)
        : [],
    query: { enabled: !!dir && !!address },
  });
  const hasDca = !!dir && !isZero(dir.dca);
  const base = hasDca ? 3 : 2;
  return {
    address,
    usdg: q.data?.[0]?.result as bigint | undefined,
    weth: q.data?.[1]?.result as bigint | undefined,
    eth: eth.data?.value,
    dca: hasDca ? (q.data?.[2]?.result as bigint | undefined) : 0n,
    effectiveFeeBps: vault ? (q.data?.[base]?.result as number | undefined) : undefined,
    autoDistribute: vault ? (q.data?.[base + 1]?.result as boolean | undefined) : undefined,
    refetch: () => {
      q.refetch();
      eth.refetch();
    },
  };
}

export type Position = {
  vault: Address;
  planId: bigint;
  stock: Address;
  recipient: Address;
  amountPerEpoch: bigint;
  /** USDG held by the vault for this plan (0 for a boosted plan, bar small residuals). */
  usdgIdle: bigint;
  stockAccrued: bigint;
  lastEpochId: number;
  paused: boolean;
  /** Idle USDG is lent through the vault's boost strategy (Morpho Blue). */
  boosted: boolean;
  /** USDG currently lent out for this plan, yield included. */
  boostValue: bigint;
  /** Cost basis of `boostValue`; the difference is yield not yet realised. */
  boostPrincipal: bigint;
  /** Yield already realised by spends / withdrawals (cumulative). */
  boostEarned: bigint;
};

/** Everything the plan can spend or withdraw: vault-held USDG plus the boosted balance. */
export const planBalance = (p: Position) => p.usdgIdle + p.boostValue;
/** Lifetime boost earnings: realised so far plus whatever the position is currently up (never negative). */
export const boostEarnings = (p: Position) => p.boostEarned + (p.boostValue > p.boostPrincipal ? p.boostValue - p.boostPrincipal : 0n);

/** All of the user's plans across every shown vault via ClaimHelper. */
export function usePositions(vaults?: VaultMap) {
  const { address } = useAccount();
  const q = useReadContract({
    address: ADDRESSES.claimHelper,
    abi: ClaimHelperAbi,
    functionName: "positions",
    args: vaults && address ? [vaultList(vaults), address] : undefined,
    query: { enabled: !!vaults && !!address && !isZero(ADDRESSES.claimHelper) },
  });
  return { positions: (q.data ?? []) as readonly Position[], isLoading: q.isLoading, refetch: q.refetch };
}

export const kindOf = (vaults: VaultMap | undefined, a: Address): VaultKind | undefined =>
  vaults ? (VAULT_KINDS.find((k) => vaults[k].toLowerCase() === a.toLowerCase()) as VaultKind | undefined) : undefined;

/** How a strategy's APY was obtained (see `useBoostApys`). */
export type BoostApy = {
  /** Supply APY as a fraction (0.0494 = 4.94%); undefined while loading or when the strategy exposes no rate. */
  apy?: number;
  /** `morpho`: Morpho's own definition via the blue-sdk. `strategy`: the on-chain average-rate fallback. */
  source: "morpho" | "strategy";
};

/** AdaptiveCurveIrm's stored rate at target utilisation (int256, WAD per second). Only this IRM has it. */
const AdaptiveCurveIrmAbi = [
  { type: "function", name: "rateAtTarget", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "int256" }] },
] as const;

/**
 * Supply APY of one boost strategy, computed the way Morpho computes it.
 *
 * Primary path — Morpho's own maths (`@morpho-org/blue-sdk` `Market.getSupplyApy`): read the market's totals,
 * fee and `lastUpdate` from Morpho Blue plus the AdaptiveCurveIrm's `rateAtTarget`, then
 * `expm1(endBorrowRate × utilisation × (1 − fee) × 1 year)` where `endBorrowRate` is the IRM's instantaneous
 * rate at the chain's current timestamp (the number the Morpho app shows).
 *
 * Fallback — the strategy's `supplyRatePerSecond()` = `borrowRateView × utilisation × (1 − fee)`. That uses the
 * IRM's *average* rate since the market was last touched (what Morpho pays for that period); it equals the
 * instantaneous rate whenever the market was touched this block and only drifts on an idle market. The SDK
 * throws `UnsupportedMarketIrmError` for IRMs without `rateAtTarget` (e.g. the local MockIrm) — that is when
 * the fallback is used.
 */
async function readStrategyApy(client: PublicClient, strategy: Address, now: bigint): Promise<BoostApy> {
  // Plain reads rather than multicall: a chain without Multicall3 (viem's `anvil` definition) must work too.
  const s = { address: strategy, abi: MorphoBlueStrategyAbi } as const;
  const [morpho, marketId, params, rate] = await Promise.all([
    tryRead(() => client.readContract({ ...s, functionName: "morpho" })),
    tryRead(() => client.readContract({ ...s, functionName: "marketId" })),
    tryRead(() => client.readContract({ ...s, functionName: "marketParams" })),
    tryRead(() => client.readContract({ ...s, functionName: "supplyRatePerSecond" })),
  ]);
  const fallback: BoostApy = { apy: rate === undefined ? undefined : apyFromRate(rate), source: "strategy" };
  if (!morpho || !marketId || !params) return fallback;
  const [market, rateAtTarget] = await Promise.all([
    tryRead(() => client.readContract({ address: morpho, abi: IMorphoAbi, functionName: "market", args: [marketId] })),
    tryRead(() => client.readContract({ address: params.irm, abi: AdaptiveCurveIrmAbi, functionName: "rateAtTarget", args: [marketId] })),
  ]);
  if (!market) return fallback;
  try {
    const apy = new Market({
      params: { loanToken: params.loanToken, collateralToken: params.collateralToken, oracle: params.oracle, irm: params.irm, lltv: params.lltv },
      totalSupplyAssets: market.totalSupplyAssets,
      totalSupplyShares: market.totalSupplyShares,
      totalBorrowAssets: market.totalBorrowAssets,
      totalBorrowShares: market.totalBorrowShares,
      lastUpdate: market.lastUpdate,
      fee: market.fee,
      rateAtTarget,
    }).getSupplyApy(now);
    return { apy, source: "morpho" };
  } catch (e) {
    if (e instanceof UnsupportedMarketIrmError) return fallback;
    throw e;
  }
}

/** A contract read that resolves to undefined instead of throwing (missing function, revert, no code). */
async function tryRead<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * Live supply APY of every boost strategy in use, keyed by strategy address (lower-case), evaluated at the
 * chain's latest block timestamp (not the wall clock: a local anvil can be warped). Refreshes every 30 s —
 * the rate moves with the market. See `readStrategyApy` for the two sources.
 */
export function useBoostApys(infos?: VaultInfo[]) {
  const client = usePublicClient();
  const strategies = useMemo(
    () => Array.from(new Set((infos ?? []).map((v) => v.boostStrategy).filter((a): a is Address => !!a && !isZero(a)).map((a) => a.toLowerCase() as Address))),
    [infos],
  );
  const q = useQuery({
    queryKey: ["boostApy", strategies.join(",")],
    enabled: !!client && strategies.length > 0,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      const block = await client!.getBlock();
      const out: Record<string, BoostApy> = {};
      await Promise.all(strategies.map(async (a) => (out[a] = await readStrategyApy(client!, a, block.timestamp))));
      return out;
    },
  });
  return useMemo(() => {
    const apys = q.data ?? {};
    return {
      apys,
      apyOf: (strategy?: Address) => (strategy ? apys[strategy.toLowerCase()]?.apy : undefined),
      sourceOf: (strategy?: Address) => (strategy ? apys[strategy.toLowerCase()]?.source : undefined),
      isLoading: q.isLoading,
    };
  }, [q.data, q.isLoading]);
}

/** Per-second WAD rate → APY fraction (0.0494 = 4.94%), continuously compounded — Morpho's `rateToApy`. */
export const apyFromRate = (ratePerSecond: bigint): number => Math.expm1((Number(ratePerSecond) / 1e18) * SECONDS_PER_YEAR);

/** Router quote via eth_call simulation (quote() is state-changing because adapters simulate swaps). */
export function useQuote(router?: Address, tokenIn?: Address, tokenOut?: Address, amountIn?: bigint) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["quote", router, tokenIn, tokenOut, amountIn?.toString()],
    enabled: !!client && !!router && !!tokenIn && !!tokenOut && !!amountIn && amountIn > 0n,
    retry: false,
    refetchInterval: 20_000,
    queryFn: async () => {
      const { result } = await client!.simulateContract({
        address: router!,
        abi: AggregatorRouterAbi,
        functionName: "quote",
        args: [tokenIn!, tokenOut!, amountIn!],
      });
      return { amountOut: result[0] as bigint, hops: (result[1] as readonly unknown[]).length };
    },
  });
}

/** One whole USDG, the probe amount `useBuyDcaRoute` quotes with. */
const ONE_USDG = 10n ** BigInt(USDG_DECIMALS);

/**
 * Can $DCA be bought in-app on this chain? True when the directory names a token and the router quotes
 * USDG → $DCA for 1 USDG (hops are directional, so this is the buy direction — `useDcaToken` quotes the
 * other way for the price). The source of truth is the router, not the FeeReceiver or the adapters'
 * approved-hop list: a quote that comes back is proof of a live, routable pool. `isLoading` is true only
 * while the first probe is in flight, so a caller can reserve the tab's slot and hide it only on a settled
 * failure. An ETH-paired Pons / Uniswap v4 pool does NOT light this up (the router cannot route native-ETH
 * pools); use BUY_DCA_TAB_FORCED for that case.
 */
export function useBuyDcaRoute(dir?: Directory) {
  const configured = !!dir && !isZero(dir.dca);
  const q = useQuote(configured ? dir.router : undefined, dir?.usdg, dir?.dca, ONE_USDG);
  return { configured, available: configured && q.data !== undefined, isLoading: configured && q.isLoading };
}

/* ------------------------------------------------------------------ */
/* Prices, holdings, TVL                                                */
/* ------------------------------------------------------------------ */

export type PriceMap = Record<string, bigint | undefined>; // lower(address) → USDG per whole token

/**
 * AggregatorRouter.quote declared `view`. The router marks it nonpayable only because the adapters simulate each swap
 * and revert it, so under eth_call it reads exactly what `simulateContract` returns (checked stock by stock on a fork).
 * As a read it joins viem's call batching — one Multicall3 aggregate3 per ~80 same-tick quotes where the chain has
 * it — which `simulateContract` (always `batch: false`) never does.
 */
const RouterQuoteViewAbi = [
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      {
        name: "path",
        type: "tuple[]",
        components: [
          { name: "protocol", type: "uint8" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "extra", type: "bytes" },
        ],
      },
    ],
  },
] as const;

/**
 * USDG price of one whole unit of each token, via the router's quote() (as a batched read, see
 * `RouterQuoteViewAbi`). Quoting a single unit (not the full amount) keeps the read under the router's impact
 * cap. Tokens with no route resolve to undefined and are simply not valued.
 */
export function usePrices(router?: Address, usdg?: Address, tokens?: { address: Address; decimals: number }[]) {
  const client = usePublicClient();
  const key = tokens?.map((t) => `${t.address.toLowerCase()}:${t.decimals}`).join(",") ?? "";
  const q = useQuery({
    queryKey: ["prices", router, usdg, key],
    enabled: !!client && !!router && !!usdg && !!tokens && tokens.length > 0,
    retry: false,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const results = await Promise.allSettled(
        tokens!.map((t) =>
          client!.readContract({
            address: router!,
            abi: RouterQuoteViewAbi,
            functionName: "quote",
            args: [t.address, usdg!, 10n ** BigInt(t.decimals)],
          }),
        ),
      );
      const out: PriceMap = {};
      tokens!.forEach((t, i) => {
        const r = results[i];
        out[t.address.toLowerCase()] = r.status === "fulfilled" ? r.value[0] : undefined;
      });
      return out;
    },
  });
  return { prices: q.data ?? ({} as PriceMap), isLoading: q.isLoading, ready: q.data !== undefined };
}

/** Number of stocks the create page shows as "Popular". */
export const TOP_STOCKS = 5;

/**
 * The registry's stocks ranked by market cap, from the periodic CoinGecko snapshot (each Stock Token is
 * listed on CoinGecko under the "Robinhood Chain Stocks Ecosystem" category, market cap = circulating
 * supply × price aggregated across venues). That snapshot is a static import — no network call on page
 * load — refreshed by `pnpm snapshot:market-caps` (also run on a schedule, see
 * .github/workflows/snapshot-market-caps.yml). Stocks missing from the snapshot (newly approved, or not
 * yet listed on CoinGecko) keep their place at the bottom in symbol order. `ready` flips once the
 * registry has answered: until then `top` is empty rather than an alphabetical guess, so the "Popular"
 * row never shows the wrong five and then flips.
 *
 * No prices here on purpose: quoting every registry stock through the router cost one `eth_call` per
 * stock per minute on every page that ranks stocks, and the picker does not need a price to choose a
 * stock. Pages that show USD values (dashboard, plans, token) call `usePrices` for just what they show.
 */
export function useRankedStocks(dir?: Directory) {
  const { stocks, byAddress, isLoading: stocksLoading } = useStocks(dir?.registry);
  return useMemo(() => {
    const marketCapOf = (s: Stock) => STOCK_MARKET_CAPS[s.symbol.toUpperCase()];
    const ranked = [...stocks].sort((a, b) => {
      const diff = (marketCapOf(b) ?? 0) - (marketCapOf(a) ?? 0);
      return diff !== 0 ? diff : a.symbol.localeCompare(b.symbol);
    });
    const ready = stocks.length > 0 && !stocksLoading;
    const top = ready ? ranked.filter((s) => (marketCapOf(s) ?? 0) > 0).slice(0, TOP_STOCKS) : [];
    return { stocks, byAddress, ranked, top, marketCapOf, ready };
  }, [stocks, byAddress, stocksLoading]);
}

/** Stock still sitting on each vault (accrued, not yet claimed), per stock and in total. */
export function useStockHoldings(vaults?: VaultMap, stocks?: Stock[]) {
  const contracts =
    vaults && stocks
      ? VAULT_KINDS.flatMap((k) =>
          stocks.map((s) => ({ address: vaults[k], abi: PlanVaultAbi, functionName: "totalStockAccrued", args: [s.address] }) as const),
        )
      : [];
  const q = useReadContracts({ contracts, query: { enabled: contracts.length > 0 } });
  return useMemo(() => {
    const perStock: Record<string, bigint> = {};
    const perVault = Object.fromEntries(VAULT_KINDS.map((k) => [k, {}])) as Record<VaultKind, Record<string, bigint>>;
    if (!vaults || !stocks) return { perStock, perVault, isLoading: q.isLoading };
    VAULT_KINDS.forEach((k, vi) => {
      stocks.forEach((s, si) => {
        const v = (q.data?.[vi * stocks.length + si]?.result as bigint | undefined) ?? 0n;
        const key = s.address.toLowerCase();
        perVault[k][key] = v;
        perStock[key] = (perStock[key] ?? 0n) + v;
      });
    });
    return { perStock, perVault, isLoading: q.isLoading };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaults, stocks, q.data, q.isLoading]);
}

/**
 * Total value locked = USDG waiting to buy (on the vaults, plus what is lent out on Morpho for boosted plans)
 * + stock on hand (at router price). Vaults hold USDG only — ETH is converted the moment it is deposited — so
 * there is no ETH component. `ready` flips once every vault aggregate, the stock list and every needed price has
 * answered (before the list loads there are no holdings to value, and the total would be USDG only).
 */
export function useTvl(dir?: Directory, vaults?: VaultMap, infos?: VaultInfo[], stocks?: Stock[]) {
  const holdings = useStockHoldings(vaults, stocks);
  const tokens = useMemo(() => (stocks ? stocks.map((s) => ({ address: s.address, decimals: s.decimals })) : undefined), [stocks]);
  const { prices, isLoading: pricesLoading } = usePrices(dir?.router, dir?.usdg, tokens);

  return useMemo(() => {
    const usdg = (infos ?? []).reduce((a, v) => a + (v.totalUsdgIdle ?? 0n), 0n);
    const boosted = (infos ?? []).reduce((a, v) => a + (v.boostAssets ?? 0n), 0n);
    let stockUsd: bigint | undefined = 0n;
    const perStockUsd: Record<string, bigint | undefined> = {};
    for (const s of stocks ?? []) {
      const key = s.address.toLowerCase();
      const amt = holdings.perStock[key] ?? 0n;
      const v = amt === 0n ? 0n : valueOf(amt, prices[key], s.decimals);
      perStockUsd[key] = v;
      if (v === undefined) stockUsd = undefined;
      else if (stockUsd !== undefined) stockUsd += v;
    }
    const infosReady = !!infos && infos.length > 0 && infos.every((v) => v.totalUsdgIdle !== undefined && v.boostAssets !== undefined);
    const ready = infosReady && !!stocks && stocks !== NO_STOCKS && !holdings.isLoading && !pricesLoading;
    const total = stockUsd === undefined ? undefined : usdg + boosted + stockUsd;
    return { usdg, boosted, stockUsd, perStockUsd, total, ready, prices, holdings: holdings.perStock, perVault: holdings.perVault };
  }, [infos, stocks, prices, pricesLoading, holdings]);
}

/** $DCA supply, router price and market cap (price is undefined when no DCA/USDG route exists). */
export function useDcaToken(dir?: Directory) {
  const dca = dir && !isZero(dir.dca) ? dir.dca : undefined;
  const supply = useReadContract({
    address: dca,
    abi: ERC20Abi,
    functionName: "totalSupply",
    query: { enabled: !!dca, staleTime: 60_000 },
  });
  const tokens = useMemo(() => (dca ? [{ address: dca, decimals: 18 }] : undefined), [dca]);
  const { prices } = usePrices(dir?.router, dir?.usdg, tokens);
  const price = dca ? prices[dca.toLowerCase()] : undefined;
  const totalSupply = supply.data as bigint | undefined;
  return {
    address: dca,
    totalSupply,
    price,
    marketCap: valueOf(totalSupply, price, 18),
  };
}
