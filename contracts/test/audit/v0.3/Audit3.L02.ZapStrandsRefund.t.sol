// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "../AuditBase.sol";
import {MockV3Pool} from "../../mocks/MockV3.sol";
import {Zap} from "../../../src/periphery/Zap.sol";
import {IAggregatorRouter} from "../../../src/router/IAggregatorRouter.sol";

/// @title AUDIT v0.3 / L-02 regression — Zap can no longer strand a refund
///
/// Finding: the router refunded a partially filled first hop to msg.sender; for Zap that was Zap itself, which
/// has no sweep. Fix: the router executes full fills only (M-02), so no refund exists to strand.
contract Audit3_L02_ZapStrandsRefund is AuditBase {
    Zap internal zap;
    MockV3Pool internal pool;

    function setUp() public override {
        super.setUp();
        pool = _wethUsdgPool();
        zap = new Zap(address(weth), address(usdg), address(router));
    }

    function test_ethToUsdg_partialFill_revertsNothingStranded() public {
        pool.setMaxOut(2_700e6); // 1 ETH would only fill 2,700 of ~2,998 USDG
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(weth), address(usdg)));
        zap.swapEthForUsdg{value: 1 ether}(0, alice);
        assertEq(weth.balanceOf(address(zap)), 0);
        assertEq(address(zap).balance, 0);
        // a trade the pool can fill in full goes through, and Zap keeps nothing
        vm.prank(alice);
        zap.swapEthForUsdg{value: 0.5 ether}(0, alice);
        assertEq(weth.balanceOf(address(zap)), 0);
        assertEq(usdg.balanceOf(address(zap)), 0);
    }

    function test_usdgToEth_partialFill_revertsNothingStranded() public {
        pool.setMaxOut(0.5 ether); // 3,000 USDG would only fill 0.5 of ~1 ETH
        vm.startPrank(alice);
        usdg.approve(address(zap), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(weth)));
        zap.swapUsdgForEth(3_000e6, 0, alice);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(zap)), 0);
    }
}
