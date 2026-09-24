#!/usr/bin/env bash
# Local Anvil chain with the full DCA stack deployed on top of mocked USDG/WETH/$DCA/stocks
# (see contracts/script/DeployLocal.s.sol). Leaves Anvil running until Ctrl-C.
#
# Six roles, pulled automatically from anvil's own deterministic accounts (0-5):
#   deployer   account 0   deploys + owns/admins every contract
#   treasury   account 1   feeRecipient — where protocol fees accrue
#   test1-3    accounts 2-4   funded wallets for interacting with the protocol
#   bot        account 5   the epoch scheduler's wallet (apps/scheduler) — pays gas for EpochKeeper.run
# All six get ETH (anvil's genesis funding); the first five get USDG; test1-3 also get WETH and $DCA.
#
# Besides Hourly / Daily / Weekly / Monthly the local stack has a TestVault with a short epoch (TEST_EPOCH_MINUTES,
# default 2) and three seeded plans, so `pnpm scheduler` has an epoch to advance every couple of minutes.
# Before deploying it installs the canonical Multicall3 at 0xcA11…CA11, so reads batch like on Robinhood Chain.
#
#   pnpm fork                        # start anvil, deploy the local stack, write apps/{web,scheduler}/.env.local
#   PORT=8546 pnpm fork              # run on a different port
#   TEST_EPOCH_MINUTES=5 pnpm fork   # test vault epoch of 5 minutes instead of 2
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/contracts"
WEB="$ROOT/apps/web"
SCHEDULER="$ROOT/apps/scheduler"
PORT="${PORT:-8545}"
TEST_EPOCH_MINUTES="${TEST_EPOCH_MINUTES:-2}"
RPC="http://127.0.0.1:${PORT}"
ANVIL_LOG="$(mktemp -t dca-anvil-XXXXXX.log)"

export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
for bin in anvil forge cast node python3; do command -v "$bin" >/dev/null || { echo "missing: $bin (install Foundry: https://getfoundry.sh)"; exit 1; }; done

log() { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }

# Refuse to run against something already listening: it may be a fork you started earlier, or something
# unrelated — either way a second deploy here would broadcast against the wrong chain.
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Port ${PORT} is already in use (another 'pnpm fork'?)."
  echo "Stop it first, or run with PORT=<other> to start on a different port."
  exit 1
fi

log "Starting Anvil (chain id 31337, port ${PORT})"
anvil --port "$PORT" > "$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
trap 'echo; echo "Stopping Anvil"; kill $ANVIL_PID 2>/dev/null || true; rm -f "$ANVIL_LOG"' EXIT INT TERM
for _ in $(seq 1 30); do
  kill -0 "$ANVIL_PID" 2>/dev/null || { echo "Anvil exited during startup (port taken?)"; cat "$ANVIL_LOG"; exit 1; }
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done
cast chain-id --rpc-url "$RPC" >/dev/null || { echo "Anvil did not come up"; exit 1; }

# The canonical Multicall3, as on Robinhood Chain (scripts/multicall3.runtime.hex is its runtime code there, identical
# to Ethereum's), so the app batches contract reads into one aggregate3 eth_call here too. env-from-deployment checks
# for it before writing NEXT_PUBLIC_LOCAL_MULTICALL3=1.
MULTICALL3=0xcA11bde05977b3631167028862bE2a173976CA11
MULTICALL3_CODEHASH=0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891
log "Installing Multicall3 at ${MULTICALL3}"
cast rpc anvil_setCode "$MULTICALL3" "$(tr -d '\n' < "$ROOT/scripts/multicall3.runtime.hex")" --rpc-url "$RPC" >/dev/null
# keccak of the code rather than `cast codehash`: a forked anvil answers eth_getProof with the empty hash after setCode.
[[ "$(cast keccak "$(cast code "$MULTICALL3" --rpc-url "$RPC")")" == "$MULTICALL3_CODEHASH" ]] || { echo "Multicall3 install failed: unexpected code at ${MULTICALL3}"; exit 1; }

# Pull the 6 role wallets straight from anvil's own "Available Accounts" / "Private Keys" banner
# (mnemonic "test test ... junk") rather than hardcoding them. (mapfile/readarray needs bash 4+,
# which macOS's default /bin/bash — 3.2 — doesn't have, hence the portable read loop.)
ADDR=(); PK=()
while IFS= read -r a; do ADDR+=("$a"); done < <(awk '/^Available Accounts/{f=1;next} /^Private Keys/{f=0} f && /^\([0-9]+\) 0x/{print $2}' "$ANVIL_LOG")
while IFS= read -r k; do PK+=("$k"); done < <(awk '/^Private Keys/{f=1;next} f && /^\([0-9]+\) 0x/{print $2}' "$ANVIL_LOG")
[[ "${#ADDR[@]}" -ge 6 && "${#PK[@]}" -ge 6 ]] || { echo "could not parse accounts from anvil's startup log ($ANVIL_LOG)"; exit 1; }

