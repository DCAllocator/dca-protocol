// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";

/// @dev A "router" that never swaps: it only has the standing approval the vault used to grant in _setRouter.
contract EvilRouter {
    address public immutable weth;

    constructor(address weth_) {
        weth = weth_;
    }

    function drain(IERC20 token, address from, address to) external {
        token.transferFrom(from, to, token.balanceOf(from));
    }
}

/// @dev A "strategy" whose only ERC-4626 surface is asset().
contract EvilStrategy {
    address public immutable asset;

    constructor(address asset_) {
        asset = asset_;
    }

    function drain(address from, address to) external {
        IERC20(asset).transferFrom(from, to, IERC20(asset).balanceOf(from));
    }
}

/// @title AUDIT v0.3 / M-03 regression — no standing approvals: setRouter / setBoostStrategy move no funds
///
/// Finding: the vault approved type(uint256).max USDG + WETH to whatever the owner set as router, and max USDG to
/// whatever it set as strategy — a single owner transaction was a custody transfer.
/// Fix: exact, per-call approvals around every swap / strategy deposit, reset to 0 afterwards; `setRouter` checks
/// the router shares the vault's WETH. (A timelock in front of the owner is an ops decision, see AUDIT.md.)
contract Audit3_M03_AdminApprovalDrain is BaseTest {
    address internal thief = makeAddr("thief");

    function test_setRouter_grantsNothing() public {
        uint256 a = _createUsdgPlan(daily, alice, address(nvda), 100e6, 100_000e6);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 100e6, 100_000e6);
        EvilRouter evil = new EvilRouter(address(weth));
        vm.prank(owner);
        daily.setRouter(address(evil));
        assertEq(usdg.allowance(address(daily), address(evil)), 0);
        assertEq(weth.allowance(address(daily), address(evil)), 0);
        vm.expectRevert(); // ERC20InsufficientAllowance: nothing to pull
        evil.drain(usdg, address(daily), thief);
        assertEq(usdg.balanceOf(thief), 0);
        assertEq(usdg.balanceOf(address(daily)), 200_000e6);
        vm.prank(alice);
        daily.withdrawIdle(a, type(uint256).max);
        vm.prank(bob);
        daily.withdrawIdle(b, type(uint256).max);
        assertEq(usdg.balanceOf(address(daily)), 0);
    }

    function test_setBoostStrategy_grantsNothing() public {
        _createUsdgPlan(daily, alice, address(nvda), 100e6, 100_000e6);
        EvilStrategy evil = new EvilStrategy(address(usdg));
        vm.prank(owner);
        daily.setBoostStrategy(address(evil));
        assertEq(usdg.allowance(address(daily), address(evil)), 0);
        vm.expectRevert(); // ERC20InsufficientAllowance: nothing to pull
        evil.drain(address(daily), thief);
        assertEq(usdg.balanceOf(thief), 0);
        // a boosted deposit into it fails loudly instead of being taken
        vm.prank(bob);
        vm.expectRevert();
        daily.createPlan(address(nvda), 10e6, address(0), 10e6, 0, 0, true);
    }
}
