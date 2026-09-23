// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {Plan, FeeConfig} from "../../src/vault/VaultTypes.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract PlanVaultPlansTest is BaseTest {
    // ------------------------------------------------------------------
    // createPlan
    // ------------------------------------------------------------------

    function test_createPlan_basic() public {
        vm.expectEmit(true, true, true, true);
        emit IPlanVault.PlanCreated(1, alice, address(nvda), 200e6, alice);
        vm.prank(alice);
        uint256 id = daily.createPlan(address(nvda), 200e6, address(0), 1_000e6, 0, 0, false);
        assertEq(id, 1);
        Plan memory p = daily.getPlan(id);
        assertEq(p.owner, alice);
        assertEq(p.recipient, alice);
        assertEq(p.stock, address(nvda));
        assertEq(p.amountPerEpoch, 200e6);
        assertEq(p.usdgIdle, 1_000e6);
        assertEq(daily.stockPlanCount(address(nvda)), 1);
        assertEq(daily.userPlans(alice).length, 1);
        assertEq(daily.nextPlanId(), 2);
    }

    function test_createPlan_withUsdgDeposit() public {
        uint256 before = usdg.balanceOf(alice);
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        assertEq(usdg.balanceOf(alice), before - 1_000e6);
        assertEq(daily.getPlan(id).usdgIdle, 1_000e6);
        assertEq(daily.totalUsdgIdle(), 1_000e6);
        assertEq(usdg.balanceOf(address(daily)), 1_000e6);
    }

    function test_createPlan_withEth_zappedToUsdg() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.WethZapped(1, 1 ether, 3_000e6, 0);
        uint256 id = daily.createPlan{value: 1 ether}(address(nvda), 200e6, address(0), 0, 0, 0, false);
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 3_000e6, "1 ETH zapped to 3000 USDG");
        assertEq(weth.balanceOf(address(daily)), 0, "vault never holds WETH");
        assertEq(address(daily).balance, 0, "no stray ETH");
    }

    function test_createPlan_withWethAndUsdg() public {
        vm.prank(alice);
        uint256 id = daily.createPlan(address(nvda), 200e6, bob, 500e6, 2 ether, 0, false);
        Plan memory p = daily.getPlan(id);
        assertEq(p.recipient, bob);
        assertEq(p.usdgIdle, 500e6 + 6_000e6);
        assertEq(weth.balanceOf(address(daily)), 0);
    }

    function test_createPlan_minOutRespected() public {
        vm.prank(alice);
        vm.expectRevert(); // MockRouter InsufficientOutput
        daily.createPlan(address(nvda), 200e6, address(0), 0, 1 ether, 3_001e6, false);
    }

    function test_createPlan_revertsUnapprovedStock() public {
        MockERC20 rogue = new MockERC20("Rogue", "RG", 18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.StockNotPurchasable.selector, address(rogue)));
        daily.createPlan(address(rogue), 200e6, address(0), 1_000e6, 0, 0, false);
    }

    function test_createPlan_revertsFeeOnTransferStock() public {
        vm.prank(owner);
        registry.setFeeOnTransfer(address(nvda), true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.StockNotPurchasable.selector, address(nvda)));
        daily.createPlan(address(nvda), 200e6, address(0), 1_000e6, 0, 0, false);
    }

    function test_createPlan_revertsBelowMinAmountPerEpoch() public {
        assertEq(daily.minAmountPerEpoch(), 10e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 0, 10e6));
        daily.createPlan(address(nvda), 0, address(0), 1_000e6, 0, 0, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 10e6 - 1, 10e6));
        daily.createPlan(address(nvda), 10e6 - 1, address(0), 1_000e6, 0, 0, false);
        vm.prank(alice);
        daily.createPlan(address(nvda), 10e6, address(0), 1_000e6, 0, 0, false);
    }

    function test_createPlan_revertsBelowMinDeposit() public {
        assertEq(daily.minDeposit(), 10e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 0, 10e6));
        daily.createPlan(address(nvda), 200e6, address(0), 0, 0, 0, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 10e6 - 1, 10e6));
        daily.createPlan(address(nvda), 200e6, address(0), 10e6 - 1, 0, 0, false);
        // legs add up: 6 USDG + ETH worth 6 USDG (0.002 ETH) clears the 10 USDG minimum
        vm.prank(alice);
        daily.createPlan{value: 0.002 ether}(address(nvda), 200e6, address(0), 6e6, 0, 0, false);
        assertEq(daily.stockPlanCount(address(nvda)), 1, "only funded plans are indexed");
    }

    function test_createPlan_revertsWhenPaused() public {
        vm.prank(owner);
        daily.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        daily.createPlan(address(nvda), 200e6, address(0), 1_000e6, 0, 0, false);
    }

    function test_manyPlansPerUser() public {
        _createUsdgPlan(daily, alice, address(nvda), 100e6, 100e6);
        _createUsdgPlan(daily, alice, address(aapl), 50e6, 100e6);
        _createUsdgPlan(daily, alice, address(nvda), 25e6, 100e6);
        assertEq(daily.userPlans(alice).length, 3);
        assertEq(daily.stockPlanCount(address(nvda)), 2);
        assertEq(daily.stockPlanCount(address(aapl)), 1);
    }

    // ------------------------------------------------------------------
    // deposits
    // ------------------------------------------------------------------

    function test_depositUSDG_anyoneCanFund() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(bob);
        vm.expectEmit(true, true, false, true);
        emit IPlanVault.Deposited(id, address(usdg), bob, 300e6, 0);
        daily.depositUSDG(id, 300e6);
        assertEq(daily.getPlan(id).usdgIdle, 400e6);
    }

    function test_depositUSDG_revertsUnknownPlan() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PlanNotFound.selector, 42));
        daily.depositUSDG(42, 100e6);
    }

    function test_depositUSDG_revertsZeroAndBelowMin() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(alice);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.depositUSDG(id, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 1, 10e6));
        daily.depositUSDG(id, 1);
    }

    function test_deposit_revertsWhenStockDelisted() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(owner);
        registry.setApproved(address(nvda), false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.StockNotPurchasable.selector, address(nvda)));
        daily.depositUSDG(id, 100e6);
    }

    function test_deposit_revertsWhenPaused() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(owner);
        daily.pause();
        vm.startPrank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        daily.depositUSDG(id, 100e6);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        daily.depositWETH(id, 1 ether, 0);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        daily.depositETH{value: 1 ether}(id, 0);
        vm.stopPrank();
    }

    function test_depositWETH_zappedToUsdg() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(alice);
        daily.depositWETH(id, 1 ether, 2_999e6);
        assertEq(daily.getPlan(id).usdgIdle, 3_100e6);
        assertEq(weth.balanceOf(address(daily)), 0);
    }

    function test_depositWETH_partialFillRefundsLeftoverToDepositor() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        router.setFill(address(weth), address(usdg), 5_000); // only half consumed
        uint256 before = weth.balanceOf(bob);
        vm.prank(bob);
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.WethZapped(id, 0.5 ether, 1_500e6, 0.5 ether);
        daily.depositWETH(id, 1 ether, 1_400e6); // explicit minOut: depositor accepts the partial fill
        assertEq(daily.getPlan(id).usdgIdle, 1_600e6);
        assertEq(weth.balanceOf(bob), before - 0.5 ether, "unspent WETH went straight back to the depositor");
        assertEq(weth.balanceOf(address(daily)), 0, "vault never holds WETH");
    }

    function test_depositETH_zappedToUsdg() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(alice);
        daily.depositETH{value: 0.5 ether}(id, 0);
        assertEq(daily.getPlan(id).usdgIdle, 100e6 + 1_500e6);
        assertEq(address(daily).balance, 0);
    }

    function test_depositETH_revertsBelowMinDeposit() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 3e6, 10e6));
        daily.depositETH{value: 0.001 ether}(id, 0);
    }

    function test_depositFee_whenEnabled() public {
        FeeConfig memory f = daily.fees();
        f.depositFeeBps = 90;
        vm.prank(owner);
        daily.setFees(f);
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        uint256 fee0 = usdg.balanceOf(treasury);
        vm.prank(alice);
        daily.depositUSDG(id, 1_000e6);
        assertEq(daily.getPlan(id).usdgIdle, 99.1e6 + 991e6);
        assertEq(usdg.balanceOf(treasury) - fee0, 9e6);
        // ETH path too
        vm.prank(alice);
        daily.depositETH{value: 1 ether}(id, 0);
        assertEq(weth.balanceOf(treasury), 0.009 ether);
    }

    function test_depositFee_defaultZero() public {
        assertEq(daily.fees().depositFeeBps, 0);
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        assertEq(daily.getPlan(id).usdgIdle, 1_000e6);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    // ------------------------------------------------------------------
    // withdrawIdle
    // ------------------------------------------------------------------

    function test_withdrawIdle_usdgFee() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.IdleWithdrawn(id, 400e6, 1e6);
        daily.withdrawIdle(id, 400e6);
        assertEq(usdg.balanceOf(alice), before + 399e6, "25 bps withdraw fee");
        assertEq(usdg.balanceOf(treasury), 1e6);
        assertEq(daily.getPlan(id).usdgIdle, 600e6);
        assertEq(daily.totalUsdgIdle(), 600e6);
    }

    function test_withdrawIdle_all_sentinel() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        assertEq(daily.getPlan(id).usdgIdle, 0);
        assertEq(usdg.balanceOf(address(daily)), 0);
    }

    function test_withdrawIdle_revertsNotOwner() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.NotPlanOwner.selector, id));
        daily.withdrawIdle(id, 1e6);
    }

    function test_withdrawIdle_revertsInsufficient() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.InsufficientIdle.selector, 101e6, 100e6));
        daily.withdrawIdle(id, 101e6);
    }

    function test_withdrawIdle_revertsZero() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(alice);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.withdrawIdle(id, 0);
    }

    function test_withdrawIdle_worksWhilePaused() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(owner);
        daily.pause();
        vm.prank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        assertEq(daily.getPlan(id).usdgIdle, 0);
    }

    function test_withdrawIdle_zeroFee() public {
        FeeConfig memory f = daily.fees();
        f.withdrawFeeBps = 0;
        vm.prank(owner);
        daily.setFees(f);
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        daily.withdrawIdle(id, 100e6);
        assertEq(usdg.balanceOf(alice), before + 100e6);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    // ------------------------------------------------------------------
    // plan settings
    // ------------------------------------------------------------------

    function test_setPlanPaused() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit IPlanVault.PlanPausedSet(id, true);
        daily.setPlanPaused(id, true);
        assertTrue(daily.getPlan(id).paused);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.NotPlanOwner.selector, id));
        daily.setPlanPaused(id, false);
    }

    function test_setPlanAmount() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(alice);
        daily.setPlanAmount(id, 50e6);
        assertEq(daily.getPlan(id).amountPerEpoch, 50e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 5e6, 10e6));
        daily.setPlanAmount(id, 5e6);
    }

    function test_setPlanRecipient() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(alice);
        daily.setPlanRecipient(id, carol);
        assertEq(daily.getPlan(id).recipient, carol);
        vm.prank(alice);
        vm.expectRevert(IPlanVault.ZeroAddress.selector);
        daily.setPlanRecipient(id, address(0));
    }

    // ------------------------------------------------------------------
    // prune / re-index
    // ------------------------------------------------------------------

    function _emptyPlan(address user) internal returns (uint256 id) {
        id = _createUsdgPlan(daily, user, address(nvda), 200e6, 100e6);
        vm.prank(user);
        daily.withdrawIdle(id, type(uint256).max);
    }

    function test_prunePlan_removesAndReindexes() public {
        uint256 a = _emptyPlan(alice);
        uint256 b = _createUsdgPlan(daily, bob, address(nvda), 200e6, 100e6);
        uint256 c = _emptyPlan(carol);
        assertEq(daily.stockPlanCount(address(nvda)), 3);

        vm.expectEmit(true, true, true, true);
        emit IPlanVault.PlanIndexed(a, address(nvda), false);
        daily.prunePlan(a); // anyone
        assertEq(daily.stockPlanCount(address(nvda)), 2);

        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PlanNotEmpty.selector, b));
        daily.prunePlan(b);

        daily.prunePlan(c);
        assertEq(daily.stockPlanCount(address(nvda)), 1);
        // idempotent
        daily.prunePlan(c);
        assertEq(daily.stockPlanCount(address(nvda)), 1);

        // a (minimum-sized) deposit re-indexes
        vm.prank(alice);
        daily.depositUSDG(a, 10e6);
        assertEq(daily.stockPlanCount(address(nvda)), 2);

        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PlanNotFound.selector, 99));
        daily.prunePlan(99);
    }

    function test_prunePlan_revertsDuringPendingEpoch() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _createUsdgPlan(daily, bob, address(nvda), 200e6, 1_000e6);
        uint256 c = _emptyPlan(carol);
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, ""); // page 1 of 3 -> pending
        assertTrue(daily.isEpochPending(address(nvda)));
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.EpochInProgress.selector, address(nvda)));
        daily.prunePlan(c);
        // finish the epoch and prune again
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 0, "");
        assertFalse(daily.isEpochPending(address(nvda)));
        daily.prunePlan(c);
    }

    // ------------------------------------------------------------------
    // remove sequence (pins the behaviour the frontend's "Withdraw & remove" composes: withdrawIdle(MAX) ->
    // claim(MAX) -> prunePlan; closePlan is the one-call version of the same legs)
    // ------------------------------------------------------------------

    function test_removeSequence_plain() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda)); // one fill: 200 spent, 75 bps fee, 198.5 net -> NVDA accrued
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 800e6);
        uint256 stock = p.stockAccrued;
        assertEq(stock, _nvdaFor(198.5e6));

        uint256 aliceUsdg = usdg.balanceOf(alice);
        uint256 treasuryUsdg = usdg.balanceOf(treasury);
        vm.startPrank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        daily.claim(id, type(uint256).max);
        vm.stopPrank();

        assertEq(usdg.balanceOf(alice) - aliceUsdg, 800e6 - 2e6, "idle back to the caller minus 25 bps");
        assertEq(usdg.balanceOf(treasury) - treasuryUsdg, 2e6, "withdraw fee to the treasury");
        uint256 claimFee = (stock * 25) / 10_000;
        assertEq(nvda.balanceOf(alice), stock - claimFee, "stock to the recipient minus 25 bps");
        assertEq(nvda.balanceOf(treasury), claimFee, "claim fee to the treasury");
        p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0);
        assertEq(p.stockAccrued, 0);
        assertEq(p.boostShares, 0);
        assertEq(daily.stockPlanCount(address(nvda)), 1, "empty but still indexed until pruned");

        vm.expectEmit(true, true, true, true);
        emit IPlanVault.PlanIndexed(id, address(nvda), false);
        daily.prunePlan(id);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
        assertEq(daily.getPlan(id).owner, alice, "the record persists (a deposit re-indexes it)");
    }

    function test_removeSequence_midEpoch() public {
        uint256 a = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _createUsdgPlan(daily, bob, address(nvda), 200e6, 1_000e6);
        uint256 c = _createUsdgPlan(daily, carol, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 1, ""); // page 1 of 3: alice filled, cursor open
        assertTrue(daily.isEpochPending(address(nvda)));

        // withdraw and claim are never blocked by an open cursor
        vm.startPrank(alice);
        daily.withdrawIdle(a, type(uint256).max);
        daily.claim(a, type(uint256).max);
        vm.stopPrank();
        Plan memory p = daily.getPlan(a);
        assertEq(p.usdgIdle, 0);
        assertEq(p.stockAccrued, 0);
        // only the prune is: its swap-and-pop would move a plan across the page cursor
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.EpochInProgress.selector, address(nvda)));
        daily.prunePlan(a);
        assertEq(daily.stockPlanCount(address(nvda)), 3, "the emptied plan stays indexed");

        // a plan emptied before its page is simply skipped by that page
        vm.prank(carol);
        daily.withdrawIdle(c, type(uint256).max);
        vm.prank(keeper);
        daily.advanceEpoch(address(nvda), 0, "");
        assertFalse(daily.isEpochPending(address(nvda)));
        assertEq(daily.getPlan(c).stockAccrued, 0, "nothing bought for an empty plan");
        assertEq(daily.getPlan(c).lastEpochId, 0, "not marked filled");

        daily.prunePlan(a);
        daily.prunePlan(c);
        assertEq(daily.stockPlanCount(address(nvda)), 1);
    }

    function test_removeSequence_whilePausedAndDelisted() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        vm.startPrank(owner);
        daily.pause();
        registry.setApproved(address(nvda), false);
        vm.stopPrank();

        uint256 before = usdg.balanceOf(alice);
        vm.startPrank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        daily.claim(id, type(uint256).max);
        vm.stopPrank();
        assertEq(usdg.balanceOf(alice) - before, 800e6 - 2e6, "exit works while paused and delisted");
        assertGt(nvda.balanceOf(alice), 0);
        daily.prunePlan(id);
        assertEq(daily.stockPlanCount(address(nvda)), 0);

        // the way back in stays closed while the stock is delisted
        vm.prank(owner);
        daily.unpause();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.StockNotPurchasable.selector, address(nvda)));
        daily.depositUSDG(id, 100e6);
    }

    function test_removeSequence_nonOwner() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        Plan memory before = daily.getPlan(id);

        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.NotPlanOwner.selector, id));
        daily.setPlanBoost(id, false);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.NotPlanOwner.selector, id));
        daily.withdrawIdle(id, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.NotPlanOwner.selector, id));
        daily.claim(id, type(uint256).max);
        // prune is permissionless but only ever drops an EMPTY plan
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PlanNotEmpty.selector, id));
        daily.prunePlan(id);
        vm.stopPrank();

        // an unknown id reads as "not yours", never as "not found", on the owner-gated legs
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.NotPlanOwner.selector, 99));
        daily.withdrawIdle(99, type(uint256).max);

        Plan memory later = daily.getPlan(id);
        assertEq(later.usdgIdle, before.usdgIdle);
        assertEq(later.stockAccrued, before.stockAccrued);
        assertEq(daily.stockPlanCount(address(nvda)), 1);
    }

    function test_noReceive_rejectsStrayEth() public {
        vm.prank(alice);
        (bool ok,) = address(daily).call{value: 1 ether}("");
        assertFalse(ok);
    }
}
