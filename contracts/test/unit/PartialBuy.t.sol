// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {BaseTest} from "../BaseTest.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {Plan} from "../../src/vault/VaultTypes.sol";
import {ClaimHelper} from "../../src/periphery/ClaimHelper.sol";

/// @dev Partial buys, pinned. A plan holding less than its `amountPerEpoch` is NOT skipped: `_collect` spends
///      min(usdgIdle + boosted value, amountPerEpoch), so the next buy takes everything the plan has and the plan
///      then sits empty — never filled, never charged — until it is topped up. Kept by owner decision after user
///      testing. The create-flow warning ("Your first buy will spend all …"), `ClaimHelper.previewFill` and the docs
///      describe exactly this; moving to skip semantics must change them together with these tests.
///
///      The per-buy minimum (`minAmountPerEpoch`) bounds the amount a plan is SET to, not what a buy spends: a
///      withdrawal or a partial-fill residual can leave any balance behind, and that balance is bought as is.
contract PartialBuyTest is BaseTest {
    ClaimHelper internal helper;

    function setUp() public override {
        super.setUp();
        helper = new ClaimHelper();
    }

    // ------------------------------------------------------------------
    // Less than one buy
    // ------------------------------------------------------------------

    function test_underfunded_spendsEverything_thenIsNotFilled() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 100e6, 50e6);
        (uint256 preview,,,) = helper.previewFill(IPlanVault(address(daily)), id);
        assertEq(preview, 50e6, "helper: the next buy is the whole balance");
        _nextEpoch(daily);

        // 50 of the 100 asked: 0.75% fee = 0.375, net 49.625
        vm.expectEmit(true, true, false, true, address(daily));
        emit IPlanVault.PlanFilled(id, 1, 50e6, 0.375e6, _nvdaFor(49.625e6), false);
        assertTrue(_advance(daily, address(nvda)));
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0, "spent everything it had");
        assertEq(p.stockAccrued, _nvdaFor(49.625e6));
        assertEq(p.lastEpochId, 1);
        assertEq(daily.totalUsdgIdle(), 0);
        assertEq(usdg.balanceOf(treasury), 0.375e6, "fee on what was spent, not on the per-buy amount");

        // epoch 2: still indexed, nothing to spend — no fill, no swap, the epoch completes anyway
        (preview,,,) = helper.previewFill(IPlanVault(address(daily)), id);
        assertEq(preview, 0);
        _nextEpoch(daily);
        vm.recordLogs();
        assertTrue(_advance(daily, address(nvda)));
        (uint256 n,) = _fillsOf(id);
        assertEq(n, 0, "an empty plan is not filled");
        assertEq(router.swapCount(), 1, "a page with nothing to buy does not swap");
        assertEq(daily.getPlan(id).lastEpochId, 1);
        assertEq(daily.lastExecutedEpoch(address(nvda)), 2);
        assertTrue(_isIndexed(daily, id), "nobody pruned it: it stays in the page until someone does");
    }

    function test_underfunded_boosted_spendsBoostedBalance_thenIsNotFilled() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 100e6, 50e6);
        vm.warp(block.timestamp + 30 days); // some yield on top, still less than one buy
        _nextEpoch(daily);
        uint256 value = _boostValue(daily, id);
        assertGt(value, 50e6);
        assertLt(value, 100e6);
        uint256 fee = (value * 75) / 10_000;

        vm.expectEmit(true, true, false, true, address(daily));
        emit IPlanVault.PlanFilled(id, daily.currentEpochId(), value, fee, _nvdaFor(value - fee), false);
        _advance(daily, address(nvda));
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0);
        assertEq(p.boostShares, 0, "the whole boosted balance was spent: every share burned");
        assertEq(p.boostPrincipal, 0);
        assertEq(p.boostEarned, value - 50e6, "the yield was spent too");
        assertTrue(p.boosted, "still flagged boosted: the next deposit is lent again");
        assertEq(daily.totalBoostShares(), 0);
        assertEq(_boostValue(daily, id), 0);

        _nextEpoch(daily);
        vm.recordLogs();
        _advance(daily, address(nvda));
        (uint256 n,) = _fillsOf(id);
        assertEq(n, 0, "nothing left to buy with");
        assertEq(router.swapCount(), 1);
    }

    /// 250 at 100 a buy: 100, 100, 50, then nothing. The helper previews each spend exactly.
    function test_twoAndAHalfBuys_fillsThreeTimes_thenNothing() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 100e6, 250e6);
        uint256[4] memory spends = [uint256(100e6), 100e6, 50e6, 0];
        for (uint256 i; i < spends.length; ++i) {
            (uint256 preview,,,) = helper.previewFill(IPlanVault(address(daily)), id);
            assertEq(preview, spends[i], "helper preview == the vault's spend");
            _nextEpoch(daily);
            vm.recordLogs();
            _advance(daily, address(nvda));
            (uint256 n, uint256 spend) = _fillsOf(id);
            assertEq(n, spends[i] > 0 ? 1 : 0);
            assertEq(spend, spends[i]);
        }
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0);
        assertEq(p.lastEpochId, 3, "last filled in epoch 3");
        assertEq(p.stockAccrued, 2 * _nvdaFor(99.25e6) + _nvdaFor(49.625e6));
        assertEq(usdg.balanceOf(treasury), 0.75e6 + 0.75e6 + 0.375e6);
        assertEq(router.swapCount(), 3);
    }

    /// The vault keeps no floor on what a withdrawal leaves behind, so a buy can be smaller than the smallest
    /// per-buy amount a plan may be set to.
    function test_withdrawLeavingLessThanOneBuy_nextBuySpendsTheRest() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        vm.prank(alice);
        daily.withdrawIdle(id, 997e6);
        assertEq(daily.getPlan(id).usdgIdle, 3e6);
        assertLt(3e6, daily.minAmountPerEpoch());
        _nextEpoch(daily);
        // 3 USDG: 0.75% fee = 0.0225, net 2.9775
        vm.expectEmit(true, true, false, true, address(daily));
        emit IPlanVault.PlanFilled(id, 1, 3e6, 0.0225e6, _nvdaFor(2.9775e6), false);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(id).usdgIdle, 0);
    }

    // ------------------------------------------------------------------
    // After the plan drains
    // ------------------------------------------------------------------

    /// A drained plan still holds the stock it bought, so it cannot be pruned (by anyone) until the owner claims.
    /// Once empty it prunes, the stock stops being due, and a top-up re-indexes it.
    function test_drained_prunesOnceClaimed_topUpReindexes() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 100e6, 50e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(id).usdgIdle, 0);

        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PlanNotEmpty.selector, id));
        daily.prunePlan(id);
        vm.prank(alice);
        daily.claim(id, type(uint256).max);
        vm.prank(bob);
        daily.prunePlan(id); // permissionless once empty
        assertFalse(_isIndexed(daily, id));
        assertEq(daily.stockPlanCount(address(nvda)), 0);
        _nextEpoch(daily);
        assertFalse(daily.isEpochDue(address(nvda)), "no plans left: nothing for the keeper to run");

        vm.prank(alice);
        daily.depositUSDG(id, 50e6);
        assertTrue(_isIndexed(daily, id));
        uint32 epoch = daily.currentEpochId();
        vm.expectEmit(true, true, false, true, address(daily));
        emit IPlanVault.PlanFilled(id, epoch, 50e6, 0.375e6, _nvdaFor(49.625e6), false);
        _advance(daily, address(nvda));
    }

    /// With the auto-distribute perk nothing accrues, so the drained plan is empty the moment it is filled.
    function test_drained_autoDistribute_emptyAtOnce() public {
        _giveDca(alice, 100_000);
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 100e6, 50e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0);
        assertEq(p.stockAccrued, 0);
        vm.prank(bob);
        daily.prunePlan(id);
        assertFalse(_isIndexed(daily, id));
    }

    /// Unspent USDG from a partial fill goes back to the plan (`_distribute`), so a plan that spent "everything"
    /// is not empty: prune refuses it and the next epoch buys the residual — a buy below `minAmountPerEpoch`,
    /// charged the purchase fee a second time (the pinned Audit.L02 decision). Production cannot get here: the
    /// AggregatorRouter fills in full or reverts `PartialFill` (audit v0.3 M-02), so `residual` is 0 there. The
    /// mock router's fill knob models the path the vault still supports.
    function test_drained_partialFillResidual_keepsPlanOpen_thenBuysIt() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 100e6, 50e6);
        router.setFill(address(usdg), address(nvda), 9_000);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        // net 49.625, 90% consumed = 44.6625, 4.9625 back to the plan
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 4.9625e6, "the residual is the plan's own money, returned");
        assertEq(p.stockAccrued, _nvdaFor(44.6625e6));
        assertEq(daily.usdgDust(), 0, "one fill: the residual splits exactly");
        vm.prank(alice);
        daily.claim(id, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PlanNotEmpty.selector, id));
        daily.prunePlan(id);

        router.setFill(address(usdg), address(nvda), 10_000);
        _nextEpoch(daily);
        // 4.9625: fee floor(4.9625 * 0.75%) = 0.037218, net 4.925282
        vm.expectEmit(true, true, false, true, address(daily));
        emit IPlanVault.PlanFilled(id, 2, 4.9625e6, 37_218, _nvdaFor(4_925_282), false);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(id).usdgIdle, 0);
        vm.prank(alice);
        daily.claim(id, type(uint256).max);
        daily.prunePlan(id);
        assertFalse(_isIndexed(daily, id));
    }

    // ------------------------------------------------------------------
    // Paused
    // ------------------------------------------------------------------

    function test_pausedUnderfundedPlan_skipped_thenBuysOnResume() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 100e6, 50e6);
        uint256 other = _createUsdgPlan(daily, bob, address(nvda), 100e6, 1_000e6);
        vm.prank(alice);
        daily.setPlanPaused(id, true);
        (uint256 preview,,,) = helper.previewFill(IPlanVault(address(daily)), id);
        assertEq(preview, 0, "helper: a paused plan is charged nothing");

        _nextEpoch(daily);
        vm.recordLogs();
        _advance(daily, address(nvda));
        (uint256 n,) = _fillsOf(id);
        assertEq(n, 0, "paused: skipped");
        assertEq(daily.getPlan(id).usdgIdle, 50e6);
        assertEq(daily.getPlan(id).lastEpochId, 0);
        assertEq(daily.getPlan(other).usdgIdle, 900e6, "the rest of the page is filled");

        vm.prank(alice);
        daily.setPlanPaused(id, false);
        _nextEpoch(daily);
        vm.recordLogs();
        _advance(daily, address(nvda));
        uint256 spend;
        (n, spend) = _fillsOf(id);
        assertEq(n, 1);
        assertEq(spend, 50e6, "resumed: the whole balance");
        assertEq(daily.getPlan(id).usdgIdle, 0);
    }

    // ------------------------------------------------------------------
    // Keeper gas: what one plan adds to a page, by state
    // ------------------------------------------------------------------

    enum Kind {
        Full,
        Underfunded,
        Empty,
        EmptyBoosted,
        Paused
    }

    /// Run with -vv for the numbers. An underfunded plan is a normal fill and costs what a full one does; an empty
    /// one costs the reads `_collect` makes before `continue` (index entry, plan slot 1, slot 3, plus slot 4 when
    /// flagged boosted); a paused one the first two. Measured at steady state (every plan filled once before)
    /// with the vault's storage cooled, as in a fresh transaction. At the time of writing: ~30.2k full, ~30.7k
    /// underfunded, ~7.7k empty, ~10.2k empty and flagged boosted, ~5.5k paused.
    function test_gas_perPlanInAPage_byState() public {
        uint256 k = 10;
        uint256 base = _pageGas(Kind.Full, 0);
        uint256 full = (_pageGas(Kind.Full, k) - base) / k;
        uint256 under = (_pageGas(Kind.Underfunded, k) - base) / k;
        uint256 empty = (_pageGas(Kind.Empty, k) - base) / k;
        uint256 emptyBoosted = (_pageGas(Kind.EmptyBoosted, k) - base) / k;
        uint256 paused = (_pageGas(Kind.Paused, k) - base) / k;
        console2.log("page with 1 plan          ", base);
        console2.log("+ per full plan           ", full);
        console2.log("+ per underfunded plan    ", under);
        console2.log("+ per empty plan          ", empty);
        console2.log("+ per empty boosted plan  ", emptyBoosted);
        console2.log("+ per paused plan         ", paused);

        assertApproxEqRel(under, full, 0.05e18, "underfunded = a normal fill");
        assertLt(paused, empty);
        assertLt(empty, emptyBoosted);
        assertLt(emptyBoosted, 12_000, "an empty plan is a handful of cold reads");
        assertGt(under, 3 * empty);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev `PlanFilled` logs of `planId` since `vm.recordLogs()`: how many, and the last one's spend.
    function _fillsOf(uint256 planId) internal view returns (uint256 n, uint256 spend) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(daily) || l.topics.length < 2) continue;
            if (l.topics[0] != IPlanVault.PlanFilled.selector || uint256(l.topics[1]) != planId) continue;
            ++n;
            (spend,,,) = abi.decode(l.data, (uint256, uint256, uint256, bool));
        }
    }

    /// @dev Gas of the epoch-2 NVDA page on the daily vault: one full anchor plan (so the page always swaps) plus
    ///      `k` plans of `kind`, each owned by its own wallet. Epoch 1 fills everyone once (the empty kinds drain
    ///      there: 50 USDG at 100 a buy); the measured call starts from cold vault / token storage. State is
    ///      rolled back afterwards.
    function _pageGas(Kind kind, uint256 k) internal returns (uint256 gas) {
        uint256 snap = vm.snapshotState();
        _createUsdgPlan(daily, carol, address(nvda), 100e6, 1_000e6);
        // underfunded: 100 in epoch 1, then 50 of 100 in the measured one; empty: drained by epoch 1's 50
        uint256 deposit = 1_000e6;
        if (kind == Kind.Underfunded) deposit = 150e6;
        else if (kind == Kind.Empty || kind == Kind.EmptyBoosted) deposit = 50e6;
        address[] memory users = new address[](k);
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            users[i] = makeAddr(string.concat("page-", vm.toString(i)));
            _fund(users[i]);
            ids[i] = kind == Kind.EmptyBoosted
                ? _createBoostedPlan(daily, users[i], address(nvda), 100e6, deposit)
                : _createUsdgPlan(daily, users[i], address(nvda), 100e6, deposit);
        }
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        if (kind == Kind.Paused) {
            for (uint256 i; i < k; ++i) {
                vm.prank(users[i]);
                daily.setPlanPaused(ids[i], true);
            }
        }
        _nextEpoch(daily);
        vm.cool(address(daily));
        vm.cool(address(dca));
        vm.cool(address(usdg));
        vm.cool(address(nvda));
        vm.cool(address(router));
        vm.prank(keeper);
        uint256 g0 = gasleft();
        daily.advanceEpoch(address(nvda), 0, "");
        gas = g0 - gasleft();
        vm.revertToState(snap);
    }
}
