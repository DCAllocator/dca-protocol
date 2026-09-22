// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {MockAggregatorV3, MockSequencerFeed} from "../mocks/MockChainlink.sol";
import {DailyVault} from "../../src/vault/DailyVault.sol";
import {VaultParams} from "../../src/vault/VaultTypes.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {Route} from "../../src/router/IAggregatorRouter.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev The Chainlink price floor on epoch purchases (audit v0.3 H-01, PriceGuardLib). NVDA feed at 500 USD with
///      8 decimals; the mock router's rate is the "pool". Plan: 200 USDG per epoch -> 198.5 USDG net of the 75 bps
///      fee; reference = 0.397 NVDA; floor at 3% deviation = 0.38509 NVDA.
contract PlanVaultPriceGuardTest is BaseTest {
    MockAggregatorV3 internal feed;
    uint256 internal constant AMOUNT_IN = 198.5e6;
    uint256 internal constant REFERENCE = 0.397e18;
    uint256 internal constant FLOOR = (REFERENCE * 9_700) / 10_000;

    function setUp() public override {
        super.setUp();
        feed = new MockAggregatorV3(8, 500e8);
        vm.startPrank(owner);
        daily.setPriceFeed(address(nvda), address(feed), 1 days);
        daily.setPriceGuard(300, true, address(0), 0);
        vm.stopPrank();
    }

    function _minOutAtRate(uint256 usdgPerNvda) internal pure returns (uint256) {
        return ((AMOUNT_IN * 1e18) / usdgPerNvda) * 9_950 / 10_000;
    }

    function test_defaults_failClosed() public {
        VaultParams memory p = VaultParams({
            owner: owner,
            usdg: address(usdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: treasury,
            epochLength: 0,
            origin: EpochLib.alignToDay(block.timestamp),
            purchaseFeeBps: 0
        });
        vm.expectEmit(false, false, false, true);
        emit IPlanVault.PriceGuardSet(300, true, address(0), 0);
        DailyVault fresh = new DailyVault(p);
        (uint16 dev, bool req, address seq, uint32 grace) = fresh.priceGuard();
        assertEq(dev, 300);
        assertTrue(req, "fail closed until feeds are configured");
        assertEq(seq, address(0));
        assertEq(grace, 0);
    }

    function test_setPriceFeed_storesDecimalsAndValidates() public {
        (address f, uint32 stale, uint8 fd, uint8 sd) = daily.priceFeed(address(nvda));
        assertEq(f, address(feed));
        assertEq(stale, 1 days);
        assertEq(fd, 8);
        assertEq(sd, 18);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.InvalidFeed.selector, address(feed)));
        daily.setPriceFeed(address(nvda), address(feed), 0);
        MockAggregatorV3 zero = new MockAggregatorV3(8, 0);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.InvalidFeed.selector, address(zero)));
        daily.setPriceFeed(address(nvda), address(zero), 1 days);
        vm.expectRevert(); // not a feed
        daily.setPriceFeed(address(nvda), bob, 1 days);
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.PriceFeedSet(address(nvda), address(0), 0);
        daily.setPriceFeed(address(nvda), address(0), 0);
        vm.stopPrank();
        (f, stale,,) = daily.priceFeed(address(nvda));
        assertEq(f, address(0));
        assertEq(stale, 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        daily.setPriceFeed(address(nvda), address(feed), 1 days);
    }

    function test_setPriceGuard_bounds() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.ValueOutOfRange.selector, 0, 1_000));
        daily.setPriceGuard(0, true, address(0), 0);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.ValueOutOfRange.selector, 1_001, 1_000));
        daily.setPriceGuard(1_001, true, address(0), 0);
        vm.expectEmit(false, false, false, true);
        emit IPlanVault.PriceGuardSet(500, false, bob, 1 hours);
        daily.setPriceGuard(500, false, bob, 1 hours);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        daily.setPriceGuard(300, true, address(0), 0);
    }

    function test_fairPool_fills() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        assertTrue(_advance(daily, address(nvda)));
        assertEq(daily.getPlan(id).stockAccrued, _nvdaFor(AMOUNT_IN));
    }

    function test_pushedPool_revertsAndRetriesWhenFair() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        router.setRate(address(usdg), address(nvda), 1e18, 800e6); // pool pushed +60%
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PriceDeviates.selector, address(nvda), _minOutAtRate(800e6), FLOOR));
        daily.advanceEpoch(address(nvda), 0, "");
        assertEq(daily.getPlan(id).usdgIdle, 1_000e6, "nothing charged");
        assertEq(daily.nextPlanIndex(address(nvda), daily.currentEpochId()), 0, "page not consumed");
        // later in the same epoch, the pool is fair again: the operator's retry fills
        router.setRate(address(usdg), address(nvda), 1e18, 500e6);
        assertTrue(_advance(daily, address(nvda)));
        assertEq(daily.getPlan(id).stockAccrued, _nvdaFor(AMOUNT_IN));
    }

    /// The floor is reference x 0.97 against minOut = quote x 0.995: a pool ~2.4% above the feed passes,
    /// ~2.6% above does not.
    function test_deviationBoundary() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        router.setRate(address(usdg), address(nvda), 1e18, 512e6);
        assertGe(_minOutAtRate(512e6), FLOOR);
        assertTrue(_advance(daily, address(nvda)));
        _nextEpoch(daily);
        feed.set(500e8); // a day passed: refresh the feed (staleness is exercised in its own test)
        router.setRate(address(usdg), address(nvda), 1e18, 513e6);
        assertLt(_minOutAtRate(513e6), FLOOR);
        vm.prank(keeper);
        vm.expectPartialRevert(IPlanVault.PriceDeviates.selector);
        daily.advanceEpoch(address(nvda), 0, "");
        // a wider tolerance lets it through
        vm.prank(owner);
        daily.setPriceGuard(500, true, address(0), 0);
        assertTrue(_advance(daily, address(nvda)));
    }

    function test_override_isGuardedToo() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        router.setRate(address(usdg), address(nvda), 1e18, 800e6);
        Route[] memory path = new Route[](1);
        path[0] = Route({protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 3000, extra: ""});
        uint256 pathFloor = (router.quotePath(path, AMOUNT_IN) * 9_950) / 10_000;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PriceDeviates.selector, address(nvda), pathFloor, FLOOR));
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, pathFloor));
        // an override minOut at or above the floor passes the guard (and then must be met by the pool)
        vm.prank(keeper);
        vm.expectRevert(); // InsufficientOutput from the pool
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, FLOOR));
    }

    function test_staleOrFutureFeed_reverts() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PriceFeedStale.selector, address(nvda)));
        daily.advanceEpoch(address(nvda), 0, "");
        feed.set(500e8); // fresh again
        assertTrue(_advance(daily, address(nvda)));
        _nextEpoch(daily);
        feed.setUpdatedAt(block.timestamp + 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PriceFeedStale.selector, address(nvda)));
        daily.advanceEpoch(address(nvda), 0, "");
        feed.set(0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PriceFeedStale.selector, address(nvda)));
        daily.advanceEpoch(address(nvda), 0, "");
    }

    function test_missingFeed_refusedUnlessOptedOut() public {
        uint256 id = _createUsdgPlan(daily, alice, address(aapl), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PriceFeedMissing.selector, address(aapl)));
        daily.advanceEpoch(address(aapl), 0, "");
        vm.prank(owner);
        daily.setPriceGuard(300, false, address(0), 0);
        assertTrue(_advance(daily, address(aapl)));
        assertGt(daily.getPlan(id).stockAccrued, 0);
    }

    function test_sequencerFeed_gatesEveryCheck() public {
        MockSequencerFeed seq = new MockSequencerFeed();
        vm.prank(owner);
        daily.setPriceGuard(300, true, address(seq), 1 hours);
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        seq.set(true, block.timestamp);
        vm.prank(keeper);
        vm.expectRevert(IPlanVault.SequencerDown.selector);
        daily.advanceEpoch(address(nvda), 0, "");
        seq.set(false, block.timestamp); // back up, inside the grace period
        vm.prank(keeper);
        vm.expectRevert(IPlanVault.SequencerDown.selector);
        daily.advanceEpoch(address(nvda), 0, "");
        vm.warp(block.timestamp + 1 hours);
        feed.set(500e8);
        assertTrue(_advance(daily, address(nvda)));
    }

    function test_feedDecimals_areNormalised() public {
        MockAggregatorV3 feed18 = new MockAggregatorV3(18, 500e18);
        vm.prank(owner);
        daily.setPriceFeed(address(nvda), address(feed18), 1 days);
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        assertTrue(_advance(daily, address(nvda)));
        assertEq(daily.getPlan(id).stockAccrued, _nvdaFor(AMOUNT_IN));
        _nextEpoch(daily);
        feed18.set(500e18);
        router.setRate(address(usdg), address(nvda), 1e18, 800e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PriceDeviates.selector, address(nvda), _minOutAtRate(800e6), FLOOR));
        daily.advanceEpoch(address(nvda), 0, "");
    }

    function test_depositsAreNotGuarded() public {
        // WETH -> USDG conversions on deposit are the depositor's own trade with their own minOut; no feed needed.
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        daily.depositWETH(id, 1 ether, 0);
        assertEq(daily.getPlan(id).usdgIdle, 4_000e6);
    }
}
