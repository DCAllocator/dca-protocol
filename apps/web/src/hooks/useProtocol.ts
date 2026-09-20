"use client";

import { useMemo } from "react";
import { useAccount, useBalance, useReadContract, useReadContracts, usePublicClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { VaultDirectoryAbi, StockRegistryAbi, PlanVaultAbi, ERC20Abi, ClaimHelperAbi, AggregatorRouterAbi } from "@/abi";
import { ADDRESSES, isZero, TEST_VAULT, VAULT_KINDS, type VaultKind } from "@/lib/config";
import { valueOf } from "@/lib/format";

export type Directory = {
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

/** VaultDirectory.get() — the single on-chain bootstrap point (plus the local test vault when enabled). */
export function useDirectory() {
  const q = useReadContract({
    address: ADDRESSES.directory,
    abi: VaultDirectoryAbi,
    functionName: "get",
    query: { enabled: !isZero(ADDRESSES.directory), staleTime: 60_000, refetchInterval: false },
  });
  const dir = q.data as Directory | undefined;
  const vaults = useMemo<VaultMap | undefined>(
    () => (dir ? ({ daily: dir.daily, weekly: dir.weekly, monthly: dir.monthly, ...(TEST_VAULT ? { test: TEST_VAULT } : {}) } as VaultMap) : undefined),
    [dir],
  );
  return { dir, vaults, isLoading: q.isLoading, error: q.error, configured: !isZero(ADDRESSES.directory) };
}

export type Stock = {
  address: Address;
  symbol: string;
  decimals: number;
  approved: boolean;
  feeOnTransfer: boolean;
  totalSupply?: bigint;
};

/** Approved stocks + metadata from the registry, including on-chain total supply (for market cap). */
export function useStocks(registry?: Address) {
  const list = useReadContract({
    address: registry,
    abi: StockRegistryAbi,
    functionName: "approvedStocks",
    query: { enabled: !!registry, staleTime: 60_000, refetchInterval: false },
  });
  const addrs = (list.data ?? []) as readonly Address[];
  const infos = useReadContracts({
    contracts: addrs.map((a) => ({ address: registry!, abi: StockRegistryAbi, functionName: "info", args: [a] }) as const),
    query: { enabled: !!registry && addrs.length > 0, staleTime: 60_000, refetchInterval: false },
  });
  const supplies = useReadContracts({
    contracts: addrs.map((a) => ({ address: a, abi: ERC20Abi, functionName: "totalSupply" }) as const),
    query: { enabled: addrs.length > 0, staleTime: 60_000, refetchInterval: false },
  });
  const stocks: Stock[] = useMemo(
    () =>
      addrs.map((address, i) => {
        const r = infos.data?.[i]?.result as
          | { approved: boolean; known: boolean; feeOnTransfer: boolean; decimals: number; symbol: string }
          | undefined;
        return {
          address,
          symbol: r?.symbol ?? "…",
          decimals: r?.decimals ?? 18,
          approved: r?.approved ?? true,
          feeOnTransfer: r?.feeOnTransfer ?? false,
          totalSupply: supplies.data?.[i]?.result as bigint | undefined,
        };
      }),
    [addrs, infos.data, supplies.data],
  );
  const bySymbol = useMemo(() => Object.fromEntries(stocks.map((s) => [s.address.toLowerCase(), s])), [stocks]);
  return { stocks, byAddress: bySymbol, isLoading: list.isLoading || infos.isLoading || supplies.isLoading };
}

export type FeeConfig = {
  purchaseFeeBps: number;
  depositFeeBps: number;
  withdrawFeeBps: number;
  claimFeeBps: number;
  keeperTipBps: number;
  swapSlippageBps: number;
  maxWethSlippageBps: number;
};

export type VaultInfo = {
  address: Address;
  kind: VaultKind;
  fees?: FeeConfig;
  nextEpochStart?: bigint;
  epochLength?: number;
  currentEpochId?: number;
  totalUsdgIdle?: bigint;
  totalWethIdle?: bigint;
  totalNotionalUsdg?: bigint;
  epochsCompleted?: bigint;
  autoDistributeThreshold?: bigint;
  feeHalveThreshold?: bigint;
  paused?: boolean;
};

/** Static-ish vault parameters + live aggregates for every shown vault. */
export function useVaults(vaults?: VaultMap) {
  const fns = [
    "fees",
    "nextEpochStart",
    "epochLength",
    "currentEpochId",
    "totalUsdgIdle",
    "totalWethIdle",
    "totalNotionalUsdg",
    "epochsCompleted",
    "autoDistributeThreshold",
    "feeHalveThreshold",
    "paused",
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
        totalWethIdle: get(5) as bigint | undefined,
        totalNotionalUsdg: get(6) as bigint | undefined,
        epochsCompleted: get(7) as bigint | undefined,
        autoDistributeThreshold: get(8) as bigint | undefined,
        feeHalveThreshold: get(9) as bigint | undefined,
        paused: get(10) as boolean | undefined,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaults, q.data]);
  return { infos, byKind: Object.fromEntries(infos.map((i) => [i.kind, i])) as Record<VaultKind, VaultInfo | undefined>, isLoading: q.isLoading, refetch: q.refetch };
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
  usdgIdle: bigint;
  wethIdle: bigint;
  stockAccrued: bigint;
  lastEpochId: number;
  paused: boolean;
  zapWethEachEpoch: boolean;
  maxWethSlippageBps: number;
};

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

/* ------------------------------------------------------------------ */
/* Prices, holdings, TVL                                                */
/* ------------------------------------------------------------------ */

export type PriceMap = Record<string, bigint | undefined>; // lower(address) → USDG per whole token

/**
 * USDG price of one whole unit of each token, via the router's quote() simulation. Quoting a single
 * unit (not the full amount) keeps the read under the router's impact cap. Tokens with no route resolve
 * to undefined and are simply not valued.
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
          client!.simulateContract({
            address: router!,
            abi: AggregatorRouterAbi,
            functionName: "quote",
            args: [t.address, usdg!, 10n ** BigInt(t.decimals)],
          }),
        ),
      );
      const out: PriceMap = {};
      tokens!.forEach((t, i) => {
        const r = results[i];
        out[t.address.toLowerCase()] = r.status === "fulfilled" ? (r.value.result[0] as bigint) : undefined;
      });
      return out;
    },
  });
  return { prices: q.data ?? ({} as PriceMap), isLoading: q.isLoading };
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
 * Total value locked = USDG waiting + WETH waiting (at router price) + stock on hand (at router price).
 * `ready` flips once every vault aggregate and every needed price has answered.
 */
export function useTvl(dir?: Directory, vaults?: VaultMap, infos?: VaultInfo[], stocks?: Stock[]) {
  const holdings = useStockHoldings(vaults, stocks);
  const tokens = useMemo(
    () => (dir && stocks ? [{ address: dir.weth, decimals: 18 }, ...stocks.map((s) => ({ address: s.address, decimals: s.decimals }))] : undefined),
    [dir, stocks],
  );
  const { prices, isLoading: pricesLoading } = usePrices(dir?.router, dir?.usdg, tokens);

  return useMemo(() => {
    const usdg = (infos ?? []).reduce((a, v) => a + (v.totalUsdgIdle ?? 0n), 0n);
    const weth = (infos ?? []).reduce((a, v) => a + (v.totalWethIdle ?? 0n), 0n);
    const wethPrice = dir ? prices[dir.weth.toLowerCase()] : undefined;
    const ethUsd = weth === 0n ? 0n : valueOf(weth, wethPrice, 18);
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
    const infosReady = !!infos && infos.length > 0 && infos.every((v) => v.totalUsdgIdle !== undefined);
    const ready = infosReady && !holdings.isLoading && !pricesLoading;
    const total = ethUsd === undefined || stockUsd === undefined ? undefined : usdg + ethUsd + stockUsd;
    return { usdg, weth, ethUsd, stockUsd, perStockUsd, total, ready, prices, holdings: holdings.perStock, perVault: holdings.perVault };
  }, [dir, infos, stocks, prices, pricesLoading, holdings]);
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
