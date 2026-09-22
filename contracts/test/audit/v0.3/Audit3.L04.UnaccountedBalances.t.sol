// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";

/// @dev AUDIT v0.3 / L-04. Tokens that reach the vault outside its own flows (a USDG or Stock Token airdrop,
///      an issuer distribution, a mistaken transfer) are unreachable: rescueERC20 refuses USDG, WETH and every
///      listed stock, sweepDust only moves the internal usdgDust counter, and no skim exists.
contract Audit3_L04_UnaccountedBalances is BaseTest {
    function test_airdroppedUsdgAndStockAreStuckForever() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 1_000e6, 2_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 accrued = daily.getPlan(id).stockAccrued;

        // Issuer / third party sends 1 NVDA and 500 USDG to the vault.
        nvda.mint(address(daily), 1e18);
        usdg.mint(address(daily), 500e6);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.TokenNotRescuable.selector, address(nvda)));
        daily.rescueERC20(address(nvda), owner, 1e18);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.TokenNotRescuable.selector, address(usdg)));
        daily.rescueERC20(address(usdg), owner, 500e6);
        daily.sweepDust(); // moves nothing: usdgDust == 0
        vm.stopPrank();

        vm.prank(alice);
        daily.claim(id, type(uint256).max);
        vm.prank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        assertEq(nvda.balanceOf(address(daily)), 1e18, "stuck");
        assertEq(usdg.balanceOf(address(daily)), 500e6, "stuck");
        assertEq(daily.totalStockAccrued(address(nvda)), 0);
        assertEq(daily.totalUsdgIdle(), 0);
        assertGt(accrued, 0);
    }
}
