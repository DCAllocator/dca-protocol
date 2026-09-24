import { activeChain } from "@/lib/chain";
import { BUY_DCA_URL } from "@/lib/config";
import { socialUrl } from "@/lib/socials";

/**
 * /v2 landing: every outbound link is config-driven and hidden when unset (never a dead icon, never a bare
 * github.com). Launch parameters are the Pons V2 mechanics as the founder stated them; `creatorTaxPct` is the
 * one number still to be decided — it ships as 0 here and must equal the real launch parameter.
 */
const env = (v: string | undefined) => (v && /^https?:\/\//.test(v) ? v : undefined);

export const V2 = {
  /** "Buy $DCA on Pons": the Pons token page once NEXT_PUBLIC_BUY_DCA_URL is set; until then the button is "Buy $DCA" to /app/buy. */
  buyUrl: BUY_DCA_URL,
  buyIsExternal: /^https?:\/\//.test(BUY_DCA_URL),
  ponsUrl: env(process.env.NEXT_PUBLIC_PONS_URL) ?? env(process.env.NEXT_PUBLIC_BUY_DCA_URL),
  /** Community links come from lib/socials.ts (placeholders on the local test chain). */
  xUrl: socialUrl("twitter"),
  telegramUrl: socialUrl("telegram"),
  repoUrl: env(process.env.NEXT_PUBLIC_REPO_URL),
  chartUrl: env(process.env.NEXT_PUBLIC_CHART_URL),
  siteUrl: env(process.env.NEXT_PUBLIC_SITE_URL),
  explorer: activeChain.blockExplorers?.default.url,
  launch: {
    supply: 1_000_000_000,
    graduationEth: 4.2,
    tradeFeePct: 1,
    creatorSharePct: 70,
    ponsSharePct: 30,
    /** Optional Pons creator tax (≤ 10%, fixed at launch). Decision pending — see the founder. */
    creatorTaxPct: 0,
  },
  /** FeeReceiver.sol constants (also read live by useFeeReceiver; these label the source). */
  split: { treasuryBps: 7_000, buybackBps: 3_000, maxSlippageCapBps: 500, defaultSlippageBps: 50, guardMinutes: 30 },
  /** FeeMath.MAX_FEE_BPS */
  maxFeeBps: 90,
  /** AggregatorRouter impact cap, PriceGuardLib max deviation */
  impactCapBps: 150,
  /** Pinned first on the tape and above the grid: the tickers this audience already trades. */
  degenAdjacent: ["MSTR", "COIN", "PLTR", "GME", "AMC", "HIMS", "SPCX", "CRCL"],
  /** Internal switch: the constants strip becomes live usage past this much stock bought (USDG, 6 dp). */
  liveStripMinNotional: 25_000n * 10n ** 6n,
} as const;

/** Share of every $DCA trade that ends up burned when the Pons creator address is the FeeReceiver. */
export const TRADE_BURN_PCT = (V2.launch.tradeFeePct * (V2.launch.creatorSharePct / 100) * (V2.split.buybackBps / 10_000)).toFixed(2);

export const explorerAddress = (a?: string) => (V2.explorer && a ? `${V2.explorer}/address/${a}` : undefined);
export const explorerTx = (h?: string) => (V2.explorer && h ? `${V2.explorer}/tx/${h}` : undefined);
export const repoFile = (path: string) => (V2.repoUrl ? `${V2.repoUrl.replace(/\/$/, "")}/blob/main/${path}` : undefined);

/** Fee in bps → "0.50%"; the holder fee is floored in bps exactly like FeeMath does (75 → 37). */
export const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
export const halfBps = (bps: number) => Math.floor(bps / 2);

export const DEAD = "0x000000000000000000000000000000000000dEaD";
export const CHAIN_ID = 4663;
