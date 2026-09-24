import { formatUnits } from "viem";
import { feeOf, fmtUnits } from "@/lib/format";
import { USDG_DECIMALS } from "@/lib/config";

/*
 * What a plan's buys get at today's price, for the create form's estimate. An estimate only: every buy fills at
 * the on-chain price when its period runs (one pooled swap per vault and stock), so the real amount differs. Pure,
 * like `planFunds.ts`.
 */

/**
 * The fixed USDG amount the estimate's quote is taken for: one whole USDG, bought the way the vault buys (USDG → stock,
 * so the pool fee is paid once, on the way in, as it is on a real buy — a token → USDG "price" would count it in the
 * buyer's favour). Not this plan's own amount: the vault pools every plan's buy into one swap per period, so this plan's
 * size alone says little about its fill. The same probe `useBuyDcaRoute` quotes $DCA with, so a $DCA plan shares that
 * query. The answer is in the token's own units, which keeps the precision whatever the token costs.
 */
export const ESTIMATE_PROBE_USDG = 10n ** BigInt(USDG_DECIMALS);

/**
 * The fewest token units the probe must return for an estimate: scaling a floored quote up from one USDG multiplies its
 * rounding, so a probe answer this coarse (a token with few decimals and a very high price) shows nothing rather than a
 * figure off by more than ~0.01%. An 18-decimal token never gets near it.
 */
const MIN_PROBE_OUT = 10_000n;

/**
 * Stock one buy of `usdg` (USDG units) gets, scaled from `probeOut` (what `ESTIMATE_PROBE_USDG` buys now, in the token's
 * units), after the purchase fee: the vault takes `feeBps` of the spend before the swap, and the keeper tip is a share
 * of that fee, not on top of it. Undefined without a usable quote. Floored throughout, so it never reads high from
 * rounding.
 */
export function stockFor(usdg: bigint, probeOut: bigint | undefined, feeBps: number): bigint | undefined {
  if (probeOut === undefined || probeOut < MIN_PROBE_OUT) return undefined;
  const net = usdg - feeOf(usdg, feeBps);
  return (net * probeOut) / ESTIMATE_PROBE_USDG;
}

/**
 * A token amount for an estimate: four decimals from 1 up ("0.5515", "12.3456"), two from 1,000 up ("992,500.12"), and
 * four significant digits under 1 so a high-priced stock still reads ("0.0002143"). Truncated, never rounded up.
 */
export function fmtTokenAmount(v: bigint, decimals: number): string {
  const [int, frac = ""] = formatUnits(v, decimals).split(".");
  if (int !== "0") return fmtUnits(v, decimals, int.length > 3 ? 2 : 4);
  const lead = frac.search(/[1-9]/);
  return lead < 0 ? "0" : fmtUnits(v, decimals, Math.max(4, lead + 4));
}
