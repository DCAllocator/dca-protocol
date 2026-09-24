import { NextResponse, type NextRequest } from "next/server";
import { isBlockedCountry } from "@/lib/geo";

/**
 * App-layer geo-block for /app. Contracts stay permissionless; this only gates the UI.
 * Country comes from the CDN (Vercel `x-vercel-ip-country`, Cloudflare `cf-ipcountry`). With no header
 * (local dev) the request is allowed.
 */
export function middleware(req: NextRequest) {
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
