// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "../AuditBase.sol";
import {CPMMPool} from "../mocks/CPMMPool.sol";
import {MockV3Pool} from "../../mocks/MockV3.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";
import {IAggregatorRouter, Route} from "../../../src/router/IAggregatorRouter.sol";

/// @dev AUDIT v0.3 / M-02. The route override's floor is max(auto floor, quotePath x (1 - slippage)).
///      quotePath applies NO impact cap and NO external reference, so exactly when the auto-route has no in-cap
///      quote (the page is too large for every approved pool) the operator may fill at any impact the pool
///      delivers. A partially filled second hop then books the users' unspent WETH as "dust" for the treasury.
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

    function test_overrideFillsBeyondTheImpactCap_whenAutoRouteHasNoQuote() public {
        // Thin pool: $200k / 400 NVDA. The 14.9k page has ~7% impact, far above the 150 bps cap.
        CPMMPool pool = _cpmmPool(address(usdg), 200_000e6, address(nvda), 400e18, 500);
        _openPlans();
        _nextEpoch();
        uint256 amountIn = _amountIn();

        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quoteWithImpact(address(usdg), address(nvda), amountIn);

        // Auto-route: the page is skipped, nobody is charged (the intended behaviour).
        uint256 snap = vm.snapshotState();
        vm.expectEmit(true, true, false, false);
        emit IPlanVault.EpochPageSkipped(address(nvda), daily.currentEpochId(), 0, 0, "");
        _advance(keeper);
        assertEq(_totalAccrued(), 0);
        vm.revertToState(snap);

        // Override: the floor is the thin pool's own quote, impact unbounded.
        Route[] memory path = new Route[](1);
        path[0] = _route(address(usdg), address(nvda), 500, address(pool));
        uint256 q = router.quotePath(path, amountIn);
        uint256 fair = (amountIn * 1e18) / 500e6;
        assertLt(q * 100, fair * 94, "quotePath accepts > 6% impact");

        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, (q * 995) / 1000));
        assertApproxEqRel(_totalAccrued(), q, 0.001e18, "filled at the uncapped price");
    }

    function test_partialSecondHop_sendsUsersWethToTheTreasury() public {
        // Deep WETH/USDG pool; WETH/NVDA pool priced at 1 NVDA = 1/6 WETH (= 500 USDG) but with only 10 NVDA of
        // liquidity in range. No direct USDG/NVDA pool.
        _wethUsdgPool();
        MockV3Pool wn =
            _constPool(address(weth), address(nvda), 500, _sqrtPrice(address(nvda), 6e18, address(weth), 1e18));
        wn.setMaxOut(10e18);
        _openPlans();
        _nextEpoch();
        uint256 amountIn = _amountIn();

        // Auto-route: the only two-hop candidate fills ~10 of ~29.7 NVDA (impact ~66%) and is refused.
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quoteWithImpact(address(usdg), address(nvda), amountIn);

        Route[] memory path = new Route[](2);
        path[0] = _route(address(usdg), address(weth), 500, address(_wethUsdgPoolAddr()));
        path[1] = _route(address(weth), address(nvda), 500, address(wn));
        uint256 q = router.quotePath(path, amountIn);
        assertApproxEqAbs(q, 10e18, 1e12);

        uint256 treasuryWethBefore = weth.balanceOf(treasury);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, (q * 995) / 1000));

        // Users were charged the FULL page (hop 1 consumed all USDG), got 10 NVDA (~$5k) for $15k ...
        assertEq(daily.totalUsdgIdle(), 3 * 50_000e6 - 3 * PER_EPOCH, "no USDG residual came back");
        assertApproxEqAbs(_totalAccrued(), 10e18, 1e12);
        // ... and ~3.3 WETH (~$10k) of their money went to the fee recipient as "dust".
        uint256 toTreasury = weth.balanceOf(treasury) - treasuryWethBefore;
        emit log_named_uint("users' WETH forwarded to treasury (1e18)", toTreasury);
        assertGt(toTreasury, 3e18);
        assertEq(daily.wethDust(), 0);
    }

    /// The same partial-fill leak exists on the AUTO path when the unfilled part is small enough to stay under
    /// the impact cap: here the second hop fills 99% and 1% of the users' WETH is forwarded to the treasury
    /// instead of being returned pro rata like a first-hop residual would be.
    function test_autoRoute_smallPartialSecondHop_stillLeaksToTreasury() public {
        _wethUsdgPool();
        MockV3Pool wn =
            _constPool(address(weth), address(nvda), 500, _sqrtPrice(address(nvda), 6e18, address(weth), 1e18));
        _openPlans();
        _nextEpoch();
        uint256 amountIn = _amountIn();
        (uint256 full,,) = router.quoteWithImpact(address(usdg), address(nvda), amountIn);
        wn.setMaxOut((full * 99) / 100); // 1% of the WETH will come back unspent
        (,, uint256 impact) = router.quoteWithImpact(address(usdg), address(nvda), amountIn);
        assertLe(impact, router.maxPriceImpactBps(), "still within the cap");

        uint256 treasuryWethBefore = weth.balanceOf(treasury);
        _advance(keeper);
        uint256 toTreasury = weth.balanceOf(treasury) - treasuryWethBefore;
        assertGt(toTreasury, 0.04e18, "~1% of a 4.96 WETH page");
        assertEq(daily.totalUsdgIdle(), 3 * 50_000e6 - 3 * PER_EPOCH, "users were charged in full");
    }

    function _wethUsdgPoolAddr() internal view returns (address) {
        return factory.getPool(address(weth), address(usdg), 500);
    }
}
