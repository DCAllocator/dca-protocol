#!/usr/bin/env bash
# Epoch gas simulation priced at the current ETH price (CoinGecko) and, when RH_RPC is set, the chain's gas price.
#   ./script/gas-sim.sh                 # unboosted plans
#   SIM_BOOSTED=true ./script/gas-sim.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${ETH_PRICE_USD:-}" ]; then
  ETH_PRICE_USD=$(curl -sf 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd' \
    | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["ethereum"]["usd"]))' 2>/dev/null || echo 3000)
fi
if [ -z "${GAS_PRICE_WEI:-}" ] && [ -n "${RH_RPC:-}" ]; then
  GAS_PRICE_WEI=$(cast gas-price --rpc-url "$RH_RPC" 2>/dev/null || echo 10000000)
fi
export ETH_PRICE_USD GAS_PRICE_WEI="${GAS_PRICE_WEI:-10000000}"
# thousands of plans in one script frame need more EVM memory than the 32 MiB default
export FOUNDRY_MEMORY_LIMIT="${FOUNDRY_MEMORY_LIMIT:-536870912}"
echo "ETH_PRICE_USD=$ETH_PRICE_USD GAS_PRICE_WEI=$GAS_PRICE_WEI (${RH_RPC:+from RH_RPC}${RH_RPC:-default 0.01 gwei})"
forge script script/GasSim.s.sol -vv 2>&1 | grep -v nightly | sed -n '/== Logs ==/,$p'
