import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  parseAbi,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import { PKG_ROOT, REPO_ROOT } from "./config.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEFAULT_RPC_URL = "https://rpc.robinhood.xyz";
export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const registryAbi = parseAbi([
  "function allStocks() view returns (address[])",
  "function info(address token) view returns ((bool approved, bool known, bool feeOnTransfer, uint8 decimals, string symbol))",
]);

type Deployment = {
  chainId?: number;
  registry?: Address;
  usdg?: Address;
  weth?: Address;
};

type AddressConfig = {
  chainId: number;
  tokens: Record<string, string>;
  stocks: Record<string, { address: string } | string>;
};

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadCliEnv(): void {
  for (const file of [".env.local", ".env"]) {
    const path = join(PKG_ROOT, file);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

export async function createCliClient(rpcUrl?: string): Promise<{
  client: PublicClient;
  chain: Chain;
  chainId: number;
  rpcUrl: string;
}> {
  loadCliEnv();
  const resolvedRpcUrl = rpcUrl ?? process.env.RPC_URL ?? DEFAULT_RPC_URL;
  const transport = http(resolvedRpcUrl, { retryCount: 2, timeout: 20_000 });
  const chainId = await createPublicClient({ transport }).getChainId();
  const chain = defineChain({
    id: chainId,
    name: chainId === 31337 ? "anvil" : chainId === 4663 ? "Robinhood Chain" : `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [resolvedRpcUrl] } },
  });
  return { client: createPublicClient({ chain, transport }), chain, chainId, rpcUrl: resolvedRpcUrl };
}

function configuredAddresses(chainId: number): Map<string, Address> {
  const lookup = new Map<string, Address>();
  const deployment = readJson<Deployment>(join(REPO_ROOT, "contracts", "deployments", `${chainId}.json`));
  if (deployment?.usdg && deployment.usdg !== ZERO_ADDRESS) lookup.set("USDG", getAddress(deployment.usdg));
  if (deployment?.weth && deployment.weth !== ZERO_ADDRESS) lookup.set("WETH", getAddress(deployment.weth));

  const config = readJson<AddressConfig>(join(REPO_ROOT, "contracts", "config", "addresses.rh.json"));
  if (config?.chainId !== chainId) return lookup;
  for (const ticker of ["USDG", "WETH"]) {
    const address = config.tokens[ticker];
    if (address && address !== ZERO_ADDRESS) lookup.set(ticker, getAddress(address));
  }
  for (const [ticker, entry] of Object.entries(config.stocks)) {
    if (ticker.startsWith("_")) continue;
    const address = typeof entry === "string" ? entry : entry.address;
    if (address && address !== ZERO_ADDRESS) lookup.set(ticker.toUpperCase(), getAddress(address));
  }
  return lookup;
}

async function addRegistryStocks(client: PublicClient, chainId: number, lookup: Map<string, Address>): Promise<void> {
  const deployment = readJson<Deployment>(join(REPO_ROOT, "contracts", "deployments", `${chainId}.json`));
  if (!deployment?.registry || deployment.registry === ZERO_ADDRESS) return;
  const registry = getAddress(deployment.registry);
  const stocks = await client.readContract({ address: registry, abi: registryAbi, functionName: "allStocks" });
  const infos = await Promise.all(
    stocks.map((address) => client.readContract({ address: registry, abi: registryAbi, functionName: "info", args: [address] })),
  );
  infos.forEach((info, index) => lookup.set(info.symbol.toUpperCase(), getAddress(stocks[index])));
}

export async function listAssets(client: PublicClient, chainId: number): Promise<string[]> {
  const lookup = configuredAddresses(chainId);
  await addRegistryStocks(client, chainId, lookup);
  return ["ETH", ...lookup.keys()].sort();
}

export async function resolveAsset(client: PublicClient, chainId: number, asset: string): Promise<Address | null> {
  if (asset.toUpperCase() === "ETH") return null;
  if (isAddress(asset)) return getAddress(asset);
  const ticker = asset.toUpperCase();
  const lookup = configuredAddresses(chainId);
  if (!lookup.has(ticker)) await addRegistryStocks(client, chainId, lookup);
  const token = lookup.get(ticker);
  if (!token) throw new Error(`Unknown ticker "${asset}" on chain ${chainId}. Use pnpm balance --list, a raw ERC-20 address, or populate contracts/config/addresses.rh.json.`);
  return token;
}