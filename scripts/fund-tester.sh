#!/usr/bin/env bash
# Fund a tester's own wallet on the local stack (`pnpm fork`): ETH for gas plus mock USDG / WETH, and optionally $DCA.
# On the mainnet fork (`pnpm fork:mainnet`) the USDG and WETH are the real tokens: USDG's balance slot is written
# (contracts/config/fork.rh.json) and the WETH is wrapped from the wallet's own ETH; $DCA is the fork's mock.
# The default leaves $DCA at 0, below the 100k holder perk, so stock accrues and Claim can be tested; DCA=150000 puts
# the wallet over both perks (stock sent straight to the wallet, half fees).
#
#   pnpm fund 0xTESTER
#   USDG=50000 DCA=150000 pnpm fund 0xTESTER      # defaults: ETH=10 USDG=10000 WETH=5 DCA=0
#   RPC=http://127.0.0.1:8546 DEPLOY_JSON=<its deployment json> pnpm fund 0xTESTER   # a second stack
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_JSON="${DEPLOY_JSON:-$ROOT/contracts/deployments/31337.json}"
RPC="${RPC:-http://127.0.0.1:8545}"
ETH="${ETH:-10}" USDG_AMOUNT="${USDG:-10000}" WETH_AMOUNT="${WETH:-5}" DCA_AMOUNT="${DCA:-0}"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

TO="${1:-}"
[[ "$TO" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "usage: pnpm fund <address>   (ETH=10 USDG=10000 WETH=5 DCA=0 by default)"; exit 1; }
[[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" == 31337 ]] || { echo "no anvil at $RPC: start 'pnpm fork' first"; exit 1; }
addr() { python3 -c "import json;print(json.load(open('$DEPLOY_JSON'))['$1'])"; }
USDG=$(addr usdg); WETH=$(addr weth); DCA=$(addr dca)
[[ "$(cast code "$(addr keeper)" --rpc-url "$RPC")" != 0x ]] \
  || { echo "$DEPLOY_JSON does not match the chain at $RPC (no keeper there): the fork was restarted or is still deploying"; exit 1; }
FORK=$(python3 -c "import json;print(1 if json.load(open('$DEPLOY_JSON')).get('fork') else 0)")
# The deployer (anvil account 0, unlocked) owns MockDCA; the USDG / WETH mocks mint to anyone.
DEPLOYER=$(cast rpc eth_accounts --rpc-url "$RPC" | python3 -c "import json,sys;print(json.load(sys.stdin)[0])")
send() { cast send "$@" --rpc-url "$RPC" --unlocked --from "$DEPLOYER" >/dev/null; }

bal=$(cast balance "$TO" --rpc-url "$RPC")
WRAP=$([[ "$FORK" == 1 ]] && cast to-wei "$WETH_AMOUNT" || echo 0)
cast rpc anvil_setBalance "$TO" "$(cast to-hex "$(python3 -c "print($bal + $(cast to-wei "$ETH") + $WRAP)")")" --rpc-url "$RPC" >/dev/null
if [[ "$FORK" == 1 ]]; then
  SLOT=$(python3 -c "import json;print(json.load(open('$ROOT/contracts/config/fork.rh.json'))['usdgBalanceSlot'])")
  KEY=$(cast index address "$TO" "$SLOT")
  CUR=$(cast storage "$USDG" "$KEY" --rpc-url "$RPC" 2>&1) || {
    echo "$CUR" | grep -q "historical state" \
      && echo "The fork's upstream RPC no longer serves the block it forked (not an archive node): restart 'pnpm fork:mainnet' with an archive RH_FORK_URL (see contracts/.env.fork in the README)." \
      || echo "$CUR"
    exit 1
  }
  NEW=$(python3 -c "print($(cast to-dec "$CUR") + $(cast parse-units "$USDG_AMOUNT" 6))")
  cast rpc anvil_setStorageAt "$USDG" "$KEY" "$(cast to-uint256 "$NEW")" --rpc-url "$RPC" >/dev/null
  if [[ "$WETH_AMOUNT" != 0 ]]; then
    cast rpc anvil_impersonateAccount "$TO" --rpc-url "$RPC" >/dev/null
    cast send "$WETH" "deposit()" --value "$WRAP" --from "$TO" --unlocked --rpc-url "$RPC" >/dev/null
    cast rpc anvil_stopImpersonatingAccount "$TO" --rpc-url "$RPC" >/dev/null
  fi
else
  send "$USDG" "mint(address,uint256)" "$TO" "$(cast parse-units "$USDG_AMOUNT" 6)"
  [[ "$WETH_AMOUNT" != 0 ]] && send "$WETH" "mint(address,uint256)" "$TO" "$(cast to-wei "$WETH_AMOUNT")"
fi
[[ "$DCA_AMOUNT" != 0 ]] && send "$DCA" "mint(address,uint256)" "$TO" "$(cast to-wei "$DCA_AMOUNT")"

tok() { cast call "$1" "balanceOf(address)(uint256)" "$TO" --rpc-url "$RPC" | cut -d' ' -f1; }
echo "$TO now holds: $(cast balance "$TO" --rpc-url "$RPC" -e) ETH · $(cast format-units "$(tok "$USDG")" 6) USDG · $(cast format-units "$(tok "$WETH")" 18) WETH · $(cast format-units "$(tok "$DCA")" 18) \$DCA"
