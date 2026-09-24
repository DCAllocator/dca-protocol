"use client";

import { useCallback, useMemo } from "react";
import { useAccount, useBalance, useReadContract, useReadContracts, usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, InternalRpcError, type Address, type Hex } from "viem";
import { VaultDirectoryAbi, StockRegistryAbi, PlanVaultAbi, EpochKeeperAbi, ERC20Abi, ClaimHelperAbi, AggregatorRouterAbi, MorphoBlueStrategyAbi, IMorphoAbi } from "@/abi";
import { Market, UnsupportedMarketIrmError } from "@morpho-org/blue-sdk";
import type { PublicClient } from "viem";
import { ADDRESSES, isZero, TEST_VAULT, VAULT_KINDS, PRODUCTION_VAULT_KINDS, SECONDS_PER_YEAR, DCA_PERK_DEFAULTS, USDG_DECIMALS, type VaultKind, type ProductionVaultKind } from "@/lib/config";
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
 * (lib/persistedQuery): a reload renders the last good list at once and revalidates it in the background. `fresh` is
 * true once a list is in and no fetch is running, i.e. past that background refetch (a restored copy may be stale).
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
  return { stocks, byAddress: bySymbol, isLoading: q.isLoading, fresh: q.data !== undefined && !q.isFetching };
}

/** The stock `query` names, by address or ticker (either case), e.g. a `?stock=` value; undefined when none does. */
export function findStock(stocks: readonly Stock[], query: string): Stock | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return stocks.find((s) => s.address.toLowerCase() === q) ?? stocks.find((s) => s.symbol.toLowerCase() === q);
}

const pairKey = (vault: Address, stock: Address) => `${vault.toLowerCase()}:${stock.toLowerCase()}`;

/**
 * Every (vault, stock) pair that actually gets bought, as `vault:stock` keys. Approved in the registry is not enough:
 * a vault only buys when an EpochKeeper operator runs that pair's job, and it refuses a stock that has no price feed
 * while `requireFeed` is on (fail-closed). So a pair counts when it has an active job and, where the vault requires
 * one, a feed. One `jobs()` read, then every job vault's `priceGuard()` and every job's `priceFeed()` in one tick
 * (one Multicall3 aggregate where the chain has it, as in `readStockList`).
 */
async function readBuyable(client: PublicClient, keeper: Address): Promise<string[]> {
  const jobs = (await client.readContract({ address: keeper, abi: EpochKeeperAbi, functionName: "jobs" })).filter((j) => j.active);
  const jobVaults = [...new Set(jobs.map((j) => j.vault))];
  const [guards, feeds] = await Promise.all([
    Promise.all(jobVaults.map((v) => client.readContract({ address: v, abi: PlanVaultAbi, functionName: "priceGuard" }))),
    Promise.all(jobs.map((j) => client.readContract({ address: j.vault, abi: PlanVaultAbi, functionName: "priceFeed", args: [j.stock] }))),
  ]);
  const requireFeed = new Map(jobVaults.map((v, i) => [v, guards[i][1]]));
  return jobs.filter((j, i) => !requireFeed.get(j.vault) || !isZero(feeds[i][0])).map((j) => pairKey(j.vault, j.stock));
}

/**
 * Whether a vault will actually buy a stock (see `readBuyable`). `isBuyable` answers undefined until the pairs have
 * loaded. Without NEXT_PUBLIC_KEEPER there is nothing to check against, so every pair counts as buyable. Persisted like
 * the stock list, so a reload filters the picker without waiting for the chain.
 */
export function useBuyable({ enabled = true }: { enabled?: boolean } = {}) {
  const client = usePublicClient();
  const keeper = isZero(ADDRESSES.keeper) ? undefined : ADDRESSES.keeper;
  const q = usePersistedQuery({
    name: "buyable",
    address: keeper,
    enabled: enabled && !!client,
    staleTime: 60_000,
    refetchInterval: false,
    queryFn: () => readBuyable(client!, keeper!),
  });
  const pairs = useMemo(() => (q.data ? new Set(q.data) : undefined), [q.data]);
  const isBuyable = useCallback((vault: Address, stock: Address): boolean | undefined => (keeper ? pairs?.has(pairKey(vault, stock)) : true), [keeper, pairs]);
  // `fresh`: past the background refetch of a restored copy, as in `useStocks`.
  return { isBuyable, ready: !keeper || !!pairs, fresh: !keeper || (!!pairs && !q.isFetching) };
}

