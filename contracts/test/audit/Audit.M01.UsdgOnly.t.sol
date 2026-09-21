// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "./AuditBase.sol";
import {CPMMPool} from "./mocks/CPMMPool.sol";
import {MockV3Pool} from "../mocks/MockV3.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {IAggregatorRouter} from "../../src/router/IAggregatorRouter.sol";
import {Plan} from "../../src/vault/VaultTypes.sol";

/// @title M-01 regression — vaults are USDG-only; ETH/WETH is converted at deposit, never sized at epoch
///
/// v0.1: zap-at-epoch plans were sized and capped on page-wide aggregates, so one whale plan could make every
/// other zap plan skip (`PlanSkippedNoRoute` / `PlanSkippedSlippage`) or over-convert its neighbours.
/// Fix: the zap-at-epoch mode is gone. A WETH/ETH deposit is converted immediately for that plan only, with the
/// depositor's own `minUsdgOut`, and any unfilled WETH goes straight back to the depositor.
contract AuditM01UsdgOnly is AuditBase {
    CPMMPool wethUsdg;
    MockV3Pool usdgNvda;

    function setUp() public override {
        super.setUp();
        // 1,000 WETH / 3,000,000 USDG -> 3000 USDG per WETH, price moves with size
        wethUsdg = _cpmmPool(address(weth), 1_000 ether, address(usdg), 3_000_000e6, 500);
        usdgNvda = _usdgNvdaPool();
    }

    /// Bob's small ETH deposit converts at his own (tiny) impact regardless of what a whale does around him.
    function test_whaleCannotGriefOtherDepositors() public {
        vm.prank(bob);
        uint256 bobId = daily.createPlan(address(nvda), 300e6, address(0), 0, 0.1 ether, 0, false);
        uint256 bobUsdg = _plan(bobId).usdgIdle;
        assertApproxEqRel(bobUsdg, 300e6, 0.002e18, "~0.1% cost: fee + own impact");

        // Mallory tries to convert 50 WETH (5% of the pool): the router's impact cap refuses HER deposit only.
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(weth), address(usdg)));
        daily.createPlan(address(nvda), 10e6, address(0), 0, 50 ether, 0, false);
        // 12 WETH (~1.2% impact) converts — she eats her own impact, nobody else's plan is touched.
        vm.prank(mallory);
        uint256 malloryId = daily.createPlan(address(nvda), 10e6, address(0), 0, 12 ether, 0, false);
        assertLt(_plan(malloryId).usdgIdle, 36_000e6 * 99 / 100, "whale pays > 1% impact herself");
        assertEq(_plan(bobId).usdgIdle, bobUsdg, "bob unaffected");

        _nextEpoch();
        assertTrue(_advance(keeper));
        assertEq(_plan(bobId).lastEpochId, 1, "bob fills");
        assertEq(_plan(malloryId).lastEpochId, 1);
        assertEq(weth.balanceOf(address(daily)), 0, "vault holds no WETH, ever");
    }

    /// The depositor's own minUsdgOut protects the conversion; a default is derived from the quote.
    function test_depositMinOutIsDepositorsChoice() public {
        vm.prank(bob);
        vm.expectRevert(); // InsufficientOutput: 1 WETH cannot yield 3000 USDG after fee + impact
        daily.createPlan(address(nvda), 300e6, address(0), 0, 1 ether, 3_000e6, false);
        vm.prank(bob);
        uint256 id = daily.createPlan(address(nvda), 300e6, address(0), 0, 1 ether, 2_990e6, false);
        assertGt(_plan(id).usdgIdle, 2_990e6);
    }

    /// Epochs never swap WETH: exactly one swap (the buy) per page.
    function test_epochDoesOneSwapOnly() public {
        vm.prank(alice);
        daily.createPlan{value: 1 ether}(address(nvda), 100e6, address(0), 0, 0, 0, false);
        vm.prank(bob);
        daily.createPlan(address(nvda), 100e6, address(0), 1_000e6, 0, 0, false);
        _nextEpoch();
        uint256 wethReservesBefore = weth.balanceOf(address(wethUsdg));
        assertTrue(_advance(keeper));
        assertEq(weth.balanceOf(address(wethUsdg)), wethReservesBefore, "WETH pool untouched at epoch");
    }
}
