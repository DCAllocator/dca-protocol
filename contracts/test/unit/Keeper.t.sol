// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {EpochKeeper} from "../../src/keeper/EpochKeeper.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {FeeConfig} from "../../src/vault/VaultTypes.sol";
import {Route} from "../../src/router/IAggregatorRouter.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract KeeperTest is BaseTest {
    EpochKeeper k;
    address bot = makeAddr("bot");

    function setUp() public override {
        super.setUp();
        k = new EpochKeeper(address(usdg), owner);
        vm.startPrank(owner);
        k.addJob(address(daily), address(nvda));
        k.addJob(address(daily), address(aapl));
        k.addJob(address(weekly), address(nvda));
        daily.setKeeper(address(k), true);
        weekly.setKeeper(address(k), true);
        k.setOperator(bot, true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // M-03 regression: every execution entry point is operator-only
    // ------------------------------------------------------------------

    function test_executionIsOperatorOnly() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        address rando = makeAddr("rando");
        uint256[] memory idx = new uint256[](1);
        vm.startPrank(rando);
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        k.runDue();
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        k.performUpkeep(abi.encode(idx));
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        k.run(0, 0, "");
        vm.stopPrank();
        assertEq(daily.lastExecutedEpoch(address(nvda)), 0, "nothing ran");
        // checkUpkeep stays open (view)
        (bool needed,) = k.checkUpkeep("");
        assertTrue(needed);
        // owner is always an operator
        vm.prank(owner);
        assertEq(k.runDue(), 1);
        // operators can be revoked
        vm.prank(owner);
        k.setOperator(bot, false);
        _nextEpoch(daily);
        vm.prank(bot);
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        k.runDue();
        vm.prank(owner);
        vm.expectRevert(EpochKeeper.ZeroAddress.selector);
        k.setOperator(address(0), true);
    }

    function test_jobs_admin() public {
        assertEq(k.jobCount(), 3);
        assertEq(k.jobs().length, 3);
        assertEq(k.job(1).stock, address(aapl));
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(EpochKeeper.JobExists.selector, address(daily), address(nvda)));
        k.addJob(address(daily), address(nvda));
        vm.expectRevert(EpochKeeper.ZeroAddress.selector);
        k.addJob(address(0), address(nvda));
        k.removeJob(0); // swap-remove: weekly/nvda moves to 0
        assertEq(k.jobCount(), 2);
        assertEq(k.job(0).vault, address(weekly));
        vm.expectRevert(abi.encodeWithSelector(EpochKeeper.JobMissing.selector, 5));
        k.removeJob(5);
        k.addJob(address(daily), address(nvda)); // re-add works after removal
        k.setJobActive(0, false);
        assertFalse(k.job(0).active);
        k.setMaxJobsPerUpkeep(0);
        assertEq(k.maxJobsPerUpkeep(), 1);
        vm.stopPrank();
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bot));
        k.addJob(address(daily), address(nvda));
    }

    function test_checkUpkeep_nothingDue() public view {
        (bool needed, bytes memory data) = k.checkUpkeep("");
        assertFalse(needed);
        assertEq(data.length, 0);
    }

    function test_runDue_runsAllDueJobsAndSkipsOthers() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _createUsdgPlan(daily, bob, address(aapl), 100e6, 1_000e6);
        _createUsdgPlan(weekly, carol, address(nvda), 50e6, 1_000e6);
        _nextEpoch(daily); // daily due, weekly not
        uint256[] memory due = k.dueJobs();
        assertEq(due.length, 2);
        (bool needed, bytes memory data) = k.checkUpkeep("");
        assertTrue(needed);
        assertEq(abi.decode(data, (uint256[])).length, 2);

        vm.prank(bot);
        vm.expectEmit(true, true, false, true);
        emit EpochKeeper.JobRun(address(daily), address(nvda), true);
        uint256 ran = k.runDue();
        assertEq(ran, 2);
        assertEq(daily.lastExecutedEpoch(address(nvda)), 1);
        assertEq(daily.lastExecutedEpoch(address(aapl)), 1);
        assertEq(weekly.lastExecutedEpoch(address(nvda)), 0);
        assertEq(k.dueJobs().length, 0);
    }

    function test_performUpkeep_batchAndRecheck() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _createUsdgPlan(daily, bob, address(aapl), 100e6, 1_000e6);
        vm.prank(owner);
        k.setMaxJobsPerUpkeep(1);
        _nextEpoch(daily);
        (, bytes memory data) = k.checkUpkeep("");
        assertEq(abi.decode(data, (uint256[])).length, 1);
        vm.prank(bot);
        k.performUpkeep(data);
        assertEq(daily.lastExecutedEpoch(address(nvda)), 1);
        assertEq(daily.lastExecutedEpoch(address(aapl)), 0);
        // stale / out-of-range perform data is ignored, not reverted
        uint256[] memory idx = new uint256[](2);
        idx[0] = 0;
        idx[1] = 99;
        vm.prank(bot);
        k.performUpkeep(abi.encode(idx));
        (, data) = k.checkUpkeep("");
        vm.prank(bot);
        k.performUpkeep(data);
        assertEq(daily.lastExecutedEpoch(address(aapl)), 1);
    }

    function test_failingJobDoesNotBlockOthers() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _createUsdgPlan(daily, bob, address(aapl), 100e6, 1_000e6);
        _nextEpoch(daily);
        // A job can still fail hard (e.g. the vault is paused between checkUpkeep and perform); it must not block others.
        vm.prank(owner);
        daily.pause();
        vm.prank(owner);
        weekly.setKeeper(address(k), false); // weekly/nvda is not due anyway
        _createUsdgPlan(weekly, carol, address(nvda), 50e6, 1_000e6);
        vm.warp(weekly.nextEpochStart());
        vm.prank(bot);
        vm.expectEmit(true, true, false, true);
        emit EpochKeeper.JobFailed(
            address(weekly), address(nvda), abi.encodeWithSelector(IPlanVault.NotKeeper.selector)
        );
        uint256 ran = k.runDue();
        assertEq(ran, 0, "daily paused (not due), weekly keeper revoked (fails)");
        vm.prank(owner);
        daily.unpause();
        vm.prank(bot);
        assertEq(k.runDue(), 2, "daily jobs run; weekly still fails and is isolated");
        assertEq(daily.lastExecutedEpoch(address(aapl)), daily.currentEpochId());
        assertEq(daily.lastExecutedEpoch(address(nvda)), daily.currentEpochId());
        assertEq(weekly.lastExecutedEpoch(address(nvda)), 0);
    }

    function test_zeroOutputPoolIsSkippedNotFailed() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        router.setRate(address(usdg), address(nvda), 0, 1); // pool returns nothing -> page skipped, job "ran"
        _nextEpoch(daily);
        vm.prank(bot);
        vm.expectEmit(true, true, false, true);
        emit EpochKeeper.JobRun(address(daily), address(nvda), true);
        assertEq(k.runDue(), 1);
        assertEq(daily.getPlan(id).usdgIdle, 1_000e6, "nobody charged");
        assertEq(daily.lastExecutedEpoch(address(nvda)), 1);
    }

    function test_pagination_multipleRuns() public {
        for (uint256 i; i < 3; ++i) {
            address u = makeAddr(string(abi.encodePacked("k", i)));
            _fund(u);
            _createUsdgPlan(daily, u, address(nvda), 100e6, 1_000e6);
        }
        vm.prank(owner);
        daily.setMaxPlansPerTx(2);
        _nextEpoch(daily);
        vm.prank(bot);
        k.runDue();
        assertTrue(daily.isEpochPending(address(nvda)));
        assertEq(k.dueJobs().length, 1, "still due until the cursor finishes");
        vm.prank(bot);
        k.runDue();
        assertFalse(daily.isEpochDue(address(nvda)));
    }

    function test_tipsForwardedToCaller() public {
        FeeConfig memory f = daily.fees();
        f.keeperTipBps = 1_000; // 10%, the cap since audit v0.3 L-04
        vm.prank(owner);
        daily.setFees(f);
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(bot);
        vm.expectEmit(true, false, false, true);
        emit EpochKeeper.TipsForwarded(bot, 0.15e6);
        k.runDue();
        assertEq(usdg.balanceOf(bot), 0.15e6);
        assertEq(usdg.balanceOf(address(k)), 0);
    }

    function test_run_withOverride() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        Route[] memory path = new Route[](1);
        path[0] = Route({protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 3000, extra: ""});
        (uint256 q,) = router.quote(address(usdg), address(nvda), 198.5e6);
        uint256 minOut = (q * 9_950) / 10_000; // the auto-route floor
        bytes memory ovr = abi.encode(path, minOut);
        vm.prank(makeAddr("rando"));
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        k.run(0, 0, ovr);
        // an override below the auto floor is refused by the vault and bubbles (page not consumed)
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.OverrideMinOutTooLow.selector, minOut - 1, minOut));
        k.run(0, 0, abi.encode(path, minOut - 1));
        vm.prank(bot);
        assertTrue(k.run(0, 0, ovr));
        assertEq(router.lastMinOut(), minOut);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(EpochKeeper.JobMissing.selector, 9));
        k.run(9, 0, "");
    }

    function test_run_withoutOverride() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(bot);
        assertTrue(k.run(0, 5, ""));
    }

    function test_keeperOnlyVault_worksThroughKeeperContractForOperators() public {
        assertTrue(daily.keeperOnly(), "default");
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(bot);
        k.runDue(); // keeper contract is whitelisted on the vault; bot is an operator on the keeper
        assertEq(daily.lastExecutedEpoch(address(nvda)), 1);
    }

    function test_inactiveJobNotDue() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(owner);
        k.setJobActive(0, false);
        _nextEpoch(daily);
        assertEq(k.dueJobs().length, 0);
    }

    function test_nonContractVaultRejected() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(EpochKeeper.NotAContract.selector, address(0xdead)));
        k.addJob(address(0xdead), address(nvda));
    }

    function test_revertingVaultIsNotDue() public {
        // A vault whose isEpochDue reverts (here: a contract without that function) is simply not due.
        vm.prank(owner);
        k.addJob(address(usdg), address(nvda));
        assertEq(k.dueJobs().length, 0);
    }
}
