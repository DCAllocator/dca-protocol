// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "./AuditBase.sol";
import {CPMMPool, Trader} from "./mocks/CPMMPool.sol";
import {Plan} from "../../src/vault/VaultTypes.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {EpochKeeper} from "../../src/keeper/EpochKeeper.sol";
import {Route} from "../../src/router/IAggregatorRouter.sol";

/// @title H-02 regression + known residual — epoch purchases vs. sandwiching
///
/// v0.1: `advanceEpoch` was permissionless and every price reference (quote, minOut, impact cap) was read in the
/// same transaction, so anyone could atomically push the pool, trigger the epoch and unwind.
/// Fixed part (M-03): triggering is now operator-only end to end (`keeperOnly` default + operator-gated
/// EpochKeeper), so the ATOMIC, unprivileged variant is closed.
/// KNOWN RESIDUAL (H-02, by decision left open): an operator's transaction can still be sandwiched at the block
/// level (builder / same-block front-run + back-run). The `test_KNOWN_RESIDUAL_*` test keeps that loss visible;
/// `test_mitigation_*` shows the operational mitigation available today (a tight `minOut` override).
contract AuditH02Sandwich is AuditBase {
    CPMMPool pool;
    Trader attacker;

    uint256 constant POOL_USDG = 1_000_000e6; // $1M
    uint256 constant POOL_NVDA = 2_000e18; // -> 500 USDG / NVDA

    function setUp() public override {
        super.setUp();
        pool = _cpmmPool(address(usdg), POOL_USDG, address(nvda), POOL_NVDA, 500);
        attacker = new Trader();
        usdg.mint(address(attacker), 5_000_000e6);
        for (uint256 i; i < 10; ++i) {
            address u = makeAddr(string(abi.encodePacked("user", i)));
            _fund(u);
            vm.prank(u);
            daily.createPlan(address(nvda), 1_000e6, address(0), 10_000e6, 0, 0, false);
        }
        _nextEpoch();
    }

    function _totalAccrued() internal view returns (uint256 s) {
        for (uint256 id = 1; id <= 10; ++id) {
            s += _plan(id).stockAccrued;
        }
    }

    function test_baseline_fairFill() public {
        assertTrue(_advance(keeper));
        assertApproxEqRel(_totalAccrued(), 19.65e18, 0.02e18, "fair fill ~19.6 NVDA");
    }

    /// The unprivileged atomic sandwich is closed: no path lets an arbitrary address trigger the epoch.
    function test_atomicSandwichByAnyoneIsClosed() public {
        bool usdgIs0 = address(usdg) < address(nvda);
        uint256 n = attacker.trade(pool, usdgIs0, 600_000e6);
        vm.startPrank(address(attacker));
        vm.expectRevert(IPlanVault.NotKeeper.selector);
        daily.advanceEpoch(address(nvda), 0, "");
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        epochKeeper.runDue();
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        epochKeeper.run(0, 0, "");
        uint256[] memory idx = new uint256[](1);
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        epochKeeper.performUpkeep(abi.encode(idx));
        vm.stopPrank();
        attacker.trade(pool, !usdgIs0, n); // unwind: attacker only paid pool fees
        assertEq(_totalAccrued(), 0, "epoch did not run");
    }

    /// KNOWN RESIDUAL (H-02, open): if the operator's transaction lands between an attacker's front-run and
    /// back-run in the same block, users still buy at the manipulated price. Kept red-flagged on purpose.
    function test_KNOWN_RESIDUAL_operatorTxCanStillBeSandwichedInBlock() public {
        bool usdgIs0 = address(usdg) < address(nvda);
        uint256 before = usdg.balanceOf(address(attacker));
        uint256 n = attacker.trade(pool, usdgIs0, 600_000e6); // front-run
        assertTrue(_advance(keeper)); // operator's epoch tx
        attacker.trade(pool, !usdgIs0, n); // back-run
        uint256 got = _totalAccrued();
        emit log_named_decimal_uint("users received NVDA (fair ~19.65)", got, 18);
        emit log_named_decimal_uint("attacker profit USDG", usdg.balanceOf(address(attacker)) - before, 6);
        assertLt(got, 8e18, "residual risk: block-level sandwich still extracts value");
    }

    /// Mitigation available today: the operator passes a `minOut` derived from an off-chain reference (Robinhood /
    /// TWAP) instead of the in-tx quote. Under manipulation the fill reverts instead of executing.
    function test_mitigation_referenceMinOutOverrideRevertsUnderManipulation() public {
        // Reference: fair fill for 9,925 net USDG is ~19.64 NVDA (an off-chain / TWAP number). The override must
        // also be >= the auto floor (quote * 0.995) so it can only ever be TIGHTER than auto, never looser.
        Route[] memory path = new Route[](1);
        path[0] = _route(address(usdg), address(nvda), 500, address(pool));
        bytes memory ovr = abi.encode(path, uint256(19.55e18));

        bool usdgIs0 = address(usdg) < address(nvda);
        uint256 n = attacker.trade(pool, usdgIs0, 600_000e6);
        vm.prank(keeper);
        vm.expectRevert(); // InsufficientOutput: page not consumed, users not charged
        daily.advanceEpoch(address(nvda), 0, ovr);
        attacker.trade(pool, !usdgIs0, n);
        assertEq(_totalAccrued(), 0);
        assertEq(daily.nextPlanIndex(address(nvda), 1), 0, "cursor untouched; operator retries later");

        // without manipulation the same override fills
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 0, ovr));
        assertGt(_totalAccrued(), 19.55e18);
    }
}
