// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "./AuditBase.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {EpochKeeper} from "../../src/keeper/EpochKeeper.sol";

/// @title M-03 regression — keepers are whitelisted end to end
///
/// v0.1: `keeperOnly` was off by default and, once on, was bypassed by the whitelisted EpochKeeper's
/// permissionless `runDue / run / performUpkeep`. Fix: `keeperOnly` defaults to true and every EpochKeeper
/// execution entry point is operator-only (owner or `isOperator`); `checkUpkeep` stays a public view.
contract AuditM03KeeperOnlyBypass is AuditBase {
    function setUp() public override {
        super.setUp();
        _usdgNvdaPool();
        vm.prank(alice);
        daily.createPlan(address(nvda), 100e6, address(0), 1_000e6, 0, 0);
        vm.prank(bob);
        daily.createPlan(address(nvda), 100e6, address(0), 1_000e6, 0, 0);
        _nextEpoch();
    }

    function test_defaultsAreClosed() public view {
        assertTrue(daily.keeperOnly());
        assertTrue(daily.isKeeper(address(epochKeeper)));
        assertTrue(epochKeeper.isOperator(keeper));
        assertFalse(epochKeeper.isOperator(mallory));
    }

    function test_noEntryPointIsOpen() public {
        uint256[] memory idx = new uint256[](1);
        vm.startPrank(mallory);
        vm.expectRevert(IPlanVault.NotKeeper.selector);
        daily.advanceEpoch(address(nvda), 0, "");
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        epochKeeper.runDue();
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        epochKeeper.run(0, 1, "");
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        epochKeeper.performUpkeep(abi.encode(idx));
        vm.stopPrank();
        assertEq(daily.lastExecutedEpoch(address(nvda)), 0);
        (bool needed,) = epochKeeper.checkUpkeep("");
        assertTrue(needed, "checkUpkeep is read-only and stays open");
    }

    function test_operatorsRun_pageSizeAndTimingAreTheirs() public {
        vm.prank(keeper);
        assertFalse(epochKeeper.run(0, 1, ""));
        assertEq(_plan(1).lastEpochId, 1);
        assertEq(_plan(2).lastEpochId, 0);
        vm.prank(keeper);
        assertEq(epochKeeper.runDue(), 1);
        assertEq(_plan(2).lastEpochId, 1);
    }

    function test_ownerCanReopenExplicitly() public {
        vm.prank(owner);
        daily.setKeeperOnly(false);
        vm.prank(mallory);
        assertTrue(daily.advanceEpoch(address(nvda), 0, ""), "explicit opt-in only");
    }
}
