// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "./AuditBase.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {IAggregatorRouter} from "../../src/router/IAggregatorRouter.sol";
import {Plan} from "../../src/vault/VaultTypes.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockV3Pool} from "../mocks/MockV3.sol";

/// @title H-01 regression — a single plan can no longer brick a stock's epochs
///
/// v0.1: a zap-at-epoch plan with a 1-unit deficit made the unguarded `quoteWithImpact` in `_zapWeth` revert
/// `NoRoute`, taking every page it sat on with it, permanently. Fix: (1) vaults are USDG-only — ETH/WETH is
/// converted at deposit, there is no WETH sizing at epoch; (2) `minAmountPerEpoch` / `minDeposit` (10 USDG)
/// keep dust plans out of the index; (3) since v0.3 a page that cannot be bought REVERTS and is retried (the
/// operator changes `limit` or waits), and the page notional cap keeps any single plan from blocking the rest.
contract AuditH01ZapDustDoS is AuditBase {
    MockV3Pool wethUsdg;
    MockV3Pool usdgNvda;

    function setUp() public override {
        super.setUp();
        wethUsdg = _wethUsdgPool();
        usdgNvda = _usdgNvdaPool();
    }

    /// The v0.1 attack transaction is rejected outright: the amount and the deposit are both below the minimums.
    function test_attackPlanCannotBeCreated() public {
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 1, 10e6));
        daily.createPlan(address(nvda), 1, address(0), 0, 0.001 ether, 0, false);
        // minimum-sized amount but dust funding: 0.001 ETH = 3 USDG < 10 USDG minimum deposit
        vm.prank(mallory);
        vm.expectPartialRevert(IPlanVault.BelowMinimum.selector);
        daily.createPlan(address(nvda), 10e6, address(0), 0, 0.001 ether, 0, false);
    }

    /// The honest "one unit short" user is now just a USDG plan: no WETH sizing exists, the buy proceeds.
    function test_honestUserOneUnitShortFillsNormally() public {
        vm.prank(alice);
        uint256 a = daily.createPlan(address(nvda), 100e6, address(0), 10_000e6, 0, 0, false);
        vm.prank(bob);
        uint256 b = daily.createPlan(address(nvda), 100e6, address(0), 100e6 - 1, 1 ether, 0, false);
        assertEq(weth.balanceOf(address(daily)), 0, "WETH converted at deposit");
        _nextEpoch();
        assertTrue(_advance(keeper));
        assertEq(_plan(a).lastEpochId, 1);
        assertEq(_plan(b).lastEpochId, 1);
    }

    /// If the purchase cannot be quoted (route gone) the call reverts: nobody is charged, the cursor stays, and
    /// the retry fills once the route is back. Nothing an attacker controls can make a page unfillable.
    function test_unquotablePageRevertsAndIsRetried() public {
        vm.prank(alice);
        uint256 a = daily.createPlan(address(nvda), 100e6, address(0), 10_000e6, 0, 0, false);
        vm.prank(owner);
        router.revokeHop(_route(address(usdg), address(nvda), 500, address(usdgNvda)));
        _nextEpoch();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        daily.advanceEpoch(address(nvda), 0, "");
        assertEq(_plan(a).usdgIdle, 10_000e6, "nothing charged");
        assertTrue(daily.isEpochDue(address(nvda)));
        assertFalse(daily.isEpochPending(address(nvda)), "prunePlan is not blocked by a stuck epoch");

        vm.prank(owner);
        router.approveHop(_route(address(usdg), address(nvda), 500, address(usdgNvda)));
        assertTrue(_advance(keeper), "retry within the same epoch fills");
        assertEq(_plan(a).lastEpochId, 1);
    }

    /// A page whose stock output would round to zero (6-decimal stock, smallest plans) cannot be bought alone
    /// (`NoRoute`); grouped with a real plan it fills, and its rounded-away share goes to the dust pot.
    /// (v0.1 L-03.)
    function test_dustOutputPlan_fillsWhenGroupedWithOthers() public {
        MockERC20 six = new MockERC20("Six", "SIX", 6);
        vm.prank(owner);
        registry.listStock(address(six), "SIX", false, true);
        // 1 SIX = 1e9 USDG so 10 USDG rounds to 0 units of output
        _constPool(address(usdg), address(six), 500, _sqrtPrice(address(six), 1e6, address(usdg), 1_000_000_000e6));
        vm.prank(owner);
        daily.setMaxPlansPerTx(1);
        vm.prank(alice);
        daily.createPlan(address(six), 10e6, address(0), 100e6, 0, 0, false); // idx 0: dust output
        vm.prank(bob);
        daily.createPlan(address(six), 90_000e6, address(0), 90_000e6, 0, 0, false); // idx 1: real output (89 units; fee rounding stays inside the 150 bps cap, and 90,010 fits the 100k page cap)
        _nextEpoch();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(six)));
        daily.advanceEpoch(address(six), 0, ""); // alone, the dust plan cannot be bought (zero output = no route)
        assertEq(daily.getPlan(1).usdgIdle, 100e6, "alice untouched");
        vm.prank(owner);
        daily.setMaxPlansPerTx(2);
        vm.prank(keeper);
        assertTrue(daily.advanceEpoch(address(six), 0, ""), "both on one page: fills, epoch completes");
        assertEq(daily.getPlan(1).lastEpochId, 1, "alice charged, her share rounds to 0");
        assertEq(daily.getPlan(1).stockAccrued, 0);
        assertEq(daily.getPlan(2).lastEpochId, 1);
        assertGt(daily.getPlan(2).stockAccrued, 0);
    }

    /// Dust WETH cannot enter the vault: every WETH/ETH deposit must convert to >= minDeposit USDG.
    function test_vaultNeverHoldsWeth() public {
        vm.prank(alice);
        uint256 a = daily.createPlan(address(nvda), 100e6, address(0), 100e6, 0, 0, false);
        vm.prank(mallory);
        vm.expectRevert(); // 1 wei: the router has no quote for dust (NoRoute); larger dust fails BelowMinimum
        daily.depositWETH(a, 1, 0);
        vm.prank(mallory);
        vm.expectPartialRevert(IPlanVault.BelowMinimum.selector);
        daily.depositWETH(a, 0.001 ether, 0);
        vm.prank(mallory);
        daily.depositWETH(a, 1 ether, 0);
        assertEq(weth.balanceOf(address(daily)), 0);
        assertEq(daily.wethDust(), 0);
        assertApproxEqAbs(_plan(a).usdgIdle, 100e6 + 2_998.5e6, 1);
    }
}
