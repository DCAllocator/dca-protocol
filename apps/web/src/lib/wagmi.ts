import { createConfig, http, injected, type CreateConnectorFn } from "wagmi";
import { mock } from "wagmi/connectors";
import { activeChain } from "./chain";

/**
 * Wallet discovery: wagmi's `multiInjectedProviderDiscovery` (on by default) listens for EIP-6963
 * announcements and creates one connector per installed wallet (MetaMask, Rabby, Phantom, ...), so the
 * user picks a wallet explicitly instead of getting whichever extension last claimed `window.ethereum`.
 * The generic `injected()` connector is kept only as a fallback for wallets that predate EIP-6963.
 */

/**
 * Local-only "test wallet": anvil's deterministic accounts are unlocked, so a connector that forwards
 * eth_sendTransaction straight to the node can sign without a browser extension. test1 (account 2) is
 * funded with USDG / WETH / $DCA by `pnpm fork`. Never registered on a real chain.
 */
export const TEST_WALLET_ID = "mock";
const local: CreateConnectorFn[] =
  activeChain.id === 31337
    ? [
        mock({
          accounts: [
            "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // test1
            "0x90F79bf6EB2c4f870365E785982E1f101E93b906", // test2
            "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", // test3
          ],
          features: { reconnect: true },
        }),
      ]
    : [];

export const wagmiConfig = createConfig({
  chains: [activeChain],
  transports: { [activeChain.id]: http() } as Record<typeof activeChain.id, ReturnType<typeof http>>,
  connectors: [injected(), ...local],
  multiInjectedProviderDiscovery: true,
  ssr: true,
});
