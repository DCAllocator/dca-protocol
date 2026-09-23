import { createConfig, http, injected } from "wagmi";
import { activeChain } from "./chain";

/**
 * Wallet discovery: wagmi's `multiInjectedProviderDiscovery` (on by default) listens for EIP-6963
 * announcements and creates one connector per installed wallet (MetaMask, Rabby, Phantom, ...), so the
 * user picks a wallet explicitly instead of getting whichever extension last claimed `window.ethereum`.
 * The generic `injected()` connector is kept only as a fallback for wallets that predate EIP-6963.
 * Only real browser wallets are registered; there is deliberately no mock/test connector (not even on the
 * local anvil chain), so every signature goes through a wallet the user picks and confirms.
 */
export const wagmiConfig = createConfig({
  chains: [activeChain],
  transports: { [activeChain.id]: http() } as Record<typeof activeChain.id, ReturnType<typeof http>>,
  batch: { multicall: { batchSize: 8_192 } }, // same-tick reads → one Multicall3 aggregate3 per 8 KB of calldata (viem default: 1 KB)
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  ssr: true,
});
