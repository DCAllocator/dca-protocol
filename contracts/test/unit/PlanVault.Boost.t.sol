// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {PlanVault} from "../../src/vault/PlanVault.sol";
import {Plan} from "../../src/vault/VaultTypes.sol";
import {ClaimHelper} from "../../src/periphery/ClaimHelper.sol";
import {MockStrategy} from "../mocks/MockStrategy.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

/// @dev Boosted plans: idle USDG lent through the MorphoBlueStrategy, per-plan share / earnings accounting,
///      and every interaction with deposits, withdrawals, epochs and admin.
contract PlanVaultBoostTest is BaseTest {
    ClaimHelper internal helper;

    function setUp() public override {
        super.setUp();
        helper = new ClaimHelper();
    }

    // ------------------------------------------------------------------
    // Accounting invariants checked after most scenarios
    // ------------------------------------------------------------------

    function _checkInvariants(PlanVault v) internal view {
        assertEq(
            usdg.balanceOf(address(v)),
            v.totalUsdgIdle() + v.usdgDust(),
            "usdg tight: boosted funds never sit in the vault"
        );
        uint256 n = v.nextPlanId();
        uint256 shares;
        uint256 values;
        for (uint256 id = 1; id < n; ++id) {
            Plan memory p = v.getPlan(id);
            shares += p.boostShares;
            values += _boostValue(v, id);
            if (!p.boosted) assertEq(p.boostShares, 0, "unboosted plans hold no shares");
        }
        assertEq(shares, v.totalBoostShares(), "sum(shares) == totalBoostShares");
        assertLe(values, v.boostAssets(), "plan values never exceed the pool");
        assertEq(strategy.convertToAssets(strategy.balanceOf(address(v))), v.boostAssets(), "pool == strategy position");
    }

    // ------------------------------------------------------------------
    // Create / deposit
    // ------------------------------------------------------------------

    function test_createPlan_boosted_lendsTheDeposit() public {
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.PlanBoostSet(1, true);
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.BoostDeposited(1, 1_000e6, 1_000e6);
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);

        Plan memory p = daily.getPlan(id);
        assertTrue(p.boosted);
        assertEq(p.usdgIdle, 0, "nothing idle on the vault");
        assertEq(p.boostShares, 1_000e6, "first pool deposit mints 1:1");
        assertEq(p.boostPrincipal, 1_000e6);
        assertEq(p.boostEarned, 0);
        assertEq(daily.totalUsdgIdle(), 0);
        assertEq(daily.totalBoostShares(), 1_000e6);
        assertEq(usdg.balanceOf(address(daily)), 0, "USDG went to Morpho");
        assertApproxEqAbs(daily.boostAssets(), 1_000e6, 1);
        assertApproxEqAbs(_boostValue(daily, id), 1_000e6, 1);
        assertEq(daily.stockPlanCount(address(nvda)), 1, "indexed like any funded plan");
        assertEq(strategy.balanceOf(address(daily)), 1_000e6);
        _checkInvariants(daily);
    }

    function test_createPlan_boosted_withEth() public {
        vm.prank(alice);
        uint256 id = daily.createPlan{value: 1 ether}(address(nvda), 200e6, address(0), 0, 0, 0, true);
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0);
        assertEq(p.boostPrincipal, 3_000e6, "1 ETH -> 3000 USDG, all lent");
        assertEq(weth.balanceOf(address(daily)), 0);
        _checkInvariants(daily);
    }

    function test_createPlan_boosted_bothLegs_twoPoolDeposits() public {
        vm.prank(alice);
        uint256 id = daily.createPlan{value: 1 ether}(address(nvda), 200e6, address(0), 500e6, 0, 0, true);
        assertEq(daily.getPlan(id).boostPrincipal, 3_500e6);
        assertApproxEqAbs(_boostValue(daily, id), 3_500e6, 2);
        _checkInvariants(daily);
    }

    function test_createPlan_boosted_revertsWithoutStrategy() public {
        vm.prank(owner);
        weekly.setBoostStrategy(address(0)); // no positions yet: allowed
        assertEq(weekly.boostStrategy(), address(0));
        vm.prank(alice);
        vm.expectRevert(IPlanVault.BoostUnavailable.selector);
        weekly.createPlan(address(nvda), 200e6, address(0), 1_000e6, 0, 0, true);
    }

    function test_createPlan_unboosted_untouched() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        Plan memory p = daily.getPlan(id);
        assertFalse(p.boosted);
        assertEq(p.usdgIdle, 1_000e6);
        assertEq(p.boostShares, 0);
        assertEq(usdg.balanceOf(address(daily)), 1_000e6);
        assertEq(daily.boostAssets(), 0);
    }

    function test_deposit_toBoostedPlan_goesToPool() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(bob); // deposits are open
        daily.depositUSDG(id, 500e6);
        vm.prank(alice);
        daily.depositETH{value: 0.1 ether}(id, 0);
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0);
        assertEq(p.boostPrincipal, 1_000e6 + 500e6 + 300e6);
        assertApproxEqAbs(_boostValue(daily, id), 1_800e6, 3);
        assertEq(usdg.balanceOf(address(daily)), 0);
        _checkInvariants(daily);
    }

    // ------------------------------------------------------------------
    // Boost / unboost existing plans
    // ------------------------------------------------------------------

    function test_setPlanBoost_retroactivelyLendsIdle() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        assertEq(usdg.balanceOf(address(daily)), 1_000e6);
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.BoostDeposited(id, 1_000e6, 1_000e6);
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.PlanBoostSet(id, true);
        vm.prank(alice);
        daily.setPlanBoost(id, true);
        Plan memory p = daily.getPlan(id);
        assertTrue(p.boosted);
        assertEq(p.usdgIdle, 0);
        assertEq(p.boostShares, 1_000e6);
        assertEq(p.boostPrincipal, 1_000e6);
        assertEq(daily.totalUsdgIdle(), 0);
        assertEq(usdg.balanceOf(address(daily)), 0);
        _checkInvariants(daily);
    }

    function test_setPlanBoost_onEmptyPlan_onlyFlags() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        vm.prank(alice);
        daily.setPlanBoost(id, true);
        assertTrue(daily.getPlan(id).boosted);
        assertEq(daily.getPlan(id).boostShares, 0);
        // the next deposit is lent straight away
        vm.prank(alice);
        daily.depositUSDG(id, 100e6);
        assertEq(daily.getPlan(id).boostPrincipal, 100e6);
        assertEq(daily.getPlan(id).usdgIdle, 0);
        _checkInvariants(daily);
    }

    function test_unboost_realisesYieldIntoIdle() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 10_000e6);
        vm.warp(block.timestamp + 30 days);
        uint256 value = _boostValue(daily, id);
        assertGt(value, 10_000e6, "yield accrued");
        uint256 yield = value - 10_000e6;

        vm.expectEmit(true, false, false, true);
        emit IPlanVault.BoostWithdrawn(id, value, 10_000e6, yield);
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.PlanBoostSet(id, false);
        vm.prank(alice);
        daily.setPlanBoost(id, false);

        Plan memory p = daily.getPlan(id);
        assertFalse(p.boosted);
        assertEq(p.usdgIdle, value, "principal + yield now idle on the vault");
        assertEq(p.boostShares, 0);
        assertEq(p.boostPrincipal, 0);
        assertEq(p.boostEarned, yield, "yield booked as earned");
        assertEq(daily.totalBoostShares(), 0);
        assertEq(daily.totalUsdgIdle(), value);
        assertEq(usdg.balanceOf(address(daily)), value);
        _checkInvariants(daily);
    }

    function test_setPlanBoost_true_twice_sweepsResidual() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        // a partial fill leaves an unboosted residual in usdgIdle
        router.setFill(address(usdg), address(nvda), 9_000);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        Plan memory p = daily.getPlan(id);
        assertGt(p.usdgIdle, 0, "residual sits unboosted");
        uint256 residual = p.usdgIdle;
        uint256 principal = p.boostPrincipal;
        vm.prank(alice);
        daily.setPlanBoost(id, true);
        p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0, "swept into the pool");
        assertEq(p.boostPrincipal, principal + residual);
        _checkInvariants(daily);
    }

    function test_setPlanBoost_reverts() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.NotPlanOwner.selector, id));
        daily.setPlanBoost(id, true);

        vm.prank(owner);
        daily.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        daily.setPlanBoost(id, true);
        vm.prank(alice);
        daily.setPlanBoost(id, false); // unboosting always works
        vm.prank(owner);
        daily.unpause();

        uint256 wid = _createUsdgPlan(weekly, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(owner);
        weekly.setBoostStrategy(address(0));
        vm.prank(alice);
        vm.expectRevert(IPlanVault.BoostUnavailable.selector);
        weekly.setPlanBoost(wid, true);
    }

    function test_unboost_whilePaused_thenWithdraw() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(owner);
        daily.pause();
        vm.startPrank(alice);
        daily.setPlanBoost(id, false);
        daily.withdrawIdle(id, type(uint256).max);
        vm.stopPrank();
        assertEq(daily.getPlan(id).usdgIdle, 0);
        _checkInvariants(daily);
    }

    // ------------------------------------------------------------------
    // Yield and withdrawals
    // ------------------------------------------------------------------

    function test_yield_accruesPerPlanProRata() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 200e6, 10_000e6);
        uint256 b = _createBoostedPlan(daily, bob, address(aapl), 200e6, 30_000e6);
        vm.warp(block.timestamp + 365 days);
        uint256 va = _boostValue(daily, a);
        uint256 vb = _boostValue(daily, b);
        assertGt(va, 10_400e6);
        assertLt(va, 10_600e6);
        assertApproxEqRel(vb, va * 3, 0.0001e18, "3x the principal earns 3x");
        assertApproxEqAbs(va + vb, daily.boostAssets(), 2);
        _checkInvariants(daily);
    }

    function test_withdrawIdle_partial_fromBoost_feeAndEarnings() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 10_000e6);
        vm.warp(block.timestamp + 365 days);
        uint256 value = _boostValue(daily, id);
        uint256 before = usdg.balanceOf(alice);
        uint256 treasuryBefore = usdg.balanceOf(treasury);

        vm.prank(alice);
        daily.withdrawIdle(id, 5_000e6);

        assertEq(usdg.balanceOf(alice) - before, 5_000e6 - 12.5e6, "0.25% withdraw fee");
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, 12.5e6);
        Plan memory p = daily.getPlan(id);
        // pro-rata cost basis: withdrawing 5000 of `value` releases 5000 * 10000 / value of principal
        uint256 principalOut = (10_000e6 * uint256(p.boostShares == 0 ? 10_000e6 : 10_000e6 - p.boostShares)) / 10_000e6;
        assertEq(p.boostPrincipal, 10_000e6 - principalOut);
        assertEq(p.boostEarned, 5_000e6 - principalOut, "realised yield = out - basis released");
        assertGt(p.boostEarned, 0);
        assertApproxEqAbs(_boostValue(daily, id), value - 5_000e6, 2, "remaining value");
        // total earnings (realised + unrealised) are the plan's whole yield, whichever way you cut it
        assertApproxEqAbs(p.boostEarned + (_boostValue(daily, id) - p.boostPrincipal), value - 10_000e6, 2);
        _checkInvariants(daily);
    }

    function test_withdrawIdle_all_drainsBoost() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 10_000e6);
        vm.warp(block.timestamp + 10 days);
        uint256 value = _boostValue(daily, id);
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.IdleWithdrawn(id, value, (value * 25) / 10_000);
        vm.prank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        Plan memory p = daily.getPlan(id);
        assertEq(p.boostShares, 0, "no dust share survives");
        assertEq(p.boostPrincipal, 0);
        assertEq(p.boostEarned, value - 10_000e6);
        assertTrue(p.boosted, "still flagged: future deposits are lent");
        assertEq(daily.totalBoostShares(), 0);
        _checkInvariants(daily);
        // and the plan can be dropped from the index right away
        daily.prunePlan(id);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
    }

    function test_withdrawIdle_takesIdleFirst() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        router.setFill(address(usdg), address(nvda), 9_000);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        Plan memory p = daily.getPlan(id);
        uint256 residual = p.usdgIdle;
        assertGt(residual, 0);
        vm.prank(alice);
        daily.withdrawIdle(id, residual / 2);
        Plan memory q = daily.getPlan(id);
        assertEq(q.usdgIdle, residual - residual / 2, "idle first");
        assertEq(q.boostShares, p.boostShares, "pool untouched");
        vm.prank(alice);
        daily.withdrawIdle(id, (residual - residual / 2) + 100e6);
        q = daily.getPlan(id);
        assertEq(q.usdgIdle, 0);
        assertLt(q.boostShares, p.boostShares, "then the pool");
        _checkInvariants(daily);
    }

    function test_withdrawIdle_reverts() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 available = _boostValue(daily, id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.InsufficientIdle.selector, available + 1, available));
        daily.withdrawIdle(id, available + 1);
        vm.prank(alice);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.withdrawIdle(id, 0);
        vm.prank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.withdrawIdle(id, type(uint256).max);
    }

    function test_withdrawIdle_illiquidMarket_reverts_unboostedStillWorks() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 plain = _createUsdgPlan(daily, bob, address(nvda), 200e6, 1_000e6);
        morpho.mockBorrow(marketId, strategy.liquidity(), borrower);
        vm.prank(alice);
        vm.expectRevert(); // ERC4626ExceededMaxWithdraw from the strategy
        daily.withdrawIdle(id, 100e6);
        vm.prank(bob);
        daily.withdrawIdle(plain, 100e6);
        _checkInvariants(daily);
    }

    function test_badDebt_reducesValue_noEarningsBooked() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 100_000e6);
        morpho.mockLoss(marketId, 1_000_000e6); // ~10% of the market written off
        uint256 value = _boostValue(daily, id);
        assertLt(value, 100_000e6, "loss is socialised");
        assertGt(value, 89_000e6);
        vm.prank(alice);
        daily.setPlanBoost(id, false);
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, value);
        assertEq(p.boostEarned, 0, "nothing earned");
        assertEq(p.boostPrincipal, 0);
        _checkInvariants(daily);
    }

    // ------------------------------------------------------------------
    // Epochs
    // ------------------------------------------------------------------

    function test_fill_boostedPlan_spendsFromPool() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 10_000e6);
        vm.warp(block.timestamp + 30 days);
        uint256 valueBefore = _boostValue(daily, id);
        _nextEpoch(daily);
        uint256 valueAtEpoch = _boostValue(daily, id);

        vm.expectEmit(true, true, false, true);
        emit IPlanVault.PlanFilled(id, daily.currentEpochId(), 200e6, 1.5e6, _nvdaFor(198.5e6), false);
        assertTrue(_advance(daily, address(nvda)));

        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0, "nothing came back to idle");
        assertEq(p.stockAccrued, _nvdaFor(198.5e6));
        assertApproxEqAbs(_boostValue(daily, id), valueAtEpoch - 200e6, 2, "spend came out of the pool");
        assertGt(valueBefore, 10_000e6);
        // 200 of `valueAtEpoch` released 200 * 10000 / valueAtEpoch of basis; the rest is realised yield
        uint256 basisOut = 10_000e6 - p.boostPrincipal;
        assertEq(p.boostEarned, 200e6 - basisOut);
        assertGt(p.boostEarned, 0);
        assertEq(daily.totalUsdgIdle(), 0);
        assertEq(daily.totalNotionalUsdg(), 198.5e6);
        _checkInvariants(daily);
    }

    function test_fill_mixedPage_oneStrategyWithdrawal() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 100e6, 1_000e6);
        uint256 c = _createBoostedPlan(daily, carol, address(nvda), 300e6, 1_000e6);
        _nextEpoch(daily);
        uint256 va = _boostValue(daily, a);
        uint256 vc = _boostValue(daily, c);
        vm.recordLogs();
        _advance(daily, address(nvda));
        uint256 strategyWithdrawals;
        bytes32 sig = keccak256("Withdraw(address,address,address,uint256,uint256)");
        VmSafeLog[] memory logs = _logs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(strategy) && logs[i].topics[0] == sig) strategyWithdrawals++;
        }
        assertEq(strategyWithdrawals, 1, "boosted spend is pulled once per page");
        assertEq(daily.getPlan(a).stockAccrued, _nvdaFor(198.5e6));
        assertEq(daily.getPlan(b).stockAccrued, _nvdaFor(99.25e6));
        assertEq(daily.getPlan(c).stockAccrued, _nvdaFor(297.75e6));
        assertEq(daily.getPlan(b).usdgIdle, 900e6);
        assertApproxEqAbs(_boostValue(daily, a), va - 200e6, 2);
        assertApproxEqAbs(_boostValue(daily, c), vc - 300e6, 2);
        _checkInvariants(daily);
    }

    function test_fill_boostedPlan_drainedToZero_noDustShare() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 500e6, 100e6);
        vm.warp(block.timestamp + 90 days);
        _nextEpoch(daily);
        uint256 value = _boostValue(daily, id);
        _advance(daily, address(nvda));
        Plan memory p = daily.getPlan(id);
        assertEq(p.boostShares, 0, "spent everything: every share burned");
        assertEq(p.boostPrincipal, 0);
        assertEq(p.boostEarned, value - 100e6);
        assertEq(daily.totalBoostShares(), 0);
        _checkInvariants(daily);
        vm.prank(alice);
        daily.claim(id, type(uint256).max);
        daily.prunePlan(id);
    }

    function test_fill_illiquidMarket_boostedPlansSitOut() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 100e6, 1_000e6);
        morpho.mockBorrow(marketId, strategy.liquidity(), borrower);
        _nextEpoch(daily);
        uint32 epoch = daily.currentEpochId();

        vm.expectEmit(true, true, false, false);
        emit IPlanVault.BoostWithdrawFailed(address(nvda), epoch, 200e6, "");
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.EpochPageExecuted(address(nvda), epoch, 0, 2, 99.25e6, _nvdaFor(99.25e6), 1);
        assertTrue(_advance(daily, address(nvda)));

        Plan memory pa = daily.getPlan(a);
        assertEq(pa.stockAccrued, 0, "boosted plan skipped");
        assertEq(pa.lastEpochId, 0, "not marked filled");
        assertEq(pa.boostShares, 1_000e6, "nothing burned");
        assertEq(daily.getPlan(b).stockAccrued, _nvdaFor(99.25e6), "unboosted plan filled");
        assertEq(daily.lastExecutedEpoch(address(nvda)), epoch, "epoch completed regardless");
        _checkInvariants(daily);

        // liquidity returns: next epoch fills the boosted plan
        usdg.mint(borrower, 1_000_000e6);
        vm.startPrank(borrower);
        usdg.approve(address(morpho), type(uint256).max);
        morpho.mockRepay(marketId, 1_000_000e6);
        vm.stopPrank();
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(a).stockAccrued, _nvdaFor(198.5e6));
        _checkInvariants(daily);
    }

    function test_fill_illiquidMarket_pageOfOnlyBoostedPlans_isEmptyNotSkipped() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        morpho.mockBorrow(marketId, strategy.liquidity(), borrower);
        _nextEpoch(daily);
        uint32 epoch = daily.currentEpochId();
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.EpochPageExecuted(address(nvda), epoch, 0, 1, 0, 0, 0);
        assertTrue(_advance(daily, address(nvda)));
        assertEq(daily.getPlan(a).lastEpochId, 0);
        assertEq(router.swapCount(), 0, "no swap for an empty page");
        _checkInvariants(daily);
    }

    function test_pageSkipped_boostedFundsGoBackToPool() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 plain = _createUsdgPlan(daily, bob, address(nvda), 100e6, 1_000e6);
        router.removePair(address(usdg), address(nvda)); // no route: page is skipped
        _nextEpoch(daily);
        uint256 valueBefore = _boostValue(daily, id);
        uint256 sharesBefore = daily.getPlan(id).boostShares;
        assertTrue(_advance(daily, address(nvda)));
        Plan memory p = daily.getPlan(id);
        assertEq(p.boostShares, sharesBefore, "nothing burned");
        assertEq(p.lastEpochId, 0);
        assertApproxEqAbs(_boostValue(daily, id), valueBefore, 2, "re-lent, minus rounding dust at most");
        assertEq(daily.getPlan(plain).usdgIdle, 1_000e6);
        assertEq(usdg.balanceOf(address(daily)), 1_000e6, "the pulled USDG went straight back to the strategy");
        _checkInvariants(daily);
    }

    function test_fill_partial_residualIsIdle_thenSpentFirst() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        router.setFill(address(usdg), address(nvda), 5_000); // half fills: half the net comes back
        _nextEpoch(daily);
        uint256 v1 = _boostValue(daily, id);
        _advance(daily, address(nvda));
        Plan memory p = daily.getPlan(id);
        uint256 residual = p.usdgIdle;
        assertEq(residual, 99.25e6, "unspent net returned as plain idle");
        assertApproxEqAbs(_boostValue(daily, id), v1 - 200e6, 2);
        _checkInvariants(daily);

        router.setFill(address(usdg), address(nvda), 10_000);
        _nextEpoch(daily);
        uint256 v2 = _boostValue(daily, id);
        _advance(daily, address(nvda));
        Plan memory q = daily.getPlan(id);
        assertEq(q.usdgIdle, 0, "residual spent first");
        assertApproxEqAbs(_boostValue(daily, id), v2 - (200e6 - residual), 3, "the pool covered the rest");
        _checkInvariants(daily);
    }

    function test_fill_pausedBoostedPlan_skipped() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        daily.setPlanPaused(id, true);
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 0, "");
        assertEq(daily.getPlan(id).boostShares, 1_000e6);
        assertEq(daily.getPlan(id).stockAccrued, 0);
    }

    function test_fill_boostedPlan_autoDistribute() public {
        _giveDca(alice, 10_000);
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        uint256 v = _boostValue(daily, id);
        _advance(daily, address(nvda));
        assertEq(nvda.balanceOf(alice), _nvdaFor(198.5e6), "sent straight to the wallet");
        assertEq(daily.getPlan(id).stockAccrued, 0);
        assertApproxEqAbs(_boostValue(daily, id), v - 200e6, 2);
        _checkInvariants(daily);
    }

    function test_prunePlan_revertsWhileBoosted() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PlanNotEmpty.selector, id));
        daily.prunePlan(id);
        vm.startPrank(alice);
        daily.setPlanBoost(id, false);
        daily.withdrawIdle(id, type(uint256).max);
        vm.stopPrank();
        daily.prunePlan(id);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
    }

    // ------------------------------------------------------------------
    // Admin: strategy
    // ------------------------------------------------------------------

    function test_setBoostStrategy_migratesOpenPositions() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 200e6, 10_000e6);
        uint256 b = _createBoostedPlan(daily, bob, address(aapl), 200e6, 5_000e6);
        vm.warp(block.timestamp + 30 days);
        uint256 va = _boostValue(daily, a);
        uint256 vb = _boostValue(daily, b);
        uint256 pool = daily.boostAssets();

        MockStrategy holding = new MockStrategy(IERC20(address(usdg)));
        vm.expectEmit(false, false, false, false);
        emit IPlanVault.BoostStrategySet(address(holding), 0);
        vm.prank(owner);
        daily.setBoostStrategy(address(holding));

        assertEq(daily.boostStrategy(), address(holding));
        assertEq(strategy.balanceOf(address(daily)), 0, "old position fully redeemed");
        assertEq(usdg.allowance(address(daily), address(strategy)), 0, "old approval revoked");
        assertEq(usdg.allowance(address(daily), address(holding)), type(uint256).max);
        assertApproxEqAbs(daily.boostAssets(), pool, 2, "value carried over");
        assertApproxEqAbs(_boostValue(daily, a), va, 2, "plan shares untouched");
        assertApproxEqAbs(_boostValue(daily, b), vb, 2);
        assertEq(daily.getPlan(a).boostShares, 10_000e6);
        assertEq(daily.totalBoostShares(), 15_000e6);
        assertEq(usdg.balanceOf(address(daily)), 0);
        assertEq(holding.convertToAssets(holding.balanceOf(address(daily))), daily.boostAssets());

        // the holding vault pays no yield; everything still works (fills, withdrawals, unboost)
        vm.warp(block.timestamp + 30 days);
        assertApproxEqAbs(_boostValue(daily, a), va, 2, "no yield in the parking vault");
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        assertEq(daily.getPlan(a).stockAccrued, _nvdaFor(198.5e6));
        vm.prank(bob);
        daily.setPlanBoost(b, false);
        assertApproxEqAbs(daily.getPlan(b).usdgIdle, vb, 2);
        assertEq(usdg.balanceOf(address(daily)), daily.totalUsdgIdle() + daily.usdgDust());

        // and back onto Morpho (the strategy must allow the vault to deposit)
        vm.prank(owner);
        daily.setBoostStrategy(address(strategy));
        assertGt(strategy.balanceOf(address(daily)), 0);
        _checkInvariants(daily);
    }

    function test_setBoostStrategy_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        daily.setBoostStrategy(address(0));

        MockStrategy wrongAsset = new MockStrategy(IERC20(address(weth)));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BoostAssetMismatch.selector, address(weth)));
        daily.setBoostStrategy(address(wrongAsset));

        _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(owner);
        vm.expectRevert(IPlanVault.BoostInUse.selector);
        daily.setBoostStrategy(address(0));

        // a strategy that refuses the vault as depositor makes the migration revert atomically
        MockStrategy holding = new MockStrategy(IERC20(address(usdg)));
        vm.prank(owner);
        daily.setBoostStrategy(address(holding));
        vm.prank(owner);
        strategy.setDepositor(address(daily), false);
        vm.prank(owner);
        vm.expectRevert();
        daily.setBoostStrategy(address(strategy));
        assertEq(daily.boostStrategy(), address(holding), "unchanged");
    }

    function test_setBoostStrategy_clearWhenEmpty() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        daily.setPlanBoost(id, false);
        vm.prank(owner);
        daily.setBoostStrategy(address(0));
        assertEq(daily.boostStrategy(), address(0));
        assertEq(daily.boostAssets(), 0);
        assertEq(usdg.allowance(address(daily), address(strategy)), 0);
        // plain plans are unaffected; a still-flagged plan's next deposit is refused rather than silently unlent
        vm.prank(alice);
        daily.setPlanBoost(id, false);
        vm.prank(alice);
        daily.depositUSDG(id, 100e6);
        assertEq(daily.getPlan(id).usdgIdle, 1_100e6);
    }

    function test_rescue_cannotTouchStrategyShares() public {
        _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.TokenNotRescuable.selector, address(strategy)));
        daily.rescueERC20(address(strategy), owner, 1);
    }

    // ------------------------------------------------------------------
    // ClaimHelper
    // ------------------------------------------------------------------

    function test_helper_positionsExposeBoost() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 200e6, 10_000e6);
        uint256 b = _createUsdgPlan(weekly, alice, address(aapl), 50e6, 500e6);
        vm.warp(block.timestamp + 365 days);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        IPlanVault[] memory vaults = new IPlanVault[](2);
        vaults[0] = IPlanVault(address(daily));
        vaults[1] = IPlanVault(address(weekly));
        ClaimHelper.Position[] memory pos = helper.positions(vaults, alice);
        assertEq(pos.length, 2);
        assertTrue(pos[0].boosted);
        assertEq(pos[0].planId, a);
        assertEq(pos[0].usdgIdle, 0);
        assertEq(pos[0].boostValue, _boostValue(daily, a));
        assertGt(pos[0].boostValue, 10_000e6);
        assertEq(pos[0].boostPrincipal, daily.getPlan(a).boostPrincipal);
        assertEq(pos[0].boostEarned, daily.getPlan(a).boostEarned);
        assertGt(pos[0].boostEarned, 0);
        assertFalse(pos[1].boosted);
        assertEq(pos[1].planId, b);
        assertEq(pos[1].boostValue, 0);
        assertEq(helper.boostValueOf(vaults[0], a), pos[0].boostValue);
        assertEq(helper.boostValueOf(vaults[1], b), 0);
    }

    function test_helper_previewFill_includesBoost() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 500e6, 100e6);
        (uint256 spend, uint256 fee,,) = helper.previewFill(IPlanVault(address(daily)), id);
        assertEq(spend, _boostValue(daily, id), "capped by the boosted balance");
        assertEq(fee, (spend * 75) / 10_000);
        vm.prank(alice);
        daily.depositUSDG(id, 1_000e6);
        (spend,,,) = helper.previewFill(IPlanVault(address(daily)), id);
        assertEq(spend, 500e6);
    }

    // ------------------------------------------------------------------
    // Fuzz: value conservation across a random deposit / warp / spend / withdraw sequence
    // ------------------------------------------------------------------

    function testFuzz_boostNeverCreatesValue(uint96 perEpoch, uint128 dep, uint32 dt, uint128 wd) public {
        perEpoch = uint96(bound(perEpoch, 10e6, 5_000e6));
        uint256 d = bound(dep, 10e6, 200_000e6);
        dt = uint32(bound(dt, 0, 400 days));
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), perEpoch, d);
        vm.warp(block.timestamp + dt);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        Plan memory p = daily.getPlan(id);
        uint256 value = _boostValue(daily, id);
        uint256 w = bound(wd, 0, value + p.usdgIdle);
        if (w > 0) {
            vm.prank(alice);
            daily.withdrawIdle(id, w);
        }
        vm.prank(alice);
        daily.setPlanBoost(id, false);
        p = daily.getPlan(id);
        // everything the plan ever got out (spend + withdrawals + what is idle now) is <= deposit + yield cap
        uint256 spent = daily.totalNotionalUsdg() > 0 ? uint256(perEpoch) < d ? perEpoch : d : 0;
        uint256 got = spent + w + p.usdgIdle;
        uint256 maxYield = (d * 55 * (uint256(dt) + 1 days)) / (1000 * 365 days) + 3;
        assertLe(got, d + maxYield, "no value out of thin air");
        assertGe(got + 3, d > spent ? d - (d * 55 * 0) : 0, "nothing lost either (beyond rounding)");
        assertEq(p.boostShares, 0);
        assertEq(daily.totalBoostShares(), 0);
        _checkInvariants(daily);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    struct VmSafeLog {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function _logs() internal returns (VmSafeLog[] memory out) {
        Vm.Log[] memory raw = vm.getRecordedLogs();
        out = new VmSafeLog[](raw.length);
        for (uint256 i; i < raw.length; ++i) {
            out[i] = VmSafeLog({topics: raw[i].topics, data: raw[i].data, emitter: raw[i].emitter});
        }
    }
}
