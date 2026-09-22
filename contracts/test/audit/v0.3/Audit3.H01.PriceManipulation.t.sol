// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "../AuditBase.sol";
import {CPMMPool, Trader} from "../mocks/CPMMPool.sol";
import {MockAggregatorV3} from "../../mocks/MockChainlink.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";

/// @title AUDIT v0.3 / H-01 regression — epoch purchases are floored at the Chainlink reference price
///
/// Finding: every number the vault checked (router quote, minOut = quote x 0.995, impact vs slot0) was read in
/// the executing block, so an attacker who pre-positioned in an EARLIER block (no ordering, no mempool needed)
/// and unwound after the fill took value from every plan on the page; timing was public and predictable.
/// Fix: PriceGuardLib — `minOut` must be >= Chainlink reference x (1 - maxDeviationBps), else `PriceDeviates`
/// and the page is retried later. The attacker's push now costs them the round-trip fees for nothing.
contract Audit3_H01_PriceManipulation is AuditBase {
    CPMMPool internal pool;
    Trader internal attacker;
    MockAggregatorV3 internal feed;
    uint256[] internal ids;
    uint256 internal constant PER_EPOCH = 5_000e6;

    function setUp() public override {
        super.setUp();
        feed = new MockAggregatorV3(8, 500e8);
        vm.startPrank(owner);
        daily.setPriceFeed(address(nvda), address(feed), 1 days);
        daily.setPriceGuard(300, true, address(0), 0);
        vm.stopPrank();
        // $2M USDG / 4,000 NVDA constant-product pool at 500 USDG per NVDA, 5 bps fee: a realistic mid-size pool
        // (a 15k page has ~0.8% impact here; in a $1M pool the same page is already OVER the 150 bps cap).
        pool = _cpmmPool(address(usdg), 2_000_000e6, address(nvda), 4_000e18, 500);
        attacker = new Trader();
        usdg.mint(address(attacker), 3_000_000e6);
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

    /// Block N: attacker buys NVDA. Block N+1: operator runs the scheduled epoch (auto-route, no override): the
    /// pool-derived checks pass (the impact cap is measured against the ALREADY PUSHED spot), but the Chainlink
    /// floor refuses the fill. Nobody is charged; the attacker unwinds at a loss (fees).
    function test_crossBlockManipulation_isRefusedByTheReferenceFloor() public {
        _nextEpoch();
        uint256 amountIn = (3 * PER_EPOCH * (10_000 - 75)) / 10_000; // page net of the 75 bps purchase fee

        // Baseline: the fair fill passes the guard.
        uint256 snap = vm.snapshotState();
        assertTrue(_advance(keeper));
        uint256 fairOut = _totalAccrued();
        assertGt(fairOut, 0);
        vm.revertToState(snap);

        bool buyNvda = address(usdg) == pool.token0();
        uint256 push = 600_000e6;
        uint256 nvdaHeld = attacker.trade(pool, buyNvda, push);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        (uint256 quoted,, uint256 impact) = router.quoteWithImpact(address(usdg), address(nvda), amountIn);
        assertLe(impact, router.maxPriceImpactBps(), "the pool-derived cap is blind to the push");
        assertGt(quoted, 0);
        vm.prank(keeper);
        vm.expectPartialRevert(IPlanVault.PriceDeviates.selector);
        daily.advanceEpoch(address(nvda), 0, "");
        assertEq(_totalAccrued(), 0, "nobody bought at the pushed price");
        assertEq(daily.totalUsdgIdle(), 3 * 50_000e6, "nobody charged");
        assertEq(daily.nextPlanIndex(address(nvda), daily.currentEpochId()), 0, "page not consumed: retried later");

        vm.roll(block.number + 1);
        uint256 usdgBack = attacker.trade(pool, !buyNvda, nvdaHeld);
        emit log_named_uint("attacker loss USDG (1e6)", push - usdgBack);
        assertLt(usdgBack, push, "attacker pays the round-trip fees for nothing");

        // Once the pool is back near the reference, the operator's retry fills at fair value.
        assertTrue(_advance(keeper));
        assertGt(_totalAccrued() * 100, fairOut * 99);
    }

    /// A push that stays inside the tolerance still fills: the residual exposure per page is bounded by
    /// maxDeviationBps (the page's own impact, the pool fee and swapSlippageBps all eat into that budget:
    /// here a +0.5% push passes, a +2% push already trips the floor), never the whole page.
    function test_pushInsideTheTolerance_fillsBounded() public {
        _nextEpoch();
        uint256 snap = vm.snapshotState();
        _advance(keeper);
        uint256 fairOut = _totalAccrued();
        vm.revertToState(snap);
        bool buyNvda = address(usdg) == pool.token0();
        attacker.trade(pool, buyNvda, 5_000e6); // ~+0.5%
        vm.roll(block.number + 1);
        assertTrue(_advance(keeper));
        assertGt(_totalAccrued() * 100, fairOut * 97, "bounded by the tolerance");
        vm.revertToState(snap);
        attacker.trade(pool, buyNvda, 20_000e6); // ~+2%: with the page's own impact that is already outside
        vm.roll(block.number + 1);
        vm.prank(keeper);
        vm.expectPartialRevert(IPlanVault.PriceDeviates.selector);
        daily.advanceEpoch(address(nvda), 0, "");
    }

    /// KNOWN: a stock without a feed is only protected while `requireFeed` is on. With the guard opted out
    /// (or the feed cleared) the original attack works exactly as in the audit report. Keep `requireFeed`
    /// on in production and give every approved stock a feed (Deploy.s.sol enforces it).
    function test_KNOWN_unguardedStock_isStillExposed() public {
        vm.startPrank(owner);
        daily.setPriceFeed(address(nvda), address(0), 0);
        daily.setPriceGuard(300, false, address(0), 0);
        vm.stopPrank();
        _nextEpoch();
        uint256 snap = vm.snapshotState();
        _advance(keeper);
        uint256 fairOut = _totalAccrued();
        vm.revertToState(snap);
        bool buyNvda = address(usdg) == pool.token0();
        uint256 nvdaHeld = attacker.trade(pool, buyNvda, 600_000e6);
        vm.roll(block.number + 1);
        _advance(keeper);
        uint256 manipulatedOut = _totalAccrued();
        vm.roll(block.number + 1);
        uint256 usdgBack = attacker.trade(pool, !buyNvda, nvdaHeld);
        assertGt(usdgBack, 600_000e6, "attacker nets a profit without the guard");
        assertLt(manipulatedOut * 100, fairOut * 70);
    }

    /// The attacker's real cost is arbitrage during the hold. If one arbitrageur restores the price between the
    /// push and the operator's transaction, the page fills at fair value and the attacker's unwind is a large
    /// loss. This is the economic argument for an UNPREDICTABLE execution time: it converts a risk-free
    /// front-run into a bet against every arbitrageur for the length of the hold. It is an argument about
    /// likelihood, not about the contract: the contract still accepts whatever price it finds.
    function test_arbitrageDuringTheHold_makesTheAttackALoss() public {
        _nextEpoch();
        uint256 snap = vm.snapshotState();
        _advance(keeper);
        uint256 fairOut = _totalAccrued();
        vm.revertToState(snap);

        bool buyNvda = address(usdg) == pool.token0();
        uint256 push = 600_000e6;
        uint256 nvdaHeld = attacker.trade(pool, buyNvda, push);

        // An arbitrageur sells NVDA (bought at the fair 500 elsewhere) back into the pool until it is ~fair.
        Trader arber = new Trader();
        nvda.mint(address(arber), 2_000e18);
        (uint256 r0, uint256 r1) = pool.reserves();
        (uint256 rUsdg, uint256 rNvda) = buyNvda ? (r0, r1) : (r1, r0);
        // restore reserves to the constant-product point where price == 500: rNvda' = sqrt(k / 500)
        uint256 k = rUsdg * rNvda;
        uint256 targetNvda = _sqrt(k / 500e6) * 1e9; // reserves are 1e6 / 1e18 scaled: sqrt(k/500e6) * 1e9
        uint256 sell = targetNvda > rNvda ? targetNvda - rNvda : 0;
        uint256 arbUsdg = arber.trade(pool, !buyNvda, sell);
        uint256 arbCost = (sell * 500e6) / 1e18;
        emit log_named_uint("arbitrageur profit USDG (1e6)", arbUsdg - arbCost);
        assertGt(arbUsdg, arbCost, "arber profits from the pushed price");

        vm.roll(block.number + 1);
        _advance(keeper);
        uint256 out = _totalAccrued();
        assertGt(out * 100, fairOut * 97, "page fills within ~3% of fair");

        vm.roll(block.number + 1);
        uint256 usdgBack = attacker.trade(pool, !buyNvda, nvdaHeld);
        emit log_named_uint("attacker loss USDG (1e6)", push - usdgBack);
        assertLt(usdgBack, push - 100_000e6, "attacker loses > 100k USDG on a 600k push");
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    /// The impact cap cannot detect pre-positioning of any size (it bounds the page's slippage relative to the
    /// current pool state, never that state's distance from a reference); the feed floor refuses all of them.
    function test_impactCapIsBlindButTheFloorIsNot() public {
        _nextEpoch();
        uint256 amountIn = (3 * PER_EPOCH * (10_000 - 75)) / 10_000;
        bool buyNvda = address(usdg) == pool.token0();
        uint256[3] memory pushes = [uint256(100_000e6), 500_000e6, 2_000_000e6];
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            attacker.trade(pool, buyNvda, pushes[i]);
            vm.roll(block.number + 1);
            (,, uint256 impact) = router.quoteWithImpact(address(usdg), address(nvda), amountIn);
            assertLe(impact, router.maxPriceImpactBps());
            vm.prank(keeper);
            vm.expectPartialRevert(IPlanVault.PriceDeviates.selector);
            daily.advanceEpoch(address(nvda), 0, "");
            vm.revertToState(snap);
        }
    }
}
