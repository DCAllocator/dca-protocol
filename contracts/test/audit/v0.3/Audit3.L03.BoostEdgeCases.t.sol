// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {MockStrategy} from "../../mocks/MockStrategy.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";

/// @dev AUDIT v0.3 / L-03 (boost operational edge cases).
contract Audit3_L03_BoostEdgeCases is BaseTest {
    /// setPlanBoost(true) does not check that a strategy exists when the plan has nothing to lend, so a plan can
    /// be flagged boosted with no strategy; every later deposit then reverts until the user unboosts.
    function test_boostFlagWithoutStrategy_thenDepositsRevert() public {
        vm.prank(owner);
        daily.setBoostStrategy(address(0)); // allowed: no open positions
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 10e6, 10e6);
        vm.startPrank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        daily.setPlanBoost(id, true); // succeeds
        vm.expectRevert(IPlanVault.BoostUnavailable.selector);
        daily.depositUSDG(id, 100e6);
        vm.stopPrank();
        // Anyone else funding the plan (Zap.depositEthAsUsdg, a friend) hits the same revert.
        vm.prank(bob);
        vm.expectRevert(IPlanVault.BoostUnavailable.selector);
        daily.depositUSDG(id, 100e6);
    }

    /// The whole position is redeemed atomically on migration, so the owner cannot move away from a market that
    /// is fully utilised (exactly the situation in which a migration is wanted). Clearing it is refused too.
    function test_migrationImpossibleWhileMarketIlliquid() public {
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

    /// A borrower who takes the market's free liquidity right before the epoch makes every boosted plan on the
    /// page miss its buy (never caught up); unboosted plans are unaffected.
    function test_borrowerCanMakeBoostedPlansMissTheEpoch() public {
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
