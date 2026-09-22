// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";

/// @title AUDIT v0.3 / M-04 regression — stray balances are reconciled, not stuck
///
/// Finding: tokens reaching the vault outside its own flows were unreachable (rescueERC20 rightly refuses USDG,
/// WETH and listed stocks; sweepDust only moved the internal counter). Fix: `skim(token)` books the excess into
/// the existing sinks — a stock's `dustPot` (to its plans at the next epoch), USDG / WETH dust (to the treasury).
contract Audit3_L04_UnaccountedBalances is BaseTest {
    function test_skim_reconcilesStrayStockAndUsdg() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 1_000e6, 2_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));

        nvda.mint(address(daily), 1e18);
        usdg.mint(address(daily), 500e6);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.TokenNotRescuable.selector, address(nvda)));
        daily.rescueERC20(address(nvda), owner, 1e18);
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.Skimmed(address(nvda), 1e18);
        daily.skim(address(nvda));
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.Skimmed(address(usdg), 500e6);
        daily.skim(address(usdg));
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.skim(address(nvda)); // nothing left to reconcile
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.NotSkimmable.selector, address(other)));
        daily.skim(address(other));
        vm.stopPrank();

        assertEq(daily.dustPot(address(nvda)), 1e18, "stock excess -> that stock's plans");
        assertEq(daily.usdgDust(), 500e6, "USDG excess -> dust, swept to the treasury");
        assertEq(nvda.balanceOf(address(daily)), daily.totalStockAccrued(address(nvda)) + daily.dustPot(address(nvda)));
        assertEq(usdg.balanceOf(address(daily)), daily.totalUsdgIdle() + daily.usdgDust());

        // the pot reaches the plan at the next fill; the dust reaches the treasury
        uint256 accruedBefore = daily.getPlan(id).stockAccrued;
        uint256 tBefore = usdg.balanceOf(treasury);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertGe(daily.getPlan(id).stockAccrued - accruedBefore, 1e18, "the skimmed NVDA went to the plan");
        assertGe(usdg.balanceOf(treasury) - tBefore, 500e6, "the skimmed USDG reached the treasury");
        assertEq(daily.dustPot(address(nvda)), 0);
    }

    function test_skim_accessControl() public {
        nvda.mint(address(daily), 1e18);
        vm.prank(alice);
        vm.expectRevert();
        daily.skim(address(nvda));
        address mgr = makeAddr("mgr");
        vm.prank(owner);
        daily.setFeeManager(mgr);
        vm.prank(mgr);
        daily.skim(address(nvda));
        assertEq(daily.dustPot(address(nvda)), 1e18);
    }
}
