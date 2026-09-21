// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {MorphoBlueStrategy} from "../../src/boost/MorphoBlueStrategy.sol";
import {MorphoLib} from "../../src/libraries/MorphoLib.sol";
import {Id, MarketParams, Market} from "../../src/interfaces/IMorpho.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev MorphoBlueStrategy against the mock market: ERC-4626 semantics, depositor gate, interest, liquidity.
contract MorphoBlueStrategyTest is BaseTest {
    address internal depositor = makeAddr("depositor");

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        strategy.setDepositor(depositor, true);
        usdg.mint(depositor, 1_000_000e6);
        vm.prank(depositor);
        usdg.approve(address(strategy), type(uint256).max);
    }

    function test_constructor_metadataAndMarket() public view {
        assertEq(strategy.asset(), address(usdg));
        assertEq(strategy.name(), "Boosted USDG");
        assertEq(strategy.symbol(), "bUSDG");
        assertEq(strategy.decimals(), 6);
        assertEq(Id.unwrap(strategy.marketId()), Id.unwrap(marketId));
        assertEq(strategy.marketParams().loanToken, address(usdg));
        assertEq(strategy.owner(), owner);
        assertEq(usdg.allowance(address(strategy), address(morpho)), type(uint256).max);
        assertEq(strategy.totalAssets(), 0);
    }

    function test_constructor_revertsUnknownMarket() public {
        MarketParams memory p = marketParams;
        p.lltv = 0.5e18; // never created
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueStrategy.MarketNotCreated.selector, MorphoLib.id(p)));
        new MorphoBlueStrategy(address(morpho), p, owner);
        vm.expectRevert(MorphoBlueStrategy.ZeroAddress.selector);
        new MorphoBlueStrategy(address(0), marketParams, owner);
    }

    function test_deposit_suppliesToMorpho() public {
        vm.prank(depositor);
        uint256 shares = strategy.deposit(1_000e6, depositor);
        assertEq(shares, 1_000e6, "first deposit mints 1:1");
        assertEq(strategy.balanceOf(depositor), 1_000e6);
        assertEq(usdg.balanceOf(address(strategy)), 0, "never holds the asset");
        assertEq(morpho.position(marketId, address(strategy)).supplyShares > 0, true);
        assertApproxEqAbs(strategy.totalAssets(), 1_000e6, 1);
    }

    function test_deposit_revertsNonDepositor() public {
        usdg.mint(alice, 100e6);
        vm.startPrank(alice);
        usdg.approve(address(strategy), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueStrategy.NotDepositor.selector, alice));
        strategy.deposit(100e6, alice);
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueStrategy.NotDepositor.selector, alice));
        strategy.mint(100e6, alice);
        vm.stopPrank();
    }

    function test_interest_accruesToShareholders() public {
        vm.prank(depositor);
        strategy.deposit(100_000e6, depositor);
        uint256 before = strategy.totalAssets();
        vm.warp(block.timestamp + 365 days);
        uint256 after_ = strategy.totalAssets();
        // 5.5% borrow APR at 90% utilisation, continuously compounded ~ 5.07% APY; the Taylor accrual lands a
        // little under that. Well inside [4.5%, 5.5%].
        assertGt(after_, (before * 1045) / 1000, "at least 4.5%");
        assertLt(after_, (before * 1055) / 1000, "at most 5.5%");
        // the projection equals what Morpho pays once interest is actually accrued
        morpho.accrueInterest(marketParams);
        assertEq(strategy.totalAssets(), after_, "view matches accrual");
        // OZ's virtual share/asset offset rounds the holder's own conversion down by at most 1 wei
        assertApproxEqAbs(strategy.convertToAssets(strategy.balanceOf(depositor)), after_, 1);
    }

    function test_withdraw_paysReceiverFromMorpho() public {
        vm.prank(depositor);
        strategy.deposit(10_000e6, depositor);
        vm.warp(block.timestamp + 30 days);
        uint256 value = strategy.maxWithdraw(depositor);
        assertGt(value, 10_000e6);
        vm.prank(depositor);
        uint256 burned = strategy.withdraw(value, bob, depositor);
        assertEq(burned, 10_000e6, "all shares burned");
        assertEq(usdg.balanceOf(bob), 1_000_000e6 + value);
        assertEq(strategy.balanceOf(depositor), 0);
        assertEq(usdg.balanceOf(address(strategy)), 0);
    }

    function test_redeem_all() public {
        vm.prank(depositor);
        strategy.deposit(10_000e6, depositor);
        vm.warp(block.timestamp + 10 days);
        uint256 expected = strategy.previewRedeem(10_000e6);
        vm.prank(depositor);
        uint256 out = strategy.redeem(10_000e6, depositor, depositor);
        assertEq(out, expected);
        assertEq(strategy.totalSupply(), 0);
    }

    function test_withdraw_allowanceForThirdParty() public {
        vm.prank(depositor);
        strategy.deposit(1_000e6, depositor);
        vm.prank(alice);
        vm.expectRevert();
        strategy.withdraw(500e6, alice, depositor);
        vm.prank(depositor);
        strategy.approve(alice, 500e6);
        vm.prank(alice);
        strategy.withdraw(500e6, alice, depositor);
        assertEq(usdg.balanceOf(alice), 1_000_000e6 + 500e6);
    }

    function test_liquidity_capsWithdrawals() public {
        vm.prank(depositor);
        strategy.deposit(100_000e6, depositor);
        // borrow everything that is free: market is fully utilised
        uint256 free = strategy.liquidity();
        morpho.mockBorrow(marketId, free, borrower);
        assertEq(strategy.liquidity(), 0);
        assertEq(strategy.maxWithdraw(depositor), 0);
        assertEq(strategy.maxRedeem(depositor), 0);
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, depositor, 1e6, 0));
        strategy.withdraw(1e6, depositor, depositor);
        // a repayment frees liquidity again
        usdg.mint(borrower, 50_000e6);
        vm.startPrank(borrower);
        usdg.approve(address(morpho), type(uint256).max);
        morpho.mockRepay(marketId, 50_000e6);
        vm.stopPrank();
        assertGt(strategy.maxWithdraw(depositor), 49_000e6);
        vm.prank(depositor);
        strategy.withdraw(40_000e6, depositor, depositor);
    }

    function test_badDebt_isSocialised() public {
        vm.prank(depositor);
        strategy.deposit(100_000e6, depositor);
        uint256 before = strategy.totalAssets();
        // 10% of the market's debt is written off; suppliers share the loss pro rata
        morpho.mockLoss(marketId, 900_000e6);
        uint256 after_ = strategy.totalAssets();
        assertLt(after_, before);
        assertApproxEqRel(after_, before - before * 900_000e6 / (MORPHO_SEED_SUPPLY + 100_000e6), 0.001e18);
    }

    function test_supplyRatePerSecond_matchesMarket() public view {
        // 90% utilisation, no fee: rate = borrowRate * 0.9
        uint256 expected = (BORROW_RATE_PER_SECOND * 9) / 10;
        assertApproxEqAbs(strategy.supplyRatePerSecond(), expected, 2);
        Market memory m = morpho.market(marketId);
        assertEq(m.fee, 0);
    }

    function test_supplyRatePerSecond_marketFeeReducesIt() public {
        morpho.setFee(marketId, 0.1e18); // 10% of interest to Morpho
        uint256 gross = (BORROW_RATE_PER_SECOND * 9) / 10;
        assertApproxEqAbs(strategy.supplyRatePerSecond(), (gross * 9) / 10, 2);
        // fee shares dilute suppliers exactly as the rate predicts (roughly, over a year)
        vm.prank(depositor);
        strategy.deposit(100_000e6, depositor);
        uint256 before = strategy.totalAssets();
        vm.warp(block.timestamp + 365 days);
        uint256 gain = strategy.totalAssets() - before;
        assertGt(gain, (before * 40) / 1000);
        assertLt(gain, (before * 50) / 1000);
    }

    function test_supplyRatePerSecond_zeroWithoutBorrows() public {
        // a fresh market with no debt pays nothing
        MarketParams memory p = marketParams;
        p.lltv = 0.5e18;
        morpho.createMarket(p);
        MorphoBlueStrategy s2 = new MorphoBlueStrategy(address(morpho), p, owner);
        assertEq(s2.supplyRatePerSecond(), 0);
    }

    function test_skim_lendsStrayAssets() public {
        vm.prank(depositor);
        strategy.deposit(1_000e6, depositor);
        usdg.mint(address(strategy), 100e6); // someone sent USDG directly
        assertApproxEqAbs(strategy.totalAssets(), 1_000e6, 1, "stray tokens are not counted");
        strategy.skim();
        assertApproxEqAbs(strategy.totalAssets(), 1_100e6, 1, "now they are, for every holder");
        assertEq(usdg.balanceOf(address(strategy)), 0);
    }

    function test_admin_depositorAndRescue() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        strategy.setDepositor(alice, true);
        vm.prank(owner);
        vm.expectRevert(MorphoBlueStrategy.ZeroAddress.selector);
        strategy.setDepositor(address(0), true);

        MockERC20 rogue = new MockERC20("Rogue", "RG", 18);
        rogue.mint(address(strategy), 5e18);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MorphoBlueStrategy.TokenNotRescuable.selector, address(usdg)));
        strategy.rescueERC20(address(usdg), owner, 1);
        vm.prank(owner);
        strategy.rescueERC20(address(rogue), owner, 5e18);
        assertEq(rogue.balanceOf(owner), 5e18);
    }

    /// @dev Share price never moves against remaining holders when others enter / leave (rounding is in the
    ///      pool's favour), and a full round trip never returns more than deposited plus interest.
    function testFuzz_roundTrip_neverMintsValue(uint128 a, uint128 b, uint32 dt) public {
        uint256 da = bound(a, 1e6, 500_000e6);
        uint256 db = bound(b, 1e6, 500_000e6);
        dt = uint32(bound(dt, 0, 30 days));
        vm.prank(owner);
        strategy.setDepositor(alice, true);
        vm.prank(alice);
        usdg.approve(address(strategy), type(uint256).max);

        vm.prank(depositor);
        strategy.deposit(da, depositor);
        uint256 priceBefore = strategy.convertToAssets(1e6);
        vm.prank(alice);
        strategy.deposit(db, alice);
        assertGe(strategy.convertToAssets(1e6), priceBefore, "entry never dilutes");
        vm.warp(block.timestamp + dt);
        uint256 aliceBal = usdg.balanceOf(alice);
        uint256 aliceShares = strategy.balanceOf(alice);
        vm.prank(alice);
        uint256 got = strategy.redeem(aliceShares, alice, alice);
        assertEq(usdg.balanceOf(alice) - aliceBal, got);
        // at most the interest the market can have paid (5.5% APR upper bound over dt), never magic
        uint256 maxGain = (db * 55 * dt) / (1000 * 365 days) + 2;
        assertLe(got, db + maxGain, "no value created");
        assertGe(strategy.convertToAssets(1e6), priceBefore, "exit never dilutes the remaining holder");
    }
}
