import type { Address } from "viem";
import { tickerIconUrl } from "@/lib/tickers";

/**
 * EIP-747 (`wallet_watchAsset`) parameters for a Stock Token, kept pure so the rules are documented in one place and
 * can be unit-tested without a wallet:
 *   - `symbol` is the registry ticker cut to 11 characters, the longest symbol MetaMask accepts (longer ones make it
 *     reject the whole request). MetaMask may still warn when this differs from the token's on-chain `symbol()`.
 *   - `decimals` passes through unchanged (18 for every Stock Token today, but the registry value is authoritative).
 *   - `image` is the ABSOLUTE URL of the light-theme ticker SVG: the wallet fetches it from its own context, so a
 *     site-relative path would resolve against the extension, not this app. With no origin (server render, tests)
 *     the field is omitted and the wallet shows its default glyph.
 */
export type WatchAssetParams = {
  type: "ERC20";
  options: { address: Address; symbol: string; decimals: number; image?: string };
};

export const WATCH_ASSET_SYMBOL_MAX = 11;

export function watchAssetParamsFor(stock: { address: Address; symbol: string; decimals: number }, origin?: string): WatchAssetParams {
  const options: WatchAssetParams["options"] = {
    address: stock.address,
    symbol: stock.symbol.slice(0, WATCH_ASSET_SYMBOL_MAX),
    decimals: stock.decimals,
  };
  if (origin) options.image = origin.replace(/\/+$/, "") + tickerIconUrl(stock.symbol, "light");
  return { type: "ERC20", options };
}
