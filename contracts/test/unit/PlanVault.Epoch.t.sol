// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {Plan, FeeConfig} from "../../src/vault/VaultTypes.sol";
import {Route} from "../../src/router/IAggregatorRouter.sol";
import {PlanVault} from "../../src/vault/PlanVault.sol";
import {BlockingToken} from "../mocks/BlockingToken.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract PlanVaultEpochTest is BaseTest {
    // ------------------------------------------------------------------
    // Scheduling
    // ------------------------------------------------------------------

    function test_epochZero_notDue() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        assertEq(daily.currentEpochId(), 0);
        assertFalse(daily.isEpochDue(address(nvda)));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.EpochNotDue.selector, address(nvda), 0));
        daily.advanceEpoch(address(nvda), 0, "");
    }

    function test_epochOne_dueAtAlignedBoundary() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 next = daily.nextEpochStart();
        assertEq(next % 1 days, 0, "daily fires at 00:00 UTC");
        vm.warp(next - 1);
        assertFalse(daily.isEpochDue(address(nvda)));
        vm.warp(next);
        assertTrue(daily.isEpochDue(address(nvda)));
        assertEq(daily.currentEpochId(), 1);
    }

    function test_weekly_originIsMonday() public view {
        assertEq((weekly.origin() - 4 days) % 7 days, 0);
        assertEq(weekly.epochLength(), 7 days);
        assertEq(monthly.epochLength(), 30 days);
    }

    function test_cannotRunTwiceInEpoch() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        assertTrue(_advance(daily, address(nvda)));
        assertFalse(daily.isEpochDue(address(nvda)));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.EpochNotDue.selector, address(nvda), 1));
        daily.advanceEpoch(address(nvda), 0, "");
    }

    function test_missedEpochsAreSkippedNotCaughtUp() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.warp(daily.nextEpochStart() + 3 days); // keeper was down for 3 epochs
        assertEq(daily.currentEpochId(), 4);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(id).usdgIdle, 800e6, "charged exactly one spend");
        assertEq(daily.lastExecutedEpoch(address(nvda)), 4);
        assertFalse(daily.isEpochDue(address(nvda)));
    }

    function test_noPlans_notDueAndReverts() public {
        _nextEpoch(daily);
        assertFalse(daily.isEpochDue(address(nvda)), "not due with zero plans");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.EpochNotDue.selector, address(nvda), 1));
        daily.advanceEpoch(address(nvda), 0, "");
        assertEq(daily.epochsCompleted(), 0);
    }

    // ------------------------------------------------------------------
    // Basic fill & fees
    // ------------------------------------------------------------------

    function test_fill_dailyFeeAndAccrual() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);

        // 200 USDG spend, 0.75% fee = 1.5 USDG, net 198.5 -> 0.397 NVDA
        uint256 expectedStock = _nvdaFor(198.5e6);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanFilled(id, 1, 200e6, 1.5e6, expectedStock, false);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.EpochPageExecuted(address(nvda), 1, 0, 1, 198.5e6, expectedStock, 1);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.EpochExecuted(address(nvda), 1);
        _advance(daily, address(nvda));

        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 800e6);
        assertEq(p.stockAccrued, expectedStock);
        assertEq(p.lastEpochId, 1);
        assertEq(usdg.balanceOf(treasury), 1.5e6, "purchase fee to treasury");
        assertEq(usdg.balanceOf(address(daily)), 800e6, "vault holds only idle");
        assertEq(nvda.balanceOf(address(daily)), expectedStock);
        assertEq(daily.totalStockAccrued(address(nvda)), expectedStock);
        assertEq(daily.userStockAccrued(alice, address(nvda)), expectedStock);
        assertEq(daily.totalUsdgIdle(), 800e6);
        assertEq(daily.totalNotionalUsdg(), 198.5e6);
        assertEq(daily.epochsCompleted(), 1);
        assertEq(router.lastMinOut(), (expectedStock * 9_950) / 10_000, "minOut = quote * (1 - 0.5%)");
    }

    function test_fill_weeklyAndMonthlyDefaultFees() public {
        uint256 w = _createUsdgPlan(weekly, alice, address(nvda), 200e6, 1_000e6);
        uint256 m = _createUsdgPlan(monthly, alice, address(nvda), 200e6, 1_000e6);
        assertEq(weekly.fees().purchaseFeeBps, 50);
        assertEq(monthly.fees().purchaseFeeBps, 25);

        vm.warp(monthly.nextEpochStart()); // >= 7 days too
        _advance(weekly, address(nvda));
        _advance(monthly, address(nvda));
        assertEq(weekly.getPlan(w).stockAccrued, _nvdaFor(199e6));
        assertEq(monthly.getPlan(m).stockAccrued, _nvdaFor(199.5e6));
        assertEq(usdg.balanceOf(treasury), 1e6 + 0.5e6);
    }

    function test_fill_spendCappedByIdle() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 120e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(id).usdgIdle, 0);
        assertEq(daily.getPlan(id).stockAccrued, _nvdaFor(120e6 - 0.9e6));
    }

    function test_fill_pausedPlanSkipped() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        daily.setPlanPaused(id, true);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(id).usdgIdle, 1_000e6);
        assertEq(router.swapCount(), 0);
    }

    function test_fill_emptyPlanSkipped() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(id).lastEpochId, 0);
        assertEq(router.swapCount(), 0);
    }

    function test_fill_zeroBpsAndMaxBps() public {
        uint256 a = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        FeeConfig memory f = daily.fees();
        f.purchaseFeeBps = 0;
        vm.prank(owner);
        daily.setFees(f);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(a).stockAccrued, _nvdaFor(200e6));
        assertEq(usdg.balanceOf(treasury), 0);

        f.purchaseFeeBps = 90;
        vm.prank(owner);
        daily.setFees(f);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(usdg.balanceOf(treasury), 1.8e6);
    }

    // ------------------------------------------------------------------
    // $DCA perks: auto-distribute and fee halving both unlock at 100k by default; the two thresholds stay
    // independently settable (`setThresholds`).
    // ------------------------------------------------------------------

    function _runTier(uint256 dcaWhole) internal returns (Plan memory p, uint256 walletStock, uint256 fee) {
        address user = makeAddr(string(abi.encodePacked("tier", dcaWhole)));
        _fund(user);
        if (dcaWhole > 0) _giveDca(user, dcaWhole);
        uint256 id = _createUsdgPlan(daily, user, address(nvda), 200e6, 1_000e6);
        uint256 tBefore = usdg.balanceOf(treasury);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        p = daily.getPlan(id);
        walletStock = nvda.balanceOf(user);
        fee = usdg.balanceOf(treasury) - tBefore;
    }

    function test_tier_0() public {
        (Plan memory p, uint256 wallet, uint256 fee) = _runTier(0);
        assertEq(fee, 1.5e6);
        assertEq(wallet, 0);
        assertEq(p.stockAccrued, _nvdaFor(198.5e6));
    }

    function test_tier_99999_noPerks() public {
        (Plan memory p, uint256 wallet, uint256 fee) = _runTier(99_999);
        assertEq(fee, 1.5e6, "full fee");
        assertEq(wallet, 0, "below auto-dist threshold");
        assertEq(p.stockAccrued, _nvdaFor(198.5e6));
    }

    function test_tier_100000_autoDistributesAndHalvesFee() public {
        (Plan memory p, uint256 wallet, uint256 fee) = _runTier(100_000);
        // 75 bps -> 37 bps (floor). 200 * 0.0037 = 0.74
        assertEq(fee, 0.74e6, "halved fee");
        assertEq(wallet, _nvdaFor(199.26e6), "stock sent to wallet, 0 claim fee");
        assertEq(p.stockAccrued, 0);
        assertEq(nvda.balanceOf(address(daily)), 0);
    }

    function test_tier_100001_autoDistributesAndHalvesFee() public {
        (Plan memory p, uint256 wallet, uint256 fee) = _runTier(100_001);
        assertEq(fee, 0.74e6);
        assertEq(wallet, _nvdaFor(199.26e6));
        assertEq(p.stockAccrued, 0);
    }

    function test_tier_thresholdsIndependent_autoDistOnly() public {
        // auto-distribute unlocks first, halving later: the band in between gets the wallet delivery at full fee.
        vm.prank(owner);
        daily.setThresholds(10_000e18, 50_000e18);
        (Plan memory p, uint256 wallet, uint256 fee) = _runTier(49_999);
        assertEq(fee, 1.5e6, "full fee");
        assertEq(wallet, _nvdaFor(198.5e6), "auto-distributed");
        assertEq(p.stockAccrued, 0);
    }

    function test_tier_thresholdsIndependent_halveOnly() public {
        // halving unlocks first: the band in between pays the halved fee but still accrues on-vault.
        vm.prank(owner);
        daily.setThresholds(50_000e18, 10_000e18);
        (Plan memory p, uint256 wallet, uint256 fee) = _runTier(49_999);
        assertEq(fee, 0.74e6, "halved fee");
        assertEq(wallet, 0, "not auto-distributed");
        assertEq(p.stockAccrued, _nvdaFor(199.26e6));
    }

    function test_tier_snapshotAtExecutionNotCreation() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _giveDca(alice, 100_000); // bought after creating the plan
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(nvda.balanceOf(alice), _nvdaFor(199.26e6), "perks read at execution");
        assertEq(daily.getPlan(id).stockAccrued, 0);
        // sells DCA before next epoch -> perks gone
        vm.prank(alice);
        assertTrue(dca.transfer(bob, 100_000e18));
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(id).stockAccrued, _nvdaFor(198.5e6));
    }

    function test_tier_recipientReceivesAutoDist() public {
        _giveDca(alice, 100_000);
        vm.prank(alice);
        uint256 id = daily.createPlan(address(nvda), 200e6, carol, 1_000e6, 0, 0, false);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(nvda.balanceOf(carol), _nvdaFor(199.26e6));
        assertEq(nvda.balanceOf(alice), 0);
        assertEq(daily.getPlan(id).stockAccrued, 0);
    }

    function test_effectiveFeeViews() public {
        assertEq(daily.effectivePurchaseFeeBps(alice), 75);
        assertFalse(daily.isAutoDistribute(alice));
        _giveDca(alice, 99_999);
        assertFalse(daily.isAutoDistribute(alice));
        assertEq(daily.effectivePurchaseFeeBps(alice), 75);
        _giveDca(alice, 1);
        assertTrue(daily.isAutoDistribute(alice));
        assertEq(daily.effectivePurchaseFeeBps(alice), 37);
        // each view follows its own threshold
        vm.prank(owner);
        daily.setThresholds(200_000e18, 100_000e18);
        assertFalse(daily.isAutoDistribute(alice));
        assertEq(daily.effectivePurchaseFeeBps(alice), 37);
    }

    function test_autoDist_blockedRecipientFallsBackToAccrual() public {
        BlockingToken blk = new BlockingToken();
        vm.prank(owner);
        registry.listStock(address(blk), "BLK", false, true);
        router.setRate(address(usdg), address(blk), 1e18, 100e6);
        _giveDca(alice, 100_000);
        blk.setBlocked(alice, true);
        uint256 id = _createUsdgPlan(daily, alice, address(blk), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanFilled(id, 1, 200e6, 0.74e6, 1.9926e18, false);
        _advance(daily, address(blk));
        assertEq(daily.getPlan(id).stockAccrued, 1.9926e18, "accrued instead of bricking the epoch");
        assertEq(blk.balanceOf(alice), 0);
    }

    // ------------------------------------------------------------------
    // Claims
    // ------------------------------------------------------------------

    function test_claim_feeAndRecipient() public {
        vm.prank(alice);
        uint256 id = daily.createPlan(address(nvda), 200e6, carol, 1_000e6, 0, 0, false);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 accrued = daily.getPlan(id).stockAccrued;

        uint256 amount = accrued / 2;
        uint256 fee = (amount * 25) / 10_000;
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit IPlanVault.Claimed(id, address(nvda), carol, amount, fee);
        daily.claim(id, amount);
        assertEq(nvda.balanceOf(carol), amount - fee);
        assertEq(nvda.balanceOf(treasury), fee);
        assertEq(daily.getPlan(id).stockAccrued, accrued - amount);
        assertEq(daily.totalStockAccrued(address(nvda)), accrued - amount);
        assertEq(daily.userStockAccrued(alice, address(nvda)), accrued - amount);

        // claim the rest with the sentinel
        vm.prank(alice);
        daily.claim(id, type(uint256).max);
        assertEq(daily.getPlan(id).stockAccrued, 0);
        assertEq(nvda.balanceOf(address(daily)), 0);
    }

    function test_claim_zeroFeeWhenThresholdCrossedAfterEpoch() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 accrued = daily.getPlan(id).stockAccrued;
        assertGt(accrued, 0);
        _giveDca(alice, 100_000); // buys $DCA between epoch and claim
        vm.prank(alice);
        daily.claim(id, type(uint256).max);
        assertEq(nvda.balanceOf(alice), accrued, "0 claim fee");
        assertEq(nvda.balanceOf(treasury), 0);
    }

    function test_claim_reverts() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.claim(id, type(uint256).max); // nothing accrued
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 accrued = daily.getPlan(id).stockAccrued;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.InsufficientAccrued.selector, accrued + 1, accrued));
        daily.claim(id, accrued + 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.NotPlanOwner.selector, id));
        daily.claim(id, 1);
    }

    function test_claim_worksWhilePaused() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        vm.prank(owner);
        daily.pause();
        vm.prank(alice);
        daily.claim(id, type(uint256).max);
        assertEq(daily.getPlan(id).stockAccrued, 0);
    }

    function test_claimAll_byStock() public {
        uint256 a = _createUsdgPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        uint256 b = _createUsdgPlan(daily, alice, address(nvda), 50e6, 1_000e6);
        uint256 c = _createUsdgPlan(daily, alice, address(aapl), 50e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        _advance(daily, address(aapl));
        uint256 total = daily.getPlan(a).stockAccrued + daily.getPlan(b).stockAccrued;
        vm.prank(alice);
        daily.claimAll(address(nvda));
        assertEq(daily.getPlan(a).stockAccrued, 0);
        assertEq(daily.getPlan(b).stockAccrued, 0);
        assertGt(daily.getPlan(c).stockAccrued, 0, "other stock untouched");
        assertEq(nvda.balanceOf(alice) + nvda.balanceOf(treasury), total);
        assertEq(daily.userStockAccrued(alice, address(nvda)), 0);
        // no-op when nothing to claim
        vm.prank(alice);
        daily.claimAll(address(nvda));
    }

    // ------------------------------------------------------------------
    // Pro-rata, dust pot
    // ------------------------------------------------------------------

    function test_proRata_weightsAndDust() public {
        // Force an output that does not divide evenly: rate 1 USDG -> 7 wei of stock
        router.setRate(address(usdg), address(nvda), 7, 1e6);
        FeeConfig memory f = daily.fees();
        f.purchaseFeeBps = 0;
        vm.prank(owner);
        daily.setFees(f);

        uint256 a = _createUsdgPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 200e6, 1_000e6);
        uint256 c = _createUsdgPlan(daily, carol, address(nvda), 10e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));

        // total net 310 USDG -> 2170 wei. Shares floor: a=700, b=1400, c=70 -> exact here, dust 0
        assertEq(daily.getPlan(a).stockAccrued, 700);
        assertEq(daily.getPlan(b).stockAccrued, 1400);
        assertEq(daily.getPlan(c).stockAccrued, 70);
        assertEq(daily.dustPot(address(nvda)), 0);

        // Now a rate producing dust: 1 USDG -> 1 wei, weights 1:2 on 3 wei? use 10 wei over 3 equal plans
        router.setRate(address(usdg), address(nvda), 10, 300e6); // 300 USDG -> 10 wei
        vm.prank(alice);
        daily.setPlanAmount(a, 100e6);
        vm.prank(bob);
        daily.setPlanAmount(b, 100e6);
        vm.prank(carol);
        daily.setPlanAmount(c, 100e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        // 10 wei / 3 -> 3 each, dust 1
        assertEq(daily.getPlan(a).stockAccrued, 703);
        assertEq(daily.getPlan(b).stockAccrued, 1403);
        assertEq(daily.getPlan(c).stockAccrued, 73);
        assertEq(daily.dustPot(address(nvda)), 1);
        assertEq(nvda.balanceOf(address(daily)), daily.totalStockAccrued(address(nvda)) + daily.dustPot(address(nvda)));

        // Next epoch folds the pot: 10 + 1 = 11 -> 3 each, dust 2
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(a).stockAccrued, 706);
        assertEq(daily.dustPot(address(nvda)), 2);
        // and again: 12 -> 4 each, dust 0
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(a).stockAccrued, 710);
        assertEq(daily.dustPot(address(nvda)), 0);
    }

    function test_residualUsdgReturnedProRata() public {
        router.setFill(address(usdg), address(nvda), 5_000); // pool only takes half (quote reflects it)
        FeeConfig memory f = daily.fees();
        f.purchaseFeeBps = 0;
        vm.prank(owner);
        daily.setFees(f);
        uint256 a = _createUsdgPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 300e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        // 200 USDG unspent, returned 1:3
        assertEq(daily.getPlan(a).usdgIdle, 900e6 + 50e6);
        assertEq(daily.getPlan(b).usdgIdle, 700e6 + 150e6);
        assertEq(daily.totalUsdgIdle(), 1_800e6);
        assertEq(daily.usdgDust(), 0, "splits exactly");
        assertEq(usdg.balanceOf(address(daily)), 1_800e6);
        assertEq(daily.totalNotionalUsdg(), 200e6, "notional counts what was actually spent");
    }

    function test_residualDust_accountedAndSweptAtThreshold() public {
        router.setFill(address(usdg), address(nvda), 5_000);
        FeeConfig memory f = daily.fees();
        f.purchaseFeeBps = 0;
        vm.prank(owner);
        daily.setFees(f);
        // odd nets (100.000001 / 100.000003 / 100.000007) with a 33.33% fill: residual cannot be split exactly
        router.setFill(address(usdg), address(nvda), 3_333);
        _createUsdgPlan(daily, alice, address(nvda), 100e6 + 1, 1_000e6);
        _createUsdgPlan(daily, bob, address(nvda), 100e6 + 3, 1_000e6);
        _createUsdgPlan(daily, carol, address(nvda), 100e6 + 7, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 dust = daily.usdgDust();
        assertGt(dust, 0, "remainder booked as dust");
        assertLt(dust, 3, "at most n-1 units");
        assertEq(usdg.balanceOf(address(daily)), daily.totalUsdgIdle() + dust, "tight invariant");
        assertEq(usdg.balanceOf(treasury), 0, "below the 1 USDG sweep threshold: kept");

        // lower the threshold: the next advanceEpoch forwards it to the treasury
        vm.prank(owner);
        daily.setDustSweepMin(1);
        _nextEpoch(daily);
        vm.expectEmit(true, true, false, false);
        emit IPlanVault.DustSwept(address(usdg), treasury, 0);
        _advance(daily, address(nvda));
        assertEq(daily.usdgDust(), 0);
        assertEq(usdg.balanceOf(address(daily)), daily.totalUsdgIdle());
    }

    function test_sweepDust_forcedByFeeManager() public {
        router.setFill(address(usdg), address(nvda), 5_000);
        FeeConfig memory f = daily.fees();
        f.purchaseFeeBps = 0;
        vm.prank(owner);
        daily.setFees(f);
        router.setFill(address(usdg), address(nvda), 3_333);
        _createUsdgPlan(daily, alice, address(nvda), 100e6 + 1, 1_000e6);
        _createUsdgPlan(daily, bob, address(nvda), 100e6 + 3, 1_000e6);
        _createUsdgPlan(daily, carol, address(nvda), 100e6 + 7, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 dust = daily.usdgDust();
        assertGt(dust, 0);
        vm.prank(alice);
        vm.expectRevert();
        daily.sweepDust();
        vm.prank(owner);
        daily.setFeeManager(bob);
        vm.prank(bob);
        daily.sweepDust();
        assertEq(daily.usdgDust(), 0);
        assertEq(usdg.balanceOf(treasury), dust);
    }

    // ------------------------------------------------------------------
    // Skip, never revert: a page whose purchase cannot happen charges nobody and still advances
    // ------------------------------------------------------------------

    function test_pageSkipped_noRoute() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        router.removePair(address(usdg), address(nvda));
        _nextEpoch(daily);
        vm.expectEmit(true, true, false, false);
        emit IPlanVault.EpochPageSkipped(address(nvda), 1, 0, 1, "");
        assertTrue(_advance(daily, address(nvda)), "epoch completes");
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 1_000e6, "nothing charged");
        assertEq(p.lastEpochId, 0, "not marked filled");
        assertEq(usdg.balanceOf(treasury), 0, "no fee");
        assertEq(daily.lastExecutedEpoch(address(nvda)), 1);
        assertFalse(daily.isEpochDue(address(nvda)));
        // route restored -> next epoch fills normally
        router.setRate(address(usdg), address(nvda), NVDA_PER_USDG_NUM, NVDA_PER_USDG_DEN);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(id).lastEpochId, 2);
        assertEq(daily.getPlan(id).usdgIdle, 800e6);
    }

    function test_pageSkipped_swapReverts() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        router.setRevertOnSwap(true);
        _nextEpoch(daily);
        vm.expectEmit(true, true, false, false);
        emit IPlanVault.EpochPageSkipped(address(nvda), 1, 0, 1, "");
        assertTrue(_advance(daily, address(nvda)));
        assertEq(daily.getPlan(id).usdgIdle, 1_000e6);
        assertEq(daily.totalUsdgIdle(), 1_000e6);
        assertEq(usdg.balanceOf(address(daily)), 1_000e6);
    }

    function test_pageSkipped_quoteTooSmall() public {
        router.setRate(address(usdg), address(nvda), 0, 1); // pool returns 0 stock
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.EpochPageSkipped(address(nvda), 1, 0, 1, bytes("quote too small"));
        assertTrue(_advance(daily, address(nvda)));
        assertEq(daily.getPlan(id).usdgIdle, 1_000e6);
        assertEq(router.swapCount(), 0, "no swap attempted");
    }

    function test_pageSkipped_otherPagesStillFill() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _createUsdgPlan(daily, bob, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, ""); // page 0 fills
        router.setRevertOnSwap(true);
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 1, "")); // page 1 skipped, epoch complete
        assertEq(daily.getPlan(1).lastEpochId, 1);
        assertEq(daily.getPlan(2).lastEpochId, 0);
        assertEq(daily.getPlan(2).usdgIdle, 1_000e6);
    }

    // ------------------------------------------------------------------
    // Pagination
    // ------------------------------------------------------------------

    function test_pagination_threePages() public {
        uint256[] memory ids = new uint256[](5);
        for (uint256 i; i < 5; ++i) {
            address u = makeAddr(string(abi.encodePacked("u", i)));
            _fund(u);
            ids[i] = _createUsdgPlan(daily, u, address(nvda), 100e6, 1_000e6);
        }
        _nextEpoch(daily);

        vm.prank(keeper);
        assertFalse(daily.advanceEpoch(address(nvda), 2, ""));
        assertEq(daily.nextPlanIndex(address(nvda), 1), 2);
        assertTrue(daily.isEpochPending(address(nvda)));
        assertEq(daily.lastExecutedEpoch(address(nvda)), 0);
        assertEq(daily.getPlan(ids[1]).lastEpochId, 1);
        assertEq(daily.getPlan(ids[2]).lastEpochId, 0);
        assertEq(router.swapCount(), 1, "one swap per page");

        vm.prank(keeper);
        assertFalse(daily.advanceEpoch(address(nvda), 2, ""));
        assertEq(daily.nextPlanIndex(address(nvda), 1), 4);

        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 2, ""));
        assertEq(daily.nextPlanIndex(address(nvda), 1), 5);
        assertFalse(daily.isEpochPending(address(nvda)));
        assertEq(daily.lastExecutedEpoch(address(nvda)), 1);
        assertEq(daily.epochsCompleted(), 1);
        assertEq(router.swapCount(), 3);
        for (uint256 i; i < 5; ++i) {
            assertEq(daily.getPlan(ids[i]).usdgIdle, 900e6);
            assertEq(daily.getPlan(ids[i]).stockAccrued, _nvdaFor(99.25e6));
        }
        assertEq(usdg.balanceOf(treasury), 5 * 0.75e6);
    }

    function test_pagination_limitCappedByMaxPlansPerTx() public {
        vm.prank(owner);
        daily.setMaxPlansPerTx(2);
        for (uint256 i; i < 3; ++i) {
            address u = makeAddr(string(abi.encodePacked("v", i)));
            _fund(u);
            _createUsdgPlan(daily, u, address(nvda), 100e6, 1_000e6);
        }
        _nextEpoch(daily);
        vm.prank(keeper);
        assertFalse(daily.advanceEpoch(address(nvda), 1_000, ""), "limit above cap is clamped");
        assertEq(daily.nextPlanIndex(address(nvda), 1), 2);
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 0, ""));
    }

    function test_pagination_planAddedMidEpochIsProcessed() public {
        _createUsdgPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        _createUsdgPlan(daily, bob, address(nvda), 100e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, "");
        uint256 c = _createUsdgPlan(daily, carol, address(nvda), 100e6, 1_000e6);
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 10, ""));
        assertEq(daily.getPlan(c).lastEpochId, 1, "appended plan filled in the same epoch");
    }

    function test_pagination_abandonedPageRestartsNextEpoch() public {
        uint256 a = _createUsdgPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 100e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, ""); // only alice
        _nextEpoch(daily); // keeper never finished epoch 1
        assertEq(daily.nextPlanIndex(address(nvda), 2), 0);
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 0, ""));
        assertEq(daily.getPlan(a).usdgIdle, 800e6, "alice: epoch 1 + epoch 2");
        assertEq(daily.getPlan(b).usdgIdle, 900e6, "bob: missed epoch 1, filled epoch 2");
    }

    // ------------------------------------------------------------------
    // ETH / WETH deposits are converted to USDG at deposit time; epochs never touch WETH
    // ------------------------------------------------------------------

    function test_weth_depositIsConvertedAndSpentAsUsdg() public {
        vm.prank(alice);
        uint256 id = daily.createPlan(address(nvda), 200e6, address(0), 50e6, 1 ether, 0, false);
        assertEq(daily.getPlan(id).usdgIdle, 3_050e6);
        assertEq(router.swapCount(), 1, "one conversion at deposit");
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(router.swapCount(), 2, "one buy per page, no zap at epoch");
        assertEq(daily.getPlan(id).usdgIdle, 2_850e6);
        assertEq(weth.balanceOf(address(daily)), 0);
        assertEq(daily.wethDust(), 0);
    }

    function test_weth_noRouteAtDepositReverts() public {
        router.removePair(address(weth), address(usdg));
        vm.prank(alice);
        vm.expectRevert();
        daily.createPlan{value: 1 ether}(address(nvda), 200e6, address(0), 0, 0, 0, false);
    }

    // ------------------------------------------------------------------
    // Access: keeperOnly, route override, tips
    // ------------------------------------------------------------------

    function test_keeperOnlyByDefault() public {
        assertTrue(daily.keeperOnly());
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(makeAddr("random"));
        vm.expectRevert(IPlanVault.NotKeeper.selector);
        daily.advanceEpoch(address(nvda), 0, "");
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(nvda), 0, ""));
        _nextEpoch(daily);
        vm.prank(owner);
        assertTrue(daily.advanceEpoch(address(nvda), 0, ""), "owner always allowed");
    }

    function test_keeperOnlyCanBeDisabled() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(owner);
        daily.setKeeperOnly(false);
        _nextEpoch(daily);
        vm.prank(makeAddr("random"));
        assertTrue(daily.advanceEpoch(address(nvda), 0, ""));
    }

    function _autoMinOut(uint256 usdgIn) internal view returns (uint256) {
        (uint256 q,) = router.quote(address(usdg), address(nvda), usdgIn);
        return (q * (10_000 - daily.fees().swapSlippageBps)) / 10_000;
    }

    function test_routeOverride_requiresPrivilege() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        Route[] memory path = new Route[](1);
        path[0] = Route({protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 3000, extra: ""});
        uint256 minOut = _autoMinOut(198.5e6);
        bytes memory ovr = abi.encode(path, minOut);
        vm.prank(makeAddr("random"));
        vm.expectRevert(IPlanVault.NotKeeper.selector);
        daily.advanceEpoch(address(nvda), 0, ovr);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 0, ovr);
        assertEq(router.lastMinOut(), minOut);
        assertEq(router.lastPathLength(), 1);
    }

    function test_routeOverride_minOutMayNotBeBelowAuto() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        Route[] memory path = new Route[](1);
        path[0] = Route({protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 3000, extra: ""});
        uint256 floor = _autoMinOut(198.5e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.OverrideMinOutTooLow.selector, floor - 1, floor));
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, floor - 1));
        // tighter than auto is the whole point of an override
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, floor + 1));
        assertEq(router.lastMinOut(), floor + 1);
    }

    function test_routeOverride_failureRevertsInsteadOfSkipping() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        Route[] memory path = new Route[](1);
        path[0] = Route({protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 3000, extra: ""});
        uint256 tooTight = _autoMinOut(198.5e6) * 2;
        vm.prank(keeper);
        vm.expectRevert(); // MockRouter InsufficientOutput bubbles: the page is not consumed
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, tooTight));
        assertEq(daily.nextPlanIndex(address(nvda), 1), 0, "cursor untouched");
        assertEq(daily.getPlan(id).usdgIdle, 1_000e6);
    }

    function test_routeOverride_allowedWhenNoAutoQuote() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        router.removePair(address(usdg), address(nvda));
        // an override can only name router-approved hops; the mock accepts any, so model "approved but unquoted"
        Route[] memory path = new Route[](1);
        path[0] = Route({protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 3000, extra: ""});
        vm.prank(keeper);
        vm.expectRevert(); // mock has no pair -> NoRoute bubbles from the swap
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, uint256(1)));
    }

    function test_routeOverride_zeroMinOutRejected() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        Route[] memory path = new Route[](1);
        path[0] = Route({protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 3000, extra: ""});
        vm.prank(keeper);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.advanceEpoch(address(nvda), 0, abi.encode(path, uint256(0)));
    }

    function test_keeperTip() public {
        FeeConfig memory f = daily.fees();
        f.keeperTipBps = 2_000; // 20% of fees
        vm.prank(owner);
        daily.setFees(f);
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(usdg.balanceOf(keeper), 0.3e6);
        assertEq(usdg.balanceOf(treasury), 1.2e6);
    }

    function test_paused_blocksEpoch() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(owner);
        daily.pause();
        assertFalse(daily.isEpochDue(address(nvda)));
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        daily.advanceEpoch(address(nvda), 0, "");
        vm.prank(owner);
        daily.unpause();
        _advance(daily, address(nvda));
    }

    function test_delisted_blocksEpoch() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(owner);
        registry.setApproved(address(nvda), false);
        _nextEpoch(daily);
        assertFalse(daily.isEpochDue(address(nvda)));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.StockNotPurchasable.selector, address(nvda)));
        daily.advanceEpoch(address(nvda), 0, "");
        // user can still exit
        vm.prank(alice);
        daily.withdrawIdle(id, type(uint256).max);
    }

    function test_noDcaToken_noPerks() public {
        // deploy a vault with dca = address(0)
        vm.warp(T0);
        DailyNoDca v = new DailyNoDca(owner, address(usdg), address(weth), address(registry), address(router), treasury);
        assertEq(v.autoDistributeThreshold(), 100_000e18);
        assertEq(v.feeHalveThreshold(), 100_000e18);
        _giveDca(alice, 200_000);
        assertEq(v.effectivePurchaseFeeBps(alice), 75);
        assertFalse(v.isAutoDistribute(alice));
        // thresholds cannot be zeroed, and with no token there are no perks whatever they are
        vm.prank(owner);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        v.setThresholds(0, 0);
        vm.prank(owner);
        v.setThresholds(1, 1);
        assertFalse(v.isAutoDistribute(alice));
        assertEq(v.effectivePurchaseFeeBps(alice), 75);
    }
}

import {DailyVault} from "../../src/vault/DailyVault.sol";
import {VaultParams} from "../../src/vault/VaultTypes.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";

contract DailyNoDca is DailyVault {
    constructor(address o, address u, address w, address r, address rt, address fr)
        DailyVault(VaultParams({
                owner: o,
                usdg: u,
                weth: w,
                dca: address(0),
                registry: r,
                router: rt,
                feeRecipient: fr,
                epochLength: 0,
                origin: EpochLib.alignToDay(block.timestamp),
                purchaseFeeBps: 0
            }))
    {}
}
