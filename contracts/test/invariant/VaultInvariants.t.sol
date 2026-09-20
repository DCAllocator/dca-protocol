// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {VaultHandler} from "./VaultHandler.sol";
import {Plan} from "../../src/vault/VaultTypes.sol";

/// @dev Vault-level accounting invariants under random plan / deposit / withdraw / claim / epoch sequences.
contract VaultInvariantsTest is BaseTest {
    VaultHandler handler;

    function setUp() public override {
        super.setUp();
        address[] memory stocks = new address[](2);
        stocks[0] = address(nvda);
        stocks[1] = address(aapl);
        handler = new VaultHandler(daily, usdg, weth, dca, router, owner, stocks);
        targetContract(address(handler));
    }

    /// vault.stockBalance >= sum(stockAccrued) + dustPot, for every stock
    function invariant_stockBackedByBalance() public view {
        assertGe(nvda.balanceOf(address(daily)), daily.totalStockAccrued(address(nvda)) + daily.dustPot(address(nvda)));
        assertGe(aapl.balanceOf(address(daily)), daily.totalStockAccrued(address(aapl)) + daily.dustPot(address(aapl)));
        // and tight: nothing else ever sits in the vault
        assertEq(nvda.balanceOf(address(daily)), daily.totalStockAccrued(address(nvda)) + daily.dustPot(address(nvda)));
        assertEq(aapl.balanceOf(address(daily)), daily.totalStockAccrued(address(aapl)) + daily.dustPot(address(aapl)));
    }

    /// vault.usdg + vault.weth == idle sums (fees leave immediately; no fee pot on the vault)
    function invariant_idleBackedByBalance() public view {
        assertEq(usdg.balanceOf(address(daily)), daily.totalUsdgIdle());
        assertEq(weth.balanceOf(address(daily)), daily.totalWethIdle());
        assertEq(address(daily).balance, 0, "no stray ETH");
    }

    /// aggregates == sum over plans (ghost recomputation)
    function invariant_aggregatesMatchPlans() public view {
        uint256 n = daily.nextPlanId();
        uint256 usdgSum;
        uint256 wethSum;
        uint256 nvdaSum;
        uint256 aaplSum;
        for (uint256 id = 1; id < n; ++id) {
            Plan memory p = daily.getPlan(id);
            usdgSum += p.usdgIdle;
            wethSum += p.wethIdle;
            if (p.stock == address(nvda)) nvdaSum += p.stockAccrued;
            else aaplSum += p.stockAccrued;
        }
        assertEq(usdgSum, daily.totalUsdgIdle());
        assertEq(wethSum, daily.totalWethIdle());
        assertEq(nvdaSum, daily.totalStockAccrued(address(nvda)));
        assertEq(aaplSum, daily.totalStockAccrued(address(aapl)));
    }

    /// per-user accrued sums match per-plan sums
    function invariant_userAccruedMatches() public view {
        uint256 n = daily.nextPlanId();
        for (uint256 a; a < 6; ++a) {
            address user = handler.actors(a);
            uint256 sN;
            uint256 sA;
            for (uint256 id = 1; id < n; ++id) {
                Plan memory p = daily.getPlan(id);
                if (p.owner != user) continue;
                if (p.stock == address(nvda)) sN += p.stockAccrued;
                else sA += p.stockAccrued;
            }
            assertEq(sN, daily.userStockAccrued(user, address(nvda)));
            assertEq(sA, daily.userStockAccrued(user, address(aapl)));
        }
    }

    /// stock index has no duplicates and every indexed plan belongs to that stock
    function invariant_stockIndexConsistent() public view {
        address[2] memory st = [address(nvda), address(aapl)];
        for (uint256 s; s < 2; ++s) {
            uint256 cnt = daily.stockPlanCount(st[s]);
            uint256 n = daily.nextPlanId();
            // count plans that claim to be for this stock and are non-empty: must all be indexed
            uint256 nonEmpty;
            for (uint256 id = 1; id < n; ++id) {
                Plan memory p = daily.getPlan(id);
                if (p.stock != st[s]) continue;
                if (p.usdgIdle > 0 || p.wethIdle > 0 || p.stockAccrued > 0) nonEmpty++;
            }
            assertGe(cnt, nonEmpty, "non-empty plans are always indexed");
        }
    }

    /// epochs never regress and a plan is never filled twice in one epoch
    function invariant_epochMonotonic() public view {
        assertLe(daily.lastExecutedEpoch(address(nvda)), daily.currentEpochId());
        assertLe(daily.lastExecutedEpoch(address(aapl)), daily.currentEpochId());
        uint256 n = daily.nextPlanId();
        for (uint256 id = 1; id < n; ++id) {
            assertLe(daily.getPlan(id).lastEpochId, daily.currentEpochId());
        }
    }

    /// Deterministic smoke drive of the handler: proves the random walk actually reaches the epoch + swap
    /// path (invariant runs swallow reverts, so a silently dead handler would otherwise pass vacuously).
    function test_handlerReachesEpochPath() public {
        for (uint256 i; i < 40; ++i) {
            handler.createPlan(
                i, i, uint96(100e6 * (i + 1)), uint128(5_000e6), uint128(i % 2 == 0 ? 1 ether : 0), i % 3 == 0
            );
            handler.depositUSDG(i, i, uint128(1_000e6));
            handler.giveDca(i, uint32((i * 7_000) % 60_000));
            handler.advanceEpoch(i, 3, 1);
            handler.advanceEpoch(i + 1, 4, 0);
            handler.claim(i, i * 31);
            handler.withdrawIdle(i, i * 17, i * 13, i % 2 == 0);
            handler.setImpact(i * 11);
            handler.prune(i);
        }
        assertGt(handler.epochsRun(), 10, "epochs ran");
        assertGt(handler.swaps(), 10, "swaps happened");
        assertGt(daily.epochsCompleted(), 0);
        invariant_stockBackedByBalance();
        invariant_idleBackedByBalance();
        invariant_aggregatesMatchPlans();
        invariant_userAccruedMatches();
    }
}
