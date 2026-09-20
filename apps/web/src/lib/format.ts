import { formatUnits } from "viem";

export const fmtUnits = (v: bigint | undefined, decimals: number, maxFrac = 4): string => {
  if (v === undefined) return "—";
  const s = formatUnits(v, decimals);
  const [i, f = ""] = s.split(".");
  const int = Number(i).toLocaleString("en-US");
  const frac = f.slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
};

/** Currency: always two decimals ("$1.00", "$0.50"). */
export const fmtUsd = (v: bigint | undefined, decimals = 6): string => {
  if (v === undefined) return "—";
  const s = formatUnits(v, decimals);
  const [i, f = ""] = s.split(".");
  return `$${Number(i).toLocaleString("en-US")}.${(f + "00").slice(0, 2)}`;
};

/** Compact currency for hero numbers: "$1.2M", "$32.8K", "$950.00". */
export const fmtUsdCompact = (v: bigint | undefined, decimals = 6): string => {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, decimals));
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 100_000) return `$${(n / 1_000).toFixed(1)}K`;
  return fmtUsd(v, decimals);
};

export const fmtBps = (bps: number | bigint | undefined): string =>
  bps === undefined ? "—" : `${(Number(bps) / 100).toFixed(2)}%`;

export const feeOf = (amount: bigint, bps: number | bigint): bigint => (amount * BigInt(bps)) / 10_000n;

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export const countdown = (target: number, now: number): string => {
  let s = Math.max(0, Math.floor(target - now));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
};

export const tsToDate = (ts: number | bigint) => new Date(Number(ts) * 1000).toUTCString().replace(" GMT", " UTC");

/** "20 Sep 2026, 00:00 UTC" — shorter than toUTCString for tables. */
export const tsToShort = (ts: number | bigint) => {
  const d = new Date(Number(ts) * 1000);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
};

/** value × price / 10^decimals — price is USDG per whole token. */
export const valueOf = (amount: bigint | undefined, price: bigint | undefined, decimals: number): bigint | undefined =>
  amount === undefined || price === undefined ? undefined : (amount * price) / 10n ** BigInt(decimals);
