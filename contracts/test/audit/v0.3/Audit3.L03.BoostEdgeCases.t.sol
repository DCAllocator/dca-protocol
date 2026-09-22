// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {MockStrategy} from "../../mocks/MockStrategy.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";

/// @title AUDIT v0.3 / L-03 — boost operational edge cases
contract Audit3_L03_BoostEdgeCases is BaseTest {
    /// Fixed: a plan can no longer be flagged boosted while no strategy is set (deposits kept reverting until
    /// the owner noticed and unboosted).
    function test_boostFlagWithoutStrategy_isRefused() public {
        vm.prank(owner);
        daily.setBoostStrategy(address(0));
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 10e6, 10e6);
        vm.startPrank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        vm.expectRevert(IPlanVault.BoostUnavailable.selector);
        daily.setPlanBoost(id, true);
        daily.depositUSDG(id, 100e6); // still a plain plan, deposits work
        vm.stopPrank();
        assertFalse(daily.getPlan(id).boosted);
        assertEq(daily.getPlan(id).usdgIdle, 100e6);
    }

    /// KNOWN / open: the whole position is redeemed atomically on migration, so the owner cannot leave a market
    /// that is fully utilised. Kept visible until a non-atomic migration is designed (see AUDIT.md L-03).
    function test_KNOWN_migrationImpossibleWhileMarketIlliquid() public {
        _createBoostedPlan(daily, alice, address(nvda), 100e6, 10_000e6);
        morpho.mockBorrow(marketId, strategy.liquidity(), borrower);
        assertEq(strategy.liquidity(), 0);
        MockStrategy fresh = new MockStrategy(usdg);
        vm.startPrank(owner);
        vm.expectRevert();
        daily.setBoostStrategy(address(fresh));
        vm.expectRevert(IPlanVault.BoostInUse.selector);
        daily.setBoostStrategy(address(0));
        vm.stopPrank();
    }

    /// KNOWN / inherent to lending: a borrower who takes the market's free liquidity right before the epoch
    /// makes every boosted plan on the page miss its buy; unboosted plans are unaffected. Documented.
    function test_KNOWN_borrowerCanMakeBoostedPlansMissTheEpoch() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 100e6, 1_000e6);
        _nextEpoch(daily);
        morpho.mockBorrow(marketId, strategy.liquidity(), borrower);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(a).stockAccrued, 0, "boosted plan skipped");
        assertGt(daily.getPlan(b).stockAccrued, 0, "unboosted plan filled");
        assertEq(daily.getPlan(a).lastEpochId, 0, "not marked filled; the epoch is simply lost");
    }
}
