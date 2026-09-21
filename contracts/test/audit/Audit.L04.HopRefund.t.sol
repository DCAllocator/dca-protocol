// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuditBase} from "./AuditBase.sol";
import {MockV3Pool} from "../mocks/MockV3.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {Zap} from "../../src/periphery/Zap.sol";

/// @title L-04 regression — unspent intermediate tokens are forwarded to the recipient, never stranded
///
/// v0.1: hop-2 remainders went to `msg.sender` = vault and sat there unaccounted and unrescuable.
/// Fix: the router forwards them to `recipient`; the vault books any WETH it receives during a buy as
/// `wethDust` and sweeps it to the treasury in the same transaction; Zap users receive it in their wallet.
contract AuditL04HopRefund is AuditBase {
    MockV3Pool usdgWeth;
    MockV3Pool wethNvda;
    Zap zap;

    function setUp() public override {
        super.setUp();
        usdgWeth = _wethUsdgPool();
        wethNvda = _constPool(address(weth), address(nvda), 3000, _sqrtPrice(address(weth), 1e18, address(nvda), 6e18));
        zap = new Zap(address(weth), address(usdg), address(router));
        vm.prank(alice);
        daily.createPlan(address(nvda), 3_000e6, address(0), 3_000e6, 0, 0, false);
        _nextEpoch();
        // hop 2 delivers only 99.5% of a full fill: the pool consumes 99.5% of the WETH and refunds the rest
        (uint256 hop1Out,) = router.quote(address(usdg), address(weth), 3_000e6 - 22.5e6);
        uint256 full = wethNvda.midOut(address(weth) < address(nvda), hop1Out) * 997 / 1000;
        wethNvda.setMaxOut(full * 995 / 1000);
    }

    function test_vaultBooksAndSweepsForwardedWeth() public {
        uint256 tBefore = weth.balanceOf(treasury);
        vm.expectEmit(true, true, false, false);
        emit IPlanVault.DustSwept(address(weth), treasury, 0);
        assertTrue(_advance(keeper));
        assertEq(weth.balanceOf(address(daily)), 0, "nothing stranded on the vault");
        assertEq(daily.wethDust(), 0, "swept in the same tx");
        assertGt(weth.balanceOf(treasury), tBefore, "forwarded remainder reached the treasury");
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(weth.balanceOf(address(router)), 0);
        assertEq(_plan(1).usdgIdle, 0);
        assertGt(_plan(1).stockAccrued, 0);
    }

    function test_zapUserReceivesForwardedIntermediate() public {
        vm.prank(bob);
        usdg.approve(address(zap), type(uint256).max);
        // Zap USDG -> ETH is single-hop; drive a two-hop swap directly through the router as a user would.
        (uint256 q,) = router.quote(address(usdg), address(nvda), 2_990e6); // sized to hit hop 2's cap within impact
        vm.startPrank(bob);
        usdg.approve(address(router), type(uint256).max);
        uint256 wBefore = weth.balanceOf(bob);
        router.swap(address(usdg), address(nvda), 2_990e6, q, bob);
        vm.stopPrank();
        assertGt(weth.balanceOf(bob), wBefore, "leftover WETH forwarded to the recipient");
        assertEq(weth.balanceOf(address(adapter)), 0);
    }
}
