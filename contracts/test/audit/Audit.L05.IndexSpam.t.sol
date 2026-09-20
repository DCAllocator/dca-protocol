// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "./AuditBase.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";

/// @title L-05 regression — indexing a plan costs real capital
///
/// v0.1: `createPlan` with zero deposit was indexed and cost the keeper ~9.3k gas per plan per epoch; a pruned
/// plan could be re-indexed for 1 unit of USDG. Fix: creation and every deposit must credit >= `minDeposit`
/// (10 USDG), so the only way to sit in the index is to have (or have had) at least 10 USDG in the plan.
contract AuditL05IndexSpam is AuditBase {
    function setUp() public override {
        super.setUp();
        _usdgNvdaPool();
    }

    function test_freePlansCannotEnterTheIndex() public {
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 0, 10e6));
        daily.createPlan(address(nvda), 10e6, address(0), 0, 0, 0);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 9.999999e6, 10e6));
        daily.createPlan(address(nvda), 10e6, address(0), 9.999999e6, 0, 0);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
    }

    function test_reindexNeedsMinimumDeposit_andCostsWithdrawFee() public {
        vm.prank(mallory);
        uint256 id = daily.createPlan(address(nvda), 10e6, address(0), 10e6, 0, 0);
        vm.prank(mallory);
        daily.withdrawIdle(id, type(uint256).max); // 25 bps fee per cycle
        daily.prunePlan(id);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 1, 10e6));
        daily.depositUSDG(id, 1);
        vm.prank(mallory);
        daily.depositUSDG(id, 10e6);
        assertEq(daily.stockPlanCount(address(nvda)), 1);
        assertEq(usdg.balanceOf(treasury), 0.025e6, "each spam cycle pays the withdraw fee");
    }

    /// Informational: the marginal keeper cost of an emptied (withdrawn-to-zero, un-pruned) plan on a page.
    function test_measure_keeperGasPerEmptiedPlan() public {
        uint256 snap = vm.snapshotState();
        uint256 g0 = _gasFor(0);
        vm.revertToState(snap);
        uint256 g149 = _gasFor(149);
        emit log_named_uint("marginal gas per emptied plan (cold)", (g149 - g0) / 149);
        assertLt((g149 - g0) / 149, 12_000);
    }

    function _gasFor(uint256 emptied) internal returns (uint256 gasUsed) {
        vm.prank(alice);
        daily.createPlan(address(nvda), 100e6, address(0), 1_000e6, 0, 0);
        for (uint256 i; i < emptied; ++i) {
            vm.prank(mallory);
            uint256 id = daily.createPlan(address(nvda), 10e6, address(0), 10e6, 0, 0);
            vm.prank(mallory);
            daily.withdrawIdle(id, type(uint256).max);
        }
        _nextEpoch();
        vm.cool(address(daily));
        vm.prank(keeper);
        uint256 g = gasleft();
        daily.advanceEpoch(address(nvda), 0, "");
        gasUsed = g - gasleft();
    }
}
