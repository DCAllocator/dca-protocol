"use client";

import type { Address } from "viem";
import { useAccount, useWatchAsset } from "wagmi";
import { Icon, Spinner } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { activeChain } from "@/lib/chain";
import { describeTxError } from "@/lib/txErrors";
import { watchAssetParamsFor } from "@/lib/watchAsset";

/**
 * "Add to MetaMask": asks the connected wallet to track a Stock Token (EIP-747 `wallet_watchAsset`) so the stock a plan
 * buys shows up in the user's token list, under the Robinhood Stock Token logo (see lib/watchAsset). The label names
 * MetaMask when that is the connected wallet and says "wallet" otherwise (Rabby & co. implement the same call).
 *
 * Renders nothing unless a wallet is connected on the active chain (the same guard as ConnectButton: a token address
 * only means something on the chain it lives on).
 *
 * Outcomes are toasts, never inline copy: `true` → "Added <SYMBOL> to your wallet"; `false` (the wallet's dialog was
 * declined) → "Not added"; a throw (closed with 4001, unsupported method, …) → the shared describeTxError copy.
 *
 * Never place this inside a `role="option"` picker row: a nested button breaks listbox semantics and keyboard selection.
 */
export function AddToWalletButton({ address, symbol, decimals, className = "" }: { address: Address; symbol: string; decimals: number; className?: string }) {
  const { connector } = useAccount();
  const visible = useAddToWalletVisible();
  const { watchAssetAsync, isPending } = useWatchAsset();
  const { toast } = useToast();

  if (!visible) return null;
  const walletName = /metamask/i.test(connector?.name ?? "") ? "MetaMask" : "wallet";

  const onClick = async () => {
    if (isPending) return;
    const origin = typeof window !== "undefined" ? window.location.origin : undefined;
    try {
      const added = await watchAssetAsync(watchAssetParamsFor({ address, symbol, decimals }, origin));
      if (added) toast({ kind: "ok", title: `Added ${symbol} to your ${walletName}` });
      else toast({ kind: "warn", title: "Not added" });
    } catch (e) {
      const d = describeTxError(e);
      toast({ kind: d.kind, title: d.title, detail: d.detail });
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      title={`Track ${symbol} in your ${walletName}`}
      className={`inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-3 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:text-ink-3 ${className}`}
    >
      {isPending ? <Spinner /> : <Icon name="wallet" size={12} />}
      Add to {walletName}
    </button>
  );
}

/** Whether `AddToWalletButton` renders at all (a wallet is connected on the active chain) — for callers that lay out around it. */
export function useAddToWalletVisible() {
  const { isConnected, chainId } = useAccount();
  return isConnected && chainId === activeChain.id;
}
