// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {TestVault} from "../mocks/TestVault.sol";
import {EpochKeeper} from "../../src/keeper/EpochKeeper.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {VaultParams} from "../../src/vault/VaultTypes.sol";

/// @dev The local-dev TestVault is plain PlanVault with a minutes-long epoch. These tests pin down what the
///      scheduler relies on: aligned origin, `isEpochDue` flipping at every boundary, and the keeper job path.
contract TestVaultTest is BaseTest {
    uint32 internal constant EPOCH = 2 minutes;

    TestVault internal tv;
    EpochKeeper internal k;
    address internal bot = makeAddr("bot");

    function setUp() public override {
        super.setUp();
        // Not on a boundary on purpose: T0 is 06:00:00, shift by 37s so alignment actually does something.
        vm.warp(T0 + 37);
        VaultParams memory p = VaultParams({
            owner: owner,
            usdg: address(usdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: treasury,
            epochLength: 0,
            origin: uint64(block.timestamp - (block.timestamp % EPOCH)),
            purchaseFeeBps: 0
        });
        tv = new TestVault(p, EPOCH);
        k = new EpochKeeper(address(usdg), owner);
        vm.startPrank(owner);
        tv.setKeeper(address(k), true);
        k.addJob(address(tv), address(nvda));
        vm.stopPrank();
        vm.prank(alice);
        usdg.approve(address(tv), type(uint256).max);
    }

    function test_params() public view {
        assertEq(tv.epochLength(), EPOCH);
        assertEq(tv.vaultKind(), "test");
        assertEq(tv.fees().purchaseFeeBps, 75);
        assertEq(tv.origin() % EPOCH, 0, "origin aligned to the epoch length");
        assertEq(tv.currentEpochId(), 0);
        assertEq(tv.nextEpochStart(), uint256(tv.origin()) + EPOCH);
    }

    function test_epochDueEveryBoundary() public {
        _createUsdgPlan(tv, alice, address(nvda), 100e6, 10_000e6);
        assertFalse(tv.isEpochDue(address(nvda)), "epoch 0 never executes");

        for (uint32 e = 1; e <= 5; ++e) {
            uint256 boundary = tv.nextEpochStart();
            vm.warp(boundary - 1);
            assertFalse(tv.isEpochDue(address(nvda)));
            vm.warp(boundary);
            assertEq(tv.currentEpochId(), e);
            assertTrue(tv.isEpochDue(address(nvda)));

            uint256[] memory due = k.dueJobs();
            assertEq(due.length, 1);
            vm.prank(bot);
            assertTrue(k.run(due[0], 0, ""));
            assertFalse(tv.isEpochDue(address(nvda)));
            assertEq(tv.lastExecutedEpoch(address(nvda)), e);
        }
        assertEq(tv.epochsCompleted(), 5);
        assertEq(tv.getPlan(1).usdgIdle, 10_000e6 - 5 * 100e6);
    }

    function test_missedEpochsAreSkippedNotCaughtUp() public {
        _createUsdgPlan(tv, alice, address(nvda), 100e6, 10_000e6);
        vm.warp(tv.nextEpochStart() + 10 * EPOCH); // scheduler was down for ten epochs
        vm.prank(bot);
        k.run(0, 0, "");
        assertEq(tv.getPlan(1).usdgIdle, 10_000e6 - 100e6, "charged once, not eleven times");
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.EpochNotDue.selector, address(nvda), tv.currentEpochId()));
        k.run(0, 0, "");
    }

    function test_badOriginReverts() public {
        VaultParams memory p = VaultParams({
            owner: owner,
            usdg: address(usdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: treasury,
            epochLength: 0,
            origin: uint64(block.timestamp - EPOCH), // a whole epoch ago: epoch 0 would not contain "now"
            purchaseFeeBps: 0
        });
        vm.expectRevert(IPlanVault.BadOrigin.selector);
        new TestVault(p, EPOCH);
    }
}
