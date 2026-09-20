import {
  createWalletClient,
  getAddress,
  http,
  isAddress,
  parseEther,
  parseUnits,
  type Address,
} from "viem";
import { createCliClient, erc20Abi, resolveAsset } from "./token-resolver.js";

type Args = {
  from?: string;
  to?: string;
  asset?: string;
  amount?: string;
  rpcUrl?: string;
  json: boolean;
  help: boolean;
};

function usage(): string {
  return `Usage:
  pnpm transfer <from> <to> <ticker-or-token-address> <amount> [--rpc <url>] [--json]

Examples:
  pnpm transfer 0xFrom... 0xTo... ETH 1.5
  pnpm transfer 0xFrom... 0xTo... USDG 250
  pnpm transfer 0xFrom... 0xTo... NVDA 2.5 --json

This command only runs against the local Anvil fork (chain 31337). The from address must be unlocked by Anvil.`;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const args: Args = { json: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--rpc") {
      const value = argv[++i];
      if (!value) throw new Error("--rpc requires a URL");
      args.rpcUrl = value;
    } else if (arg.startsWith("--rpc=")) args.rpcUrl = arg.slice("--rpc=".length);
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }

  [args.from, args.to, args.asset, args.amount] = positional;
  if (positional.length > 4) throw new Error("Expected from, to, ticker/token address, and amount");
  return args;
}

function parseAmount(value: string, decimals: number): bigint {
  let amount: bigint;
  try {
    amount = parseUnits(value, decimals);
  } catch {
    throw new Error(`Invalid amount "${value}" for a token with ${decimals} decimals`);
  }
  if (amount <= 0n) throw new Error("Amount must be greater than zero");
  return amount;
}

async function requireUnlocked(wallet: ReturnType<typeof createWalletClient>, from: Address): Promise<void> {
  const unlocked = await wallet.getAddresses();
  if (!unlocked.some((address) => address.toLowerCase() === from.toLowerCase())) {
    throw new Error(`From wallet ${from} is not unlocked by Anvil`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.from || !args.to || !args.asset || !args.amount) throw new Error(`From, to, asset, and amount are required.\n\n${usage()}`);
  if (!isAddress(args.from)) throw new Error(`Invalid from address: ${args.from}`);
  if (!isAddress(args.to)) throw new Error(`Invalid to address: ${args.to}`);

  const from = getAddress(args.from);
  const to = getAddress(args.to);
  const { client, chain, chainId, rpcUrl } = await createCliClient(args.rpcUrl);
  if (chainId !== 31337) throw new Error(`Transfers are restricted to the local Anvil fork (chain 31337); connected to chain ${chainId}`);

  const wallet = createWalletClient({ account: from, chain, transport: http(rpcUrl, { retryCount: 2, timeout: 20_000 }) });
  await requireUnlocked(wallet, from);
  const token = await resolveAsset(client, chainId, args.asset);

  let symbol: string;
  let decimals: number;
  let rawAmount: bigint;
  let hash: `0x${string}`;
  if (token === null) {
    symbol = "ETH";
    decimals = 18;
    try {
      rawAmount = parseEther(args.amount);
    } catch {
      throw new Error(`Invalid ETH amount: ${args.amount}`);
    }
    if (rawAmount <= 0n) throw new Error("Amount must be greater than zero");
    hash = await wallet.sendTransaction({ account: from, chain, to, value: rawAmount });
  } else {
    [decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    ]);
    rawAmount = parseAmount(args.amount, decimals);
    const { request } = await client.simulateContract({
      account: from,
      address: token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, rawAmount],
    });
    hash = await wallet.writeContract(request);
  }

  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transfer reverted: ${hash}`);
  const result = { chainId, rpcUrl, from, to, asset: symbol, token, amount: args.amount, rawAmount: rawAmount.toString(), hash, blockNumber: receipt.blockNumber.toString() };
  console.log(args.json ? JSON.stringify(result, null, 2) : `Transferred ${args.amount} ${symbol} from ${from} to ${to}\n${hash}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});