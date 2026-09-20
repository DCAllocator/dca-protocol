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
        vm.stopPrank();
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
        router.setRate(address(usdg), address(nvda), 0, 1); // nvda swap returns zero -> vault reverts
        _nextEpoch(daily);
        vm.prank(bot);
        vm.expectEmit(true, true, false, true);
        emit EpochKeeper.JobFailed(
            address(daily), address(nvda), abi.encodeWithSelector(IPlanVault.SwapReturnedZero.selector)
        );
        uint256 ran = k.runDue();
        assertEq(ran, 1);
        assertEq(daily.lastExecutedEpoch(address(aapl)), 1);
        assertEq(daily.lastExecutedEpoch(address(nvda)), 0);
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
        f.keeperTipBps = 5_000;
        vm.prank(owner);
        daily.setFees(f);
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(bot);
        vm.expectEmit(true, false, false, true);
        emit EpochKeeper.TipsForwarded(bot, 0.75e6);
        k.runDue();
        assertEq(usdg.balanceOf(bot), 0.75e6);
        assertEq(usdg.balanceOf(address(k)), 0);
    }

    function test_run_withOverrideRequiresOperator() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        Route[] memory path = new Route[](1);
        path[0] = Route({protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 3000, extra: ""});
        bytes memory ovr = abi.encode(path, uint256(1));
        vm.prank(bot);
        vm.expectRevert(EpochKeeper.NotOperator.selector);
        k.run(0, 0, ovr);
        vm.prank(owner);
        k.setOperator(bot, true);
        vm.prank(bot);
        assertTrue(k.run(0, 0, ovr));
        assertEq(router.lastMinOut(), 1);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(EpochKeeper.JobMissing.selector, 9));
        k.run(9, 0, "");
    }

    function test_run_withoutOverrideIsPermissionless() public {
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(bot);
        assertTrue(k.run(0, 5, ""));
    }

    function test_keeperOnlyVault_worksThroughKeeperContract() public {
        vm.prank(owner);
        daily.setKeeperOnly(true);
        _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        vm.prank(bot);
        k.runDue(); // keeper contract is whitelisted on the vault
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