/**
 * The production frequencies whose vault buys `stock` (see `useBuyable`), fastest first; undefined until the directory
 * and the keeper's pairs are in. Without NEXT_PUBLIC_KEEPER every frequency counts. The landing pages' stock links and
 * Create plan's `?stock=` go by it; the local test vault never counts. `fresh` as in `useBuyable`.
 */
export function useKindsBuying() {
  const { vaults } = useDirectory();
  const { isBuyable, ready, fresh } = useBuyable();
  const kindsBuying = useCallback(
    (stock: Address): ProductionVaultKind[] | undefined => (vaults && ready ? PRODUCTION_VAULT_KINDS.filter((k) => isBuyable(vaults[k], stock)) : undefined),
    [vaults, ready, isBuyable],
  );
  return { kindsBuying, fresh: !!vaults && fresh };
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

/**
 * The amounts `useBuyDcaRoute` probes each pay token with, in the router's units: one whole USDG, and 0.001 WETH (for
 * ETH, which the buy wraps first) — both small, so a thin pool's impact cap does not hide a route. /app/buy's card asks
 * the same amount when a typed amount has no quote, to tell "too big for the pool" from "no route with this token".
 */
export const BUY_DCA_PROBE = { USDG: 10n ** BigInt(USDG_DECIMALS), ETH: 10n ** 15n } as const;

/**
 * Can $DCA be bought in-app on this chain, and with what? True when the directory names a token and either of
 * /app/buy's pay tokens has a route into it, whichever token the $DCA pool is paired with (hops are directional, so
 * this is the buy direction — `useDcaToken` quotes the other way for the price). The source of truth is the router,
 * not the FeeReceiver or the adapters' approved-hop list: a quote that comes back is proof of a live, routable pool.
 *
 * - 1 USDG first, as the router's own `quote(usdg, dca)` — for USDG that IS `readBestRoute` (USDG is an end, and the
 *   router already searches through WETH), as one read. Kept as `useQuote` so a $DCA plan's estimate shares the query
 *   (`lib/planEstimate.ts`).
 * - Only once that has settled on "no": 0.001 WETH through `readBestRoute`, for a $DCA pool only ETH can reach (a
 *   WETH/$DCA pool with no approved USDG → WETH hop).
 *
 * Both probes FAIL on "no route" (`useQuote` throws on a revert; the ETH one throws when the finder comes back empty),
 * so a later poll that finds nothing — or an RPC blip — keeps the last answer instead of flipping `available` off and
 * unmounting an open buy card mid-order; only a probe that has never answered counts as "no".
 *
 * `payWith` is the pay token that answered (USDG when both would), for the card to open on. `isLoading` is true only
 * while a first probe is in flight, so a caller can reserve the tab's slot and hide it only on a settled failure. A
 * native-ETH Uniswap v4 pool (a Pons launch pool) does NOT light this up with either pay token: the UniV4 adapter only
 * takes ERC-20/ERC-20 pool keys, so the router cannot route it at all — use BUY_DCA_TAB_FORCED (or the Pons hand-off)
 * for that case. A WETH (ERC-20) pool on an approved adapter does.
 */
export function useBuyDcaRoute(dir?: Directory) {
  const client = usePublicClient();
  const configured = !!dir && !isZero(dir.dca);
  const usdg = useQuote(configured ? dir.router : undefined, dir?.usdg, dir?.dca, BUY_DCA_PROBE.USDG);
  // Settled on "no": an error with no answer kept from an earlier poll (a failed refetch keeps the last good one).
  const usdgNo = configured && usdg.isError && usdg.data === undefined;
  const eth = useQuery({
    queryKey: ["buyDcaEthProbe", dir?.router, dir?.usdg, dir?.weth, dir?.dca],
    enabled: !!client && usdgNo,
    retry: false,
    refetchInterval: 20_000,
    queryFn: async () => {
      const found = await readBestRoute(client!, dir!, dir!.weth, dir!.dca, BUY_DCA_PROBE.ETH);
      if (!found.best) throw new Error("No route from WETH to $DCA");
      return found.best;
    },
  });
  const payWith: "USDG" | "ETH" | undefined = !configured ? undefined : usdg.data !== undefined ? "USDG" : usdgNo && eth.data !== undefined ? "ETH" : undefined;
  return { configured, available: payWith !== undefined, payWith, isLoading: configured && (usdg.isLoading || (usdgNo && eth.isLoading)) };
}

/** One hop of a router path: AggregatorRouter's `Route` struct as viem decodes it (`extra` is the adapter's pool encoding). */
export type RouteHop = { protocol: number; tokenIn: Address; tokenOut: Address; fee: number; extra: Hex };

/** A path `swapWithRoute` accepts, and what it delivers right now for the amount it was quoted for. */
export type BestRoute = {
  /** `tokenOut` the path delivers for the whole amount, as the router simulates it now. */
  amountOut: bigint;
  /** The explicit path to hand `swapWithRoute`: 1–3 approved hops. */
  path: readonly RouteHop[];
  /** Every token the path visits, `tokenIn` first and `tokenOut` last: the route as the copy names it. */
  tokens: readonly Address[];
};

/** What `readBestRoute` found for one amount. */
export type RouteQuote = {
  /** The candidate that delivers the most `tokenOut`; undefined when none quotes within the router's impact cap. */
  best?: BestRoute;
  /**
   * What the whole amount fetches in each stepping-stone token the finder tried (lower-case address → amount), from that
   * candidate's first leg: the USDG an ETH amount is worth, for the "≈ $" beside it. A token is missing when it was not
   * tried (it is one of the two ends — USDG is the only stepping stone, see `readBestRoute`) or that leg does not quote.
   */
  firstLegs: Record<string, bigint>;
};

/** Same address, whatever the checksum casing. */
const sameAddr = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

/**
 * Like `tryRead`, but only the contract's own "no" resolves to undefined: a revert (NoRoute, PriceImpactTooHigh — also
 * a failed call inside a Multicall3 batch, which viem raises as a raw revert) or no code at the address. Anything else
 * (a timeout, an HTTP error, a rate limit) is rethrown, so a query built on it fails and keeps its last good answer
 * instead of replacing it with "no route".
 *
 * One trap: viem files EVERY JSON-RPC -32603 "Internal error" that has a message under ContractFunctionRevertedError,
 * and many providers — and an anvil fork whose upstream fetch fails — report a timeout exactly that way. A real revert
 * from the router carries revert data (its errors are all custom errors) or comes as code 3 (anvil, Nitro, a Multicall3
 * sub-call), so a -32603 with no revert data is taken for the transport failure it is and rethrown.
 */
async function readOrNo<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (e) {
    if (!(e instanceof BaseError)) throw e;
    if (e.walk((x) => x instanceof ContractFunctionZeroDataError)) return undefined;
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (!(reverted instanceof ContractFunctionRevertedError)) throw e;
    const hasRevertData = !!reverted.raw && reverted.raw !== "0x";
    const internalError = !!e.walk((x) => (x as { code?: unknown }).code === InternalRpcError.code);
    if (internalError && !hasRevertData) throw e;
    return undefined;
  }
}