DEPLOYER="${ADDR[0]}"; DEPLOYER_PK="${PK[0]}"
TREASURY="${ADDR[1]}"; TREASURY_PK="${PK[1]}"
TEST1="${ADDR[2]}"; TEST1_PK="${PK[2]}"
TEST2="${ADDR[3]}"; TEST2_PK="${PK[3]}"
TEST3="${ADDR[4]}"; TEST3_PK="${PK[4]}"
BOT="${ADDR[5]}"; BOT_PK="${PK[5]}"

log "Deploying the local stack (mocks + router/vaults/keeper + ${TEST_EPOCH_MINUTES}-minute test vault)"
( cd "$CONTRACTS" && TREASURY="$TREASURY" TEST1="$TEST1" TEST2="$TEST2" TEST3="$TEST3" BOT="$BOT" \
  TEST_EPOCH_MINUTES="$TEST_EPOCH_MINUTES" \
  forge script script/DeployLocal.s.sol --rpc-url "$RPC" --broadcast --slow --private-key "$DEPLOYER_PK" )
DEPLOY_JSON="$CONTRACTS/deployments/31337.json"
[[ -f "$DEPLOY_JSON" ]] || { echo "Deploy failed: $DEPLOY_JSON not written"; exit 1; }
USDG=$(python3 -c "import json;print(json.load(open('$DEPLOY_JSON'))['usdg'])")
KEEPER=$(python3 -c "import json;print(json.load(open('$DEPLOY_JSON'))['keeper'])")
TEST_VAULT=$(python3 -c "import json;print(json.load(open('$DEPLOY_JSON'))['testVault'])")

log "Writing ${WEB}/.env.local"
LOCAL_RPC="$RPC" node "$WEB/scripts/env-from-deployment.mjs" 31337

log "Writing ${SCHEDULER}/.env.local"
cat > "$SCHEDULER/.env.local" <<ENV
# Written by scripts/fork.sh — local anvil only. The key is anvil's public account 5 ("bot").
RPC_URL=${RPC}
KEEPER_ADDRESS=${KEEPER}
PRIVATE_KEY=${BOT_PK}
ENV

log "Wallets"
eth() { cast balance "$1" --rpc-url "$RPC" -e | cut -c1-10; }
usdg() { python3 -c "print(f'{int(\"$(cast call "$USDG" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC" | cut -d' ' -f1)\")/1e6:,.2f}')"; }
BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RST=$(printf '\033[0m')
printf '%-11s %-44s %10s %12s   %s\n' "role" "address" "ETH" "USDG" "private key"
printf '%-11s %-44s %10s %12s   %s\n' "deployer" "$DEPLOYER" "$(eth "$DEPLOYER")" "$(usdg "$DEPLOYER")" "$DEPLOYER_PK"
printf '%-11s %-44s %10s %12s   %s\n' "treasury" "$TREASURY" "$(eth "$TREASURY")" "$(usdg "$TREASURY")" "$TREASURY_PK"
printf '%-11s %-44s %10s %12s   %s\n' "test1" "$TEST1" "$(eth "$TEST1")" "$(usdg "$TEST1")" "$TEST1_PK"
printf '%-11s %-44s %10s %12s   %s\n' "test2" "$TEST2" "$(eth "$TEST2")" "$(usdg "$TEST2")" "$TEST2_PK"
printf '%-11s %-44s %10s %12s   %s\n' "test3" "$TEST3" "$(eth "$TEST3")" "$(usdg "$TEST3")" "$TEST3_PK"
printf '%-11s %-44s %10s %12s   %s\n' "bot" "$BOT" "$(eth "$BOT")" "$(usdg "$BOT")" "$BOT_PK"

cat <<MSG

${BOLD}Fork is ready.${RST}  In other terminals:   pnpm dev              →  http://localhost:3000
                                       pnpm dev:test-vault   →  same, with the test vault shown in the app
                                       pnpm scheduler        →  advances epochs (test vault every ${TEST_EPOCH_MINUTES} min)

${DIM}test1-3 also hold 100 WETH and 60,000 \$DCA each. Deployer owns/admins the protocol; treasury is feeRecipient.
Test vault ${TEST_VAULT} (${TEST_EPOCH_MINUTES}-minute epochs) holds three deployer-owned plans: NVDA 100, AAPL 50, TSLA 25 USDG/epoch.
Public Anvil test keys — never use them with real funds.${RST}

${BOLD}MetaMask:${RST} after every fresh fork, Settings → Advanced → "Clear activity tab data" (anvil restarts reuse the same nonces).

${BOLD}Leave this terminal open — Anvil is running here.${RST} Ctrl-C stops the fork and all state vanishes.
MSG

wait $ANVIL_PID
