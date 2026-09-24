import type { Address } from "viem";

/**
 * The Robinhood Stock Token mark (the feather on lime), served from /public. Robinhood's asset registry
 * (`api.robinhood.com/rhj/assets`, `logoUrl`) publishes one PNG per token address, but every one of them is this
 * same 180×180 image; a local copy also works for the mock tokens on a local anvil, whose addresses the CDN does
 * not know.
 */
export const STOCK_TOKEN_LOGO_PATH = "/robinhood-stock-token.png";

/** Our own mark (the one components/Logo.tsx renders), for $DCA: the protocol token is not a Robinhood Stock Token. */
export const DCA_TOKEN_LOGO_PATH = "/logo.png";

/**
 * EIP-747 (`wallet_watchAsset`) parameters for a Stock Token or $DCA, kept pure so the rules are documented in one
 * place and can be unit-tested without a wallet:
 *   - `symbol` is the registry ticker cut to 11 characters, the longest symbol MetaMask accepts (longer ones make it
 *     reject the whole request). MetaMask may still warn when this differs from the token's on-chain `symbol()`. For
 *     $DCA the caller passes the token's own `symbol()` and `decimals()` instead (see AddToWalletButton).
 *   - `decimals` passes through unchanged (18 for every Stock Token today, but the registry value is authoritative).
 *   - `image` is the ABSOLUTE URL of the Robinhood Stock Token logo — deliberately not the company's logo the app
 *     shows (/public/tickers): in the wallet the token should read as Robinhood's token, not as the stock itself.
 *     `logo: "dca"` swaps in our own mark for $DCA. The wallet fetches it from its own context, so a site-relative
 *     path would resolve against the extension, not this app. With no origin (server render, tests) the field is
 *     omitted and the wallet shows its default glyph.
 */
export type WatchAssetParams = {
  type: "ERC20";
  options: { address: Address; symbol: string; decimals: number; image?: string };
};

export const WATCH_ASSET_SYMBOL_MAX = 11;

export function watchAssetParamsFor(
  token: { address: Address; symbol: string; decimals: number },
  origin?: string,
  logo: "stock" | "dca" = "stock",
): WatchAssetParams {
  const options: WatchAssetParams["options"] = {
    address: token.address,
    symbol: token.symbol.slice(0, WATCH_ASSET_SYMBOL_MAX),
    decimals: token.decimals,
  };
  if (origin) options.image = origin.replace(/\/+$/, "") + (logo === "dca" ? DCA_TOKEN_LOGO_PATH : STOCK_TOKEN_LOGO_PATH);
  return { type: "ERC20", options };
}