/**
 * Whether `path` is one `swapWithRoute(from, to, …)` would accept as a shape: 1–3 hops, starting at `from`, ending at
 * `to`, each hop taking what the last one gave. (`_execute` also checks every hop is approved; `quotePath` checks that.)
 */
const isChained = (path: readonly RouteHop[], from: Address, to: Address) =>
  path.length > 0 &&
  path.length <= 3 &&
  sameAddr(path[0].tokenIn, from) &&
  sameAddr(path[path.length - 1].tokenOut, to) &&
  path.every((h, i) => i === 0 || sameAddr(path[i - 1].tokenOut, h.tokenIn));

/** Every token a path visits, in order: its first hop's input, then each hop's output. */
const pathTokens = (path: readonly RouteHop[]): Address[] => [path[0].tokenIn, ...path.map((h) => h.tokenOut)];

/**
 * `isChained`, and no token visited twice. A revisit is a round trip that only pays two more pool fees: joining WETH →
 * USDG with the router's own USDG → $DCA pick gives WETH → USDG → WETH → $DCA whenever that pick is itself through WETH
 * (both pools exist). Dropping it loses nothing: the WETH → $DCA hop it ends on is the router's own candidate for the
 * whole amount, and WETH → USDG → $DCA over USDG's direct hop — the route the loop hid — is a candidate of its own
 * (`readBestRoute` joins the first leg to every approved direct hop too), which counts near the direct hop's impact cap,
 * where the whole amount fails WETH → $DCA but the slightly smaller amount the round trip leaves would not.
 */
