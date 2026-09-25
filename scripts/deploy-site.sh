#!/usr/bin/env bash
# Deploy the public website to the linked Vercel project as its production deployment (every production domain of the
# project, dcallocator.com and dcallocator.app, then serves it). A Robinhood Chain build; until the contracts are
# deployed it runs in prelaunch mode: links into the app and to the token open a "not launched yet" dialog pointing to
# X, and /app redirects to the landing (NEXT_PUBLIC_PRELAUNCH, lib/prelaunch.ts). The social links are in the code
# (lib/socials.ts).
#
#   pnpm deploy:site
#   PRELAUNCH=0 NEXT_PUBLIC_DIRECTORY=0x… pnpm deploy:site     # at launch: the app on, with the deployed addresses
#
# Needs the Vercel CLI logged in with this repo linked (`vercel link` at the repo root, root directory apps/web).
# `pnpm share` deploys to the same project with --prod and replaces this site with the test build: redeploy after it.
# Every push to main also rebuilds production through the project's Git integration, with the env vars stored in the
# project (not these -b ones): keep NEXT_PUBLIC_CHAIN, NEXT_PUBLIC_PRELAUNCH and NEXT_PUBLIC_SITE_URL set there too.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERCEL="${VERCEL:-vercel}"
SITE_URL="${SITE_URL:-https://dcallocator.com}"
PRELAUNCH="${PRELAUNCH:-1}"

die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
command -v "$VERCEL" >/dev/null || die "missing: the Vercel CLI (npm i -g vercel, then vercel login)"
[[ -f "$ROOT/.vercel/project.json" ]] || die "not linked to a Vercel project: run 'vercel link' in $ROOT (code directory: apps/web)"

BUILD_ENV=(
  -b NEXT_PUBLIC_CHAIN=robinhood
  -b "NEXT_PUBLIC_PRELAUNCH=${PRELAUNCH}"
  -b "NEXT_PUBLIC_SITE_URL=${SITE_URL%/}"
)
# Contract addresses and other NEXT_PUBLIC_* settings pass straight through when set in the environment.
for v in NEXT_PUBLIC_DIRECTORY NEXT_PUBLIC_CLAIM_HELPER NEXT_PUBLIC_ZAP NEXT_PUBLIC_KEEPER NEXT_PUBLIC_RH_RPC \
  NEXT_PUBLIC_BUY_DCA_URL NEXT_PUBLIC_PONS_URL NEXT_PUBLIC_BRIDGE_URL NEXT_PUBLIC_WC_PROJECT_ID \
  NEXT_PUBLIC_BLOCKED_COUNTRIES; do
  [[ -n "${!v:-}" ]] && BUILD_ENV+=(-b "$v=${!v}")
done

( cd "$ROOT" && "$VERCEL" deploy --prod --yes "${BUILD_ENV[@]}" )
