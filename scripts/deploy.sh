#!/usr/bin/env bash
# Production deploy of the DCA protocol to Robinhood Chain (4663).
# Reads contracts/.env — copy contracts/.env.example there and fill it in first.
#
#   pnpm protocol:deploy
#
# After this script: from the OWNER multisig, call acceptOwnership() on registry, router,
# adapters, vaults, keeper and directory (see README.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/contracts"

if [[ ! -f "$CONTRACTS/.env" ]]; then
  echo "missing $CONTRACTS/.env — copy contracts/.env.example to contracts/.env and fill it in first"
  exit 1
fi
set -a; source "$CONTRACTS/.env"; set +a

: "${RH_RPC:?RH_RPC must be set in contracts/.env}"

echo "About to broadcast script/Deploy.s.sol to ${RH_RPC} (expected chain id 4663)."
read -r -p "This deploys the protocol with real transactions. Continue? [y/N] " CONFIRM
[[ "$CONFIRM" == "y" || "$CONFIRM" == "Y" ]] || { echo "aborted"; exit 1; }

( cd "$CONTRACTS" && forge script script/Deploy.s.sol --rpc-url "$RH_RPC" --broadcast --verify -vvvv )

cat <<MSG

Deployed — see contracts/deployments/4663.json.
Next: from the OWNER multisig, call acceptOwnership() on registry, router, adapters, vaults, keeper and directory.
MSG