const isRoutable = (path: readonly RouteHop[], from: Address, to: Address) =>
  isChained(path, from, to) && new Set(pathTokens(path).map((t) => t.toLowerCase())).size === path.length + 1;

/** A path's identity, for dropping duplicates: every field of every hop, as the router's `hopKey` hashes them. */
const pathKey = (path: readonly RouteHop[]) =>
  path.map((h) => [h.protocol, h.tokenIn.toLowerCase(), h.tokenOut.toLowerCase(), h.fee, h.extra.toLowerCase()].join(":")).join("|");

/**
 * The explicit path that delivers the most `tokenOut` for `amountIn`, whichever token the `tokenOut` pool is paired
 * with. The router's own `quote()` tries every approved direct hop and, only when neither end is WETH, every two-hop
 * route THROUGH WETH: USDG → WETH → $DCA it finds by itself, but from WETH it only ever sees a direct hop, and it never
 * steps through USDG — so WETH → USDG → $DCA (ETH paid into a USDG-paired $DCA) is composed here. The candidates:
 *
 * - the router's own pick: `quote(tokenIn, tokenOut, amountIn)` — a direct hop, or two hops through WETH;
 * - through USDG, the one stepping stone the router does not search (unless USDG is an end): the first leg is
 *   `quote(tokenIn, usdg, amountIn)`'s path, joined to (a) the router's own onward pick, `quote(usdg, tokenOut,
 *   thatOutput)`'s path, and (b) each approved direct hop out of USDG (`approvedHops(usdg, tokenOut)`) — (a) may loop
 *   back through `tokenIn` (see `isRoutable`), and (b) is the route such a loop hides. Each is kept only when
 *   `swapWithRoute` would take it, it visits no token twice and it is not a path already on the list; then confirmed
 *   end to end with `quotePath`, which applies the router's impact cap to the WHOLE path — the cap `quote()` holds its
 *   own two-hop routes to. Each leg alone can pass the cap while the pair does not; such a path is dropped rather than
 *   sent, since `swapWithRoute` does not re-check impact (the caller's `minOut` is then the only guard).
 *
 * WETH is never a stepping stone here: when it is neither end, `quote()` has already tried every tokenIn → WETH hop with
 * the best WETH → tokenOut hop after it, under the same end-to-end impact formula `quotePath` applies, so a composed
 * path through WETH could only tie or lose. That keeps a USDG buy to the router's one read.
 *
 * The highest output wins; on a tie the shorter path (less gas), then the router's own pick. For $DCA that means:
 * paired with USDG, USDG pays straight in and ETH goes WETH → USDG → $DCA; paired with WETH, ETH pays straight in and
 * USDG goes USDG → WETH → $DCA; with both pools, whichever delivers more. Only ERC-20 pools on the approved adapters
 * are ever candidates: a native-ETH Uniswap v4 pool (a Pons launch pool) is not routable by this router at all — its
 * UniV4 adapter only takes ERC-20/ERC-20 pool keys.
 *
 * Every read goes as a `view` (see `RouterQuoteViewAbi`), in up to three rounds — the first quotes and the approved
 * hops, the onward quotes, the `quotePath` checks — each one Multicall3 aggregate where the chain has it (a round with
 * nothing to ask sends nothing). A candidate that reverts (NoRoute, PriceImpactTooHigh) is simply not one, and with none
 * left `best` is undefined ("no quote for this amount"). A transport failure on ANY read throws instead (`readOrNo`), so
 * a query keeps its last good answer through an RPC blip rather than losing its route.
 */
