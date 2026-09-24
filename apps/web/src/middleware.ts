import { NextResponse, type NextRequest } from "next/server";
import { isBlockedCountry } from "@/lib/geo";
import { PRELAUNCH, PRELAUNCH_NOTICE_PARAM } from "@/lib/prelaunch";

/**
 * App-layer geo-block for /app. Contracts stay permissionless; this only gates the UI.
 * Country comes from the CDN (Vercel `x-vercel-ip-country`, Cloudflare `cf-ipcountry`). With no header
 * (local dev) the request is allowed. In prelaunch mode (lib/prelaunch.ts) every /app request goes back to the
 * landing instead, which then shows the "not launched yet" dialog.
 */
export function middleware(req: NextRequest) {
  if (PRELAUNCH) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = `?${PRELAUNCH_NOTICE_PARAM}`;
    return NextResponse.redirect(url);
  }
  const country = req.headers.get("x-vercel-ip-country") ?? req.headers.get("cf-ipcountry") ?? req.headers.get("x-country-code");
  if (isBlockedCountry(country)) {
    const url = req.nextUrl.clone();
    url.pathname = "/restricted";
    url.searchParams.set("c", country!.toUpperCase());
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/app/:path*"] };
