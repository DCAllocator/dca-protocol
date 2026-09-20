// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {Plan, FeeConfig} from "../../src/vault/VaultTypes.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";

/// @title L-01 regression — every unit is accounted; dust goes to the treasury, never strands, never insolvent
///
/// v0.1: `_creditZap` floored both legs, stranding USDG on the vault and under-debiting WETH on partial fills
/// (`totalWethIdle > balance`: the last withdrawer reverted). The shipped invariant suite failed on every seed.
/// Fix: WETH is never held; the USDG remainder of a pro-rata split is booked in `usdgDust` and forwarded to
/// `feeRecipient` once it reaches `dustSweepMinUsdg`. Invariants: usdg == idle + usdgDust, weth == wethDust.
contract AuditL01ExactAccounting is BaseTest {
    function _threeOddPlans() internal returns (uint256 a, uint256 b, uint256 c) {
        a = _createUsdgPlan(daily, alice, address(nvda), 100e6 + 1, 1_000e6);
        b = _createUsdgPlan(daily, bob, address(nvda), 100e6 + 3, 1_000e6);
        c = _createUsdgPlan(daily, carol, address(nvda), 100e6 + 7, 1_000e6);
    }

    function test_partialFillDustIsBookedAndSwept() public {
        router.setFill(address(usdg), address(nvda), 3_333);
        FeeConfig memory f = daily.fees();
        f.purchaseFeeBps = 0;
        vm.prank(owner);
        daily.setFees(f);
        (uint256 a, uint256 b, uint256 c) = _threeOddPlans();
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 dust = daily.usdgDust();
        assertGt(dust, 0, "remainder exists");
        assertEq(usdg.balanceOf(address(daily)), daily.totalUsdgIdle() + dust, "tight USDG invariant");
        assertEq(weth.balanceOf(address(daily)), 0);

        // everyone can always withdraw everything (no phantom balances)
        vm.prank(alice);
        daily.withdrawIdle(a, type(uint256).max);
        vm.prank(bob);
        daily.withdrawIdle(b, type(uint256).max);
        vm.prank(carol);
        daily.withdrawIdle(c, type(uint256).max);
        assertEq(daily.totalUsdgIdle(), 0);
        assertEq(usdg.balanceOf(address(daily)), dust, "only the booked dust remains");

        // and the dust reaches the treasury at the threshold (owner lowers it here to force it)
        vm.prank(owner);
        daily.setDustSweepMin(1);
        uint256 tBefore = usdg.balanceOf(treasury);
        vm.prank(owner);
        daily.sweepDust();
        assertEq(usdg.balanceOf(treasury) - tBefore, dust);
        assertEq(usdg.balanceOf(address(daily)), 0);
    }

    function test_wethDepositPartialFillRefundsDepositor_noInsolvency() public {
        router.setFill(address(weth), address(usdg), 9_999);
        uint256 wBefore = weth.balanceOf(alice);
        vm.prank(alice);
        uint256 a = daily.createPlan(address(nvda), 100e6, address(0), 0, 1 ether, 0);
        assertEq(weth.balanceOf(alice), wBefore - 0.9999 ether, "unfilled wei refunded");
        assertEq(weth.balanceOf(address(daily)), 0);
        assertEq(daily.wethDust(), 0);
        vm.prank(alice);
        daily.withdrawIdle(a, type(uint256).max);
        assertEq(usdg.balanceOf(address(daily)), 0);
    }
}
