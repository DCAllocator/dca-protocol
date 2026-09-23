// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";
import {Plan} from "../../../src/vault/VaultTypes.sol";
import {IAggregatorRouter} from "../../../src/router/IAggregatorRouter.sol";
import {Vm} from "forge-std/Vm.sol";

/// @title AUDIT v0.4 — `closePlan` while an epoch page is pending (deferred unindex)
///
/// `prunePlan` reverts `EpochInProgress` because the swap-and-pop unindex would move the last plan of the list
/// into the closed plan's slot, across the page cursor: a plan behind the cursor could be filled twice, one
/// ahead of it never. `closePlan` must never block on that (a page that keeps reverting can hold the cursor open
/// for a whole epoch), so it pays out and PARKS the plan instead: `paused = true`, still indexed,
/// `PlanClosed(..., unindexed = false)`. This suite checks the cursor stays sound around such closes: every
/// surviving plan is filled exactly once, the parked plan never, and the index is consistent after the deferred
/// prunes.
contract Audit4_ClosePlan_MidEpoch is BaseTest {
    bytes32 internal constant PLAN_FILLED_SIG = keccak256("PlanFilled(uint256,uint32,uint256,uint256,uint256,bool)");

    uint256[] internal ids;

    function _fills(Vm.Log[] memory logs, uint256 id) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == PLAN_FILLED_SIG && uint256(logs[i].topics[1]) == id) n++;
        }
    }

    /// @dev Five funded NVDA plans: alice x3 (ids 1, 4, 5), bob (2), carol (3).
    function _fivePlans() internal {
        ids.push(_createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6));
        ids.push(_createUsdgPlan(daily, bob, address(nvda), 200e6, 1_000e6));
        ids.push(_createUsdgPlan(daily, carol, address(nvda), 200e6, 1_000e6));
        ids.push(_createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6));
        ids.push(_createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6));
    }

    /// @dev "closed => balances zero && (unindexed || paused)"
    function _assertClosedInvariant(uint256 id) internal view {
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0, "closed: no idle");
        assertEq(p.stockAccrued, 0, "closed: no stock");
        assertEq(p.boostShares, 0, "closed: no shares");
        assertTrue(!_isIndexed(daily, id) || p.paused, "closed: unindexed or parked");
    }

    function test_deferredCloses_pageCursorStaysSound() public {
        _fivePlans();
        _nextEpoch(daily);
        uint32 epoch = daily.currentEpochId();
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 2, ""); // plans 1, 2 filled; cursor at 2
        assertEq(daily.nextPlanIndex(address(nvda), epoch), 2);

        // close one plan BEHIND the cursor (already filled) and one AHEAD of it (not yet)
        vm.prank(alice);
        daily.closePlan(ids[0]);
        vm.prank(alice);
        daily.closePlan(ids[3]);
        _assertClosedInvariant(ids[0]);
        _assertClosedInvariant(ids[3]);
        assertEq(daily.stockPlanCount(address(nvda)), 5, "index length unchanged while the cursor is open");
        assertEq(daily.nextPlanIndex(address(nvda), epoch), 2, "cursor untouched");
        assertEq(daily.getPlan(ids[0]).lastEpochId, epoch, "the earlier fill stands");

        vm.recordLogs();
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 2, ""); // plans 3, 4: 4 is parked
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 2, "")); // plan 5
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_fills(logs, ids[0]), 0, "closed-behind-cursor: not filled again");
        assertEq(_fills(logs, ids[1]), 0, "bob was filled on page 1, not again");
        assertEq(_fills(logs, ids[2]), 1);
        assertEq(_fills(logs, ids[3]), 0, "closed-ahead-of-cursor: skipped");
        assertEq(_fills(logs, ids[4]), 1);
        assertEq(daily.getPlan(ids[3]).lastEpochId, 0);
        assertFalse(daily.isEpochPending(address(nvda)));

        // deferred prunes: two swap-and-pops on a closed list
        daily.prunePlan(ids[0]);
        daily.prunePlan(ids[3]);
        assertEq(daily.stockPlanCount(address(nvda)), 3);
        assertFalse(_isIndexed(daily, ids[0]));
        assertFalse(_isIndexed(daily, ids[3]));
        assertTrue(_isIndexed(daily, ids[1]));
        assertTrue(_isIndexed(daily, ids[2]));
        assertTrue(_isIndexed(daily, ids[4]));

        // next epoch: exactly the three survivors, once each, in one page
        _nextEpoch(daily);
        vm.recordLogs();
        assertTrue(_advance(daily, address(nvda)));
        logs = vm.getRecordedLogs();
        assertEq(_fills(logs, ids[1]), 1);
        assertEq(_fills(logs, ids[2]), 1);
        assertEq(_fills(logs, ids[4]), 1);
        assertEq(_fills(logs, ids[0]), 0);
        assertEq(_fills(logs, ids[3]), 0);
        assertEq(usdg.balanceOf(address(daily)), daily.totalUsdgIdle() + daily.usdgDust());
    }

    /// @dev A page that cannot be bought keeps the cursor open indefinitely; the plans on it can still exit.
    function test_stuckPage_closeStillExits_pruneAfterRecovery() public {
        _fivePlans();
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 2, "");
        router.removePair(address(usdg), address(nvda)); // the remaining pages revert NoRoute
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        daily.advanceEpoch(address(nvda), 2, "");
        assertTrue(daily.isEpochPending(address(nvda)));

        uint256 carolUsdg = usdg.balanceOf(carol);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanClosed(ids[2], carol, 1_000e6, 0, false);
        vm.prank(carol);
        daily.closePlan(ids[2]);
        assertEq(usdg.balanceOf(carol) - carolUsdg, 997.5e6, "out, even though the epoch is stuck");
        _assertClosedInvariant(ids[2]);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.EpochInProgress.selector, address(nvda)));
        daily.prunePlan(ids[2]);

        router.setRate(address(usdg), address(nvda), NVDA_PER_USDG_NUM, NVDA_PER_USDG_DEN);
        vm.recordLogs();
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 0, ""));
        assertEq(_fills(vm.getRecordedLogs(), ids[2]), 0, "parked plan skipped when the page finally runs");
        daily.prunePlan(ids[2]);
        assertFalse(_isIndexed(daily, ids[2]));
        assertEq(daily.stockPlanCount(address(nvda)), 4);
    }

    /// @dev The park relies on `paused`; an owner who unpauses a parked (empty) plan gets an empty, indexed plan
    ///      that `_collect` skips on `avail == 0` — it costs the page one storage read and buys nothing.
    function test_parkedPlan_unpausedByOwner_isEmptyAndSkipped() public {
        _fivePlans();
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 2, "");
        vm.prank(carol);
        daily.closePlan(ids[2]);
        vm.prank(carol);
        daily.setPlanPaused(ids[2], false);
        vm.recordLogs();
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 0, ""));
        assertEq(_fills(vm.getRecordedLogs(), ids[2]), 0, "nothing to spend: skipped");
        Plan memory p = daily.getPlan(ids[2]);
        assertEq(p.usdgIdle, 0);
        assertEq(p.lastEpochId, 0);
        daily.prunePlan(ids[2]);
    }

    /// @dev The immediate and the deferred close both satisfy the closed-plan invariant; a deposit reopens.
    function test_closedInvariant_holdsUntilReopened() public {
        _fivePlans();
        vm.prank(alice);
        daily.closePlan(ids[0]); // no epoch pending: immediate
        _assertClosedInvariant(ids[0]);
        assertFalse(_isIndexed(daily, ids[0]));
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, "");
        vm.prank(carol);
        daily.closePlan(ids[2]); // pending: deferred
        _assertClosedInvariant(ids[2]);
        assertTrue(_isIndexed(daily, ids[2]));
        // reopen the immediate one: re-indexed, funded, not paused
        vm.prank(alice);
        daily.depositUSDG(ids[0], 100e6);
        assertTrue(_isIndexed(daily, ids[0]));
        assertEq(daily.getPlan(ids[0]).usdgIdle, 100e6);
        assertFalse(daily.getPlan(ids[0]).paused);
    }
}
