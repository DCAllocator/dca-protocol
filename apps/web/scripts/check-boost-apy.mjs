// Cross-checks the boost APY three ways for Morpho Blue markets and prints them side by side:
//   api       Morpho's public API (blue-api.morpho.org) — only for chains it indexes
//   sdk       @morpho-org/blue-sdk Market.getSupplyApy from raw chain state (what the app shows)
//   fallback  the strategy's on-chain formula: borrowRateView × utilisation × (1 − fee), compounded
//
//   node scripts/check-boost-apy.mjs                                 # 8 largest live USDC markets on Ethereum mainnet
//   node scripts/check-boost-apy.mjs <rpc> <morpho> <chainId> <marketId>...   # any chain / market
import { createPublicClient, http, parseAbi } from "viem";
import { Market } from "@morpho-org/blue-sdk";

const [rpcArg, morphoArg, chainArg, ...ids] = process.argv.slice(2);
const RPC = rpcArg ?? "https://ethereum-rpc.publicnode.com";
const MORPHO = morphoArg ?? "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const CHAIN_ID = Number(chainArg ?? 1);
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const YEAR = 31_536_000;

const client = createPublicClient({ transport: http(RPC) });
const morphoAbi = parseAbi([
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
]);
const irmAbi = parseAbi([
  "function rateAtTarget(bytes32) view returns (int256)",
  "function borrowRateView((address,address,address,address,uint256), (uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)",
]);

async function api(query) {
  const r = await fetch("https://blue-api.morpho.org/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) }).then((x) => x.json());
  if (r.errors) throw new Error(r.errors.map((e) => e.message).join("; "));
  return r.data;
}

let markets;
if (ids.length > 0) markets = ids.map((marketId) => ({ marketId }));
else {
  const d = await api(`{ markets(first: 12, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: { chainId_in: [${CHAIN_ID}], loanAssetAddress_in: ["${USDC_MAINNET}"] }) { items { marketId loanAsset { symbol } collateralAsset { symbol } state { supplyApy utilization timestamp } } } }`);
  markets = d.markets.items;
}

const block = await client.getBlock();
console.log(`chain ${CHAIN_ID} block ${block.number} ts ${block.timestamp}`);
for (const mk of markets) {
  const id = mk.marketId;
  const [m, p] = await Promise.all([
    client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [id] }),
    client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [id] }),
  ]);
  const util = m[0] === 0n ? 0 : Number(m[2]) / Number(m[0]);
  if (!ids.length && util >= 0.999) continue; // dead, fully utilised markets pinned at the IRM cap
  const params = { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] };
  let rat;
  try {
    rat = await client.readContract({ address: p[3], abi: irmAbi, functionName: "rateAtTarget", args: [id] });
  } catch {
    rat = undefined; // not the AdaptiveCurveIrm: the sdk path is unavailable, only the fallback applies
  }
  const avgRate = await client.readContract({ address: p[3], abi: irmAbi, functionName: "borrowRateView", args: [[p[0], p[1], p[2], p[3], p[4]], [m[0], m[1], m[2], m[3], m[4], m[5]]] });
  let sdk = "n/a";
  try {
    sdk = (new Market({ params, totalSupplyAssets: m[0], totalSupplyShares: m[1], totalBorrowAssets: m[2], totalBorrowShares: m[3], lastUpdate: m[4], fee: m[5], rateAtTarget: rat }).getSupplyApy(block.timestamp) * 100).toFixed(3) + "%";
  } catch (e) {
    sdk = `n/a (${e.name})`;
  }
  const fallback = Math.expm1((Number(avgRate) / 1e18) * util * (1 - Number(m[5]) / 1e18) * YEAR);
  const label = mk.collateralAsset ? `${mk.collateralAsset.symbol}/${mk.loanAsset.symbol}` : id.slice(0, 10);
  const apiStr = mk.state ? `api ${(mk.state.supplyApy * 100).toFixed(3)}% (snapshot ${Number(block.timestamp) - mk.state.timestamp}s old)  ` : "";
  console.log(`${label.padEnd(28)} ${apiStr}sdk ${sdk}  fallback ${(fallback * 100).toFixed(3)}%  util ${(util * 100).toFixed(2)}%  idle ${Number(block.timestamp - m[4])}s`);
}
