import type { Address, Client, Hash } from "viem";
import { getTransactionCount } from "viem/actions";

/**
 * Keeps the second wallet prompt of a flow from reusing the first one's nonce.
 *
 * A receipt carries no nonce and `eth_sendTransaction` returns only the hash, so the app never passes one: the wallet
 * picks it. MetaMask picks max(its network count, its own still-pending transactions). The network count is
 * `eth_getTransactionCount` at the block its block tracker has cached (it rewrites "latest" to that block), and its
 * safeguard based on its own confirmed transactions is dead (an argument-order bug in @metamask/transaction-controller,
 * shipped in 13.48). Once the previous step has left its pending list, a cached block from before that step makes it
 * sign the same nonce again, and the node answers "nonce too low" (seen with approve → Start plan on anvil).
 *
 * So before prompting the step after one of ours, ask the wallet itself: read ITS "latest" count, which goes through
 * the same cached block MetaMask's nonce tracker uses, until it covers the step that just mined. MetaMask's block
 * tracker never moves backwards, so once the count shows it, it cannot go stale again before the user confirms.
 */

/** How long a mined step counts as "the last one" for the next prompt. MetaMask's block tracker polls every 20 s. */
const TTL_MS = 120_000;

export type MinedTx = { nonce: number; hash: Hash; at: number };

// Module-level on purpose: a row action and the remove dialog run separate sequences, but share the account's nonces.
const lastMined = new Map<string, MinedTx>();
const keyOf = (chainId: number, address: Address) => `${chainId}:${address.toLowerCase()}`;

/** The account's most recent mined transaction on this chain from any flow in this tab, if it is recent enough to matter. */
export function lastMinedOf(chainId: number, address: Address): MinedTx | undefined {
  const key = keyOf(chainId, address);
  const m = lastMined.get(key);
  if (m && Date.now() - m.at > TTL_MS) {
    lastMined.delete(key);
    return undefined;
  }
  return m;
}

/** Records a mined transaction of `address` (its own nonce and hash: a sped-up copy has both from the replacement). Keeps the highest nonce. */
export function noteMined(chainId: number, address: Address, tx: { nonce: number; hash: Hash }) {
  const cur = lastMinedOf(chainId, address);
  if (cur && cur.nonce > tx.nonce) return;
  lastMined.set(keyOf(chainId, address), { nonce: tx.nonce, hash: tx.hash, at: Date.now() });
}

export type WalletSyncOptions = {
  /** Give up after this long and let the wallet prompt anyway; the send-conflict handling covers what is left. */
  timeoutMs?: number;
  intervalMs?: number;
  /** Stops the wait at once (the user closed the dialog: nothing has been sent for this step). */
  signal?: AbortSignal;
  /** Called once, when the first check shows the wallet behind, so the UI only mentions the wait when there is one. */
  onSlow?: () => void;
};

/**
 * Resolves `true` once the wallet's own "latest" transaction count is past `prev.nonce`, i.e. the wallet will pick the
 * next nonce. `false` when it gave up: timed out, aborted, or the wallet cannot answer the read (then there is nothing
 * to wait for). Never throws.
 *
 * Each check first asks the wallet for `prev`'s receipt: MetaMask refreshes its cached block when a receipt from a newer
 * block passes through its provider, before it answers, so the count read right after sees that block. On a chain where
 * the wallet's RPC is not ours, it also shows the wallet's node already has `prev`. "latest", not "pending": only
 * "latest" is pinned to MetaMask's cached block, and "pending" would say synced too early.
 */
export async function waitForWalletNonce(
  wallet: Client,
  address: Address,
  prev: { nonce: number; hash: Hash },
  { timeoutMs = 25_000, intervalMs = 750, signal, onSlow }: WalletSyncOptions = {},
): Promise<boolean> {
  const target = prev.nonce + 1;
  // Settles when the wait is over from outside (aborted or out of time). Every wallet call races it, so a wallet that
  // never answers cannot hold the flow either.
  let over = false;
  let end = () => {};
  const stop = new Promise<"stop">((resolve) => {
    end = () => {
      over = true;
      resolve("stop");
    };
  });
  const timer = setTimeout(end, timeoutMs);
  if (signal?.aborted) end();
  signal?.addEventListener("abort", end, { once: true });

  // true: synced; false: not yet; "error": the count could not be read.
  const check = async (): Promise<boolean | "error"> => {
    await Promise.race([wallet.request({ method: "eth_getTransactionReceipt", params: [prev.hash] }).catch(() => null), stop]);
    if (over) return false;
    try {
      const count = await Promise.race([getTransactionCount(wallet, { address, blockTag: "latest" }), stop]);
      return count !== "stop" && count >= target;
    } catch {
      return "error";
    }
  };

  try {
    if (over) return false;
    const first = await check();
    if (first !== false || over) return first === true;
    onSlow?.();
    while (!over) {
      await Promise.race([new Promise((r) => setTimeout(r, intervalMs)), stop]);
      // A failed read mid-wait is retried on the next tick; the timeout bounds it.
      if (!over && (await check()) === true) return true;
    }
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", end);
  }
}
