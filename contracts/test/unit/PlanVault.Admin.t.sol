// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {FeeConfig, VaultParams} from "../../src/vault/VaultTypes.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {DailyVault} from "../../src/vault/DailyVault.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract PlanVaultAdminTest is BaseTest {
    function _params() internal view returns (VaultParams memory p) {
        p = VaultParams({
            owner: owner,
            usdg: address(usdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: treasury,
            epochLength: 0,
            origin: uint64(block.timestamp - (block.timestamp % 1 days)),
            purchaseFeeBps: 0
        });
    }

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    function test_constructor_defaults() public view {
        FeeConfig memory f = daily.fees();
        assertEq(f.purchaseFeeBps, 75);
        assertEq(f.depositFeeBps, 0);
        assertEq(f.withdrawFeeBps, 25);
        assertEq(f.claimFeeBps, 25);
        assertEq(f.keeperTipBps, 0);
        assertEq(f.swapSlippageBps, 50);
        assertEq(daily.autoDistributeThreshold(), 10_000e18);
        assertEq(daily.feeHalveThreshold(), 50_000e18);
        assertEq(daily.maxPlansPerTx(), 150);
        assertEq(daily.minAmountPerEpoch(), 10e6, "10 USDG");
        assertEq(daily.minDeposit(), 10e6, "10 USDG");
        assertEq(daily.dustSweepMinUsdg(), 1e6, "1 USDG");
        assertTrue(daily.keeperOnly(), "keeperOnly by default");
        assertEq(daily.usdgDecimals(), 6);
        assertEq(daily.usdg(), address(usdg));
        assertEq(daily.weth(), address(weth));
        assertEq(daily.dca(), address(dca));
        assertEq(daily.registry(), address(registry));
        assertEq(daily.router(), address(router));
        assertEq(daily.feeRecipient(), treasury);
        assertEq(daily.owner(), owner);
        assertEq(daily.vaultKind(), "daily");
        assertEq(weekly.vaultKind(), "weekly");
        assertEq(monthly.vaultKind(), "monthly");
        assertEq(usdg.allowance(address(daily), address(router)), type(uint256).max);
        assertEq(weth.allowance(address(daily), address(router)), type(uint256).max);
    }

    function test_constructor_rejectsBadOrigin() public {
        VaultParams memory p = _params();
        p.origin = 0;
        vm.expectRevert(IPlanVault.BadOrigin.selector);
        new DailyVault(p);
        p.origin = uint64(block.timestamp + 1);
        vm.expectRevert(IPlanVault.BadOrigin.selector);
        new DailyVault(p);
        p.origin = uint64(block.timestamp - 1 days);
        vm.expectRevert(IPlanVault.BadOrigin.selector);
        new DailyVault(p);
        p.origin = uint64(block.timestamp);
        new DailyVault(p); // ok: epoch 0 starts now
    }

    function test_constructor_rejectsZeroAddresses() public {
        VaultParams memory p = _params();
        p.usdg = address(0);
        vm.expectRevert(IPlanVault.ZeroAddress.selector);
        new DailyVault(p);
        p = _params();
        p.router = address(0);
        vm.expectRevert(IPlanVault.ZeroAddress.selector);
        new DailyVault(p);
        p = _params();
        p.feeRecipient = address(0);
        vm.expectRevert(IPlanVault.ZeroAddress.selector);
        new DailyVault(p);
    }

    // ------------------------------------------------------------------
    // Fees
    // ------------------------------------------------------------------

    function test_setFees_capsEveryFeeAt90() public {
        FeeConfig memory f = daily.fees();
        f.purchaseFeeBps = 90;
        f.depositFeeBps = 90;
        f.withdrawFeeBps = 90;
        f.claimFeeBps = 90;
        vm.prank(owner);
        daily.setFees(f);
        assertEq(daily.fees().claimFeeBps, 90);

        f.purchaseFeeBps = 91;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeMath.FeeTooHigh.selector, 91, 90));
        daily.setFees(f);
        f = daily.fees();
        f.claimFeeBps = 91;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeMath.FeeTooHigh.selector, 91, 90));
        daily.setFees(f);
        f = daily.fees();
        f.depositFeeBps = 91;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeMath.FeeTooHigh.selector, 91, 90));
        daily.setFees(f);
        f = daily.fees();
        f.withdrawFeeBps = 91;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeMath.FeeTooHigh.selector, 91, 90));
        daily.setFees(f);
    }

    function test_setFees_toleranceCaps() public {
        FeeConfig memory f = daily.fees();
        f.keeperTipBps = 5_001;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.ValueOutOfRange.selector, 5_001, 5_000));
        daily.setFees(f);
        f = daily.fees();
        f.swapSlippageBps = 501;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.ValueOutOfRange.selector, 501, 500));
        daily.setFees(f);
    }

    function test_setFees_feeManagerRole() public {
        FeeConfig memory f = daily.fees();
        f.purchaseFeeBps = 10;
        address mgr = makeAddr("mgr");
        vm.prank(mgr);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mgr));
        daily.setFees(f);
        vm.prank(owner);
        daily.setFeeManager(mgr);
        vm.prank(mgr);
        daily.setFees(f);
        assertEq(daily.fees().purchaseFeeBps, 10);
        // manager cannot do owner things
        vm.prank(mgr);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mgr));
        daily.setThresholds(1, 2);
    }

    function test_setThresholds() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit IPlanVault.ThresholdsSet(1e18, 2e18);
        daily.setThresholds(1e18, 2e18);
        assertEq(daily.autoDistributeThreshold(), 1e18);
        assertEq(daily.feeHalveThreshold(), 2e18);
        vm.prank(owner);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.setThresholds(0, 2e18);
    }

    function test_setMinimums() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit IPlanVault.MinimumsSet(25e6, 5e6);
        daily.setMinimums(25e6, 5e6);
        assertEq(daily.minAmountPerEpoch(), 25e6);
        assertEq(daily.minDeposit(), 5e6);
        vm.prank(owner);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.setMinimums(0, 5e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        daily.setMinimums(1e6, 1e6);
        // applies to new plans and amount changes
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 20e6, 25e6));
        daily.createPlan(address(nvda), 20e6, address(0), 100e6, 0, 0, false);
    }

    function test_setDustSweepMin() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit IPlanVault.DustSweepMinSet(5e6);
        daily.setDustSweepMin(5e6);
        assertEq(daily.dustSweepMinUsdg(), 5e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        daily.setDustSweepMin(1);
    }

    function test_setMaxPlansPerTx() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.ValueOutOfRange.selector, 0, 1_000));
        daily.setMaxPlansPerTx(0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.ValueOutOfRange.selector, 1_001, 1_000));
        daily.setMaxPlansPerTx(1_001);
        vm.prank(owner);
        daily.setMaxPlansPerTx(1_000);
        assertEq(daily.maxPlansPerTx(), 1_000);
    }

    function test_setRouter_revokesOldApproval() public {
        MockRouter r2 = new MockRouter(address(weth));
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit IPlanVault.RouterSet(address(r2));
        daily.setRouter(address(r2));
        assertEq(usdg.allowance(address(daily), address(router)), 0);
        assertEq(weth.allowance(address(daily), address(router)), 0);
        assertEq(usdg.allowance(address(daily), address(r2)), type(uint256).max);
        vm.prank(owner);
        vm.expectRevert(IPlanVault.ZeroAddress.selector);
        daily.setRouter(address(0));
    }

    function test_setFeeRecipient() public {
        vm.prank(owner);
        daily.setFeeRecipient(bob);
        assertEq(daily.feeRecipient(), bob);
        vm.prank(owner);
        vm.expectRevert(IPlanVault.ZeroAddress.selector);
        daily.setFeeRecipient(address(0));
    }

    function test_onlyOwnerGuards() public {
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        daily.setRouter(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        daily.setKeeper(bob, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        daily.setKeeperOnly(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        daily.sweepDust();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        daily.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        daily.rescueERC20(address(0x1), bob, 1);
        vm.stopPrank();
    }

    function test_setKeeper_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(IPlanVault.ZeroAddress.selector);
        daily.setKeeper(address(0), true);
    }

    function test_ownable2Step() public {
        vm.prank(owner);
        daily.transferOwnership(bob);
        assertEq(daily.owner(), owner);
        vm.prank(bob);
        daily.acceptOwnership();
        assertEq(daily.owner(), bob);
    }

    // ------------------------------------------------------------------
    // Rescue
    // ------------------------------------------------------------------

    function test_rescue_onlyForeignTokens() public {
        MockERC20 stray = new MockERC20("Stray", "STR", 18);
        stray.mint(address(daily), 5e18);
        vm.prank(owner);
        daily.rescueERC20(address(stray), bob, 5e18);
        assertEq(stray.balanceOf(bob), 5e18);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.TokenNotRescuable.selector, address(usdg)));
        daily.rescueERC20(address(usdg), bob, 1);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.TokenNotRescuable.selector, address(weth)));
        daily.rescueERC20(address(weth), bob, 1);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.TokenNotRescuable.selector, address(nvda)));
        daily.rescueERC20(address(nvda), bob, 1);
        // delisted stock is still "known" -> still protected
        registry.setApproved(address(nvda), false);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.TokenNotRescuable.selector, address(nvda)));
        daily.rescueERC20(address(nvda), bob, 1);
        vm.expectRevert(IPlanVault.ZeroAddress.selector);
        daily.rescueERC20(address(stray), address(0), 1);
        vm.stopPrank();
    }
}
