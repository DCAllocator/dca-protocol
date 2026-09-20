import { defineChain } from "viem";
import { anvil } from "viem/chains";

/** Robinhood Chain — Arbitrum Orbit, chain id 4663, gas in ETH. RPC / explorer: see config/addresses.rh.json (TODO verify). */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_RH_RPC ?? "https://rpc.robinhood.xyz"] },
  },
  blockExplorers: {
    default: { name: "Robinhood Explorer", url: "https://explorer.robinhood.xyz" },
  },
  testnet: false,
});

export const localChain = defineChain({
  ...anvil,
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_LOCAL_RPC ?? "http://127.0.0.1:8545"] } },
});

export const activeChain = process.env.NEXT_PUBLIC_CHAIN === "robinhood" ? robinhoodChain : localChain;
