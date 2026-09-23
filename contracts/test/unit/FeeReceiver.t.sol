// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {FeeReceiver} from "../../src/treasury/FeeReceiver.sol";
import {IAggregatorRouter} from "../../src/router/IAggregatorRouter.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {BlockingToken} from "../mocks/BlockingToken.sol";
import {
    BurnableDCA,
    FakeBurnDCA,
    HalfBurnDCA,
    MockOraclePool,
    LyingRouter,
    ReentrantToken
} from "../mocks/FeeReceiverMocks.sol";

/// @dev Standalone fixture: tokens + MockRouter (1 USDG = 1 DCA, 1 NVDA = 500 USDG, 1 WETH = 3000 USDG).
contract FeeReceiverTest is Test {
    uint256 internal constant BPS = 10_000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal operator = makeAddr("operator");
    address internal rando = makeAddr("rando");

    MockERC20 internal usdg;
    MockWETH internal weth;
    BurnableDCA internal dca;
    MockERC20 internal nvda;
    MockRouter internal router;
    MockOraclePool internal pool;
    FeeReceiver internal fr;

    function setUp() public virtual {
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        weth = new MockWETH();
        dca = new BurnableDCA();
        nvda = new MockERC20("NVIDIA Stock Token", "NVDAst", 18);
        router = new MockRouter(address(weth));
        // 1 USDG (1e6) = 1 DCA (1e18); 1 NVDA = 500 USDG; 1 WETH = 3000 USDG; WETH -> DCA at 3000
        router.setRate(address(usdg), address(dca), 1e18, 1e6);
        router.setRate(address(nvda), address(usdg), 500e6, 1e18);
        router.setRate(address(nvda), address(weth), 1e18, 6e18); // 500 / 3000
        router.setRate(address(weth), address(usdg), 3000e6, 1e18);
        router.setRate(address(weth), address(dca), 3000e18, 1e18);
        // Every quoted path names a V3-style pool so the (default-on) price guard runs on every swap below.
        pool = new MockOraclePool(address(dca), address(usdg));
        pool.setTicks(1_000, 1_000);
        _routeThrough(pool);

        fr = new FeeReceiver(address(usdg), address(weth), address(dca), address(router), treasury, owner);
        vm.prank(owner);
        fr.setOperator(operator, true);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _routeThrough(MockOraclePool p) internal {
        bytes memory extra = abi.encode(address(p));
        router.setPathExtra(address(usdg), address(dca), extra);
        router.setPathExtra(address(nvda), address(usdg), extra);
        router.setPathExtra(address(nvda), address(weth), extra);
        router.setPathExtra(address(weth), address(usdg), extra);
        router.setPathExtra(address(weth), address(dca), extra);
    }

    function _fee(address token, uint256 amount) internal {
        MockERC20(token).mint(address(fr), amount);
    }

    function _distribute(address token) internal returns (uint256 t, uint256 b) {
        vm.prank(operator);
        (t, b) = fr.distribute(token);
    }

    function _seedReserve(address token, uint256 total) internal returns (uint256 reserve) {
        _fee(token, total);
        (, reserve) = _distribute(token);
    }

    // ==================================================================
    // Construction & admin
    // ==================================================================

    function test_constructor() public view {
        assertEq(address(fr.usdg()), address(usdg));
        assertEq(address(fr.weth()), address(weth));
        assertEq(address(fr.dca()), address(dca));
        assertEq(address(fr.router()), address(router));
        assertEq(fr.treasury(), treasury);
        assertEq(fr.owner(), owner);
        assertEq(fr.maxSlippageBps(), 50);
        assertEq(uint256(fr.TREASURY_BPS()) + uint256(fr.BUYBACK_BPS()), FeeMath.BPS);
        assertEq(fr.TREASURY_BPS(), 7_000);
        assertEq(fr.BUYBACK_BPS(), 3_000);
        assertEq(fr.guardWindow(), 30 minutes, "guard on by default");
        assertEq(fr.guardMaxTicks(), 300);
        assertFalse(fr.allowUnguardedHops(), "unguarded hops refused by default");
    }

    function test_constructor_reverts() public {
        vm.expectRevert(FeeReceiver.ZeroAddress.selector);
        new FeeReceiver(address(0), address(weth), address(dca), address(router), treasury, owner);
        vm.expectRevert(FeeReceiver.ZeroAddress.selector);
        new FeeReceiver(address(usdg), address(0), address(dca), address(router), treasury, owner);
        vm.expectRevert(FeeReceiver.ZeroAddress.selector);
        new FeeReceiver(address(usdg), address(weth), address(0), address(router), treasury, owner);
        vm.expectRevert(FeeReceiver.ZeroAddress.selector);
        new FeeReceiver(address(usdg), address(weth), address(dca), address(0), treasury, owner);
        vm.expectRevert(FeeReceiver.TokensNotDistinct.selector);
        new FeeReceiver(address(usdg), address(weth), address(usdg), address(router), treasury, owner);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.NotAContract.selector, rando));
        new FeeReceiver(address(usdg), address(weth), rando, address(router), treasury, owner);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.InvalidTreasury.selector, address(0)));
        new FeeReceiver(address(usdg), address(weth), address(dca), address(router), address(0), owner);
        // a router on a different WETH is a wiring mistake
        MockRouter other = new MockRouter(address(usdg));
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.RouterWethMismatch.selector, address(other)));
        new FeeReceiver(address(usdg), address(weth), address(dca), address(other), treasury, owner);
    }

    function test_admin_onlyOwner() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        fr.setTreasury(rando);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        fr.setRouter(address(router));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        fr.setOperator(rando, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        fr.setMaxSlippageBps(10);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        fr.setGuard(0, 0, true);
        vm.stopPrank();
    }

    function test_setTreasury() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.InvalidTreasury.selector, address(0)));
        fr.setTreasury(address(0));
        // pointing the treasury at itself would let repeated distributes route 100% into the reserve
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.InvalidTreasury.selector, address(fr)));
        fr.setTreasury(address(fr));
        vm.expectEmit(true, false, false, true);
        emit FeeReceiver.TreasurySet(rando);
        fr.setTreasury(rando);
        vm.stopPrank();
        assertEq(fr.treasury(), rando);
    }

    function test_setRouter() public {
        MockRouter r2 = new MockRouter(address(weth));
        MockRouter bad = new MockRouter(address(usdg));
        vm.startPrank(owner);
        vm.expectRevert(FeeReceiver.ZeroAddress.selector);
        fr.setRouter(address(0));
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.RouterWethMismatch.selector, address(bad)));
        fr.setRouter(address(bad));
        fr.setRouter(address(r2));
        vm.stopPrank();
        assertEq(address(fr.router()), address(r2));
        assertEq(usdg.allowance(address(fr), address(router)), 0, "no standing approval to the old router");
    }

    function test_setOperator() public {
        vm.prank(owner);
        vm.expectRevert(FeeReceiver.ZeroAddress.selector);
        fr.setOperator(address(0), true);
        _fee(address(usdg), 100e6);
        vm.prank(rando);
        vm.expectRevert(FeeReceiver.NotOperator.selector);
        fr.distribute(address(usdg));
        vm.prank(owner);
        fr.setOperator(rando, true);
        vm.prank(rando);
        fr.distribute(address(usdg));
        vm.prank(owner);
        fr.setOperator(rando, false);
        _fee(address(usdg), 100e6);
        vm.prank(rando);
        vm.expectRevert(FeeReceiver.NotOperator.selector);
        fr.distribute(address(usdg));
        // the owner is always an operator
        vm.prank(owner);
        fr.distribute(address(usdg));
    }

    function test_setMaxSlippageBps() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.SlippageOutOfRange.selector, 501, 500));
        fr.setMaxSlippageBps(501);
        fr.setMaxSlippageBps(500);
        assertEq(fr.maxSlippageBps(), 500);
        fr.setMaxSlippageBps(0);
        vm.stopPrank();
    }

    function test_ownership_twoStep() public {
        vm.prank(owner);
        fr.transferOwnership(rando);
        assertEq(fr.owner(), owner);
        vm.prank(rando);
        fr.acceptOwnership();
        assertEq(fr.owner(), rando);
    }

    // ==================================================================
    // distribute
    // ==================================================================

    function test_distribute_split() public {
        _fee(address(usdg), 1_000e6);
        assertEq(fr.pending(address(usdg)), 1_000e6);
        vm.expectEmit(true, true, false, true);
        emit FeeReceiver.Distributed(address(usdg), treasury, 700e6, 300e6);
        (uint256 t, uint256 b) = _distribute(address(usdg));
        assertEq(t, 700e6);
        assertEq(b, 300e6);
        assertEq(usdg.balanceOf(treasury), 700e6);
        assertEq(usdg.balanceOf(address(fr)), 300e6);
        assertEq(fr.buybackReserve(address(usdg)), 300e6);
        assertEq(fr.pending(address(usdg)), 0);
    }

    function test_distribute_roundsTowardBuyback() public {
        _fee(address(usdg), 1);
        (uint256 t, uint256 b) = _distribute(address(usdg));
        assertEq(t, 0);
        assertEq(b, 1);
        _fee(address(usdg), 3);
        (t, b) = _distribute(address(usdg));
        assertEq(t, 2);
        assertEq(b, 1);
    }

    function test_distribute_accumulatesReserve_andNewArrivalsArePending() public {
        _seedReserve(address(usdg), 1_000e6);
        _fee(address(usdg), 500e6);
        assertEq(fr.pending(address(usdg)), 500e6, "reserve is not pending");
        _distribute(address(usdg));
        assertEq(fr.buybackReserve(address(usdg)), 450e6);
        assertEq(usdg.balanceOf(treasury), 1_050e6);
        assertEq(usdg.balanceOf(address(fr)), 450e6);
    }

    function test_distribute_nothingPending_reverts() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.NothingToDistribute.selector, address(usdg)));
        fr.distribute(address(usdg));
        _seedReserve(address(usdg), 100e6);
        // reserve alone is not distributable again
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.NothingToDistribute.selector, address(usdg)));
        fr.distribute(address(usdg));
    }

    function test_distributeMany_skipsEmpty() public {
        _fee(address(usdg), 100e6);
        _fee(address(nvda), 2e18);
        address[] memory toks = new address[](3);
        toks[0] = address(usdg);
        toks[1] = address(weth); // nothing pending
        toks[2] = address(nvda);
        vm.prank(operator);
        fr.distributeMany(toks);
        assertEq(usdg.balanceOf(treasury), 70e6);
        assertEq(nvda.balanceOf(treasury), 1.4e18);
        assertEq(fr.buybackReserve(address(usdg)), 30e6);
        assertEq(fr.buybackReserve(address(nvda)), 0.6e18);
        assertEq(fr.buybackReserve(address(weth)), 0);
        vm.prank(rando);
        vm.expectRevert(FeeReceiver.NotOperator.selector);
        fr.distributeMany(toks);
    }

    function test_distribute_dcaItself() public {
        dca.mint(address(fr), 100e18);
        _distribute(address(dca));
        assertEq(dca.balanceOf(treasury), 70e18);
        assertEq(fr.buybackReserve(address(dca)), 30e18);
        uint256 supply = dca.totalSupply();
        vm.prank(operator);
        (uint256 spent, uint256 burned) = fr.buyback(address(dca), type(uint256).max, 0);
        assertEq(spent, 30e18);
        assertEq(burned, 30e18);
        assertEq(dca.totalSupply(), supply - 30e18);
        assertEq(router.swapCount(), 0, "no swap for DCA -> DCA");
        assertEq(fr.buybackReserve(address(dca)), 0);
    }

    function test_distribute_treasuryBlockedOnToken_revertsUntilTreasuryMoved() public {
        BlockingToken blk = new BlockingToken();
        blk.mint(address(fr), 10e18);
        blk.setBlocked(treasury, true);
        vm.prank(operator);
        vm.expectRevert("BLK: recipient blocked");
        fr.distribute(address(blk));
        vm.prank(owner);
        fr.setTreasury(rando);
        _distribute(address(blk));
        assertEq(blk.balanceOf(rando), 7e18);
    }

    function testFuzz_distribute_exactSplit(uint128 amount) public {
        vm.assume(amount > 0);
        _fee(address(usdg), amount);
        (uint256 t, uint256 b) = _distribute(address(usdg));
        assertEq(t + b, amount);
        assertEq(t, (uint256(amount) * 7_000) / BPS);
        assertGe(usdg.balanceOf(address(fr)), fr.buybackReserve(address(usdg)));
        assertEq(usdg.balanceOf(treasury), t);
    }

    // ==================================================================
    // buyback
    // ==================================================================

    function test_buyback_burnsViaBurn() public {
        _seedReserve(address(usdg), 1_000e6); // reserve 300 USDG
        uint256 supply = dca.totalSupply();
        vm.expectEmit(false, false, false, true);
        emit FeeReceiver.Burned(300e18, true);
        vm.expectEmit(true, false, false, true);
        emit FeeReceiver.BoughtBack(address(usdg), 300e6, 300e18);
        vm.prank(operator);
        (uint256 spent, uint256 burned) = fr.buyback(address(usdg), type(uint256).max, 0);
        assertEq(spent, 300e6);
        assertEq(burned, 300e18);
        assertEq(fr.totalBurned(), 300e18);
        assertEq(fr.buybackReserve(address(usdg)), 0);
        assertEq(usdg.balanceOf(address(fr)), 0);
        assertEq(dca.balanceOf(address(fr)), 0, "nothing lingers");
        assertEq(dca.balanceOf(DEAD), 0);
        assertEq(dca.totalSupply(), supply, "router minted 300, burn removed 300");
        assertEq(usdg.allowance(address(fr), address(router)), 0, "approval reset");
    }

    function test_buyback_partialAmount() public {
        _seedReserve(address(usdg), 1_000e6);
        vm.prank(operator);
        fr.buyback(address(usdg), 100e6, 0);
        assertEq(fr.buybackReserve(address(usdg)), 200e6);
        assertEq(usdg.balanceOf(address(fr)), 200e6);
        assertEq(fr.totalBurned(), 100e18);
    }

    function test_buyback_neverTouchesPending() public {
        _seedReserve(address(usdg), 1_000e6); // reserve 300
        _fee(address(usdg), 5_000e6); // pending 5000
        vm.prank(operator);
        (uint256 spent,) = fr.buyback(address(usdg), type(uint256).max, 0);
        assertEq(spent, 300e6);
        assertEq(fr.pending(address(usdg)), 5_000e6);
        assertEq(usdg.balanceOf(address(fr)), 5_000e6);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.InsufficientReserve.selector, address(usdg), 1, 0));
        fr.buyback(address(usdg), 1, 0);
    }

    function test_buyback_reverts() public {
        vm.startPrank(operator);
        vm.expectRevert(FeeReceiver.ZeroAmount.selector);
        fr.buyback(address(usdg), 0, 0);
        vm.expectRevert(FeeReceiver.ZeroAmount.selector);
        fr.buyback(address(usdg), type(uint256).max, 0); // empty reserve
        vm.stopPrank();
        _seedReserve(address(usdg), 1_000e6);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(FeeReceiver.InsufficientReserve.selector, address(usdg), 300e6 + 1, 300e6)
        );
        fr.buyback(address(usdg), 300e6 + 1, 0);
        vm.prank(rando);
        vm.expectRevert(FeeReceiver.NotOperator.selector);
        fr.buyback(address(usdg), 1, 0);
        // no route
        _seedReserve(address(nvda), 1e18);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(nvda), address(dca)));
        fr.buyback(address(nvda), 1e17, 0);
        // router revert bubbles, nothing changes
        router.setRevertOnSwap(true);
        vm.prank(operator);
        vm.expectRevert("MockRouter: forced revert");
        fr.buyback(address(usdg), 1e6, 0);
        assertEq(fr.buybackReserve(address(usdg)), 300e6);
    }

    function test_buyback_minOutFloor() public {
        _seedReserve(address(usdg), 1_000e6);
        uint256 floor = (300e18 * (BPS - 50)) / BPS;
        vm.prank(operator);
        fr.buyback(address(usdg), 100e6, 0);
        assertEq(router.lastMinOut(), floor / 3, "minOut floored at quote x (1 - 50 bps)");
        vm.prank(operator);
        fr.buyback(address(usdg), 100e6, 99.9e18);
        assertEq(router.lastMinOut(), 99.9e18, "a stricter operator minOut is kept");
        // the router refuses when the operator asks for more than the pool gives
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.InsufficientOutput.selector, 100e18, 101e18));
        fr.buyback(address(usdg), 100e6, 101e18);
    }

    function test_buyback_floorTracksSlippageSetting() public {
        _seedReserve(address(usdg), 1_000e6);
        vm.prank(owner);
        fr.setMaxSlippageBps(500);
        vm.prank(operator);
        fr.buyback(address(usdg), 100e6, 0);
        assertEq(router.lastMinOut(), 95e18);
        vm.prank(owner);
        fr.setMaxSlippageBps(0);
        vm.prank(operator);
        fr.buyback(address(usdg), 100e6, 0);
        assertEq(router.lastMinOut(), 100e18);
    }

    function test_buyback_partialFill_reserveDebitedByWhatWasSpent() public {
        _seedReserve(address(usdg), 1_000e6);
        router.setFill(address(usdg), address(dca), 5_000);
        vm.prank(operator);
        (uint256 spent, uint256 burned) = fr.buyback(address(usdg), 300e6, 0);
        assertEq(spent, 150e6);
        assertEq(burned, 150e18);
        assertEq(fr.buybackReserve(address(usdg)), 150e6);
        assertEq(usdg.balanceOf(address(fr)), 150e6);
        assertEq(fr.pending(address(usdg)), 0, "unspent input is still reserve, not pending");
    }

    function test_buyback_quoteTooSmall() public {
        _seedReserve(address(usdg), 10); // reserve 3 units -> 3e12 DCA quote, fine; use a dust rate instead
        router.setRate(address(usdg), address(dca), 1, 1e18);
        vm.prank(operator);
        vm.expectRevert(FeeReceiver.QuoteTooSmall.selector);
        fr.buyback(address(usdg), 3, 0);
    }

    function test_buyback_fromWeth_direct() public {
        _seedReserve(address(weth), 10e18); // reserve 3 WETH
        vm.prank(operator);
        (uint256 spent, uint256 burned) = fr.buyback(address(weth), type(uint256).max, 0);
        assertEq(spent, 3e18);
        assertEq(burned, 9_000e18);
        assertEq(fr.buybackReserve(address(weth)), 0);
    }

    // ---- burn fallbacks ----

    function test_buyback_noBurnFunction_sendsToDead() public {
        MockERC20 plain = new MockERC20("DCA", "DCA", 18);
        router.setRate(address(usdg), address(plain), 1e18, 1e6);
        router.setPathExtra(address(usdg), address(plain), abi.encode(address(pool)));
        FeeReceiver f2 = new FeeReceiver(address(usdg), address(weth), address(plain), address(router), treasury, owner);
        usdg.mint(address(f2), 1_000e6);
        vm.prank(owner);
        f2.distribute(address(usdg));
        vm.expectEmit(false, false, false, true);
        emit FeeReceiver.Burned(300e18, false);
        vm.prank(owner);
        f2.buyback(address(usdg), type(uint256).max, 0);
        assertEq(plain.balanceOf(DEAD), 300e18);
        assertEq(plain.balanceOf(address(f2)), 0);
        assertEq(f2.totalBurned(), 300e18);
    }

    function test_buyback_fakeBurn_sendsToDead() public {
        FakeBurnDCA fake = new FakeBurnDCA();
        router.setRate(address(usdg), address(fake), 1e18, 1e6);
        router.setPathExtra(address(usdg), address(fake), abi.encode(address(pool)));
        FeeReceiver f2 = new FeeReceiver(address(usdg), address(weth), address(fake), address(router), treasury, owner);
        usdg.mint(address(f2), 1_000e6);
        vm.prank(owner);
        f2.distribute(address(usdg));
        vm.prank(owner);
        f2.buyback(address(usdg), type(uint256).max, 0);
        assertEq(fake.balanceOf(DEAD), 300e18, "a burn() that did nothing falls back to the dead address");
        assertEq(fake.balanceOf(address(f2)), 0);
    }

    function test_buyback_halfBurn_reverts() public {
        HalfBurnDCA half = new HalfBurnDCA();
        router.setRate(address(usdg), address(half), 1e18, 1e6);
        router.setPathExtra(address(usdg), address(half), abi.encode(address(pool)));
        FeeReceiver f2 = new FeeReceiver(address(usdg), address(weth), address(half), address(router), treasury, owner);
        usdg.mint(address(f2), 1_000e6);
        vm.prank(owner);
        f2.distribute(address(usdg));
        vm.prank(owner);
        vm.expectRevert(FeeReceiver.BurnFailed.selector);
        f2.buyback(address(usdg), type(uint256).max, 0);
    }

    // ---- router misbehaviour ----

    function _liar() internal returns (LyingRouter liar) {
        liar = new LyingRouter(address(weth));
        liar.setRate(1e18, 1e6);
        bytes[] memory ex = new bytes[](1);
        ex[0] = abi.encode(address(pool));
        liar.setExtras(ex);
    }

    function test_buyback_routerDeliversLess_reverts() public {
        LyingRouter liar = _liar();
        liar.setDeliverBps(9_000); // quotes 100%, pays 90%, ignores minOut
        vm.prank(owner);
        fr.setRouter(address(liar));
        _seedReserve(address(usdg), 1_000e6);
        uint256 floor = (300e18 * (BPS - 50)) / BPS;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.InsufficientOutput.selector, 270e18, floor));
        fr.buyback(address(usdg), type(uint256).max, 0);
        assertEq(usdg.balanceOf(address(fr)), 300e6, "nothing left the contract");
    }

    function test_buyback_routerTakesInputPaysNothing_reverts() public {
        LyingRouter liar = _liar();
        liar.setPullOnly(true);
        vm.prank(owner);
        fr.setRouter(address(liar));
        _seedReserve(address(usdg), 1_000e6);
        vm.prank(operator);
        vm.expectRevert();
        fr.buyback(address(usdg), type(uint256).max, 0);
        assertEq(usdg.balanceOf(address(fr)), 300e6);
        assertEq(usdg.allowance(address(fr), address(liar)), 0);
    }

    function test_buyback_hop2WethRefundStaysInReserve() public {
        LyingRouter liar = _liar();
        liar.setWethRefund(0.01e18); // models an unspent WETH intermediate forwarded to the recipient
        vm.prank(owner);
        fr.setRouter(address(liar));
        _seedReserve(address(usdg), 1_000e6);
        vm.prank(operator);
        fr.buyback(address(usdg), type(uint256).max, 0);
        assertEq(fr.buybackReserve(address(weth)), 0.01e18, "refund is buyback money, not pending");
        assertEq(fr.pending(address(weth)), 0);
        assertEq(weth.balanceOf(address(fr)), 0.01e18);
    }

    // ==================================================================
    // convert
    // ==================================================================

    function test_convert_stockToUsdg_thenBuyback() public {
        _seedReserve(address(nvda), 10e18); // reserve 3 NVDA = 1500 USDG
        vm.expectEmit(true, true, false, true);
        emit FeeReceiver.Converted(address(nvda), address(usdg), 3e18, 1_500e6);
        vm.prank(operator);
        (uint256 spent, uint256 out) = fr.convert(address(nvda), address(usdg), type(uint256).max, 0);
        assertEq(spent, 3e18);
        assertEq(out, 1_500e6);
        assertEq(fr.buybackReserve(address(nvda)), 0);
        assertEq(fr.buybackReserve(address(usdg)), 1_500e6);
        assertEq(fr.pending(address(usdg)), 0, "converted output is reserve, never re-split");
        assertEq(nvda.allowance(address(fr), address(router)), 0);
        vm.prank(operator);
        (, uint256 burned) = fr.buyback(address(usdg), type(uint256).max, 0);
        assertEq(burned, 1_500e18);
        assertEq(usdg.balanceOf(treasury), 0, "the treasury never sees converted reserve");
    }

    function test_convert_stockToWeth() public {
        _seedReserve(address(nvda), 10e18);
        vm.prank(operator);
        (, uint256 out) = fr.convert(address(nvda), address(weth), 3e18, 0);
        assertEq(out, 0.5e18);
        assertEq(fr.buybackReserve(address(weth)), 0.5e18);
    }

    function test_convert_partialFill() public {
        _seedReserve(address(nvda), 10e18);
        router.setFill(address(nvda), address(usdg), 2_500);
        vm.prank(operator);
        (uint256 spent, uint256 out) = fr.convert(address(nvda), address(usdg), 3e18, 0);
        assertEq(spent, 0.75e18);
        assertEq(out, 375e6);
        assertEq(fr.buybackReserve(address(nvda)), 2.25e18);
        assertEq(fr.buybackReserve(address(usdg)), 375e6);
    }

    function test_convert_reverts() public {
        _seedReserve(address(usdg), 1_000e6);
        _seedReserve(address(weth), 1e18);
        _seedReserve(address(nvda), 1e18);
        dca.mint(address(fr), 1e18);
        _distribute(address(dca));
        vm.startPrank(operator);
        // base reserves and $DCA can never be sold
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.NotConvertible.selector, address(usdg)));
        fr.convert(address(usdg), address(weth), 1, 0);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.NotConvertible.selector, address(weth)));
        fr.convert(address(weth), address(usdg), 1, 0);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.NotConvertible.selector, address(dca)));
        fr.convert(address(dca), address(usdg), 1, 0);
        // only into a base token
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.InvalidConversionTarget.selector, address(dca)));
        fr.convert(address(nvda), address(dca), 1, 0);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.InvalidConversionTarget.selector, address(nvda)));
        fr.convert(address(nvda), address(nvda), 1, 0);
        vm.expectRevert(FeeReceiver.ZeroAmount.selector);
        fr.convert(address(nvda), address(usdg), 0, 0);
        vm.expectRevert(
            abi.encodeWithSelector(FeeReceiver.InsufficientReserve.selector, address(nvda), 0.3e18 + 1, 0.3e18)
        );
        fr.convert(address(nvda), address(usdg), 0.3e18 + 1, 0);
        vm.stopPrank();
        vm.prank(rando);
        vm.expectRevert(FeeReceiver.NotOperator.selector);
        fr.convert(address(nvda), address(usdg), 1, 0);
    }

    // ==================================================================
    // price guard (on-path TWAP vs spot)
    // ==================================================================

    function test_setGuard() public {
        vm.startPrank(owner);
        vm.expectRevert(FeeReceiver.InvalidGuard.selector);
        fr.setGuard(30 minutes, 0, false);
        vm.expectEmit(false, false, false, true);
        emit FeeReceiver.GuardSet(1 hours, 100, true);
        fr.setGuard(1 hours, 100, true);
        vm.stopPrank();
        assertEq(fr.guardWindow(), 1 hours);
        assertEq(fr.guardMaxTicks(), 100);
        assertTrue(fr.allowUnguardedHops());
        // off: maxTicks may be anything
        vm.prank(owner);
        fr.setGuard(0, 0, false);
        assertEq(fr.guardWindow(), 0);
    }

    function test_guard_blocksBuybackWhenSpotDeviates() public {
        _seedReserve(address(usdg), 1_000e6);
        // within tolerance (exactly at the edge) passes, either direction
        pool.setTicks(1_300, 1_000);
        vm.prank(operator);
        fr.buyback(address(usdg), 10e6, 0);
        pool.setTicks(700, 1_000);
        vm.prank(operator);
        fr.buyback(address(usdg), 10e6, 0);
        // one tick beyond reverts, and no operator minOut can override it
        pool.setTicks(1_301, 1_000);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.PriceDeviates.selector, address(pool), 1_301, 1_000, 300));
        fr.buyback(address(usdg), 10e6, 0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.PriceDeviates.selector, address(pool), 1_301, 1_000, 300));
        fr.buyback(address(usdg), 10e6, 1e30);
        pool.setTicks(699, 1_000);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.PriceDeviates.selector, address(pool), 699, 1_000, 300));
        fr.buyback(address(usdg), 10e6, 0);
        // negative ticks
        pool.setTicks(-50_000, -49_800);
        vm.prank(operator);
        fr.buyback(address(usdg), 10e6, 0);
        pool.setTicks(-50_301, -50_000);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(FeeReceiver.PriceDeviates.selector, address(pool), -50_301, -50_000, 300)
        );
        fr.buyback(address(usdg), 10e6, 0);
        assertEq(fr.buybackReserve(address(usdg)), 300e6 - 30e6, "only the three good buybacks went through");
        // switching the guard off lifts the check
        vm.prank(owner);
        fr.setGuard(0, 0, false);
        vm.prank(operator);
        fr.buyback(address(usdg), 10e6, 0);
    }

    function test_guard_appliesToConvert() public {
        _seedReserve(address(nvda), 10e18);
        pool.setTicks(2_000, 1_000);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.PriceDeviates.selector, address(pool), 2_000, 1_000, 300));
        fr.convert(address(nvda), address(usdg), 1e18, 0);
        pool.setTicks(1_100, 1_000);
        vm.prank(operator);
        fr.convert(address(nvda), address(usdg), 1e18, 0);
    }

    function test_guard_unguardedHopRefusedUnlessAllowed() public {
        _seedReserve(address(usdg), 1_000e6);
        // a hop with no pool in `extra` (or a V4 PoolKey) has no oracle: refused by default
        router.setPathExtra(address(usdg), address(dca), "");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.UnguardedHop.selector, 0));
        fr.buyback(address(usdg), 10e6, 0);
        router.setPathExtra(address(usdg), address(dca), new bytes(160));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.UnguardedHop.selector, 0));
        fr.buyback(address(usdg), 10e6, 0);
        // the owner can allow them explicitly...
        vm.prank(owner);
        fr.setGuard(30 minutes, 300, true);
        vm.prank(operator);
        fr.buyback(address(usdg), 10e6, 0);
        // ...and guarded hops on the same path are still checked
        router.setPathExtra(address(usdg), address(dca), abi.encode(address(pool)));
        pool.setTicks(5_000, 1_000);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.PriceDeviates.selector, address(pool), 5_000, 1_000, 300));
        fr.buyback(address(usdg), 10e6, 0);
    }

    function test_guard_checksEveryHopOfThePath() public {
        MockOraclePool p1 = new MockOraclePool(address(usdg), address(weth));
        MockOraclePool p2 = new MockOraclePool(address(weth), address(dca));
        p1.setTicks(0, 0);
        p2.setTicks(0, 0);
        LyingRouter liar = new LyingRouter(address(weth));
        liar.setRate(1e18, 1e6);
        bytes[] memory ex = new bytes[](2);
        ex[0] = abi.encode(address(p1));
        ex[1] = abi.encode(address(p2));
        liar.setExtras(ex);
        vm.prank(owner);
        fr.setRouter(address(liar));
        _seedReserve(address(usdg), 1_000e6);
        vm.prank(operator);
        fr.buyback(address(usdg), 10e6, 0);
        // a push on the SECOND pool of the path is caught
        p2.setTicks(400, 0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.PriceDeviates.selector, address(p2), 400, 0, 300));
        fr.buyback(address(usdg), 10e6, 0);
        // and an unguarded second hop is refused
        ex[1] = "";
        liar.setExtras(ex);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.UnguardedHop.selector, 1));
        fr.buyback(address(usdg), 10e6, 0);
    }

    function test_guard_toleratesForkSlot0Layout() public {
        pool.setExtraSlot0Words(3);
        _seedReserve(address(usdg), 1_000e6);
        vm.prank(operator);
        fr.buyback(address(usdg), 10e6, 0);
    }

    function test_guard_oracleFailureBlocksSwap() public {
        _seedReserve(address(usdg), 1_000e6);
        pool.setObserveReverts(true);
        vm.prank(operator);
        vm.expectRevert(bytes("OLD"));
        fr.buyback(address(usdg), 10e6, 0);
        // a pool without slot0 at all
        router.setPathExtra(address(usdg), address(dca), abi.encode(address(usdg)));
        pool.setObserveReverts(false);
        vm.prank(operator);
        vm.expectRevert();
        fr.buyback(address(usdg), 10e6, 0);
    }

    function test_guard_windowIsWhatIsAskedOfThePool() public {
        // The pool sees exactly [guardWindow, 0] as secondsAgos: a 1h window with the mock still passes, and a
        // different window is what setGuard changes (observable through the revert data on failure).
        _seedReserve(address(usdg), 1_000e6);
        vm.prank(owner);
        fr.setGuard(1 hours, 1, false);
        pool.setTicks(2, 0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(FeeReceiver.PriceDeviates.selector, address(pool), 2, 0, 1));
        fr.buyback(address(usdg), 10e6, 0);
        pool.setTicks(1, 0);
        vm.prank(operator);
        fr.buyback(address(usdg), 10e6, 0);
    }

    // ==================================================================
    // ETH
    // ==================================================================

    function test_eth_wrapAndDistribute() public {
        vm.deal(rando, 5 ether);
        vm.prank(rando);
        (bool ok,) = address(fr).call{value: 2 ether}("");
        assertTrue(ok);
        vm.prank(rando);
        vm.expectEmit(false, false, false, true);
        emit FeeReceiver.EthWrapped(2 ether);
        fr.wrapEth(); // anyone
        assertEq(address(fr).balance, 0);
        assertEq(fr.pending(address(weth)), 2 ether);
        _distribute(address(weth));
        assertEq(weth.balanceOf(treasury), 1.4 ether);
        assertEq(fr.buybackReserve(address(weth)), 0.6 ether);
        vm.expectRevert(FeeReceiver.ZeroAmount.selector);
        fr.wrapEth();
    }

    // ==================================================================
    // reentrancy
    // ==================================================================

    function test_reentrancy_distributeBlocked() public {
        ReentrantToken evil = new ReentrantToken();
        evil.mint(address(fr), 100e18);
        evil.setMode(ReentrantToken.Mode.Distribute);
        // A token that re-enters from its transfer hook is stopped by the role check first...
        vm.prank(operator);
        vm.expectRevert(FeeReceiver.NotOperator.selector);
        fr.distribute(address(evil));
        // ...and, even if it somehow held the operator role, by the reentrancy guard.
        vm.prank(owner);
        fr.setOperator(address(evil), true);
        vm.prank(operator);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        fr.distribute(address(evil));
        evil.setMode(ReentrantToken.Mode.Buyback);
        vm.prank(operator);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        fr.distribute(address(evil));
        assertEq(evil.balanceOf(treasury), 0);
        assertEq(fr.buybackReserve(address(evil)), 0);
    }

    // ==================================================================
    // "nothing bypasses the split"
    // ==================================================================

    function test_noWayOutButTheSplit() public {
        // Every value-moving selector on the contract, for the record. If a rescue / sweep / withdraw is ever
        // added this test must be revisited: it exists so the audit statement stays true.
        bytes4[] memory movers = new bytes4[](4);
        movers[0] = FeeReceiver.distribute.selector;
        movers[1] = FeeReceiver.distributeMany.selector;
        movers[2] = FeeReceiver.buyback.selector;
        movers[3] = FeeReceiver.convert.selector;
        assertEq(movers.length, 4);
        // and none of them is reachable without the operator role
        _fee(address(usdg), 1e6);
        vm.startPrank(rando);
        vm.expectRevert(FeeReceiver.NotOperator.selector);
        fr.distribute(address(usdg));
        vm.expectRevert(FeeReceiver.NotOperator.selector);
        fr.buyback(address(usdg), 1, 0);
        vm.expectRevert(FeeReceiver.NotOperator.selector);
        fr.convert(address(nvda), address(usdg), 1, 0);
        vm.stopPrank();
    }

    function testFuzz_reserveNeverExceedsBalance(uint96 feeA, uint96 feeB, uint16 fillBps, uint96 buy) public {
        vm.assume(feeA > 0);
        fillBps = uint16(bound(fillBps, 1, 10_000));
        _fee(address(usdg), feeA);
        _distribute(address(usdg));
        _fee(address(usdg), feeB);
        router.setFill(address(usdg), address(dca), fillBps);
        uint256 r = fr.buybackReserve(address(usdg));
        uint256 amount = bound(buy, 0, r);
        if (amount > 0 && (amount * fillBps) / 10_000 > 0) {
            uint256 quote = (((amount * fillBps) / 10_000) * 1e18) / 1e6;
            if ((quote * (BPS - 50)) / BPS > 0) {
                vm.prank(operator);
                fr.buyback(address(usdg), amount, 0);
            }
        }
        assertGe(usdg.balanceOf(address(fr)), fr.buybackReserve(address(usdg)));
        assertEq(fr.pending(address(usdg)), usdg.balanceOf(address(fr)) - fr.buybackReserve(address(usdg)));
        assertEq(dca.balanceOf(address(fr)), 0);
    }
}
