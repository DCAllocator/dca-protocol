#!/usr/bin/env bash
# Share the local stack for user testing: the web app on Vercel (SITE_URL, default https://dcallocator.app), the chain
# on this machine.
#
#   tester's browser + wallet ─► SITE_URL/api/rpc (Vercel) ─► Cloudflare quick tunnel ─► share-rpc-guard :8547 ─► anvil :8545
#
# Needs `pnpm fork` running (anvil + contracts/deployments/31337.json), `pnpm scheduler` for the buys, cloudflared
# (brew install cloudflared) and the Vercel CLI logged in with this repo linked (`vercel link` at the repo root, root
# directory apps/web). A quick tunnel gets a new URL every run, so every run redeploys the site with it and with the
# current contract addresses (~1-2 min). Ctrl-C closes the tunnel; the site then reports the test chain as offline.
#
#   pnpm share
#   SITE_URL=https://<project>.vercel.app pnpm share    # before the custom domain is live
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_JSON="$ROOT/contracts/deployments/31337.json"
RPC="${RPC:-http://127.0.0.1:8545}"
GUARD_PORT="${GUARD_PORT:-8547}"
SITE_URL="${SITE_URL:-https://dcallocator.app}"
SITE_URL="${SITE_URL%/}"
VERCEL="${VERCEL:-vercel}"
MULTICALL3=0xcA11bde05977b3631167028862bE2a173976CA11
MULTICALL3_CODEHASH=0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

log() { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

for bin in cloudflared cast node python3 curl openssl; do
  command -v "$bin" >/dev/null || die "missing: $bin$([[ $bin == cloudflared ]] && echo ' (brew install cloudflared)')"
done
command -v "$VERCEL" >/dev/null || die "missing: the Vercel CLI (npm i -g vercel, then vercel login)"
[[ -f "$ROOT/.vercel/project.json" ]] || die "not linked to a Vercel project: run 'vercel link' in $ROOT (code directory: apps/web)"
[[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" == 31337 ]] || die "no anvil at $RPC: start 'pnpm fork' first"
[[ -f "$DEPLOY_JSON" ]] || die "missing $DEPLOY_JSON: start 'pnpm fork' first"
addr() { python3 -c "import json,sys;print(json.load(open('$DEPLOY_JSON')).get('$1') or '')"; }
DIRECTORY=$(addr directory)
[[ "$(cast code "$DIRECTORY" --rpc-url "$RPC")" != 0x ]] \
  || die "deployments/31337.json does not match the chain at $RPC (no VaultDirectory at $DIRECTORY): restart 'pnpm fork'"
! lsof -iTCP:"$GUARD_PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1 || die "port $GUARD_PORT is busy (another 'pnpm share'?)"
pgrep -f "apps/scheduler|@dca/scheduler" >/dev/null || echo "note: 'pnpm scheduler' does not seem to be running, so no buys will happen"

# A fresh key per run: the deployment made below is the only thing that knows it, so an older deployment (or anyone who
# finds the tunnel URL) cannot reach anvil.
SHARE_RPC_KEY=$(openssl rand -hex 24)
TMP="$(mktemp -d -t dca-share-XXXXXX)"
GUARD_PID=""; TUNNEL_PID=""
cleanup() {
  echo; echo "Closing the tunnel and the guard"
  [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  [[ -n "$GUARD_PID" ]] && kill "$GUARD_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

log "RPC guard on 127.0.0.1:${GUARD_PORT} → ${RPC}"
SHARE_RPC_KEY="$SHARE_RPC_KEY" GUARD_PORT="$GUARD_PORT" UPSTREAM="$RPC" node "$ROOT/scripts/share-rpc-guard.mjs" &
GUARD_PID=$!
for _ in $(seq 1 20); do lsof -iTCP:"$GUARD_PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1 && break; sleep 0.5; done

log "Cloudflare quick tunnel"
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${GUARD_PORT}" > "$TMP/tunnel.log" 2>&1 &
TUNNEL_PID=$!
TUNNEL_URL=""
for _ in $(seq 1 60); do
  TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TMP/tunnel.log" | grep -v '^https://api\.' | head -1 || true)
  [[ -n "$TUNNEL_URL" ]] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || { cat "$TMP/tunnel.log"; die "cloudflared exited"; }
  sleep 1
done
[[ -n "$TUNNEL_URL" ]] || { cat "$TMP/tunnel.log"; die "no tunnel URL from cloudflared after 60 s"; }
echo "$TUNNEL_URL"

chain_id_via() { curl -s -m 5 -X POST -H 'content-type: application/json' ${2:+-H "x-share-key: $2"} \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$1" 2>/dev/null || true; }
reached=""
for _ in $(seq 1 30); do [[ "$(chain_id_via "$TUNNEL_URL" "$SHARE_RPC_KEY")" == *0x7a69* ]] && { reached=1; break; }; sleep 2; done
[[ -n "$reached" ]] && echo "tunnel → guard → anvil: ok" \
  || echo "warning: could not reach anvil through the tunnel from here yet (new tunnels can take a minute to resolve); deploying anyway"

LOCAL_MULTICALL3=""
code=$(cast code "$MULTICALL3" --rpc-url "$RPC")
[[ "$code" != 0x && "$(cast keccak "$code")" == "$MULTICALL3_CODEHASH" ]] && LOCAL_MULTICALL3=1
# Without it every contract read is its own request through Vercel and the tunnel (~220 for the landing page vs ~6).
[[ -n "$LOCAL_MULTICALL3" ]] || echo "warning: no Multicall3 on ${RPC}; restart it with the current 'pnpm fork' (it installs one) so reads are batched"

log "Deploying ${SITE_URL} (Vercel production)"
BUILD_ENV=(
  -b ENABLE_EXPERIMENTAL_COREPACK=1
  -b NEXT_PUBLIC_CHAIN=local
  -b "NEXT_PUBLIC_LOCAL_RPC=${SITE_URL}/api/rpc"
  -b "NEXT_PUBLIC_DIRECTORY=${DIRECTORY}"
  -b "NEXT_PUBLIC_CLAIM_HELPER=$(addr claimHelper)"
  -b "NEXT_PUBLIC_ZAP=$(addr zap)"
  -b "NEXT_PUBLIC_KEEPER=$(addr keeper)"
  -b "NEXT_PUBLIC_TEST_VAULT=$(addr testVault)"
  -b NEXT_PUBLIC_SHOW_TEST_VAULT=1
  -b NEXT_PUBLIC_LOG_LOOKBACK=200000
  -b NEXT_PUBLIC_BLOCKED_COUNTRIES=CU,IR,KP,SY
)
[[ -n "$LOCAL_MULTICALL3" ]] && BUILD_ENV+=(-b NEXT_PUBLIC_LOCAL_MULTICALL3=1)
RUN_ENV=(-e "RPC_UPSTREAM=${TUNNEL_URL}" -e "RPC_UPSTREAM_KEY=${SHARE_RPC_KEY}")
[[ -n "${COINGECKO_API_KEY:-}" ]] && RUN_ENV+=(-e "COINGECKO_API_KEY=${COINGECKO_API_KEY}")
( cd "$ROOT" && "$VERCEL" deploy --prod --yes "${BUILD_ENV[@]}" "${RUN_ENV[@]}" )

if [[ "$(chain_id_via "${SITE_URL}/api/rpc")" == *0x7a69* ]]; then
  echo "${SITE_URL}/api/rpc → anvil: ok"
else
  echo "warning: ${SITE_URL}/api/rpc does not answer yet (domain not live? then rerun with SITE_URL=https://<project>.vercel.app)"
fi

cat <<MSG

$(printf '\033[1m')Shared:$(printf '\033[0m') ${SITE_URL}/app   (chain 31337, test vault buys every few minutes while 'pnpm scheduler' runs)

Testers: MetaMask (or Rabby) in a browser profile that holds no real funds → Connect → "Switch network" adds the
test chain (RPC ${SITE_URL}/api/rpc). Fund their address from here:  pnpm fund <address>
After a fresh 'pnpm fork', testers clear MetaMask's activity data (Settings → Advanced) or it reuses old nonces.

$(printf '\033[1m')Leave this terminal open.$(printf '\033[0m') Ctrl-C closes the tunnel; the site then shows the chain as offline.
MSG

wait "$TUNNEL_PID"
