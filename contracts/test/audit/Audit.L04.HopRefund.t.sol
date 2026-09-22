// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "./AuditBase.sol";
import {MockV3Pool} from "../mocks/MockV3.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {IAggregatorRouter, Route} from "../../src/router/IAggregatorRouter.sol";

/// @title L-04 regression — an unspent intermediate can never exist
///
/// v0.1: hop-2 remainders went to `msg.sender` = vault and sat there unaccounted and unrescuable.
/// v0.2: the router forwarded them to `recipient`; the vault booked them as `wethDust` and swept them to the
///       treasury — i.e. users' money (audit v0.3 M-02).
/// v0.3: the router executes FULL fills only. A hop that cannot consume its whole input is "no fill" at quote
///       time (the auto-route never selects it; the page is skipped, nobody is charged) and reverts `PartialFill`
///       at execution (an explicit path / override is refused). Nothing is ever refunded or forwarded.
contract AuditL04HopRefund is AuditBase {
    MockV3Pool usdgWeth;
    MockV3Pool wethNvda;

    function setUp() public override {
        super.setUp();
        usdgWeth = _wethUsdgPool();
        wethNvda = _constPool(address(weth), address(nvda), 3000, _sqrtPrice(address(weth), 1e18, address(nvda), 6e18));
        vm.prank(alice);
        daily.createPlan(address(nvda), 3_000e6, address(0), 3_000e6, 0, 0, false);
        _nextEpoch();
        // hop 2 can deliver only 99.5% of a full fill: the pool would consume 99.5% of the WETH
        (uint256 hop1Out,) = router.quote(address(usdg), address(weth), 3_000e6 - 22.5e6);
        uint256 full = wethNvda.midOut(address(weth) < address(nvda), hop1Out) * 997 / 1000;
        wethNvda.setMaxOut(full * 995 / 1000);
    }

    function test_partialSecondHop_pageIsSkippedAndNobodyIsCharged() public {
        uint256 tBefore = weth.balanceOf(treasury);
        vm.expectEmit(true, true, false, false);
        emit IPlanVault.EpochPageSkipped(address(nvda), daily.currentEpochId(), 0, 1, "");
        assertTrue(_advance(keeper));
        assertEq(_plan(1).usdgIdle, 3_000e6, "nothing charged");
        assertEq(_plan(1).stockAccrued, 0);
        assertEq(weth.balanceOf(treasury), tBefore, "nothing forwarded to the treasury");
        assertEq(weth.balanceOf(address(daily)), 0);
        assertEq(daily.wethDust(), 0);
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    function test_explicitPathRevertsPartialFill_nothingStranded() public {
        Route[] memory path = new Route[](2);
        path[0] = _route(address(usdg), address(weth), 500, address(usdgWeth));
        path[1] = _route(address(weth), address(nvda), 3000, address(wethNvda));
        vm.startPrank(bob);
        usdg.approve(address(router), type(uint256).max);
        uint256 uBefore = usdg.balanceOf(bob);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.PartialFill.selector, 1));
        router.swapWithRoute(address(usdg), address(nvda), 2_990e6, 0, bob, path);
        vm.stopPrank();
        assertEq(usdg.balanceOf(bob), uBefore);
        assertEq(weth.balanceOf(bob), 10_000 ether, "no intermediate forwarded");
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(weth.balanceOf(address(router)), 0);
        // the override path is refused the same way: the vault's quotePath sees no fill (the page is not consumed)
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(weth), address(nvda)));
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, uint256(1)));
        assertEq(_plan(1).usdgIdle, 3_000e6);
    }
}
