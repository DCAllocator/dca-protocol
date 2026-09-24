#!/usr/bin/env bash
# Robinhood Chain mainnet fork with the PRODUCTION deploy on top: anvil forks chain 4663, then
# contracts/script/Deploy.s.sol runs against the real USDG / WETH, Uniswap V3 pools, Chainlink feeds and Morpho Blue,
# exactly as `pnpm protocol:deploy` would, with the local stack's test tooling around it. Leaves anvil running until
# Ctrl-C. The mock stack (`pnpm fork`) is unchanged; both serve chain id 31337 on :8545, so run one at a time.
#
# What is real: every token, pool, feed and the Morpho market (config/fork.rh.json), and which stocks get listed —
# scripts/fork-mainnet-discover.py lists each Stock Token that has a Chainlink feed and a Uniswap V3 route from USDG
# priced within 2% of that feed. What is not: $DCA (no token on mainnet yet — a mock with a real V3 pool on the chain's
# own factory, listed with no price floor as production would: PriceGuardLib.UNGUARDED), the TestVault, and the wallets' USDG (their balance
# slot is written directly). Nothing else trades on a fork: prices and Chainlink answers stay at the fork block, which
# is why FEED_MAX_STALENESS defaults to 7 days here (production: 25 h). Re-run to pick up fresh prices.
#
# RPC: needs an ARCHIVE endpoint in RH_FORK_URL or contracts/.env.fork (git-ignored), e.g. Alchemy's
# https://robinhood-mainnet.g.alchemy.com/v2/<key>. The public endpoint keeps only minutes of history, so a fork of it
# goes stale within ~15 minutes (checked at startup; FORK_ALLOW_PRUNED=1 overrides for a quick check) and rate-limits,
# so anvil is throttled on it.
#
#   pnpm fork:mainnet                          # fork the latest block, deploy, write apps/{web,scheduler}/.env.local
#   FORK_BLOCK=70746690 pnpm fork:mainnet      # a fixed block (needs an archive RPC: the public one keeps only
#                                              # recent state; anvil caches a pinned block, so restarts are faster)
#   PORT=8546 CHAIN_ID=31338 WRITE_APP_ENV=0 pnpm fork:mainnet   # side by side with a running stack, apps untouched
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/contracts"
WEB="$ROOT/apps/web"
SCHEDULER="$ROOT/apps/scheduler"
CFG="$CONTRACTS/config/fork.rh.json"
PORT="${PORT:-8545}"
CHAIN_ID="${CHAIN_ID:-31337}"
TEST_EPOCH_MINUTES="${TEST_EPOCH_MINUTES:-2}"
FEED_MAX_STALENESS="${FEED_MAX_STALENESS:-604800}"
WRITE_APP_ENV="${WRITE_APP_ENV:-1}"
RPC="http://127.0.0.1:${PORT}"
TMP="$(mktemp -d -t dca-fork-mainnet-XXXXXX)"
ANVIL_LOG="$TMP/anvil.log"
DEPLOY_JSON="$CONTRACTS/deployments/${CHAIN_ID}.json"
SETUP_JSON="$CONTRACTS/deployments/${CHAIN_ID}-fork-setup.json"
DISCOVERY_JSON="$CONTRACTS/deployments/${CHAIN_ID}-fork-discovery.json"

export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
for bin in anvil forge cast node python3 curl; do command -v "$bin" >/dev/null || { echo "missing: $bin"; exit 1; }; done

log() { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
cfg() { python3 -c "import json;print(json.load(open('$CFG'))['$1'])"; }
jget() { python3 -c "import json;print(json.load(open('$1'))['$2'])"; }

if [[ -z "${RH_FORK_URL:-}" && -f "$CONTRACTS/.env.fork" ]]; then set -a; source "$CONTRACTS/.env.fork"; set +a; fi
FORK_URL="${RH_FORK_URL:-$(cfg publicRpc)}"
FORK_HOST="$(python3 -c "from urllib.parse import urlparse;print(urlparse('$FORK_URL').hostname)")"
ANVIL_ARGS=(--port "$PORT" --chain-id "$CHAIN_ID" --fork-url "$FORK_URL")
[[ -n "${FORK_BLOCK:-}" ]] && ANVIL_ARGS+=(--fork-block-number "$FORK_BLOCK")
if [[ -z "${RH_FORK_URL:-}" ]]; then
  # The public endpoint answers 429 under anvil's default request rate.
  ANVIL_ARGS+=(--compute-units-per-second 100 --retries 10 --fork-retry-backoff 1000)
  PUBLIC_NOTE="public RPC (throttled: set RH_FORK_URL for speed)"
else
  PUBLIC_NOTE="RH_FORK_URL"
fi

# Anvil loads mainnet state lazily, at the fork block, the first time anything touches it. A node that is not an archive
# (the public endpoint keeps only minutes of history) stops serving that block soon after, and from then on the fork
# fails on anything it has not loaded yet — a new tester's balance, an approval, a stock nobody bought — with
# "historical state … is not available". Probe for state an hour back before starting.
rpc_post() { curl -s -m 20 -X POST -H 'content-type: application/json' --data "$1" "$FORK_URL"; }
LATEST_HEX="$(rpc_post '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('result',''))" 2>/dev/null || true)"
[[ "$LATEST_HEX" == 0x* ]] || { echo "${FORK_HOST} did not answer eth_blockNumber: check RH_FORK_URL"; exit 1; }
HOUR_AGO="$(printf '0x%x' $(( LATEST_HEX - 36000 )))" # ~10 blocks a second
if ! rpc_post "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"0x0000000000000000000000000000000000000000\",\"${HOUR_AGO}\"]}" | grep -q '"result"'; then
  if [[ "${FORK_ALLOW_PRUNED:-}" == 1 ]]; then
    echo "warning: ${FORK_HOST} is not an archive node — this fork goes stale in ~15 minutes (FORK_ALLOW_PRUNED=1)"
  else
    echo "${FORK_HOST} does not serve state from an hour ago (not an archive node). A fork of it goes stale within"
    echo "~15 minutes: after that, anything the fork has not loaded yet (a new wallet, an approval, a stock nobody"
    echo "bought yet) fails with \"historical state … is not available\"."
    echo "Put an archive endpoint in contracts/.env.fork, e.g. RH_FORK_URL=https://robinhood-mainnet.g.alchemy.com/v2/<key>"
    echo "(or FORK_ALLOW_PRUNED=1 for a quick check that is done within a few minutes)."
    exit 1
  fi
fi

if lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
  echo "Port ${PORT} is already in use (a 'pnpm fork' or 'pnpm fork:mainnet' already running?)."
  echo "Stop it first, or run with PORT=<other> (and CHAIN_ID=<other>, WRITE_APP_ENV=0 to leave the apps alone)."
  exit 1
fi

