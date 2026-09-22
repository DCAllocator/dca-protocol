// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {Zap} from "../../../src/periphery/Zap.sol";

/// @dev AUDIT v0.3 / L-02. AggregatorRouter refunds the unspent part of a partially filled first hop to
///      msg.sender. For Zap, msg.sender is the Zap contract itself, which has no sweep: the refund is stranded
///      forever. The vault handles the same refund correctly (it is msg.sender and books it).
contract Audit3_L02_ZapStrandsRefund is BaseTest {
    Zap internal zap;

    function setUp() public override {
        super.setUp();
        zap = new Zap(address(weth), address(usdg), address(router));
    }

    function test_ethToUsdg_partialFill_strandsWethInZap() public {
        router.setFill(address(weth), address(usdg), 9_000); // pool can only absorb 90%
        vm.prank(alice);
        zap.swapEthForUsdg{value: 1 ether}(0, alice);
        assertEq(weth.balanceOf(address(zap)), 0.1 ether, "10% of alice's ETH is stuck in Zap");
        assertEq(address(zap).balance, 0);
    }

    function test_usdgToEth_partialFill_strandsUsdgInZap() public {
        router.setFill(address(usdg), address(weth), 9_000);
        vm.deal(address(weth), 10 ether); // MockRouter mints WETH unbacked; give WETH ETH to unwrap
        vm.startPrank(alice);
        usdg.approve(address(zap), 1_000e6);
        zap.swapUsdgForEth(1_000e6, 0, alice);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(zap)), 100e6, "10% of alice's USDG is stuck in Zap");
    }
}