export async function readBestRoute(
  client: PublicClient,
  dir: Pick<Directory, "router" | "usdg">,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<RouteQuote> {
  const quote = (from: Address, to: Address, amount: bigint) =>
    readOrNo(async () => {
      const [amountOut, path] = await client.readContract({ address: dir.router, abi: RouterQuoteViewAbi, functionName: "quote", args: [from, to, amount] });
      return { amountOut, path: path as readonly RouteHop[] };
    });
  const directHops = (from: Address, to: Address) =>
    readOrNo(async () => (await client.readContract({ address: dir.router, abi: AggregatorRouterAbi, functionName: "approvedHops", args: [from, to] })) as readonly RouteHop[]);
  // The stepping stones the router's own search does not cover (see above): USDG, unless it is one of the ends.
  const bases = [dir.usdg].filter((b) => !sameAddr(b, tokenIn) && !sameAddr(b, tokenOut));

  const [own, firsts, hopsOut] = await Promise.all([
    quote(tokenIn, tokenOut, amountIn),
    Promise.all(bases.map((b) => quote(tokenIn, b, amountIn))),
    Promise.all(bases.map((b) => directHops(b, tokenOut))),
  ]);
  const onwards = await Promise.all(bases.map((b, i) => (firsts[i] && firsts[i].amountOut > 0n ? quote(b, tokenOut, firsts[i].amountOut) : undefined)));

  const candidates: BestRoute[] = [];
  const seen = new Set<string>();
  if (own && own.amountOut > 0n && isRoutable(own.path, tokenIn, tokenOut)) {
    candidates.push({ amountOut: own.amountOut, path: own.path, tokens: pathTokens(own.path) });
    seen.add(pathKey(own.path));
  }
  const composed: RouteHop[][] = [];
  bases.forEach((_, i) => {
    const first = firsts[i];
    if (!first || first.amountOut === 0n) return;
    // (a) the router's onward pick first, then (b) each direct hop; a (b) that equals (a) is the same path, asked once.
    const tails: (readonly RouteHop[])[] = [...(onwards[i] ? [onwards[i].path] : []), ...(hopsOut[i] ?? []).map((h) => [h])];
    for (const tail of tails) {
      const path = [...first.path, ...tail];
      const key = isRoutable(path, tokenIn, tokenOut) ? pathKey(path) : undefined;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      composed.push(path);
    }
  });
  const confirmed = await Promise.all(
    composed.map((path) => readOrNo(() => client.readContract({ address: dir.router, abi: RouterQuotePathViewAbi, functionName: "quotePath", args: [path, amountIn] }))),
  );
  composed.forEach((path, i) => {
    const out = confirmed[i];
    if (out !== undefined && out > 0n) candidates.push({ amountOut: out, path, tokens: pathTokens(path) });
  });

  // The router's own pick is first on the list, so it keeps a full tie; a strictly shorter path takes one.
  const best = candidates.reduce<BestRoute | undefined>(
    (b, c) => (!b || c.amountOut > b.amountOut || (c.amountOut === b.amountOut && c.path.length < b.path.length) ? c : b),
    undefined,
  );
  const firstLegs: Record<string, bigint> = {};
  bases.forEach((b, i) => {
    const first = firsts[i];
    if (first) firstLegs[b.toLowerCase()] = first.amountOut;
  });
  return { best, firstLegs };
}

/**
 * `readBestRoute` for the amount being typed, refreshed every 20 s like `useQuote`. `data.best` is the path to freeze into
 * an order at click time; `data.firstLegs` prices the amount in the stepping-stone tokens (USDG for the "≈ $" line).
 *
 * `gcTime: 0`: an amount's answer is dropped as soon as nothing shows it. An order freezes this path and its floor
 * (`swapWithRoute` does not re-check impact), so going back to an amount typed minutes ago (0.1 → 0.12 → 0.1) must wait
 * for a fresh read rather than offer the cached one while it refetches.
 */
export function useBestRoute(dir?: Directory, tokenIn?: Address, tokenOut?: Address, amountIn?: bigint) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["bestRoute", dir?.router, dir?.usdg, tokenIn, tokenOut, amountIn?.toString()],
    enabled: !!client && !!dir && !!tokenIn && !isZero(tokenOut) && !!amountIn && amountIn > 0n,
    retry: false,
    refetchInterval: 20_000,
    gcTime: 0,
    queryFn: () => readBestRoute(client!, dir!, tokenIn!, tokenOut!, amountIn!),
  });
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