log "Forking Robinhood Chain via ${FORK_HOST} — ${PUBLIC_NOTE} (chain id ${CHAIN_ID}, port ${PORT})"
anvil "${ANVIL_ARGS[@]}" > "$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
trap 'echo; echo "Stopping Anvil"; kill $ANVIL_PID 2>/dev/null || true; rm -rf "$TMP"' EXIT INT TERM
for _ in $(seq 1 60); do
  kill -0 "$ANVIL_PID" 2>/dev/null || { echo "Anvil exited during startup"; sed -E 's#(https?://[^ ]*)#<rpc>#g' "$ANVIL_LOG"; exit 1; }
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done
[[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" == "$CHAIN_ID" ]] || { echo "Anvil did not come up"; exit 1; }
FORK_BLOCK="$(cast block-number --rpc-url "$RPC")"
FORK_TS="$(cast block latest -f timestamp --rpc-url "$RPC")"
echo "forked at block ${FORK_BLOCK} ($(python3 -c "import time;print(time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime($FORK_TS)))"))"
# Anvil's clock starts at the fork block's time (hours back with an old FORK_BLOCK). Put it on the wall clock, as the
# scheduler, the app's countdowns and the epoch-boundary waits below all assume.
cast rpc evm_setTime "$(date +%s)" --rpc-url "$RPC" >/dev/null
cast rpc evm_mine --rpc-url "$RPC" >/dev/null

# Robinhood Chain has the canonical Multicall3; check it made it through the fork (the app batches reads through it).
MULTICALL3=0xcA11bde05977b3631167028862bE2a173976CA11
MULTICALL3_CODEHASH=0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891
if [[ "$(cast keccak "$(cast code "$MULTICALL3" --rpc-url "$RPC")")" != "$MULTICALL3_CODEHASH" ]]; then
  cast rpc anvil_setCode "$MULTICALL3" "$(tr -d '\n' < "$ROOT/scripts/multicall3.runtime.hex")" --rpc-url "$RPC" >/dev/null
fi

# The same six roles as `pnpm fork`, from anvil's own banner (fork mode funds the dev accounts too).
ADDR=(); PK=()
while IFS= read -r a; do ADDR+=("$a"); done < <(awk '/^Available Accounts/{f=1;next} /^Private Keys/{f=0} f && /^\([0-9]+\) 0x/{print $2}' "$ANVIL_LOG")
while IFS= read -r k; do PK+=("$k"); done < <(awk '/^Private Keys/{f=1;next} f && /^\([0-9]+\) 0x/{print $2}' "$ANVIL_LOG")
[[ "${#ADDR[@]}" -ge 6 && "${#PK[@]}" -ge 6 ]] || { echo "could not parse accounts from anvil's startup log"; exit 1; }
DEPLOYER="${ADDR[0]}"; DEPLOYER_PK="${PK[0]}"
TREASURY="${ADDR[1]}"; TREASURY_PK="${PK[1]}"
TEST1="${ADDR[2]}"; TEST1_PK="${PK[2]}"
TEST2="${ADDR[3]}"; TEST2_PK="${PK[3]}"
TEST3="${ADDR[4]}"; TEST3_PK="${PK[4]}"
BOT="${ADDR[5]}"; BOT_PK="${PK[5]}"
# These keys are public, and on Robinhood Chain every one of these accounts carries an EIP-7702 delegation to a sweeper
# contract that forwards away any ETH it receives; the fork inherits that code, so the first 0-value self-transfer (the
# scheduler's nudge) would empty the bot. Strip it so the six roles are plain EOAs here (their mainnet nonces remain).
for a in "${ADDR[@]:0:6}"; do cast rpc anvil_setCode "$a" 0x --rpc-url "$RPC" >/dev/null; done

USDG="$(cfg usdg)"; WETH="$(cfg weth)"; USDG_SLOT="$(cfg usdgBalanceSlot)"
# USDG (Paxos) cannot be minted here: write the holder's balance slot, then read it back.
usdg_add() {
  local who="$1" whole="$2" key cur want
  key="$(cast index address "$who" "$USDG_SLOT")"
  cur="$(cast to-dec "$(cast storage "$USDG" "$key" --rpc-url "$RPC")")"
  want="$(python3 -c "print($cur + $whole * 10**6)")"
  cast rpc anvil_setStorageAt "$USDG" "$key" "$(cast to-uint256 "$want")" --rpc-url "$RPC" >/dev/null
  [[ "$(cast call "$USDG" "balanceOf(address)(uint256)" "$who" --rpc-url "$RPC" | cut -d' ' -f1)" == "$want" ]] \
    || { echo "USDG balance slot ${USDG_SLOT} is wrong for ${USDG} (token upgraded?): update usdgBalanceSlot in $CFG"; exit 1; }
}
# Every forge broadcast below runs with --slow (one transaction at a time, each waited for): anvil can leave a
# transaction that arrives while it is still building a block parked in its queue forever — no error, forge just waits.
# A fork builds blocks slowly (state comes from the upstream RPC), which makes that race easy to hit.
# Epoch boundaries: the vaults revert BadOrigin unless created in the epoch their origin starts, and forge simulates at
# the last block's time. Mine a fresh block, and wait out a boundary that is closer than `margin` seconds.
settle_before_boundary() {
  local len="$1" margin="$2" now left
  now="$(date +%s)"; left=$(( len - now % len ))
  if (( left < margin )); then echo "waiting ${left}s for the next ${len}s boundary"; sleep $(( left + 3 )); fi
  cast rpc evm_mine --rpc-url "$RPC" >/dev/null
}

log "Picking stocks: Chainlink feed + Uniswap V3 route from USDG"
curl -fsS -A Mozilla/5.0 "$(cfg chainlinkFeedsUrl)" -o "$TMP/feeds.json" || { echo "could not fetch the Chainlink feed list"; exit 1; }
curl -fsS -A Mozilla/5.0 "$(cfg assetRegistryUrl)" -o "$TMP/assets.json" || { echo "could not fetch the Robinhood asset registry"; exit 1; }
python3 "$ROOT/scripts/fork-mainnet-discover.py" "$RPC" "$CFG" "$TMP/feeds.json" "$TMP/assets.json" "$DISCOVERY_JSON"
denv() { python3 -c "import json;print(json.load(open('$DISCOVERY_JSON'))['env']['$1'])"; }
STOCKS="$(denv STOCKS)"; PRICE_FEEDS="$(denv PRICE_FEEDS)"; V3_POOLS="$(denv V3_POOLS)"
[[ -n "$STOCKS" ]] || { echo "no stock qualified: nothing to deploy"; exit 1; }

log "Funding the deployer with USDG, then mock \$DCA + its Uniswap V3 pool"
usdg_add "$DEPLOYER" 2000000
( cd "$CONTRACTS" && forge script script/DeployFork.s.sol --tc DeployFork --sig 'prepare()' --rpc-url "$RPC" --broadcast --slow --private-key "$DEPLOYER_PK" ) > "$TMP/setup.log" \
  || { tail -40 "$TMP/setup.log"; exit 1; }
DCA="$(jget "$SETUP_JSON" dca)"; DCA_POOL="$(jget "$SETUP_JSON" dcaPool)"
echo "mDCA ${DCA} · pool ${DCA_POOL}"
# $DCA has no Chainlink feed: list it without a price floor, as production would (PriceGuardLib.UNGUARDED).
UNGUARDED=0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF

log "Deploying the protocol with the production script (script/Deploy.s.sol)"
settle_before_boundary 3600 180
( cd "$CONTRACTS" && env \
    OWNER="$DEPLOYER" FEE_RECIPIENT="$TREASURY" KEEPERS="$BOT" BUYBACK_OPERATORS="$DEPLOYER" \
    USDG="$USDG" WETH="$WETH" DCA="$DCA" LIST_DCA=true DCA_PRICE_FEED="$UNGUARDED" \
    UNIV3_FACTORY="$(cfg uniV3Factory)" UNIV4_POOL_MANAGER="$(cfg uniV4PoolManager)" RAMSES_FACTORY= \
    STOCKS="$STOCKS" PRICE_FEEDS="$PRICE_FEEDS" V3_POOLS="${V3_POOLS},1:${DCA_POOL}" \
    MORPHO="$(cfg morpho)" MORPHO_MARKET_ID="$(cfg morphoMarketId)" BOOST_SEED_USDG=100 \
    FEED_MAX_STALENESS="$FEED_MAX_STALENESS" REQUIRE_PRICE_FEED=true \
    forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow --private-key "$DEPLOYER_PK" ) > "$TMP/deploy.log" \
  || { tail -60 "$TMP/deploy.log"; exit 1; }
[[ -f "$DEPLOY_JSON" ]] || { echo "Deploy failed: $DEPLOY_JSON not written"; exit 1; }

log "Adding the ${TEST_EPOCH_MINUTES}-minute test vault and seeding it"
settle_before_boundary $(( TEST_EPOCH_MINUTES * 60 )) 45
( cd "$CONTRACTS" && env TEST1="$TEST1" TEST2="$TEST2" TEST3="$TEST3" BOT="$BOT" TEST_EPOCH_MINUTES="$TEST_EPOCH_MINUTES" \
    FORK_BLOCK="$FORK_BLOCK" DCA_POOL="$DCA_POOL" \
    forge script script/DeployFork.s.sol --tc DeployFork --sig 'extras()' --rpc-url "$RPC" --broadcast --slow --private-key "$DEPLOYER_PK" ) > "$TMP/extras.log" \
  || { tail -40 "$TMP/extras.log"; exit 1; }
KEEPER="$(jget "$DEPLOY_JSON" keeper)"; TEST_VAULT="$(jget "$DEPLOY_JSON" testVault)"

log "Funding treasury and test wallets (real USDG and WETH)"
for w in "$TREASURY" "$TEST1" "$TEST2" "$TEST3"; do usdg_add "$w" 100000; done
for w in "$TEST1" "$TEST2" "$TEST3"; do cast send "$WETH" "deposit()" --value 10ether --from "$w" --unlocked --rpc-url "$RPC" >/dev/null; done

if [[ "$WRITE_APP_ENV" == 1 ]]; then
  log "Writing ${WEB}/.env.local and ${SCHEDULER}/.env.local"
  LOCAL_RPC="$RPC" node "$WEB/scripts/env-from-deployment.mjs" "$CHAIN_ID"
  cat > "$SCHEDULER/.env.local" <<ENV
# Written by scripts/fork-mainnet.sh — Robinhood Chain fork on anvil. The key is anvil's public account 5 ("bot").
RPC_URL=${RPC}
KEEPER_ADDRESS=${KEEPER}
PRIVATE_KEY=${BOT_PK}
ENV
else
  log "WRITE_APP_ENV=0: apps/{web,scheduler}/.env.local left as they were"
fi

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
LISTED="$(python3 -c "import json;print(' '.join(s['symbol'] for s in json.load(open('$DISCOVERY_JSON'))['stocks']))")"
SKIPPED="$(python3 -c "import json;print(', '.join(s['symbol'] for s in json.load(open('$DISCOVERY_JSON'))['excluded']) or 'none')")"

cat <<MSG

${BOLD}Mainnet fork is ready${RST} (block ${FORK_BLOCK}, chain id ${CHAIN_ID}, ${RPC}).
In other terminals:   pnpm dev:test-vault   →  http://localhost:3000 with the test vault
                      pnpm scheduler        →  advances epochs (test vault every ${TEST_EPOCH_MINUTES} min)

${BOLD}Listed:${RST} DCA (mock) ${LISTED}
${DIM}Skipped (no usable route or price off the feed): ${SKIPPED} — details in ${DISCOVERY_JSON#$ROOT/}
Real: USDG, WETH, every Stock Token, their Uniswap V3 pools, Chainlink feeds (frozen at the fork block; staleness
window ${FEED_MAX_STALENESS}s), Morpho Blue. Mock: \$DCA (0.10 USDG pool on the real V3 factory), bought without a price floor.
test1-3 hold 100,000 USDG and 10 WETH; test1 also 150,000 \$DCA (both perks), test2 / test3 none (stock accrues, Claim works).
Test vault ${TEST_VAULT} holds three deployer plans: NVDA 100 (boosted on Morpho), SPCX 50, TSLA 25 USDG/epoch.
Public Anvil test keys — never use them with real funds.${RST}

${BOLD}MetaMask:${RST} same "localhost 8545 / 31337" network as \`pnpm fork\`; "Clear activity tab data" after every restart.

${BOLD}Leave this terminal open — Anvil is running here.${RST} Ctrl-C stops the fork and all state vanishes.
MSG

wait $ANVIL_PID
