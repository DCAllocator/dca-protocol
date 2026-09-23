// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {PlanVault} from "../../src/vault/PlanVault.sol";
import {Plan} from "../../src/vault/VaultTypes.sol";
import {Vm} from "forge-std/Vm.sol";

/// @dev `closePlan`: the one-transaction version of the remove sequence (unboost -> withdrawIdle(MAX) ->
///      claim(MAX) -> prunePlan) that PlanVault.Plans / PlanVault.Boost pin as `test_removeSequence_*`. Every
///      case here has a sequence counterpart; the payout destinations and fees must be identical.
contract PlanVaultCloseTest is BaseTest {
    uint256 internal constant MAX = type(uint256).max;

    bytes32 internal constant PLAN_INDEXED_SIG = keccak256("PlanIndexed(uint256,address,bool)");
    bytes32 internal constant PLAN_BOOST_SET_SIG = keccak256("PlanBoostSet(uint256,bool)");
    bytes32 internal constant PLAN_PAUSED_SET_SIG = keccak256("PlanPausedSet(uint256,bool)");
    bytes32 internal constant PLAN_FILLED_SIG = keccak256("PlanFilled(uint256,uint32,uint256,uint256,uint256,bool)");

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /// @dev Plain plan with 800 USDG idle and one fill's worth of NVDA accrued.
    function _filledPlan(address user) internal returns (uint256 id) {
        id = _createUsdgPlan(daily, user, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
    }

    /// @dev Vault-level accounting after a close: USDG tight, boost pool consistent, aggregates match plans.
    function _checkAccounting(PlanVault v) internal view {
        assertEq(usdg.balanceOf(address(v)), v.totalUsdgIdle() + v.usdgDust(), "usdg tight");
        assertEq(
            nvda.balanceOf(address(v)), v.totalStockAccrued(address(nvda)) + v.dustPot(address(nvda)), "nvda tight"
        );
        uint256 n = v.nextPlanId();
        uint256 shares;
        uint256 idle;
        uint256 accrued;
        for (uint256 id = 1; id < n; ++id) {
            Plan memory p = v.getPlan(id);
            shares += p.boostShares;
            idle += p.usdgIdle;
            if (p.stock == address(nvda)) accrued += p.stockAccrued;
            if (!p.boosted) assertEq(p.boostShares, 0, "unboosted plans hold no shares");
        }
        assertEq(shares, v.totalBoostShares(), "sum(shares) == totalBoostShares");
        assertEq(idle, v.totalUsdgIdle(), "sum(idle) == totalUsdgIdle");
        assertEq(accrued, v.totalStockAccrued(address(nvda)), "sum(accrued) == totalStockAccrued");
    }

    function _countTopic(Vm.Log[] memory logs, bytes32 sig) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) n++;
        }
    }

    /// @dev Number of `PlanFilled` logs whose planId topic is `id`.
    function _fills(Vm.Log[] memory logs, uint256 id) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == PLAN_FILLED_SIG && uint256(logs[i].topics[1]) == id) n++;
        }
    }

    function _assertClosedEmpty(uint256 id) internal view {
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0, "no idle left");
        assertEq(p.stockAccrued, 0, "no stock left");
        assertEq(p.boostShares, 0, "no shares left");
        assertEq(p.boostPrincipal, 0);
        assertFalse(p.boosted, "closed plans are plain plans");
    }

    // ------------------------------------------------------------------
    // Slot pin for the `_isIndexed` probe used by this and the invariant suites
    // ------------------------------------------------------------------

    function test_isIndexedProbe_matchesPlanIndexedEvents() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        assertTrue(_isIndexed(daily, id), "STOCK_PLAN_INDEX_SLOT: fresh plan must read as indexed");
        vm.prank(alice);
        daily.withdrawIdle(id, MAX);
        vm.expectEmit(true, true, true, true);
        emit IPlanVault.PlanIndexed(id, address(nvda), false);
        daily.prunePlan(id);
        assertFalse(_isIndexed(daily, id), "STOCK_PLAN_INDEX_SLOT: pruned plan must read as unindexed");
        assertFalse(_isIndexed(daily, 99), "unknown plan is not indexed");
    }

    // ------------------------------------------------------------------
    // AC9: plain plan, idle + accrued
    // ------------------------------------------------------------------

    function test_closePlan_plain_paysBothLegsAndUnindexes() public {
        uint256 id = _filledPlan(alice);
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 800e6);
        uint256 stock = p.stockAccrued;
        assertEq(stock, _nvdaFor(198.5e6));
        uint256 claimFee = (stock * 25) / 10_000;
        uint256 aliceUsdg = usdg.balanceOf(alice);
        uint256 treasuryUsdg = usdg.balanceOf(treasury);

        vm.expectEmit(true, false, false, true);
        emit IPlanVault.IdleWithdrawn(id, 800e6, 2e6);
        vm.expectEmit(true, true, true, true);
        emit IPlanVault.Claimed(id, address(nvda), alice, stock, claimFee);
        vm.expectEmit(true, true, true, true);
        emit IPlanVault.PlanIndexed(id, address(nvda), false);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanClosed(id, alice, 800e6, stock, true);
        vm.prank(alice);
        daily.closePlan(id);

        assertEq(usdg.balanceOf(alice) - aliceUsdg, 798e6, "idle minus the 25 bps withdraw fee, to the caller");
        assertEq(usdg.balanceOf(treasury) - treasuryUsdg, 2e6, "withdraw fee");
        assertEq(nvda.balanceOf(alice), stock - claimFee, "stock minus the 25 bps claim fee, to the recipient");
        assertEq(nvda.balanceOf(treasury), claimFee, "claim fee");
        _assertClosedEmpty(id);
        assertEq(daily.getPlan(id).owner, alice, "the record persists");
        assertFalse(daily.getPlan(id).paused, "immediate unindex does not pause");
        assertEq(daily.stockPlanCount(address(nvda)), 0, "count -1");
        assertFalse(_isIndexed(daily, id));
        assertEq(daily.totalUsdgIdle(), 0);
        assertEq(daily.totalStockAccrued(address(nvda)), 0);
        assertEq(daily.userStockAccrued(alice, address(nvda)), 0);
        _checkAccounting(daily);
    }

    function test_closePlan_customRecipient_stockToRecipientUsdgToCaller() public {
        vm.prank(alice);
        uint256 id = daily.createPlan(address(nvda), 200e6, bob, 1_000e6, 0, 0, false);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 stock = daily.getPlan(id).stockAccrued;
        uint256 aliceUsdg = usdg.balanceOf(alice);

        vm.prank(alice);
        daily.closePlan(id);
        assertEq(usdg.balanceOf(alice) - aliceUsdg, 798e6, "USDG follows the caller");
        assertEq(nvda.balanceOf(bob), stock - (stock * 25) / 10_000, "stock follows the plan's recipient");
        assertEq(nvda.balanceOf(alice), 0);
    }

    // ------------------------------------------------------------------
    // AC10: boosted plans
    // ------------------------------------------------------------------

    function test_closePlan_boosted_unboostsAndPaysYield() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 10_000e6);
        vm.warp(block.timestamp + 30 days);
        _nextEpoch(daily);
        _advance(daily, address(nvda)); // one spend out of the pool
        Plan memory p = daily.getPlan(id);
        uint256 value = _boostValue(daily, id);
        assertGt(value, 10_000e6 - 200e6, "yield accrued on the lent balance");
        uint256 expectedOut = uint256(p.usdgIdle) + value;
        uint256 stock = p.stockAccrued;
        uint256 aliceUsdg = usdg.balanceOf(alice);
        uint256 treasuryUsdg = usdg.balanceOf(treasury);

        vm.expectEmit(true, false, false, true);
        emit IPlanVault.PlanBoostSet(id, false);
        vm.prank(alice);
        daily.closePlan(id);

        uint256 gross = usdg.balanceOf(alice) - aliceUsdg + (usdg.balanceOf(treasury) - treasuryUsdg);
        assertApproxEqAbs(gross, expectedOut, 2, "idle + boosted value left the vault (+-2 wei rounding)");
        assertApproxEqAbs(usdg.balanceOf(treasury) - treasuryUsdg, (expectedOut * 25) / 10_000, 1, "25 bps fee");
        assertEq(nvda.balanceOf(alice), stock - (stock * 25) / 10_000);
        _assertClosedEmpty(id);
        assertGt(daily.getPlan(id).boostEarned, 0, "realised yield booked on the way out");
        assertEq(daily.totalBoostShares(), 0);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
        assertEq(daily.totalUsdgIdle(), 0);
        _checkAccounting(daily);
    }

    /// @dev Same construction as PlanVault.Boost `test_removeSequence_boostedDustShares`: shares worth nothing
    ///      survive a withdraw-all and block a prune; the close burns them on the way (unboost first).
    function test_closePlan_boostedDustShares_burnedAndPruned() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        router.setFill(address(usdg), address(nvda), 9_000);
        _nextEpoch(daily);
        uint96 nearlyAll = uint96(_boostValue(daily, id) - 2);
        vm.prank(alice);
        daily.setPlanAmount(id, nearlyAll);
        _advance(daily, address(nvda));
        Plan memory p = daily.getPlan(id);
        assertGt(p.boostShares, 0);
        morpho.mockLoss(marketId, (morpho.market(marketId).totalBorrowAssets * 99) / 100);
        assertEq(_boostValue(daily, id), 0, "dust shares worth nothing");
        uint256 idle = p.usdgIdle;
        uint256 aliceUsdg = usdg.balanceOf(alice);

        vm.prank(alice);
        daily.closePlan(id);
        assertEq(usdg.balanceOf(alice) - aliceUsdg, idle - (idle * 25) / 10_000, "idle paid; the dust added 0");
        _assertClosedEmpty(id);
        assertEq(daily.totalBoostShares(), 0, "dust shares burned");
        assertEq(daily.stockPlanCount(address(nvda)), 0, "and the plan was pruned in the same call");
        _checkAccounting(daily);
    }

    function test_closePlan_boostedFlagWithoutShares_clearsTheFlag() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        daily.withdrawIdle(id, MAX); // drains the pool but leaves `boosted = true`
        assertTrue(daily.getPlan(id).boosted);
        assertEq(daily.getPlan(id).boostShares, 0);

        vm.expectEmit(true, false, false, true);
        emit IPlanVault.PlanBoostSet(id, false);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanClosed(id, alice, 0, 0, true);
        vm.prank(alice);
        daily.closePlan(id);
        assertFalse(daily.getPlan(id).boosted, "a closed plan is a plain plan (a re-deposit is not lent)");
        assertEq(daily.stockPlanCount(address(nvda)), 0);
    }

    // ------------------------------------------------------------------
    // AC11: access; prune semantics unchanged
    // ------------------------------------------------------------------

    function test_closePlan_access() public {
        uint256 id = _filledPlan(alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.NotPlanOwner.selector, id));
        daily.closePlan(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.NotPlanOwner.selector, 99));
        daily.closePlan(99);

        // prune is untouched: permissionless, empty plans only, refused while a page is open
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PlanNotEmpty.selector, id));
        daily.prunePlan(id);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PlanNotFound.selector, 99));
        daily.prunePlan(99);
        assertEq(daily.stockPlanCount(address(nvda)), 1);

        vm.prank(alice);
        daily.closePlan(id);
        daily.prunePlan(id); // idempotent no-op on the closed plan
        assertEq(daily.stockPlanCount(address(nvda)), 0);
    }

    // ------------------------------------------------------------------
    // AC12: empty, already pruned, never boosted
    // ------------------------------------------------------------------

    function test_closePlan_emptyPlan_noZeroAmount() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        daily.withdrawIdle(id, MAX);
        vm.recordLogs();
        vm.expectEmit(true, true, true, true);
        emit IPlanVault.PlanIndexed(id, address(nvda), false);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanClosed(id, alice, 0, 0, true);
        vm.prank(alice);
        daily.closePlan(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countTopic(logs, PLAN_BOOST_SET_SIG), 0, "never-boosted: no PlanBoostSet");
        assertEq(daily.stockPlanCount(address(nvda)), 0);
    }

    function test_closePlan_alreadyPruned_idempotent() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        daily.withdrawIdle(id, MAX);
        daily.prunePlan(id);
        assertFalse(_isIndexed(daily, id));

        vm.recordLogs();
        vm.prank(alice);
        daily.closePlan(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countTopic(logs, PLAN_INDEXED_SIG), 0, "nothing to unindex: no PlanIndexed");
        assertEq(_countTopic(logs, keccak256("PlanClosed(uint256,address,uint256,uint256,bool)")), 1);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
        // and again
        vm.prank(alice);
        daily.closePlan(id);
    }

    // ------------------------------------------------------------------
    // AC13: paused vault, delisted stock
    // ------------------------------------------------------------------

    function test_closePlan_whilePausedAndDelisted() public {
        uint256 id = _filledPlan(alice);
        vm.startPrank(owner);
        daily.pause();
        registry.setApproved(address(nvda), false);
        vm.stopPrank();
        uint256 aliceUsdg = usdg.balanceOf(alice);
        vm.prank(alice);
        daily.closePlan(id);
        assertEq(usdg.balanceOf(alice) - aliceUsdg, 798e6);
        assertGt(nvda.balanceOf(alice), 0);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
    }

    function test_closePlan_boosted_whilePaused() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(owner);
        daily.pause();
        vm.prank(alice);
        daily.closePlan(id); // the unboost leg never needs an unpaused vault
        _assertClosedEmpty(id);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
        _checkAccounting(daily);
    }

    // ------------------------------------------------------------------
    // AC14: mid-epoch — deferred unindex
    // ------------------------------------------------------------------

    function test_closePlan_midEpoch_defersUnindex() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 200e6, 1_000e6);
        uint256 c = _createUsdgPlan(daily, carol, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        uint32 epoch = daily.currentEpochId();
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, ""); // page 1 of 3
        assertTrue(daily.isEpochPending(address(nvda)));

        uint256 carolUsdg = usdg.balanceOf(carol);
        vm.recordLogs();
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.PlanPausedSet(c, true);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanClosed(c, carol, 1_000e6, 0, false);
        vm.prank(carol);
        daily.closePlan(c);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countTopic(logs, PLAN_INDEXED_SIG), 0, "not unindexed while the cursor is open");

        assertEq(usdg.balanceOf(carol) - carolUsdg, 997.5e6, "funds are out regardless");
        Plan memory p = daily.getPlan(c);
        assertEq(p.usdgIdle, 0);
        assertTrue(p.paused, "parked: paused");
        assertTrue(_isIndexed(daily, c), "and still indexed");
        assertEq(daily.stockPlanCount(address(nvda)), 3);

        // the remaining pages fill bob and skip the closed plan
        vm.recordLogs();
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 0, ""));
        logs = vm.getRecordedLogs();
        assertEq(_fills(logs, c), 0, "no PlanFilled for the closed plan");
        assertEq(_fills(logs, b), 1);
        assertEq(daily.getPlan(c).lastEpochId, 0);
        assertEq(daily.getPlan(b).lastEpochId, epoch);
        assertFalse(daily.isEpochPending(address(nvda)));

        // anyone finishes the job once the epoch is over
        vm.expectEmit(true, true, true, true);
        emit IPlanVault.PlanIndexed(c, address(nvda), false);
        daily.prunePlan(c);
        assertEq(daily.stockPlanCount(address(nvda)), 2);
        assertFalse(_isIndexed(daily, c));
        _checkAccounting(daily);
    }

    function test_closePlan_midEpoch_secondCloseFinishes() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 c = _createUsdgPlan(daily, carol, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, "");
        vm.prank(carol);
        daily.closePlan(c); // deferred
        assertTrue(_isIndexed(daily, c));
        vm.prank(carol);
        daily.closePlan(c); // still pending: stays parked, no revert, no double payout
        assertTrue(_isIndexed(daily, c));
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 0, "");

        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanClosed(c, carol, 0, 0, true);
        vm.prank(carol);
        daily.closePlan(c); // epoch over: the owner can finish it too
        assertFalse(_isIndexed(daily, c));
        assertEq(daily.stockPlanCount(address(nvda)), 1);
    }

    /// @dev Filled on page 1, closed before the epoch completes: the fill's debit and the close's credit land
    ///      in the same epoch; the close claims the stock that was just bought.
    function test_closePlan_midEpoch_filledThisEpoch_claimsTheFill() public {
        uint256 a = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _createUsdgPlan(daily, bob, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, ""); // alice filled
        uint256 stock = daily.getPlan(a).stockAccrued;
        assertEq(stock, _nvdaFor(198.5e6));

        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanClosed(a, alice, 800e6, stock, false);
        vm.prank(alice);
        daily.closePlan(a);
        assertEq(nvda.balanceOf(alice), stock - (stock * 25) / 10_000, "this epoch's stock is claimed");
        assertTrue(daily.getPlan(a).paused);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 0, "");
        daily.prunePlan(a);
        assertEq(daily.stockPlanCount(address(nvda)), 1);
        _checkAccounting(daily);
    }

    /// @dev Review CP-01: the deferral exists only to keep the swap-and-pop away from an open page cursor, so a
    ///      plan that is ALREADY out of the iteration list (closed earlier with an immediate unindex, or pruned
    ///      by anyone) must not be parked when its owner closes it again while a page is pending: no
    ///      `PlanPausedSet`, no sticky `paused` that would survive a re-deposit, and `PlanClosed(..., true)` so
    ///      the frontend never shows "Delete later" for a plan that has nothing left to do.
    function test_closePlan_alreadyUnindexed_whilePending_doesNotParkAndReportsUnindexed() public {
        uint256 a = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 200e6, 1_000e6);
        _createUsdgPlan(daily, carol, address(nvda), 200e6, 1_000e6);
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        // a: closed with an immediate unindex; b: drained by its owner and pruned by a third party
        vm.prank(alice);
        daily.closePlan(a);
        vm.prank(bob);
        daily.withdrawIdle(b, MAX);
        daily.prunePlan(b);
        assertFalse(_isIndexed(daily, a));
        assertFalse(_isIndexed(daily, b));
        assertEq(daily.stockPlanCount(address(nvda)), 2);

        // page 1 of 2 for the two live plans: the cursor is open
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, "");
        assertTrue(daily.isEpochPending(address(nvda)));

        vm.recordLogs();
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanClosed(a, alice, 0, 0, true);
        vm.prank(alice);
        daily.closePlan(a);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanClosed(b, bob, 0, 0, true);
        vm.prank(bob);
        daily.closePlan(b);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countTopic(logs, PLAN_PAUSED_SET_SIG), 0, "nothing to protect: not parked");
        assertEq(_countTopic(logs, PLAN_INDEXED_SIG), 0, "nothing to unindex: no PlanIndexed");
        assertFalse(daily.getPlan(a).paused, "a: not paused");
        assertFalse(daily.getPlan(b).paused, "b: not paused");
        assertFalse(_isIndexed(daily, a));
        assertFalse(_isIndexed(daily, b));
        assertEq(daily.stockPlanCount(address(nvda)), 2, "the live list is untouched");

        // the epoch finishes normally; a re-deposit reopens a as a live, buying plan (no stale pause)
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 0, ""));
        vm.expectEmit(true, true, true, true);
        emit IPlanVault.PlanIndexed(a, address(nvda), true);
        vm.prank(alice);
        daily.depositUSDG(a, 100e6);
        assertFalse(daily.getPlan(a).paused, "reopened plan is not paused");
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertGt(daily.getPlan(a).stockAccrued, 0, "and buys in the next epoch");
        _checkAccounting(daily);
    }

    /// @dev The other side of CP-01: a plan that IS still indexed while the cursor is open is parked even when the
    ///      owner had already paused it by hand (no duplicate `PlanPausedSet`, `unindexed = false`), and is
    ///      dropped by the next close once the epoch is over.
    function test_closePlan_indexedAndAlreadyPaused_whilePending_staysParked() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 c = _createUsdgPlan(daily, carol, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, "");
        vm.prank(carol);
        daily.setPlanPaused(c, true);

        vm.recordLogs();
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanClosed(c, carol, 1_000e6, 0, false);
        vm.prank(carol);
        daily.closePlan(c);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countTopic(logs, PLAN_PAUSED_SET_SIG), 0, "already paused: no duplicate PlanPausedSet");
        assertTrue(_isIndexed(daily, c), "still indexed while the cursor is open");
        assertTrue(daily.getPlan(c).paused);

        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 0, "");
        vm.expectEmit(true, true, true, true);
        emit IPlanVault.PlanIndexed(c, address(nvda), false);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanClosed(c, carol, 0, 0, true);
        vm.prank(carol);
        daily.closePlan(c);
        assertFalse(_isIndexed(daily, c));
    }

    // ------------------------------------------------------------------
    // Perk holder
    // ------------------------------------------------------------------

    function test_closePlan_perkHolder_noClaimFee() public {
        uint256 id = _filledPlan(alice);
        _giveDca(alice, 100_000); // after the fill, so the stock accrued instead of auto-distributing
        uint256 stock = daily.getPlan(id).stockAccrued;
        vm.expectEmit(true, true, true, true);
        emit IPlanVault.Claimed(id, address(nvda), alice, stock, 0);
        vm.prank(alice);
        daily.closePlan(id);
        assertEq(nvda.balanceOf(alice), stock, "whole stock: the claim fee is 0 for the perk");
        assertEq(nvda.balanceOf(treasury), 0);
        assertEq(usdg.balanceOf(treasury), 1.5e6 + 2e6, "purchase fee + withdraw fee (no perk on withdrawals)");
    }

    // ------------------------------------------------------------------
    // AC15: illiquid Morpho — revert wholesale, recover
    // ------------------------------------------------------------------

    function test_closePlan_illiquidMorpho_revertsAtomicallyThenRecovers() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        router.setFill(address(usdg), address(nvda), 9_000);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        Plan memory before = daily.getPlan(id);
        assertGt(before.usdgIdle, 0);
        assertGt(before.boostShares, 0);
        assertGt(before.stockAccrued, 0);
        morpho.mockBorrow(marketId, strategy.liquidity(), borrower);

        uint256 aliceUsdg = usdg.balanceOf(alice);
        uint256 aliceNvda = nvda.balanceOf(alice);
        uint256 totalIdle = daily.totalUsdgIdle();
        vm.prank(alice);
        vm.expectRevert(); // ERC4626ExceededMaxWithdraw from the strategy, in the unboost leg
        daily.closePlan(id);

        Plan memory later = daily.getPlan(id);
        assertEq(later.usdgIdle, before.usdgIdle, "nothing moved: idle");
        assertEq(later.stockAccrued, before.stockAccrued, "nothing moved: stock");
        assertEq(later.boostShares, before.boostShares, "nothing moved: shares");
        assertTrue(later.boosted);
        assertFalse(later.paused);
        assertEq(usdg.balanceOf(alice), aliceUsdg);
        assertEq(nvda.balanceOf(alice), aliceNvda);
        assertEq(daily.totalUsdgIdle(), totalIdle);
        assertEq(daily.stockPlanCount(address(nvda)), 1);

        // the single legs remain the fallback: the idle part and the stock are reachable now
        vm.startPrank(alice);
        daily.withdrawIdle(id, before.usdgIdle);
        daily.claim(id, MAX);
        vm.stopPrank();

        usdg.mint(borrower, 1_000_000e6);
        vm.startPrank(borrower);
        usdg.approve(address(morpho), type(uint256).max);
        morpho.mockRepay(marketId, 1_000_000e6);
        vm.stopPrank();
        vm.prank(alice);
        daily.closePlan(id);
        _assertClosedEmpty(id);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
        _checkAccounting(daily);
    }

    // ------------------------------------------------------------------
    // Re-index on deposit (no permanent closed bit)
    // ------------------------------------------------------------------

    function test_closePlan_thenDeposit_reindexesAsPlainPlan() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        daily.closePlan(id);
        assertFalse(_isIndexed(daily, id));
        vm.expectEmit(true, true, true, true);
        emit IPlanVault.PlanIndexed(id, address(nvda), true);
        vm.prank(alice);
        daily.depositUSDG(id, 100e6);
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 100e6, "held idle: the close cleared the boost flag");
        assertEq(p.boostShares, 0);
        assertFalse(p.paused);
        assertEq(daily.stockPlanCount(address(nvda)), 1);
    }

    /// @dev The deferred unindex parks the plan as `paused`; a later deposit keeps that flag (the owner unpauses
    ///      to resume buying). Pinned so the frontend copy can say so.
    function test_closePlan_deferred_thenDeposit_staysPausedUntilUnpaused() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 c = _createUsdgPlan(daily, carol, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, "");
        vm.prank(carol);
        daily.closePlan(c);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 0, "");

        vm.prank(carol);
        daily.depositUSDG(c, 100e6); // already indexed: no PlanIndexed(true)
        Plan memory p = daily.getPlan(c);
        assertEq(p.usdgIdle, 100e6);
        assertTrue(p.paused, "still parked");
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(c).stockAccrued, 0, "a paused plan buys nothing");
        vm.prank(carol);
        daily.setPlanPaused(c, false);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertGt(daily.getPlan(c).stockAccrued, 0, "buying again once unpaused");
    }

    // ------------------------------------------------------------------
    // Aggregates with other plans around
    // ------------------------------------------------------------------

    function test_closePlan_leavesOtherPlansAndAggregatesIntact() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 200e6, 5_000e6);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 100e6, 2_000e6);
        uint256 c = _createBoostedPlan(daily, carol, address(aapl), 300e6, 3_000e6);
        vm.warp(block.timestamp + 10 days);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        _advance(daily, address(aapl));
        uint256 vc = _boostValue(daily, c);

        vm.prank(alice);
        daily.closePlan(a);
        assertEq(daily.totalUsdgIdle(), daily.getPlan(b).usdgIdle, "only bob's idle is left on the vault");
        assertEq(daily.totalBoostShares(), daily.getPlan(c).boostShares, "only carol's shares are left");
        assertApproxEqAbs(_boostValue(daily, c), vc, 1, "carol's value untouched by alice's unboost");
        assertEq(daily.stockPlanCount(address(nvda)), 1);
        assertEq(daily.stockPlanCount(address(aapl)), 1);
        assertTrue(_isIndexed(daily, b));
        assertTrue(_isIndexed(daily, c));
        assertEq(daily.totalStockAccrued(address(nvda)), daily.getPlan(b).stockAccrued);
        _checkAccounting(daily);
        // the surviving index still fills exactly the survivors
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(b).lastEpochId, daily.currentEpochId());
        assertEq(daily.getPlan(a).lastEpochId, daily.currentEpochId() - 1, "closed plan not touched again");
    }

    // ------------------------------------------------------------------
    // Fuzz: closing never creates value (mirrors PlanVault.Boost testFuzz_boostNeverCreatesValue)
    // ------------------------------------------------------------------

    function testFuzz_closeNeverCreatesValue(uint96 perEpoch, uint128 dep, uint32 dt, bool boost) public {
        perEpoch = uint96(bound(perEpoch, 10e6, 5_000e6));
        uint256 d = bound(dep, 10e6, 200_000e6);
        dt = uint32(bound(dt, 0, 400 days));
        uint256 id = boost
            ? _createBoostedPlan(daily, alice, address(nvda), perEpoch, d)
            : _createUsdgPlan(daily, alice, address(nvda), perEpoch, d);
        vm.warp(block.timestamp + dt);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 spent = daily.totalNotionalUsdg() > 0 ? (uint256(perEpoch) < d ? perEpoch : d) : 0;

        uint256 aliceUsdg = usdg.balanceOf(alice);
        uint256 treasuryUsdg = usdg.balanceOf(treasury);
        vm.prank(alice);
        daily.closePlan(id);
        // gross USDG the close moved out of the vault = what alice got + the withdraw fee
        uint256 gross = (usdg.balanceOf(alice) - aliceUsdg) + (usdg.balanceOf(treasury) - treasuryUsdg);
        uint256 got = spent + gross;
        uint256 maxYield = boost ? (d * 55 * (uint256(dt) + 1 days)) / (1000 * 365 days) + 3 : 0;
        assertLe(got, d + maxYield, "no value out of thin air");
        assertGe(got + 3, d, "nothing lost either (beyond rounding)");

        _assertClosedEmpty(id);
        assertEq(daily.totalBoostShares(), 0);
        assertEq(daily.totalUsdgIdle(), 0);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
        assertFalse(_isIndexed(daily, id));
        _checkAccounting(daily);
    }
}
