// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {MockAggregatorV3} from "../mocks/MockChainlink.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {PriceGuardLib} from "../../src/libraries/PriceGuardLib.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev `PriceGuardLib.UNGUARDED`: the owner's explicit opt-out of the price floor for one stock ($DCA, whose trading
///      tax is its sandwich defence). AAPL plays the unguarded token (no feed of its own), NVDA keeps a Chainlink feed
///      at 500 USD; the mock router's rate is the pool. The guard stays fail-closed (`requireFeed`) throughout.
contract PlanVaultPriceGuardUnguardedTest is BaseTest {
    MockAggregatorV3 internal feed;
    address internal constant UNGUARDED = PriceGuardLib.UNGUARDED;

    function setUp() public override {
        super.setUp();
        feed = new MockAggregatorV3(8, 500e8);
        vm.startPrank(owner);
        daily.setPriceFeed(address(nvda), address(feed), 1 days);
        daily.setPriceGuard(300, true, address(0), 0);
        vm.stopPrank();
    }

    function test_marker_isAllOnesAddress() public pure {
        assertEq(UNGUARDED, 0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF);
    }

    function test_setUnguarded_storesMarkerWithoutReadingAFeed() public {
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.PriceFeedSet(address(aapl), UNGUARDED, 0);
        vm.prank(owner);
        daily.setPriceFeed(address(aapl), UNGUARDED, 12345); // staleness is meaningless here and stored as 0
        (address f, uint32 stale, uint8 fd, uint8 sd) = daily.priceFeed(address(aapl));
        assertEq(f, UNGUARDED);
        assertEq(stale, 0);
        assertEq(fd, 0);
        assertEq(sd, 0);
    }

    function test_setUnguarded_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        daily.setPriceFeed(address(aapl), UNGUARDED, 0);
    }

    /// Without the marker a feedless stock is refused (fail closed); with it the page fills, however far the pool
    /// sits from any outside price — only the router's own quote / slippage / impact checks apply.
    function test_unguardedStock_fillsUnderFailClosedGuard_evenWhenPoolIsFarOff() public {
        uint256 id = _createUsdgPlan(daily, alice, address(aapl), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PriceFeedMissing.selector, address(aapl)));
        daily.advanceEpoch(address(aapl), 0, "");

        vm.prank(owner);
        daily.setPriceFeed(address(aapl), UNGUARDED, 0);
        router.setRate(address(usdg), address(aapl), 1e18, 400e6); // pool +100% on the 200 USDG seed price
        assertTrue(_advance(daily, address(aapl)));
        assertGt(daily.getPlan(id).stockAccrued, 0);
    }

    /// The opt-out is per stock: NVDA, with its feed, is still floored in the same vault.
    function test_otherStocksStayGuarded() public {
        vm.prank(owner);
        daily.setPriceFeed(address(aapl), UNGUARDED, 0);
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        router.setRate(address(usdg), address(nvda), 1e18, 800e6); // pool pushed +60%
        vm.prank(keeper);
        vm.expectPartialRevert(IPlanVault.PriceDeviates.selector);
        daily.advanceEpoch(address(nvda), 0, "");
    }

    /// A stale sequencer feed or a stale stock feed cannot block an unguarded stock: there is no reference to trust.
    function test_unguardedStock_ignoresSequencerAndStaleness() public {
        vm.startPrank(owner);
        daily.setPriceFeed(address(aapl), UNGUARDED, 0);
        daily.setPriceGuard(300, true, address(0xdead), 1 hours); // not a feed at all: would revert if read
        vm.stopPrank();
        _createUsdgPlan(daily, alice, address(aapl), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.warp(block.timestamp + 30 days);
        assertTrue(_advance(daily, address(aapl)));
    }

    /// Replacing the marker with a real feed (or clearing it) restores the normal behaviour.
    function test_markerCanBeReplacedOrCleared() public {
        vm.startPrank(owner);
        daily.setPriceFeed(address(aapl), UNGUARDED, 0);
        daily.setPriceFeed(address(aapl), address(0), 0);
        vm.stopPrank();
        (address f,,,) = daily.priceFeed(address(aapl));
        assertEq(f, address(0));
        _createUsdgPlan(daily, alice, address(aapl), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PriceFeedMissing.selector, address(aapl)));
        daily.advanceEpoch(address(aapl), 0, "");

        MockAggregatorV3 aaplFeed = new MockAggregatorV3(8, 200e8);
        vm.prank(owner);
        daily.setPriceFeed(address(aapl), address(aaplFeed), 1 days);
        router.setRate(address(usdg), address(aapl), 1e18, 400e6);
        vm.prank(keeper);
        vm.expectPartialRevert(IPlanVault.PriceDeviates.selector);
        daily.advanceEpoch(address(aapl), 0, "");
    }
}
