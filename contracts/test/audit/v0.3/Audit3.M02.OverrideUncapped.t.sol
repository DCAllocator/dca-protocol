// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "../AuditBase.sol";
import {CPMMPool} from "../mocks/CPMMPool.sol";
import {MockV3Pool} from "../../mocks/MockV3.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";
import {IAggregatorRouter, Route} from "../../../src/router/IAggregatorRouter.sol";

/// @title AUDIT v0.3 / M-02 regression — overrides are capped like the auto-route; no partial hop ever executes
///
/// Finding: `quotePath` applied no impact cap, so when the auto-route had no in-cap quote an operator override
/// could fill at any impact; and a partially filled second hop forwarded the users' unspent WETH to the treasury
/// (auto path too, within the cap).
/// Fix: `quotePath` enforces `maxPriceImpactBps`; adapters report a hop that cannot consume its whole input as
/// "no fill" and the router reverts `PartialFill` on execution. The right operator tool for a page that is too
/// large for the pool is a smaller `limit`, not a worse price.
contract Audit3_M02_OverrideUncapped is AuditBase {
    uint256[] internal ids;
    uint256 internal constant PER_EPOCH = 5_000e6;

    function _openPlans() internal {
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.prank(users[i]);
            ids.push(daily.createPlan(address(nvda), uint96(PER_EPOCH), address(0), 50_000e6, 0, 0, false));
        }
    }

    function _totalAccrued() internal view returns (uint256 t) {
        for (uint256 i; i < ids.length; ++i) {
            t += _plan(ids[i]).stockAccrued;
        }
    }

    function _amountIn() internal pure returns (uint256) {
        return (3 * PER_EPOCH * (10_000 - 75)) / 10_000;
    }

    function test_overrideCannotExceedTheImpactCap_smallerPagesCan() public {
        // $400k / 800 NVDA: the 15k page has ~3.7% impact (over the cap); a one-plan page ~1.3% (inside it).
        CPMMPool pool = _cpmmPool(address(usdg), 400_000e6, address(nvda), 800e18, 500);
        _openPlans();
        _nextEpoch();
        uint256 amountIn = _amountIn();

        Route[] memory path = new Route[](1);
        path[0] = _route(address(usdg), address(nvda), 500, address(pool));
        vm.expectPartialRevert(IAggregatorRouter.PriceImpactTooHigh.selector);
        router.quotePath(path, amountIn);

        // Override: refused, page not consumed.
        vm.prank(keeper);
        vm.expectPartialRevert(IAggregatorRouter.PriceImpactTooHigh.selector);
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, uint256(1)));
        assertEq(_totalAccrued(), 0);
        assertEq(daily.nextPlanIndex(address(nvda), daily.currentEpochId()), 0, "page not consumed");

        // The operator's tool: smaller pages, each inside the cap, at the auto-route's own price.
        vm.startPrank(keeper);
        assertFalse(daily.advanceEpoch(address(nvda), 1, ""));
        assertFalse(daily.advanceEpoch(address(nvda), 1, ""));
        assertTrue(daily.advanceEpoch(address(nvda), 1, ""));
        vm.stopPrank();
        uint256 fair = (amountIn * 1e18) / 500e6;
        assertGt(_totalAccrued() * 100, fair * 96, "three in-cap fills, ~2-4% total slippage across them");
    }

    function test_partialSecondHop_isRefused_nothingGoesToTheTreasury() public {
        _wethUsdgPool();
        MockV3Pool wn =
            _constPool(address(weth), address(nvda), 500, _sqrtPrice(address(nvda), 6e18, address(weth), 1e18));
        wn.setMaxOut(10e18); // only 10 NVDA of liquidity in range
        _openPlans();
        _nextEpoch();
        uint256 amountIn = _amountIn();

        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quoteWithImpact(address(usdg), address(nvda), amountIn);

        Route[] memory path = new Route[](2);
        path[0] = _route(address(usdg), address(weth), 500, factory.getPool(address(weth), address(usdg), 500));
        path[1] = _route(address(weth), address(nvda), 500, address(wn));
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(weth), address(nvda)));
        router.quotePath(path, amountIn);

        uint256 treasuryWethBefore = weth.balanceOf(treasury);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(weth), address(nvda)));
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, uint256(1)));

        // auto path: the page is skipped, nobody is charged, nothing leaves
        vm.expectEmit(true, true, false, false);
        emit IPlanVault.EpochPageSkipped(address(nvda), daily.currentEpochId(), 0, 3, "");
        _advance(keeper);
        assertEq(daily.totalUsdgIdle(), 3 * 50_000e6, "nobody charged");
        assertEq(_totalAccrued(), 0);
        assertEq(weth.balanceOf(treasury), treasuryWethBefore, "nothing forwarded to the treasury");
        assertEq(daily.wethDust(), 0);
    }

    function test_autoRoute_smallPartialSecondHop_isSkippedNotLeaked() public {
        _wethUsdgPool();
        MockV3Pool wn =
            _constPool(address(weth), address(nvda), 500, _sqrtPrice(address(nvda), 6e18, address(weth), 1e18));
        _openPlans();
        _nextEpoch();
        uint256 amountIn = _amountIn();
        (uint256 full,,) = router.quoteWithImpact(address(usdg), address(nvda), amountIn);
        wn.setMaxOut((full * 99) / 100); // 1% of the WETH would come back unspent: inside the cap, but a partial fill
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quoteWithImpact(address(usdg), address(nvda), amountIn);

        uint256 treasuryWethBefore = weth.balanceOf(treasury);
        _advance(keeper);
        assertEq(weth.balanceOf(treasury), treasuryWethBefore, "nothing forwarded to the treasury");
        assertEq(daily.totalUsdgIdle(), 3 * 50_000e6, "nobody charged");
    }
}
