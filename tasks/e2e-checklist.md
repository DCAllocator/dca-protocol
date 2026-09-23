# Manual browser e2e checklist (seed)

Header per run: date · branch/commit · anvil port + directory address · web port · latency preset · wallet (test1
`0x3C44…3BC` via "Use test wallet") · scheduler running y/n.

Setup (worktree): `PORT=8546 TEST_EPOCH_MINUTES=1 pnpm fork` (or copy the three gitignored files for frontend-only work);
`PORT=8556 UPSTREAM=http://127.0.0.1:8546 pnpm latency` (never upstream :8545); `NEXT_PUBLIC_LOCAL_RPC=http://127.0.0.1:8556
NEXT_PUBLIC_SHOW_TEST_VAULT=1 pnpm exec next dev -p 300N` (Bash-started; attach the browser pane by URL); `pnpm scheduler`
when a fill is needed; accept the disclaimer once; knobs `curl 'localhost:8556/__latency?sign=6000'`, `?reject=1`,
`?revert=1`, `?drop=1`, `?blockTime=manual` (mine with `/__latency/mine`), reset with `?preset=off`. Navigate client-side only (mock wallet drops on reload).

Columns: ID | Item | Precondition (chain state + knobs) | Steps | Expected | Observed (PASS/FAIL + screenshot) | Console/network notes.

| ID | Workstream | Scenario | Expected |
|----|-----------|----------|----------|
| E1 | 02 | Pause with `sign=4000` | only a pause indicator spins; Claim/Boost unchanged |
| E2 | 02 | Boost success | "Boosted" toast outside the row, auto-dismiss |
| E3 | 02 | Boost/Claim/Pause with `reject=1` | rejection toast; nothing in the row; button re-enabled; no unhandled rejection |
| E4 | 02 | `revert=1` | error toast with decoded reason; no inline error |
| E5 | 03 | Remove a plan with balance, boost and accrued stock on the 1-minute TestVault | N steps mine; wallet USDG += balance − fee; row disappears only after verification; toast |
| E6 | 03 | Remove during a pending epoch (multi-page via `advanceEpoch(limit=1)`) / Escape during mining / reject the prune | prune deferred with "Finish delete"; dialog stays open; "Try again" sends only `prunePlan` |
| E7 | 05 | /app/create and / | picker shows no prices and no "—"; no router `quote` calls in the network log |
| E8 | 05 | Add-to-wallet with the test wallet, then with MetaMask on 31337 | hidden (or "test wallet" toast); MetaMask dialog pre-filled; confirm/decline/close paths toast; no inline error |
| E9 | 06 | /app/create vs /app/create/2 with identical inputs | orders read as specified; `cast tx <hash> input` byte-identical |
| E10 | 06 | Buy $DCA tab on 31337; /app/buy 100 USDG | tab visible; ≈ 997 mDCA quoted; approve → swap; balances update; rejection leaves "Try again" |
| E11 | 04 | Hourly vault on the fork | scheduler dry-run lists it; hourly plan shows "per hour"; hourly job fires at the boundary, daily does not; four vault cards fit at 375 px |
| E12 | all | Regression: create plan (USDG and ETH), deposit, withdraw, claim on daily/weekly/monthly | unchanged behaviour |
| E13 | 02 | Receipt timeout and dropped tx (`blockTime=manual`, then `drop=1`) | sequence shows "still waiting", never offers a resend, completes after `/__latency/mine`; row action re-enables after the timeout with a warn toast |
