#!/usr/bin/env python3
"""Pick the stocks, feeds and pools a Robinhood Chain fork deploys with (run by scripts/fork-mainnet.sh).

A stock is listed when Chainlink publishes a feed for it on Robinhood Chain (the vaults refuse a stock without one) and
a Uniswap V3 route reaches it from USDG: a USDG pool, or else a WETH pool behind the WETH/USDG pools (the router's
two-hop). A pool counts when it holds at least FORK_MIN_POOL_USD on its USDG / WETH side and its price is within
FORK_MAX_DEVIATION_BPS of the feed; anything else would only revert in the price guard. Everything is read from the
fork itself, so the choice matches the block it was forked at.

  fork-mainnet-discover.py <rpc> <config.json> <chainlink-feeds.json> <rh-assets.json> <out.json>

Zero dependencies (stdlib only): eth_call batches straight to the fork's JSON-RPC.
"""
import json, os, re, sys, urllib.request

MIN_POOL_USD = float(os.environ.get("FORK_MIN_POOL_USD", "10000"))
MAX_DEV_BPS = float(os.environ.get("FORK_MAX_DEVIATION_BPS", "200"))
MAX_POOLS_PER_PAIR = 3
FEES = [100, 500, 3000, 10000]
SEL = {
    "getPool": "0x1698ee82", "balanceOf": "0x70a08231", "slot0": "0x3850c7bd", "token0": "0x0dfe1681",
    "decimals": "0x313ce567", "latestRoundData": "0xfeaf968c",
}

rpc_url, cfg_path, feeds_path, assets_path, out_path = sys.argv[1:6]
cfg = json.load(open(cfg_path))
USDG, WETH, FACTORY = cfg["usdg"].lower(), cfg["weth"].lower(), cfg["uniV3Factory"].lower()


