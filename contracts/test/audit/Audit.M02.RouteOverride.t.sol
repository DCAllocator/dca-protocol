// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "./AuditBase.sol";
import {MockV3Pool} from "../mocks/MockV3.sol";
import {Route, IAggregatorRouter} from "../../src/router/IAggregatorRouter.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {Plan} from "../../src/vault/VaultTypes.sol";

/// @title M-02 regression — a route override can pick a path, never a price
///
/// v0.1: `minOut >= 1` was the only check; a keeper could route a page through any factory pool at any price.
/// Fix: (1) the router refuses any hop that the owner has not approved (`RouteNotApproved`), so the override can
/// only select among approved pools; (2) the vault requires the override's `minOut` to be at least the auto
/// route's own floor (`quote * (1 - swapSlippageBps)`) whenever an auto quote exists.
contract AuditM02RouteOverride is AuditBase {
    MockV3Pool fairPool; // 500 USDG / NVDA, approved
    MockV3Pool badPool; // 50,000 USDG / NVDA (100x worse), factory pool, NOT approved

    function setUp() public override {
        super.setUp();
        fairPool = _usdgNvdaPool();
        badPool = MockV3Pool(
            factory.createPool(
                address(usdg), address(nvda), 10000, _sqrtPrice(address(nvda), 1e18, address(usdg), 50_000e6)
            )
        );
        usdg.mint(address(badPool), 1_000_000_000e6);
        nvda.mint(address(badPool), 1_000_000e18);
        vm.prank(alice);
        daily.createPlan(address(nvda), 10_000e6, address(0), 100_000e6, 0, 0);
        _nextEpoch();
    }

    function _override(address pool, uint24 fee, uint256 minOut) internal view returns (bytes memory) {
        Route[] memory path = new Route[](1);
        path[0] = _route(address(usdg), address(nvda), fee, pool);
        return abi.encode(path, minOut);
    }

    function test_baseline_autoRouteUsesFairPool() public {
        assertTrue(_advance(keeper));
        assertApproxEqRel(_plan(1).stockAccrued, 19.85e18, 0.01e18, "~19.85 NVDA for 9,925 net USDG");
    }

    function _autoFloor() internal returns (uint256) {
        (uint256 q,) = router.quote(address(usdg), address(nvda), 9_925e6);
        return (q * 9_950) / 10_000;
    }

    function test_unapprovedPoolRejectedEvenForKeeper() public {
        bytes32 key = router.hopKey(_route(address(usdg), address(nvda), 10000, address(badPool)));
        // the router refuses the unapproved pool while the vault floors the override (quotePath), whatever minOut
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.RouteNotApproved.selector, key));
        daily.advanceEpoch(address(nvda), 0, _override(address(badPool), 10000, 1));
        uint256 floor = _autoFloor();
        bytes memory ovr = _override(address(badPool), 10000, floor);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.RouteNotApproved.selector, key));
        daily.advanceEpoch(address(nvda), 0, ovr);
        assertEq(_plan(1).usdgIdle, 100_000e6, "page not consumed, nothing charged");
    }

    /// When the auto-router has no route (e.g. the only approved pool is over the impact cap) the override is still
    /// floored at the override path's OWN current quote: an operator can accept the impact, not a worse price.
    function test_noAutoQuote_overrideFlooredByPathQuote() public {
        fairPool.setImpact(200); // 2% > 150 bps cap -> auto route says NoRoute
        vm.prank(keeper);
        vm.expectEmit(true, true, false, false);
        emit IPlanVault.EpochPageSkipped(address(nvda), 1, 0, 1, "");
        daily.advanceEpoch(address(nvda), 1, ""); // auto: skipped, page consumed for this epoch
        _nextEpoch();

        Route[] memory path = new Route[](1);
        path[0] = _route(address(usdg), address(nvda), 500, address(fairPool));
        uint256 pathOut = router.quotePath(path, 9_925e6);
        uint256 pathFloor = (pathOut * 9_950) / 10_000;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.OverrideMinOutTooLow.selector, 1, pathFloor));
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, uint256(1)));
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 0, abi.encode(path, pathFloor)));
        assertGe(_plan(1).stockAccrued, pathFloor);
        assertLt(_plan(1).stockAccrued, 19.85e18 * 985 / 1000, "the operator explicitly accepted ~2% impact");
    }

    function test_approvedWorsePoolStillMustMeetAutoFloor() public {
        // Even if the owner approved the bad pool, the keeper cannot use it below the auto floor ...
        _approveBoth(address(usdg), address(nvda), 10000, address(badPool));
        (uint256 q,) = router.quote(address(usdg), address(nvda), 9_925e6);
        uint256 floor = (q * 9_950) / 10_000;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.OverrideMinOutTooLow.selector, 1, floor));
        daily.advanceEpoch(address(nvda), 0, _override(address(badPool), 10000, 1));
        // ... and with a compliant minOut the bad pool simply cannot deliver: InsufficientOutput, page not consumed
        vm.prank(keeper);
        vm.expectRevert();
        daily.advanceEpoch(address(nvda), 0, _override(address(badPool), 10000, floor));
        assertEq(daily.nextPlanIndex(address(nvda), 1), 0);
        // the fair pool with the same floor works
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 0, _override(address(fairPool), 500, floor)));
        assertGe(_plan(1).stockAccrued, floor);
    }

    function test_operatorThroughKeeperContractHasSameBounds() public {
        bytes32 key = router.hopKey(_route(address(usdg), address(nvda), 10000, address(badPool)));
        uint256 floor = _autoFloor();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.RouteNotApproved.selector, key));
        epochKeeper.run(0, 0, _override(address(badPool), 10000, floor));
        vm.prank(keeper);
        vm.expectPartialRevert(IPlanVault.OverrideMinOutTooLow.selector);
        epochKeeper.run(0, 0, _override(address(fairPool), 500, floor - 1));
    }
}
