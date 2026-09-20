import {
  formatUnits,
  getAddress,
  isAddress,
} from "viem";
import { createCliClient, DEFAULT_RPC_URL, erc20Abi, listAssets, resolveAsset } from "./token-resolver.js";

type Args = {
  wallet?: string;
  asset?: string;
  rpcUrl?: string;
  json: boolean;
  list: boolean;
  help: boolean;
};

function usage(): string {
  return `Usage:
  pnpm balance <wallet> <ticker-or-token-address> [--rpc <url>] [--json]
  pnpm balance --list [--rpc <url>]

Examples:
  pnpm balance 0x1234... ETH
  pnpm balance 0x1234... WETH --rpc http://127.0.0.1:8545
  pnpm balance 0x1234... NVDA --json

RPC defaults to RPC_URL, apps/scheduler/.env.local, then ${DEFAULT_RPC_URL}.
Tickers include ETH, WETH, USDG, and Robinhood Stock Tokens registered or configured for the connected chain.`;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const args: Args = { json: false, list: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--rpc") {
      const value = argv[++i];
      if (!value) throw new Error("--rpc requires a URL");
      args.rpcUrl = value;
    } else if (arg.startsWith("--rpc=")) args.rpcUrl = arg.slice("--rpc=".length);
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }

  [args.wallet, args.asset] = positional;
  if (positional.length > 2) throw new Error("Expected a wallet and one ticker or token address");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.list && (!args.wallet || !args.asset)) throw new Error(`Wallet and ticker/token address are required.\n\n${usage()}`);
  if (args.wallet && !isAddress(args.wallet)) throw new Error(`Invalid wallet address: ${args.wallet}`);

  const { client, chainId } = await createCliClient(args.rpcUrl);

  if (args.list) {
    console.log((await listAssets(client, chainId)).join("\n"));
    return;
  }

  const wallet = getAddress(args.wallet!);
  const requestedAsset = args.asset!;
  const ticker = requestedAsset.toUpperCase();
  if (ticker === "ETH") {
    const raw = await client.getBalance({ address: wallet });
    const result = { chainId, wallet, asset: "ETH", token: null, decimals: 18, raw: raw.toString(), formatted: formatUnits(raw, 18) };
    console.log(args.json ? JSON.stringify(result, null, 2) : `${result.formatted} ETH`);
    return;
  }

  const token = await resolveAsset(client, chainId, requestedAsset);
  if (!token) throw new Error("ETH must be handled as a native asset");
  const [raw, decimals, symbol] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
  ]);
  const result = { chainId, wallet, asset: symbol, token, decimals, raw: raw.toString(), formatted: formatUnits(raw, decimals) };
  console.log(args.json ? JSON.stringify(result, null, 2) : `${result.formatted} ${symbol}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});