"use client";

import type { Address } from "viem";
import { useAccount, useReadContract, useWatchAsset } from "wagmi";
import { ERC20Abi } from "@/abi";
import { Icon, Spinner } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { useDirectory, isDcaToken } from "@/hooks/useProtocol";
import { activeChain } from "@/lib/chain";
import { describeTxError } from "@/lib/txErrors";
import { watchAssetParamsFor } from "@/lib/watchAsset";

/**
 * "Add to MetaMask": asks the connected wallet to track a Stock Token (EIP-747 `wallet_watchAsset`) so the stock a plan
 * buys shows up in the user's token list, under the Robinhood Stock Token logo (see lib/watchAsset). The label names
 * MetaMask when that is the connected wallet and says "wallet" otherwise (Rabby & co. implement the same call).
 *
 * $DCA (the directory's token, matched by address) goes in under our own mark instead, with the symbol and decimals the
 * token itself reports: the registry may list it as "DCA" while the contract says otherwise (locally, mDCA), and
 * MetaMask refuses a symbol that does not match the contract. So for $DCA the props are never sent: the button shows a
 * spinner, disabled, until both reads are in, and is hidden if either fails. Callers pass the same props either way.
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
  const { dir } = useDirectory();
  const dca = isDcaToken(dir, address);
  const symbolQ = useReadContract({ address, abi: ERC20Abi, functionName: "symbol", query: { enabled: dca && visible, staleTime: Infinity } });
  const decimalsQ = useReadContract({ address, abi: ERC20Abi, functionName: "decimals", query: { enabled: dca && visible, staleTime: Infinity } });

  if (!visible) return null;
  // $DCA's on-chain symbol / decimals: `reading` until both are in; a read that failed with nothing to show hides the button.
  const reading = dca && (symbolQ.data === undefined || decimalsQ.data === undefined);
  if (reading && ((symbolQ.isError && symbolQ.data === undefined) || (decimalsQ.isError && decimalsQ.data === undefined))) return null;
  const walletName = /metamask/i.test(connector?.name ?? "") ? "MetaMask" : "wallet";
  const label = dca ? "$DCA" : symbol;

  const onClick = async () => {
    if (isPending || reading) return;
    const origin = typeof window !== "undefined" ? window.location.origin : undefined;
    const token = dca ? { address, symbol: symbolQ.data!, decimals: decimalsQ.data! } : { address, symbol, decimals };
    try {
      const added = await watchAssetAsync(watchAssetParamsFor(token, origin, dca ? "dca" : "stock"));
      if (added) toast({ kind: "ok", title: `Added ${label} to your ${walletName}` });
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
      disabled={isPending || reading}
      aria-busy={reading || undefined}
      title={`Track ${label} in your ${walletName}`}
      className={`inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-3 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:text-ink-3 ${className}`}
    >
      {isPending || reading ? <Spinner /> : <Icon name="wallet" size={12} />}
      Add to {walletName}
    </button>
  );
}

/** Whether `AddToWalletButton` renders at all (a wallet is connected on the active chain) — for callers that lay out around it. */
export function useAddToWalletVisible() {
  const { isConnected, chainId } = useAccount();
  return isConnected && chainId === activeChain.id;
}
