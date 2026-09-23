#!/usr/bin/env bash
# Fund a tester's own wallet on the local stack (`pnpm fork`): ETH for gas plus mock USDG / WETH, and optionally $DCA.
# The default leaves $DCA at 0, below the 100k holder perk, so stock accrues and Claim can be tested; DCA=150000 puts
# the wallet over both perks (stock sent straight to the wallet, half fees).
#
#   pnpm fund 0xTESTER
#   USDG=50000 DCA=150000 pnpm fund 0xTESTER      # defaults: ETH=10 USDG=10000 WETH=5 DCA=0
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_JSON="$ROOT/contracts/deployments/31337.json"
RPC="${RPC:-http://127.0.0.1:8545}"
ETH="${ETH:-10}" USDG_AMOUNT="${USDG:-10000}" WETH_AMOUNT="${WETH:-5}" DCA_AMOUNT="${DCA:-0}"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

TO="${1:-}"
[[ "$TO" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "usage: pnpm fund <address>   (ETH=10 USDG=10000 WETH=5 DCA=0 by default)"; exit 1; }
[[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" == 31337 ]] || { echo "no anvil at $RPC: start 'pnpm fork' first"; exit 1; }
addr() { python3 -c "import json;print(json.load(open('$DEPLOY_JSON'))['$1'])"; }
USDG=$(addr usdg); WETH=$(addr weth); DCA=$(addr dca)
# The deployer (anvil account 0, unlocked) owns MockDCA; the USDG / WETH mocks mint to anyone.
DEPLOYER=$(cast rpc eth_accounts --rpc-url "$RPC" | python3 -c "import json,sys;print(json.load(sys.stdin)[0])")
send() { cast send "$@" --rpc-url "$RPC" --unlocked --from "$DEPLOYER" >/dev/null; }

bal=$(cast balance "$TO" --rpc-url "$RPC")
cast rpc anvil_setBalance "$TO" "$(cast to-hex "$(python3 -c "print($bal + $(cast to-wei "$ETH"))")")" --rpc-url "$RPC" >/dev/null
send "$USDG" "mint(address,uint256)" "$TO" "$(cast parse-units "$USDG_AMOUNT" 6)"
[[ "$WETH_AMOUNT" != 0 ]] && send "$WETH" "mint(address,uint256)" "$TO" "$(cast to-wei "$WETH_AMOUNT")"
[[ "$DCA_AMOUNT" != 0 ]] && send "$DCA" "mint(address,uint256)" "$TO" "$(cast to-wei "$DCA_AMOUNT")"

tok() { cast call "$1" "balanceOf(address)(uint256)" "$TO" --rpc-url "$RPC" | cut -d' ' -f1; }
echo "$TO now holds: $(cast balance "$TO" --rpc-url "$RPC" -e) ETH · $(cast format-units "$(tok "$USDG")" 6) USDG · $(cast format-units "$(tok "$WETH")" 18) WETH · $(cast format-units "$(tok "$DCA")" 18) \$DCA"
