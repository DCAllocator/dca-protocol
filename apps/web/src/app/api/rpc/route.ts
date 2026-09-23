import type { NextRequest } from "next/server";

/**
 * JSON-RPC for a shared local stack (`pnpm share`, scripts/share.sh). The hosted app is built with
 * NEXT_PUBLIC_LOCAL_RPC=<site>/api/rpc, so the page and the tester's wallet (the app adds the network with that URL)
 * both talk to this route, which relays the body to RPC_UPSTREAM — a tunnel to scripts/share-rpc-guard.mjs on the
 * machine running anvil — with RPC_UPSTREAM_KEY in `x-share-key`. The guard checks the key and the method allowlist;
 * this route only relays. Without RPC_UPSTREAM (every normal build) it answers 404.
 */
export const dynamic = "force-dynamic";

const MAX_BODY = 512 * 1024;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const rpcError = (status: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message } }, { status, headers: CORS });

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  const upstream = process.env.RPC_UPSTREAM;
  if (!upstream) return new Response("Not found", { status: 404 });
  const body = await req.text();
  if (body.length > MAX_BODY) return rpcError(413, "Request too large");
  try {
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json", "x-share-key": process.env.RPC_UPSTREAM_KEY ?? "" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    const type = res.headers.get("content-type") ?? "";
    // A closed tunnel answers with Cloudflare's HTML error page, not JSON-RPC.
    if (!type.includes("json")) return rpcError(502, "The test chain is offline");
    return new Response(await res.text(), {
      status: res.status,
      headers: { ...CORS, "content-type": type, "cache-control": "no-store" },
    });
  } catch {
    return rpcError(502, "The test chain is offline");
  }
}
