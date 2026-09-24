#!/usr/bin/env bash
# Make $DCA a plan asset on the running local stack (`pnpm fork`) without redeploying: lists the local mDCA in the
# registry as "DCA", sets its mock price feed on every vault and adds its keeper jobs (contracts/script/ListDca.s.sol).
# Idempotent: a second run changes nothing. A stack deployed by the current DeployLocal already has all of it.
# The running scheduler and web app pick the new jobs up on their own (no restart).
#
#   pnpm dca:list
#   RPC=http://127.0.0.1:8546 pnpm dca:list    # another anvil (contracts/deployments/31337.json must be its deployment)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_JSON="$ROOT/contracts/deployments/31337.json"
RPC="${RPC:-http://127.0.0.1:8545}"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

[[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" == 31337 ]] || { echo "no anvil at $RPC: start 'pnpm fork' first"; exit 1; }
[[ -f "$DEPLOY_JSON" ]] || { echo "missing $DEPLOY_JSON: start 'pnpm fork' first"; exit 1; }
addr() { python3 -c "import json;print(json.load(open('$DEPLOY_JSON'))['$1'])"; }
[[ "$(cast code "$(addr registry)" --rpc-url "$RPC")" != 0x ]] \
  || { echo "deployments/31337.json does not match the chain at $RPC (no registry): restart 'pnpm fork'"; exit 1; }

# The deployer (anvil account 0, unlocked) owns the registry, the vaults and the keeper.
cd "$ROOT/contracts"
forge script script/ListDca.s.sol --rpc-url "$RPC" --broadcast --unlocked --sender "$(addr deployer)"
