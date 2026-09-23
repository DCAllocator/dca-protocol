// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {BlockingToken} from "../../mocks/BlockingToken.sol";
import {DailyVault} from "../../../src/vault/DailyVault.sol";
import {VaultParams, Plan, FeeConfig} from "../../../src/vault/VaultTypes.sol";
import {EpochLib} from "../../../src/libraries/EpochLib.sol";

/// @title AUDIT v0.4 — `closePlan` amplifies accepted L-06 (push-style fee transfers vs a blocked `feeRecipient`)
///
/// L-06 (accepted): a token that refuses `feeRecipient` makes the fee-paying leg revert until the owner zeroes
/// that fee or moves the recipient. With the single legs only the affected leg blocks: a blocked stock still lets
/// the USDG leave, a blocked USDG still lets the stock leave. `closePlan` is atomic, so a block on EITHER token
/// reverts the whole close — with state untouched (nothing half-done) — which is why the single entries stay and
/// the frontend falls back to them. Runbook (audit/AUDIT-FeeReceiver.md R-05): the FeeReceiver must be allowlisted
/// on every listed stock and on USDG before it becomes `feeRecipient`.
contract Audit4_ClosePlan_BlockedFeeRecipient is BaseTest {
    BlockingToken blk;

    function setUp() public override {
        super.setUp();
        blk = new BlockingToken();
        vm.prank(owner);
        registry.listStock(address(blk), "BLK", false, true);
        router.setRate(address(usdg), address(blk), 1e18, 100e6);
    }

    // ------------------------------------------------------------------
    // Stock side blocked
    // ------------------------------------------------------------------

    function test_stockBlocksTreasury_closeRevertsAtomically_usdgLegStillWorksAlone() public {
        uint256 id = _createUsdgPlan(daily, alice, address(blk), 100e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(blk));
        blk.setBlocked(treasury, true);
        Plan memory before = daily.getPlan(id);
        uint256 aliceUsdg = usdg.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert("BLK: recipient blocked");
        daily.closePlan(id);
        Plan memory later = daily.getPlan(id);
        assertEq(later.usdgIdle, before.usdgIdle, "atomic: the USDG leg was rolled back too");
        assertEq(later.stockAccrued, before.stockAccrued);
        assertEq(usdg.balanceOf(alice), aliceUsdg);
        assertEq(daily.stockPlanCount(address(blk)), 1);
        assertFalse(later.paused);

        // the single legs are the fallback: the unaffected token still leaves
        vm.prank(alice);
        daily.withdrawIdle(id, type(uint256).max);
        assertEq(usdg.balanceOf(alice) - aliceUsdg, 900e6 - 2.25e6);
        vm.prank(alice);
        vm.expectRevert("BLK: recipient blocked");
        daily.claim(id, type(uint256).max);

        // admin remedy: no claim fee => no transfer to the blocked treasury => the close goes through
        FeeConfig memory f = daily.fees();
        f.claimFeeBps = 0;
        vm.prank(owner);
        daily.setFees(f);
        vm.prank(alice);
        daily.closePlan(id);
        assertEq(blk.balanceOf(alice), before.stockAccrued, "whole stock, no fee");
        assertEq(daily.stockPlanCount(address(blk)), 0);
    }

    function test_stockBlocksRecipient_closeReverts_ownerMovesRecipientAndCloses() public {
        vm.prank(alice);
        uint256 id = daily.createPlan(address(blk), 100e6, bob, 1_000e6, 0, 0, false);
        _nextEpoch(daily);
        _advance(daily, address(blk));
        blk.setBlocked(bob, true); // the plan's own recipient is refused by the token
        vm.prank(alice);
        vm.expectRevert("BLK: recipient blocked");
        daily.closePlan(id);
        vm.prank(alice);
        daily.setPlanRecipient(id, alice);
        vm.prank(alice);
        daily.closePlan(id);
        assertGt(blk.balanceOf(alice), 0);
        assertEq(daily.stockPlanCount(address(blk)), 0);
    }

    // ------------------------------------------------------------------
    // USDG side blocked (a vault whose USDG is a permissioned token)
    // ------------------------------------------------------------------

    /// @dev A second DailyVault denominated in a BlockingToken standing in for USDG (18 decimals: minimums scale).
    function _usdgSideVault() internal returns (DailyVault v, BlockingToken bUsdg) {
        bUsdg = new BlockingToken();
        router.setRate(address(bUsdg), address(nvda), 1e18, 500e18); // 1 NVDA = 500 bUSDG
        VaultParams memory p = VaultParams({
            owner: owner,
            usdg: address(bUsdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: treasury,
            epochLength: 0,
            origin: uint64(EpochLib.alignToDay(block.timestamp)),
            purchaseFeeBps: 0
        });
        v = new DailyVault(p);
        vm.startPrank(owner);
        v.setKeeper(keeper, true);
        v.setPriceGuard(300, false, address(0), 0);
        vm.stopPrank();
        bUsdg.mint(alice, 100_000e18);
        vm.prank(alice);
        bUsdg.approve(address(v), type(uint256).max);
    }

    function test_usdgBlocksTreasury_closeRevertsAtomically_stockLegStillWorksAlone() public {
        (DailyVault v, BlockingToken bUsdg) = _usdgSideVault();
        vm.prank(alice);
        uint256 id = v.createPlan(address(nvda), 200e18, address(0), 1_000e18, 0, 0, false);
        vm.warp(v.nextEpochStart());
        vm.prank(keeper);
        v.advanceEpoch(address(nvda), 0, "");
        Plan memory before = v.getPlan(id);
        assertEq(before.usdgIdle, 800e18);
        assertGt(before.stockAccrued, 0);
        bUsdg.setBlocked(treasury, true);

        vm.prank(alice);
        vm.expectRevert("BLK: recipient blocked");
        v.closePlan(id);
        Plan memory later = v.getPlan(id);
        assertEq(later.usdgIdle, before.usdgIdle, "atomic: nothing left the vault");
        assertEq(later.stockAccrued, before.stockAccrued);
        assertEq(nvda.balanceOf(alice), 0);
        assertEq(v.stockPlanCount(address(nvda)), 1);

        // the stock leg alone is unaffected (today's "other leg pays")
        vm.prank(alice);
        v.claim(id, type(uint256).max);
        assertGt(nvda.balanceOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert("BLK: recipient blocked");
        v.withdrawIdle(id, type(uint256).max);

        // admin remedy on the USDG side: zero the withdraw fee
        FeeConfig memory f = v.fees();
        f.withdrawFeeBps = 0;
        vm.prank(owner);
        v.setFees(f);
        uint256 aliceB = bUsdg.balanceOf(alice);
        vm.prank(alice);
        v.closePlan(id);
        assertEq(bUsdg.balanceOf(alice) - aliceB, 800e18, "whole idle, no fee");
        assertEq(v.stockPlanCount(address(nvda)), 0);
        assertEq(v.totalUsdgIdle(), 0);
    }

    /// @dev Moving `feeRecipient` to an allowed address is the other remedy; it keeps the fee.
    function test_usdgBlocksTreasury_ownerMovesFeeRecipient() public {
        (DailyVault v, BlockingToken bUsdg) = _usdgSideVault();
        vm.prank(alice);
        uint256 id = v.createPlan(address(nvda), 200e18, address(0), 1_000e18, 0, 0, false);
        bUsdg.setBlocked(treasury, true);
        vm.prank(alice);
        vm.expectRevert("BLK: recipient blocked");
        v.closePlan(id);
        address treasury2 = makeAddr("treasury2");
        vm.prank(owner);
        v.setFeeRecipient(treasury2);
        vm.prank(alice);
        v.closePlan(id);
        assertEq(bUsdg.balanceOf(treasury2), 2.5e18, "25 bps of 1000");
        assertEq(v.stockPlanCount(address(nvda)), 0);
    }
}
