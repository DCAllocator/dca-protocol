# Manual browser e2e checklist (seed)

Header per run: date · branch/commit · anvil port + directory address · web port · latency preset · wallet (MetaMask
with test1 `0x3C44…3BC` imported, RPC → the anvil port or the proxy) · scheduler running y/n.

Setup (worktree): `PORT=8546 TEST_EPOCH_MINUTES=1 pnpm fork` (or copy the three gitignored files for frontend-only work);
`PORT=8556 UPSTREAM=http://127.0.0.1:8546 pnpm latency` (never upstream :8545); `NEXT_PUBLIC_LOCAL_RPC=http://127.0.0.1:8556
NEXT_PUBLIC_SHOW_TEST_VAULT=1 pnpm exec next dev -p 300N` (Bash-started; open it in a Chrome profile that has
MetaMask, e.g. claude-in-chrome, not the Browser pane, which has no wallet extension); `pnpm scheduler`
when a fill is needed; knobs `curl 'localhost:8556/__latency?sign=6000'`, `?reject=1`,
`?revert=1`, `?drop=1`, `?blockTime=manual` (mine with `/__latency/mine`), reset with `?preset=off`. `sign`/`reject`/`revert`
only reach `eth_sendTransaction` senders such as `cast send --unlocked`: with MetaMask, hold or reject the prompt yourself,
and for `revert` lower the gas limit in MetaMask's advanced gas settings.
After every fresh fork, MetaMask → Settings → Advanced → "Clear activity tab data" (nonces repeat across anvil restarts).

Columns: ID | Item | Precondition (chain state + knobs) | Steps | Expected | Observed (PASS/FAIL + screenshot) | Console/network notes.

| ID | Workstream | Scenario | Expected |
|----|-----------|----------|----------|
| E1 | 02 | Pause, holding the MetaMask prompt ~4 s | only a pause indicator spins; Claim/Boost unchanged |
| E2 | 02 | Boost success | "Boosted" toast outside the row, auto-dismiss |
| E3 | 02 | Boost/Claim/Pause rejected in MetaMask | rejection toast; nothing in the row; button re-enabled; no unhandled rejection |
| E4 | 02 | Gas limit cut in MetaMask (mined, reverts) | error toast with decoded reason; no inline error |
| E5 | 03 | Remove a plan with balance, boost and accrued stock on the 1-minute TestVault | N steps mine; wallet USDG += balance − fee; row disappears only after verification; toast |
| E6 | 03 | Remove during a pending epoch (multi-page via `advanceEpoch(limit=1)`) / Escape during mining / reject the prune | prune deferred with "Finish delete"; dialog stays open; "Try again" sends only `prunePlan` |
| E7 | 05 | /app/create, /app/create/2 and / | no per-stock router `quote` calls from the stock picker in the network log: the dialog's prices and caps come from `/api/stock-market`, and its one router quote is $DCA's own price (`useDcaToken`) where the frequency lists $DCA; on /app/create and /app/create/2 the form adds exactly one more, the chosen token's 1 USDG buy quote for the "At today's price" estimate (every 20 s) |
| E8 | 05 | Add-to-wallet with MetaMask on 31337 | MetaMask dialog pre-filled; confirm/decline/close paths toast; no inline error |
| E9 | 06 | /app/create vs /app/create/2 with identical inputs | orders read as specified; `cast tx <hash> input` byte-identical |
| E10 | 06 | Buy $DCA tab on 31337, $DCA paired with USDG (the local stack as deployed); /app/buy 100 USDG | tab visible; ≈ 997 mDCA quoted; Route "USDG → mDCA"; Approve USDG → Buy (`swapWithRoute` on that path); balances update; rejection leaves "Try again", which shows "Getting a fresh quote…" before re-sending |
| E10b | 06 | Same chain, Pay → ETH, 0.1 ETH | ≈ $ line (≈ $299.85) and ≈ 2,989.5 mDCA; Route "ETH → WETH → USDG → mDCA"; steps Approve WETH (skipped when covered) → Wrap ETH → Buy ("through USDG"); ETH down 0.1 + gas, mDCA up ≥ Minimum received; no WETH left over |
| E10s | 06 | Setup for E10c–E10e, not a test: a private anvil running the DeployLocal stack, never :8545. Every send is `cast send --unlocked --from 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (the deployer); R, U, W, M are `router`, `usdg`, `weth`, `dca` from `contracts/deployments/31337.json`; F, the mock V3 factory, is `cast call <uniV3Adapter> "factory()(address)"`. (1) On F, `createPool(address,address,uint24,uint160)` with `M W 3000 457424009550099325341618706` ($0.10 per mDCA at $3,000/WETH, mDCA first as token0; `450510402518635165455855656` for E10d's 3% cheaper mDCA). (2) P is `getPool(address,address,uint24)(address)` on F for `M W 3000`; `mint(address,uint256)` P `100000000000000000000000` on W (100k WETH) and `1000000000000000000000000000` on M (1B mDCA). (3) On R, `approveHop((uint8,address,address,uint24,bytes))` with `(1,M,W,3000,E)` and `(1,W,M,3000,E)`, E = `cast abi-encode "f(address)" P`. Then E10c: `revokeHop` (same tuple) both USDG/mDCA hops, pool `getPool(M,U,3000)`; E10d: keep them; E10e: E10c plus `revokeHop((1,U,W,500,E'))`, E' encoding `getPool(W,U,500)` (WETH → USDG stays approved, so ETH's ≈ $ line still works) | `quote(address,address,uint256)` on R for 100 USDG and 0.1 WETH into M returns the paths the row expects |
| E10c | 06 | Launch shape (E10s): $DCA paired with WETH only (USDG/$DCA hops revoked, a WETH/$DCA hop approved); /app/buy 100 USDG, then Pay → ETH 0.1 | tab and card still shown (the 1 USDG probe routes through WETH); USDG: Route "USDG → WETH → mDCA", Buy step "through WETH"; ETH: Route "ETH → WETH → mDCA", no "through"; both buys land with nothing left over in USDG or WETH |
| E10d | 06 | Both pools (E10s at the 3% cheaper price), the WETH one pricing $DCA cheaper; 100 USDG, then 0.1 ETH | USDG takes "USDG → WETH → mDCA" (more mDCA than the direct USDG hop); ETH takes "ETH → WETH → mDCA" (more than via USDG); the dialog's Route line matches the card's |
| E10e | 06 | E10c's chain with the USDG → WETH hop revoked too (E10s), so only ETH reaches $DCA; /app/buy | tab and card still shown, opening on ETH (the 1 USDG probe fails, the 0.001 WETH one answers); ETH buys as in E10c; Pay → USDG, 100: "No route from USDG to mDCA on this chain — pay with ETH instead." (never "Try a smaller amount"), Buy disabled |
| E11 | 04 | Hourly vault on the fork | scheduler dry-run lists it; hourly plan shows "per hour"; hourly job fires at the boundary, daily does not; four vault cards fit at 375 px |
| E12 | all | Regression: create plan (USDG and ETH), deposit, withdraw, claim on daily/weekly/monthly | unchanged behaviour |
| E13 | 02 | Receipt timeout and dropped tx (`blockTime=manual`, then `drop=1`) | sequence shows "still waiting", never offers a resend, completes after `/__latency/mine`; row action re-enables after the timeout with a warn toast |