def batch(calls):
    """eth_call each (to, data) at latest; None where it reverts."""
    out = []
    for i in range(0, len(calls), 200):
        chunk = calls[i:i + 200]
        body = [{"jsonrpc": "2.0", "id": j, "method": "eth_call", "params": [{"to": to, "data": data}, "latest"]} for j, (to, data) in enumerate(chunk)]
        req = urllib.request.Request(rpc_url, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
        res = {r["id"]: r.get("result") for r in json.load(urllib.request.urlopen(req, timeout=600))}
        out += [res.get(j) for j in range(len(chunk))]
    return out


def word(a):
    return a.lower().replace("0x", "").rjust(64, "0")


def as_addr(r):
    return "0x" + r[-40:] if r and len(r) >= 66 and int(r[-40:], 16) != 0 else None


def get_pool(a, b, fee):
    return (FACTORY, SEL["getPool"] + word(a) + word(b) + hex(fee)[2:].rjust(64, "0"))


def price(slot0, token0, base, base_dec, quote_dec):
    """Whole quote tokens per whole base token from a pool's slot0."""
    p = (int(slot0[2:66], 16) / 2**96) ** 2  # raw token1 per raw token0
    if p == 0:
        return None
    raw = p if token0 == base else 1 / p
    return raw * 10**base_dec / 10**quote_dec


def pools_for(base, base_dec, quote, quote_dec, quote_usd):
    """Every V3 pool of base/quote, with its quote-side depth in USD and its price in USD per whole base token."""
    base, quote = base.lower(), quote.lower()
    found = [(fee, as_addr(r)) for fee, r in zip(FEES, batch([get_pool(base, quote, fee) for fee in FEES]))]
    found = [(fee, p) for fee, p in found if p]
    if not found:
        return []
    reads = batch([c for _, p in found for c in [(quote, SEL["balanceOf"] + word(p)), (p, SEL["slot0"]), (p, SEL["token0"])]])
    out = []
    for i, (fee, p) in enumerate(found):
        bal, s0, t0 = reads[3 * i:3 * i + 3]
        if not (bal and s0 and t0):
            continue
        px = price(s0, "0x" + t0[-40:], base, base_dec, quote_dec)
        out.append({"pool": p, "fee": fee, "depthUsd": int(bal, 16) / 10**quote_dec * quote_usd, "priceUsd": px * quote_usd if px else None})
    return out


# WETH/USDG: the deposit / Zap route and the second hop of every WETH-routed stock.
weth_pools = pools_for(WETH, 18, USDG, 6, 1.0)
weth_pools.sort(key=lambda p: -p["depthUsd"])
if not weth_pools:
    sys.exit("no WETH/USDG pool on the Uniswap V3 factory: check config/fork.rh.json")
weth_usd = weth_pools[0]["priceUsd"]
weth_route = [p for p in weth_pools if p["depthUsd"] >= MIN_POOL_USD][:MAX_POOLS_PER_PAIR]

# Robinhood Stock Tokens on 4663, then the Chainlink feeds that price one of them.
tokens = {}
for a in json.load(open(assets_path))["assets"]:
    for d in a.get("deployments", []):
        if d.get("chainId") == 4663:
            tokens[a["tokenSymbol"].upper()] = d["contractAddress"]
feeds = {}
for f in json.load(open(feeds_path)):
    name = f.get("name") or ""
    m = re.match(r"^Robinhood ([A-Z0-9.]+)\s*[/-]\s*USD$", name) or re.match(r"^([A-Z0-9.]+) / USD$", name)
    if m and m.group(1) in tokens and f.get("proxyAddress"):
        feeds[m.group(1)] = f["proxyAddress"]

now = int(json.load(urllib.request.urlopen(urllib.request.Request(rpc_url, data=json.dumps(
    {"jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber", "params": ["latest", False]}).encode(),
    headers={"content-type": "application/json"})))["result"]["timestamp"], 16)

listed, excluded = [], []
for sym in sorted(feeds):
    token, feed = tokens[sym], feeds[sym]
    dec_r, frd, fdec = batch([(token, SEL["decimals"]), (feed, SEL["latestRoundData"]), (feed, SEL["decimals"])])
    if not (dec_r and frd and fdec):
        excluded.append({"symbol": sym, "token": token, "reason": "token or feed does not answer on the fork"})
        continue
    dec = int(dec_r, 16)
    feed_usd = int(frd[66:130], 16) / 10 ** int(fdec, 16)
    feed_age_h = round((now - int(frd[194:258], 16)) / 3600, 1)

    def usable(pools):
        ok = []
        for p in pools:
            p["devBps"] = round((p["priceUsd"] / feed_usd - 1) * 10_000) if p["priceUsd"] and feed_usd else None
            if p["depthUsd"] >= MIN_POOL_USD and p["devBps"] is not None and abs(p["devBps"]) <= MAX_DEV_BPS:
                ok.append(p)
        return sorted(ok, key=lambda p: -p["depthUsd"])[:MAX_POOLS_PER_PAIR]

    direct = pools_for(token, dec, USDG, 6, 1.0)
    route, chosen = "USDG", usable(direct)
    via = []
    if not chosen and weth_route:
        via = pools_for(token, dec, WETH, 18, weth_usd)
        route, chosen = "WETH", usable(via)
    row = {"symbol": sym, "token": token, "feed": feed, "feedUsd": feed_usd, "feedAgeHours": feed_age_h}
    if chosen:
        listed.append({**row, "route": route, "pools": chosen})
    else:
        seen = direct + via
        deep = [p for p in seen if p["depthUsd"] >= MIN_POOL_USD]
        if not seen:
            reason = "no Uniswap V3 USDG or WETH pool"
        elif not deep:
            reason = f"pools too thin (deepest ${max(p['depthUsd'] for p in seen):,.0f})"
        else:
            worst = min(deep, key=lambda p: abs(p["devBps"] or 1e9))
            reason = f"pool price {worst['devBps'] / 100:+.2f}% off the feed" if worst["devBps"] is not None else "pool has no price"
        excluded.append({**row, "reason": reason})

v3_pools = [p["pool"] for p in weth_route] + [p["pool"] for s in listed for p in s["pools"]]
out = {
    "forkTimestamp": now,
    "minPoolUsd": MIN_POOL_USD,
    "maxDeviationBps": MAX_DEV_BPS,
    "wethUsd": weth_usd,
    "wethUsdgPools": weth_route,
    "stocks": listed,
    "excluded": excluded,
    "env": {
        "STOCKS": ",".join(f"{s['symbol']}:{s['token']}" for s in listed),
        "PRICE_FEEDS": ",".join(f"{s['token']}:{s['feed']}" for s in listed),
        "V3_POOLS": ",".join(f"1:{p}" for p in dict.fromkeys(v3_pools)),
    },
}
json.dump(out, open(out_path, "w"), indent=1)

print(f"{'stock':7} {'route':5} {'feed $':>10} {'age h':>6}  {'pool (fee, depth, vs feed)'}")
for s in listed:
    pools = "; ".join(f"{p['fee'] / 1e4:g}% ${p['depthUsd'] / 1e3:,.0f}k {p['devBps'] / 100:+.2f}%" for p in s["pools"])
    print(f"{s['symbol']:7} {s['route']:5} {s['feedUsd']:>10,.2f} {s['feedAgeHours']:>6}  {pools}")
for s in excluded:
    print(f"{s['symbol']:7} skip  {s['reason']}")
print(f"{len(listed)} stocks listed, {len(excluded)} skipped; WETH/USDG ${weth_usd:,.2f} over {len(weth_route)} pool(s)")
