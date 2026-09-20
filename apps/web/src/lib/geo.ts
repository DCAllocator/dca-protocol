export const BLOCKED_COUNTRIES = (process.env.NEXT_PUBLIC_BLOCKED_COUNTRIES ?? "US,GB,CA,AU,CU,IR,KP,SY")
  .split(",")
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

export const isBlockedCountry = (code?: string | null) => !!code && BLOCKED_COUNTRIES.includes(code.toUpperCase());