/** AggregatorRouter.quotePath declared `view`, for the same reason as `RouterQuoteViewAbi` (its adapters simulate and revert). */
const RouterQuotePathViewAbi = [
  {
    type: "function",
    name: "quotePath",
    stateMutability: "view",
    inputs: [
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
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
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

/** Number of largest stocks shown as pills: the stock picker dialog's, and /app/create/legacy's "Popular" row. */
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
 *
 * `buyableOn` (a stock picker's vault) narrows `stocks`, `ranked` and `top` to what that vault will actually buy
 * (`useBuyable`), so a plan cannot be started on a stock that never gets bought; `ready` then also waits for that
 * check. `byAddress` stays the whole registry, for lookups.
 *
 * $DCA, when the registry lists it (`isDcaToken`), is not a Stock Token and has no market cap: it stays in `stocks` but
 * is left out of `ranked` and `top` (the ticker, the landing grids and the "Popular" chips stay Stock Tokens only) and
 * comes back as `dca` instead. `choices` is what a picker lists — `dca` pinned first, then `ranked` — and `preferred`
 * what it starts on: `dca`, else the largest Stock Token; undefined until `ready`. With $DCA unlisted (or not bought on
 * `buyableOn`) `dca` is undefined and `choices` is `ranked`.
 */
export function useRankedStocks(dir?: Directory, buyableOn?: Address) {
  const { stocks: listed, byAddress, isLoading: stocksLoading } = useStocks(dir?.registry);
  const { isBuyable, ready: buyableReady } = useBuyable({ enabled: !!buyableOn });
  return useMemo(() => {
    const marketCapOf = (s: Stock) => (isDcaToken(dir, s.address) ? undefined : STOCK_MARKET_CAPS[s.symbol.toUpperCase()]);
    const stocks = buyableOn ? listed.filter((s) => isBuyable(buyableOn, s.address)) : listed;
    const dca = stocks.find((s) => isDcaToken(dir, s.address));
    const ranked = stocks
      .filter((s) => s !== dca)
      .sort((a, b) => {
        const diff = (marketCapOf(b) ?? 0) - (marketCapOf(a) ?? 0);
        return diff !== 0 ? diff : a.symbol.localeCompare(b.symbol);
      });
    const choices = dca ? [dca, ...ranked] : ranked;
    const ready = listed.length > 0 && !stocksLoading && (!buyableOn || buyableReady);
    const top = ready ? ranked.filter((s) => (marketCapOf(s) ?? 0) > 0).slice(0, TOP_STOCKS) : [];
    const preferred = ready ? (dca ?? top[0]) : undefined;
    return { stocks, byAddress, ranked, top, dca, choices, preferred, marketCapOf, ready };
  }, [dir, listed, byAddress, stocksLoading, buyableOn, isBuyable, buyableReady]);
}

/**
 * Whether `address` is the protocol's own $DCA token (the directory's `dca`). The registry can list $DCA beside the
 * Stock Tokens so plans can buy it; it is told apart by address, never by ticker (a Stock Token could share one).
 */
export const isDcaToken = (dir: Directory | undefined, address: Address | undefined): boolean =>
  !!dir && !!address && !isZero(dir.dca) && address.toLowerCase() === dir.dca.toLowerCase();

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

/**
 * $DCA supply, router price and market cap. The price is the router's own `quote($DCA, USDG)`, which also finds
 * $DCA → WETH → USDG, so a WETH-paired $DCA is priced too; undefined when neither route exists.
 */
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
