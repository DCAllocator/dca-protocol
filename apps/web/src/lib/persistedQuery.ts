"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { serialize, deserialize } from "wagmi";
import type { Address } from "viem";
import { activeChain } from "@/lib/chain";

/**
 * Stale-while-revalidate across page loads, for reads that almost never change (the VaultDirectory entry, the stock
 * list). The last good result is kept in localStorage per chain and contract, so a full page load renders it without
 * a single RPC round trip and still refetches it in the background:
 * - restored after mount, never through initialData / placeholderData (the first client render must match the server's);
 * - only into a query that has no data yet (this session's cache always wins), and marked stale so the load refetches;
 * - written by the queryFn after every successful fetch; a failed fetch writes nothing;
 * - never served once older than PERSIST_MAX_AGE (removed when read);
 * - blocked or private storage is just a cache miss.
 * A `pnpm fork` redeploy lands on the same addresses, so the old copy shows until the background refetch replaces it.
 */
const PREFIX = "dca.q.v1";
export const PERSIST_MAX_AGE = 24 * 60 * 60_000;

type Entry<T> = { updatedAt: number; data: T };

function readEntry<T>(key: string): Entry<T> | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return undefined;
    const entry = deserialize<Entry<T> | null>(raw);
    if (entry && typeof entry.updatedAt === "number" && entry.data !== undefined && Date.now() - entry.updatedAt < PERSIST_MAX_AGE) return entry;
    localStorage.removeItem(key);
  } catch {
    /* unreadable entry or blocked storage: fetch as if nothing was stored */
  }
  return undefined;
}

function writeEntry<T>(key: string, data: T) {
  try {
    localStorage.setItem(key, serialize({ updatedAt: Date.now(), data } satisfies Entry<T>));
  } catch {
    /* quota / private mode: the next page load just fetches */
  }
}

/**
 * `useQuery` keyed `[name, chainId, address]` whose data also persists across page loads (see above). `address` is the
 * contract the read targets; the query stays disabled until it is known.
 */
export function usePersistedQuery<T>({
  name,
  address,
  enabled = true,
  queryFn,
  staleTime,
  refetchInterval,
}: {
  name: string;
  address?: Address;
  enabled?: boolean;
  queryFn: () => Promise<T>;
  staleTime?: number;
  refetchInterval?: number | false;
}) {
  const queryClient = useQueryClient();
  const addr = address?.toLowerCase();
  const queryKey = [name, activeChain.id, addr] as const;
  const storageKey = addr ? `${PREFIX}:${activeChain.id}:${name}:${addr}` : undefined;
  const on = enabled && !!storageKey;

  // Declared before useQuery, so on mount the entry is in the cache before the query's observer subscribes.
  useEffect(() => {
    if (!on || !storageKey || queryClient.getQueryData(queryKey) !== undefined) return;
    const entry = readEntry<T>(storageKey);
    if (!entry) return;
    queryClient.setQueryData(queryKey, entry.data, { updatedAt: entry.updatedAt });
    // Keeps its real age but never counts as fresh: an entry written seconds ago would otherwise skip this load's refetch.
    void queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is a function of storageKey
  }, [queryClient, on, storageKey]);

  return useQuery({
    queryKey,
    enabled: on,
    staleTime,
    refetchInterval,
    queryFn: async () => {
      const data = await queryFn();
      writeEntry(storageKey!, data);
      return data;
    },
  });
}
