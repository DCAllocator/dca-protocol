// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {Zap} from "../../src/periphery/Zap.sol";
import {ClaimHelper} from "../../src/periphery/ClaimHelper.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {TwapOracle} from "../../src/oracles/TwapOracle.sol";

contract PeripheryTest is BaseTest {
    Zap zap;
    ClaimHelper helper;

    function setUp() public override {
        super.setUp();
        zap = new Zap(address(weth), address(usdg), address(router));
        helper = new ClaimHelper();
        vm.prank(alice);
        usdg.approve(address(zap), type(uint256).max);
    }

    function test_zap_ethToUsdg() public {
        uint256 before = usdg.balanceOf(bob);
        vm.prank(alice);
        uint256 out = zap.swapEthForUsdg{value: 1 ether}(2_999e6, bob);
        assertEq(out, 3_000e6);
        assertEq(usdg.balanceOf(bob) - before, 3_000e6);
        assertEq(weth.balanceOf(address(zap)), 0);
        assertEq(usdg.balanceOf(address(zap)), 0);
    }

    function test_zap_usdgToEth() public {
        vm.deal(address(weth), 10 ether); // back the mock WETH mint with ETH
        uint256 before = bob.balance;
        vm.prank(alice);
        uint256 out = zap.swapUsdgForEth(3_000e6, 0.99 ether, bob);
        assertEq(out, 1 ether);
        assertEq(bob.balance - before, 1 ether);
        assertEq(address(zap).balance, 0);
    }

    function test_zap_depositEthAsUsdgIntoPlan() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 100e6);
        vm.prank(alice);
        uint256 out = zap.depositEthAsUsdg{value: 0.5 ether}(address(daily), id, 1_400e6);
        assertEq(out, 1_500e6);
        assertEq(daily.getPlan(id).usdgIdle, 1_600e6, "credited as USDG");
        assertEq(usdg.allowance(address(zap), address(daily)), 0);
        // below the vault's minimum deposit the vault refuses
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BelowMinimum.selector, 3e6, 10e6));
        zap.depositEthAsUsdg{value: 0.001 ether}(address(daily), id, 0);
    }

    function test_zap_reverts() public {
        vm.prank(alice);
        vm.expectRevert(Zap.ZeroAmount.selector);
        zap.swapEthForUsdg{value: 0}(0, alice);
        vm.prank(alice);
        vm.expectRevert(Zap.ZeroAmount.selector);
        zap.swapUsdgForEth(0, 0, alice);
        vm.prank(alice);
        vm.expectRevert(Zap.ZeroAmount.selector);
        zap.depositEthAsUsdg{value: 0}(address(daily), 1, 0);
        vm.prank(alice);
        (bool ok,) = address(zap).call{value: 1 ether}("");
        assertFalse(ok, "stray ETH rejected");
    }

    function test_helper_positionsAndClaimable() public {
        uint256 a = _createUsdgPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        uint256 b = _createUsdgPlan(weekly, alice, address(nvda), 50e6, 1_000e6);
        _createUsdgPlan(daily, bob, address(aapl), 50e6, 1_000e6);
        vm.warp(weekly.nextEpochStart());
        _advance(daily, address(nvda));
        _advance(weekly, address(nvda));

        IPlanVault[] memory vaults = new IPlanVault[](2);
        vaults[0] = daily;
        vaults[1] = weekly;
        ClaimHelper.Position[] memory pos = helper.positions(vaults, alice);
        assertEq(pos.length, 2);
        assertEq(pos[0].vault, address(daily));
        assertEq(pos[0].planId, a);
        assertEq(pos[0].stockAccrued, daily.getPlan(a).stockAccrued);
        assertEq(pos[1].vault, address(weekly));
        assertEq(pos[1].planId, b);
        assertEq(pos[1].amountPerEpoch, 50e6);
        assertEq(
            helper.claimable(vaults, alice, address(nvda)),
            daily.getPlan(a).stockAccrued + weekly.getPlan(b).stockAccrued
        );
        assertEq(helper.claimable(vaults, alice, address(aapl)), 0);
        assertEq(helper.positions(vaults, carol).length, 0);
    }

    function test_helper_previews() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        (uint256 spend, uint256 fee, uint16 bps, bool auto_) = helper.previewFill(daily, id);
        assertEq(spend, 200e6);
        assertEq(fee, 1.5e6);
        assertEq(bps, 75);
        assertFalse(auto_);
        _giveDca(alice, 50_000);
        (spend, fee, bps, auto_) = helper.previewFill(daily, id);
        assertEq(fee, 0.74e6);
        assertEq(bps, 37);
        assertTrue(auto_);
        vm.prank(alice);
        daily.setPlanPaused(id, true);
        (spend, fee,,) = helper.previewFill(daily, id);
        assertEq(spend, 0);
        (spend,,,) = helper.previewFill(daily, 999);
        assertEq(spend, 0);
        // hypothetical plan: "you pay 0.50% of $200 = $1.00 this epoch"
        (fee, bps,) = helper.previewFee(weekly, bob, 200e6);
        assertEq(fee, 1e6);
        assertEq(bps, 50);
    }

    function test_twap_consultTick() public {
        TwapPoolMock pool = new TwapPoolMock();
        TwapHarness h = new TwapHarness();
        pool.set(int56(0), int56(600 * 100)); // +100 tick over 600s
        assertEq(h.consult(address(pool), 600), 100);
        pool.set(int56(0), int56(-600 * 100 - 1)); // negative with remainder -> rounds down
        assertEq(h.consult(address(pool), 600), -101);
        vm.expectRevert(TwapOracle.WindowTooShort.selector);
        h.consult(address(pool), 0);
    }
}

contract TwapHarness {
    function consult(address pool, uint32 ago) external view returns (int24) {
        return TwapOracle.consultTick(pool, ago);
    }
}

contract TwapPoolMock {
    int56 a;
    int56 b;

    function set(int56 a_, int56 b_) external {
        a = a_;
        b = b_;
    }

    function observe(uint32[] calldata) external view returns (int56[] memory c, uint160[] memory s) {
        c = new int56[](2);
        c[0] = a;
        c[1] = b;
        s = new uint160[](2);
    }
}
