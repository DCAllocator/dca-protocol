import { defineChain } from "viem";
import { anvil, robinhood } from "viem/chains";

/** The canonical Multicall3: same address and runtime code on every chain that has it (Robinhood Chain included). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/**
 * Robinhood Chain — Arbitrum Orbit, chain id 4663, gas in ETH. viem's own definition: the official RPC
 * (https://rpc.mainnet.chain.robinhood.com, overridable with NEXT_PUBLIC_RH_RPC), the Blockscout explorer, 100 ms
 * blocks and the canonical Multicall3, so contract reads made in the same tick go out as one aggregate3 eth_call.
 */
export const robinhoodChain = defineChain({
  ...robinhood,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_RH_RPC || robinhood.rpcUrls.default.http[0]] } },
});

/**
 * Local anvil. Multicall3 is declared only when NEXT_PUBLIC_LOCAL_MULTICALL3=1, which env-from-deployment writes
 * after finding the canonical code at MULTICALL3 on the node (`pnpm fork` installs it): declared on a node without
 * it, every batched read would fail, while undeclared viem just sends one eth_call per read.
 */
export const localChain = defineChain({
  ...anvil,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_LOCAL_RPC ?? "http://127.0.0.1:8545"] } },
  ...(process.env.NEXT_PUBLIC_LOCAL_MULTICALL3 === "1" ? { contracts: { multicall3: { address: MULTICALL3 } } } : {}),
});

export const activeChain = process.env.NEXT_PUBLIC_CHAIN === "robinhood" ? robinhoodChain : localChain;
