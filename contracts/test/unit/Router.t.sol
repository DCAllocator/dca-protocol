// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {AggregatorRouter} from "../../src/router/AggregatorRouter.sol";
import {IAggregatorRouter, Route} from "../../src/router/IAggregatorRouter.sol";
import {UniV3Adapter} from "../../src/router/adapters/UniV3Adapter.sol";
import {RamsesV3Adapter} from "../../src/router/adapters/RamsesV3Adapter.sol";
import {UniV4Adapter} from "../../src/router/adapters/UniV4Adapter.sol";
import {PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockV3Pool, MockV3Factory, EvilPool} from "../mocks/MockV3.sol";
import {MockV4PoolManager} from "../mocks/MockV4PoolManager.sol";

/// @dev Router + adapters against mock V3 / V4 liquidity. Verifies best-of-N selection, impact cap,
///      one-hop via WETH, callback authentication, partial-fill refunds and admin surface.
contract RouterTest is Test {
    address owner = makeAddr("owner");
    address user = makeAddr("user");

    MockERC20 usdg;
    MockERC20 weth;
    MockERC20 nvda;
    AggregatorRouter router;
    UniV3Adapter uni;
    RamsesV3Adapter ramses;
    UniV4Adapter v4;
    MockV3Factory uniFactory;
    MockV3Factory ramsesFactory;
    MockV4PoolManager pm;

    MockV3Pool uniNvda3000;
    MockV3Pool uniNvda500;
    MockV3Pool uniWethUsdg500;
    MockV3Pool uniWethNvda3000;
    MockV3Pool ramsesNvda3000;
    PoolKey v4NvdaKey;

    uint24[] tiers = [uint24(100), 500, 3000, 10000];

    function setUp() public {
        usdg = new MockERC20("USDG", "USDG", 6);
        weth = new MockERC20("WETH", "WETH", 18);
        nvda = new MockERC20("NVDA", "NVDA", 18);

        router = new AggregatorRouter(address(weth), owner);
        uniFactory = new MockV3Factory();
        ramsesFactory = new MockV3Factory();
        pm = new MockV4PoolManager();
        uni = new UniV3Adapter(1, address(router), address(uniFactory), tiers, owner);
        ramses = new RamsesV3Adapter(address(router), address(ramsesFactory), tiers, owner);
        v4 = new UniV4Adapter(address(router), address(pm), owner);

        vm.startPrank(owner);
        router.setAdapter(1, address(uni));
        router.setAdapter(2, address(v4));
        router.setAdapter(3, address(ramses));
        vm.stopPrank();

        // Prices: 1 NVDA = 500 USDG; 1 WETH = 3000 USDG; 1 WETH = 6 NVDA
        uint160 pNvdaUsdg = _sqrtPrice(address(nvda), 1e18, address(usdg), 500e6);
        uint160 pWethUsdg = _sqrtPrice(address(weth), 1e18, address(usdg), 3000e6);
        uint160 pWethNvda = _sqrtPrice(address(weth), 1e18, address(nvda), 6e18);

        uniNvda3000 = _v3(uniFactory, address(usdg), address(nvda), 3000, pNvdaUsdg);
        uniNvda500 = _v3(uniFactory, address(usdg), address(nvda), 500, pNvdaUsdg);
        uniWethUsdg500 = _v3(uniFactory, address(weth), address(usdg), 500, pWethUsdg);
        uniWethNvda3000 = _v3(uniFactory, address(weth), address(nvda), 3000, pWethNvda);
        ramsesNvda3000 = _v3(ramsesFactory, address(usdg), address(nvda), 3000, pNvdaUsdg);

        (address c0, address c1) =
            address(usdg) < address(nvda) ? (address(usdg), address(nvda)) : (address(nvda), address(usdg));
        v4NvdaKey = PoolKey({currency0: c0, currency1: c1, fee: 100, tickSpacing: 1, hooks: address(0)});
        pm.initPool(v4NvdaKey, pNvdaUsdg);
        nvda.mint(address(pm), 1_000_000e18);
        usdg.mint(address(pm), 1_000_000_000e6);
        vm.prank(owner);
        v4.addPool(v4NvdaKey);

        usdg.mint(user, 10_000_000e6);
        weth.mint(user, 10_000e18);
        nvda.mint(user, 10_000e18);
        vm.startPrank(user);
        usdg.approve(address(router), type(uint256).max);
        weth.approve(address(router), type(uint256).max);
        nvda.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /// @dev sqrtPriceX96 such that `baseAmt` of `base` == `quoteAmt` of `quote` (raw units), token0 = lower address.
    function _sqrtPrice(address base, uint256 baseAmt, address quote, uint256 quoteAmt)
        internal
        pure
        returns (uint160)
    {
        (uint256 num, uint256 den) = base < quote ? (quoteAmt, baseAmt) : (baseAmt, quoteAmt);
        return uint160(Math.sqrt(Math.mulDiv(2 ** 192, num, den)));
    }

    function _v3(MockV3Factory f, address a, address b, uint24 fee, uint160 sqrtP) internal returns (MockV3Pool p) {
        p = MockV3Pool(f.createPool(a, b, fee, sqrtP));
        usdg.mint(address(p), 1_000_000_000e6);
        weth.mint(address(p), 1_000_000e18);
        nvda.mint(address(p), 1_000_000e18);
    }

    function _expectedOut(uint256 amountIn, uint256 midOut, uint24 fee, uint256 impact)
        internal
        pure
        returns (uint256)
    {
        amountIn;
        uint256 o = (midOut * (1_000_000 - fee)) / 1_000_000;
        return (o * (10_000 - impact)) / 10_000;
    }

    // ------------------------------------------------------------------
    // Quote selection
    // ------------------------------------------------------------------

    function test_quote_picksHighestOutputAcrossAdapters() public {
        // V4 pool has 1 bps fee -> best
        (uint256 out, Route[] memory path, uint256 impact) =
            router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path.length, 1);
        assertEq(path[0].protocol, 2, "V4 wins with 0.01% fee");
        assertEq(path[0].fee, 100);
        uint256 mid = uniNvda500.midOut(address(usdg) < address(nvda), 1_000e6);
        assertEq(out, _expectedOut(1_000e6, mid, 100, 0));
        assertEq(impact, 1, "impact vs mid == fee (1 bps)");
        assertApproxEqRel(out, 2e18, 0.001e18, "~2 NVDA for 1000 USDG");

        // remove the V4 pool -> Uni V3 500 tier wins over 3000 tiers
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        (, path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].protocol, 1);
        assertEq(path[0].fee, 500);
        assertEq(abi.decode(path[0].extra, (address)), address(uniNvda500));

        // degrade the 500 tier -> Uni 3000 and Ramses 3000 tie; Uni is listed first and strictly-greater wins
        uniNvda500.setImpact(120);
        (, path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].fee, 3000);
        assertEq(path[0].protocol, 1);

        // make Ramses better
        ramsesNvda3000.setPrice(_sqrtPrice(address(nvda), 1e18, address(usdg), 490e6));
        (, path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].protocol, 3, "Ramses wins with better price");
    }

    function test_quote_plainQuoteMatchesWithImpact() public {
        (uint256 a, Route[] memory pa) = router.quote(address(usdg), address(nvda), 1_000e6);
        (uint256 b, Route[] memory pb,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(a, b);
        assertEq(pa[0].protocol, pb[0].protocol);
    }

    function test_quote_impactCapRejectsDirectFallsBackToHop() public {
        // All direct USDG/NVDA pools exceed 150 bps -> route USDG -> WETH -> NVDA
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        uniNvda3000.setImpact(200);
        uniNvda500.setImpact(200);
        ramsesNvda3000.setImpact(200);
        (uint256 out, Route[] memory path, uint256 impact) =
            router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path.length, 2);
        assertEq(path[0].tokenIn, address(usdg));
        assertEq(path[0].tokenOut, address(weth));
        assertEq(path[1].tokenIn, address(weth));
        assertEq(path[1].tokenOut, address(nvda));
        // 0.05% + 0.3% fees ~ 35 bps impact
        assertApproxEqAbs(impact, 35, 1);
        assertLe(impact, router.maxPriceImpactBps());
        assertApproxEqRel(out, 2e18, 0.005e18);
    }

    function test_quote_hopPreferredWhenBetter() public {
        // Direct pools ok but expensive (fee 3000 + 100 bps impact); hop is cheaper.
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        uniNvda500.setImpact(100);
        uniNvda3000.setImpact(100);
        ramsesNvda3000.setImpact(100);
        (, Route[] memory path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path.length, 2, "hop wins on output");
    }

    function test_quote_noRouteReverts() public {
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        uniNvda3000.setImpact(500);
        uniNvda500.setImpact(500);
        ramsesNvda3000.setImpact(500);
        uniWethNvda3000.setImpact(500);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quote(address(usdg), address(nvda), 1_000e6);
    }

    function test_quote_unknownPairReverts() public {
        MockERC20 x = new MockERC20("X", "X", 18);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(x), address(nvda)));
        router.quote(address(x), address(nvda), 1e18);
    }

    function test_quote_inputValidation() public {
        vm.expectRevert(IAggregatorRouter.ZeroAmount.selector);
        router.quote(address(usdg), address(nvda), 0);
        vm.expectRevert(IAggregatorRouter.InvalidPath.selector);
        router.quote(address(usdg), address(usdg), 1);
    }

    function test_quote_brokenPoolIsSkipped() public {
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        uniNvda500.setBroken(true);
        (, Route[] memory path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].fee, 3000, "broken 500 tier ignored");
    }

    function test_quote_wethLegHasNoHop() public {
        (, Route[] memory path,) = router.quoteWithImpact(address(weth), address(usdg), 1e18);
        assertEq(path.length, 1);
        assertEq(path[0].fee, 500);
    }

    // ------------------------------------------------------------------
    // Swaps
    // ------------------------------------------------------------------

    function test_swap_direct() public {
        (uint256 q,) = router.quote(address(usdg), address(nvda), 1_000e6);
        uint256 before = nvda.balanceOf(user);
        vm.prank(user);
        vm.expectEmit(true, true, true, true);
        emit IAggregatorRouter.Swapped(user, address(usdg), address(nvda), 1_000e6, q);
        uint256 out = router.swap(address(usdg), address(nvda), 1_000e6, q, user);
        assertEq(out, q);
        assertEq(nvda.balanceOf(user) - before, q);
        assertEq(usdg.balanceOf(address(v4)), 0, "adapter holds nothing");
        assertEq(nvda.balanceOf(address(v4)), 0);
    }

    function test_swap_v3Direct() public {
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        (uint256 q, Route[] memory path) = router.quote(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].protocol, 1);
        uint256 before = nvda.balanceOf(user);
        vm.prank(user);
        uint256 out = router.swapWithRoute(address(usdg), address(nvda), 1_000e6, q, user, path);
        assertEq(out, q);
        assertEq(nvda.balanceOf(user) - before, q);
        assertEq(usdg.balanceOf(address(uni)), 0);
    }

    function test_swap_hop() public {
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        uniNvda3000.setImpact(200);
        uniNvda500.setImpact(200);
        ramsesNvda3000.setImpact(200);
        (uint256 q, Route[] memory path) = router.quote(address(usdg), address(nvda), 1_000e6);
        assertEq(path.length, 2);
        uint256 before = nvda.balanceOf(user);
        vm.prank(user);
        uint256 out = router.swapWithRoute(address(usdg), address(nvda), 1_000e6, q, user, path);
        assertEq(out, q);
        assertEq(nvda.balanceOf(user) - before, q);
        assertEq(weth.balanceOf(address(uni)), 0, "intermediate fully consumed");
    }

    function test_swap_minOutReverts() public {
        (uint256 q,) = router.quote(address(usdg), address(nvda), 1_000e6);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.InsufficientOutput.selector, q, q + 1));
        router.swap(address(usdg), address(nvda), 1_000e6, q + 1, user);
    }

    function test_swap_partialFillRefundsCaller() public {
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        // Pool runs out of liquidity at 1.98 NVDA (~1% below the ~1.999 quote: within the impact cap).
        uniNvda500.setMaxOut(1.98e18);
        uniNvda3000.setBroken(true);
        ramsesNvda3000.setBroken(true);
        uniWethNvda3000.setBroken(true);
        (uint256 q, Route[] memory path) = router.quote(address(usdg), address(nvda), 1_000e6);
        assertEq(q, 1.98e18, "quote reflects the partial fill");
        uint256 usdgBefore = usdg.balanceOf(user);
        vm.prank(user);
        router.swapWithRoute(address(usdg), address(nvda), 1_000e6, q, user, path);
        uint256 spent = usdgBefore - usdg.balanceOf(user);
        assertLt(spent, 1_000e6, "unspent input refunded");
        assertApproxEqRel(spent, 990.5e6, 0.002e18);
        assertEq(usdg.balanceOf(address(uni)), 0);
    }

    function test_swapWithRoute_validation() public {
        Route[] memory p = new Route[](0);
        vm.prank(user);
        vm.expectRevert(IAggregatorRouter.InvalidPath.selector);
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);

        p = new Route[](1);
        p[0] = Route({
            protocol: 1, tokenIn: address(weth), tokenOut: address(nvda), fee: 3000, extra: abi.encode(uniWethNvda3000)
        });
        vm.prank(user);
        vm.expectRevert(IAggregatorRouter.InvalidPath.selector);
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);

        p = new Route[](2);
        p[0] = Route({
            protocol: 1, tokenIn: address(usdg), tokenOut: address(weth), fee: 500, extra: abi.encode(uniWethUsdg500)
        });
        p[1] = Route({
            protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 500, extra: abi.encode(uniNvda500)
        });
        vm.prank(user);
        vm.expectRevert(IAggregatorRouter.InvalidPath.selector);
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);

        p = new Route[](1);
        p[0] = Route({protocol: 7, tokenIn: address(usdg), tokenOut: address(nvda), fee: 500, extra: ""});
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.AdapterNotSet.selector, 7));
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);

        vm.prank(user);
        vm.expectRevert(IAggregatorRouter.ZeroAmount.selector);
        router.swapWithRoute(address(usdg), address(nvda), 0, 0, user, p);
    }

    function test_swapWithRoute_unknownV3PoolRejected() public {
        EvilPool evil = new EvilPool(address(usdg), address(nvda));
        Route[] memory p = new Route[](1);
        p[0] = Route({
            protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 3000, extra: abi.encode(address(evil))
        });
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(UniV3Adapter.UnknownPool.selector, address(evil)));
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);
    }

    function test_swapWithRoute_tokenMismatchRejected() public {
        Route[] memory p = new Route[](1);
        // real pool, wrong token pair in the route
        p[0] = Route({
            protocol: 1, tokenIn: address(weth), tokenOut: address(nvda), fee: 500, extra: abi.encode(uniNvda500)
        });
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(UniV3Adapter.PoolTokenMismatch.selector, address(uniNvda500)));
        router.swapWithRoute(address(weth), address(nvda), 1e18, 0, user, p);
    }

    function test_swapWithRoute_factoryVerifiedPoolWithoutPriorQuote() public {
        // Fresh adapter that never quoted this pool: swap must still verify via the factory and succeed.
        UniV3Adapter fresh = new UniV3Adapter(1, address(router), address(uniFactory), tiers, owner);
        vm.prank(owner);
        router.setAdapter(1, address(fresh));
        Route[] memory p = new Route[](1);
        p[0] = Route({
            protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 500, extra: abi.encode(uniNvda500)
        });
        vm.prank(user);
        uint256 out = router.swapWithRoute(address(usdg), address(nvda), 1_000e6, 1, user, p);
        assertGt(out, 0);
        assertTrue(fresh.verifiedPool(address(uniNvda500)));
    }

    // ------------------------------------------------------------------
    // Adapter security
    // ------------------------------------------------------------------

    function test_adapter_onlyRouterCanSwap() public {
        Route memory r = Route({
            protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 500, extra: abi.encode(uniNvda500)
        });
        vm.prank(user);
        vm.expectRevert(UniV3Adapter.OnlyRouter.selector);
        uni.swap(r, 1e6, user, user);
        PoolKey memory k = v4NvdaKey;
        r = Route({protocol: 2, tokenIn: address(usdg), tokenOut: address(nvda), fee: 100, extra: abi.encode(k)});
        vm.prank(user);
        vm.expectRevert(UniV4Adapter.OnlyRouter.selector);
        v4.swap(r, 1e6, user, user);
    }

    function test_adapter_callbackRejectsUnverifiedCaller() public {
        EvilPool evil = new EvilPool(address(usdg), address(nvda));
        usdg.mint(address(uni), 1_000e6); // stray balance an attacker would love
        bytes memory forged = abi.encode(
            UniV3Adapter.CallbackData({mode: 1, pool: address(evil), tokenIn: address(usdg), tokenOut: address(nvda)})
        );
        vm.expectRevert(UniV3Adapter.UnauthorizedCallback.selector);
        evil.attack(address(uni), forged);
        // forged data naming a real pool but called from the wrong address
        forged = abi.encode(
            UniV3Adapter.CallbackData({
                mode: 1, pool: address(uniNvda500), tokenIn: address(usdg), tokenOut: address(nvda)
            })
        );
        vm.expectRevert(UniV3Adapter.UnauthorizedCallback.selector);
        evil.attack(address(uni), forged);
        assertEq(usdg.balanceOf(address(uni)), 1_000e6, "nothing drained");
    }

    function test_adapter_greedyVerifiedPoolCannotDrainMoreThanInput() public {
        // Worst case: a compromised factory verifies a greedy pool. The adapter holds nothing between swaps,
        // so a callback demanding more than this swap's input simply reverts and the user keeps their funds.
        EvilPool evil = new EvilPool(address(usdg), address(nvda));
        uniFactory.forceRegister(address(usdg), address(nvda), 3000, address(evil));
        UniV3Adapter fresh = new UniV3Adapter(1, address(router), address(uniFactory), tiers, owner);
        vm.prank(owner);
        router.setAdapter(1, address(fresh));
        Route[] memory p = new Route[](1);
        p[0] = Route({
            protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 3000, extra: abi.encode(address(evil))
        });
        uint256 before = usdg.balanceOf(user);
        vm.prank(user);
        vm.expectRevert(); // ERC20InsufficientBalance inside the callback
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);
        assertEq(usdg.balanceOf(user), before);
        assertEq(usdg.balanceOf(address(fresh)), 0);
    }

    function test_v4_callbackOnlyFromPoolManager() public {
        vm.expectRevert(UniV4Adapter.OnlyPoolManager.selector);
        v4.unlockCallback("");
    }

    function test_v4_addPoolValidation() public {
        PoolKey memory bad = v4NvdaKey;
        bad.currency0 = address(0);
        vm.prank(owner);
        vm.expectRevert(UniV4Adapter.InvalidPoolKey.selector);
        v4.addPool(bad);
        bad = v4NvdaKey;
        (bad.currency0, bad.currency1) = (bad.currency1, bad.currency0);
        vm.prank(owner);
        vm.expectRevert(UniV4Adapter.InvalidPoolKey.selector);
        v4.addPool(bad);
        // idempotent add / remove
        vm.startPrank(owner);
        v4.addPool(v4NvdaKey);
        assertEq(v4.poolCount(), 1);
        v4.removePool(v4NvdaKey);
        v4.removePool(v4NvdaKey);
        assertEq(v4.poolCount(), 0);
        assertFalse(v4.enabled());
        vm.stopPrank();
        assertEq(v4.pools(address(usdg), address(nvda)).length, 0);
    }

    function test_v4_swapUnknownPoolRejected() public {
        PoolKey memory k = v4NvdaKey;
        k.fee = 3000;
        Route[] memory p = new Route[](1);
        p[0] = Route({protocol: 2, tokenIn: address(usdg), tokenOut: address(nvda), fee: 3000, extra: abi.encode(k)});
        bytes32 id = v4.poolId(k);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(UniV4Adapter.UnknownPool.selector, id));
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);
        // token mismatch
        p[0] = Route({
            protocol: 2, tokenIn: address(weth), tokenOut: address(nvda), fee: 100, extra: abi.encode(v4NvdaKey)
        });
        vm.prank(user);
        vm.expectRevert(UniV4Adapter.PoolTokenMismatch.selector);
        router.swapWithRoute(address(weth), address(nvda), 1e18, 0, user, p);
    }

    function test_v4_partialFillRefund() public {
        pm.setMaxOut(v4NvdaKey, 1.98e18);
        uniNvda500.setBroken(true);
        uniNvda3000.setBroken(true);
        ramsesNvda3000.setBroken(true);
        uniWethNvda3000.setBroken(true);
        (uint256 q, Route[] memory path) = router.quote(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].protocol, 2);
        assertEq(q, 1.98e18);
        uint256 before = usdg.balanceOf(user);
        vm.prank(user);
        router.swapWithRoute(address(usdg), address(nvda), 1_000e6, q, user, path);
        assertApproxEqRel(before - usdg.balanceOf(user), 990.1e6, 0.002e18);
        assertEq(usdg.balanceOf(address(v4)), 0);
    }

    function test_v4_reverseDirection() public {
        (uint256 q, Route[] memory path) = router.quote(address(nvda), address(usdg), 1e18);
        assertEq(path[0].protocol, 2);
        assertApproxEqRel(q, 500e6, 0.001e18);
        vm.prank(user);
        uint256 out = router.swapWithRoute(address(nvda), address(usdg), 1e18, q, user, path);
        assertEq(out, q);
    }

    function test_v4_poolsSlotOverride() public {
        vm.prank(owner);
        v4.setPoolsSlot(bytes32(uint256(7)));
        // mid can no longer be read -> impact reads as maximal -> V4 excluded, V3 wins
        (, Route[] memory path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].protocol, 1);
    }

    // ------------------------------------------------------------------
    // Explicit pool registration (factory-less adapter)
    // ------------------------------------------------------------------

    function test_registerPool_factorylessAdapter() public {
        UniV3Adapter bare = new UniV3Adapter(3, address(router), address(0), tiers, owner);
        assertFalse(bare.enabled());
        vm.prank(owner);
        bare.registerPool(address(ramsesNvda3000));
        assertTrue(bare.enabled());
        assertEq(bare.extraPools(address(usdg), address(nvda)).length, 1);
        (uint256 out,, Route memory r) = bare.quote(address(usdg), address(nvda), 1_000e6);
        assertGt(out, 0);
        assertEq(abi.decode(r.extra, (address)), address(ramsesNvda3000));
        vm.prank(owner);
        bare.unregisterPool(address(ramsesNvda3000));
        assertFalse(bare.enabled());
        assertFalse(bare.verifiedPool(address(ramsesNvda3000)));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(UniV3Adapter.InvalidPool.selector, address(0xdead)));
        bare.registerPool(address(0xdead));
    }

    function test_setFeeTiers() public {
        uint24[] memory t = new uint24[](1);
        t[0] = 3000;
        vm.prank(owner);
        uni.setFeeTiers(t);
        assertEq(uni.feeTiers().length, 1);
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        (, Route[] memory path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].fee, 3000, "500 tier no longer probed");
    }

    // ------------------------------------------------------------------
    // Router admin
    // ------------------------------------------------------------------

    function test_admin() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(AggregatorRouter.ProtocolIdOutOfRange.selector, 0));
        router.setAdapter(0, address(uni));
        vm.expectRevert(abi.encodeWithSelector(AggregatorRouter.ProtocolIdOutOfRange.selector, 9));
        router.setAdapter(9, address(uni));
        vm.expectRevert(abi.encodeWithSelector(AggregatorRouter.ImpactCapOutOfRange.selector, 1001));
        router.setMaxPriceImpactBps(1001);
        router.setMaxPriceImpactBps(10);
        assertEq(router.maxPriceImpactBps(), 10);
        assertEq(router.protocols().length, 3);
        router.setAdapter(1, address(0)); // disable
        assertEq(router.protocols().length, 3, "id stays listed, adapter cleared");
        vm.stopPrank();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.setAdapter(1, address(uni));
        assertEq(router.weth(), address(weth));
    }

    function test_disabledAdapterSkipped() public {
        vm.startPrank(owner);
        router.setAdapter(1, address(0));
        router.setAdapter(3, address(0));
        v4.removePool(v4NvdaKey);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quote(address(usdg), address(nvda), 1e6);
    }

    // ------------------------------------------------------------------
    // Edge branches (coverage of defensive paths)
    // ------------------------------------------------------------------

    function test_v4_views() public view {
        assertEq(v4.protocolId(), 2);
        assertEq(v4.pools(address(nvda), address(usdg)).length, 1);
        assertEq(v4.poolId(v4NvdaKey), keccak256(abi.encode(v4NvdaKey)));
        assertEq(uni.protocolId(), 1);
        assertEq(ramses.protocolId(), 3);
        assertEq(uni.router(), address(router));
        assertEq(address(v4.poolManager()), address(pm));
    }

    function test_v4_uninitializedRegisteredPoolQuotesZero() public {
        // Registered in the adapter but never initialised in the PoolManager: simulate reverts with a
        // non-sentinel reason -> treated as "no fill", router falls back to V3.
        PoolKey memory k = v4NvdaKey;
        k.fee = 3000;
        vm.prank(owner);
        v4.addPool(k);
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        (, Route[] memory path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].protocol, 1);
        (uint256 out,,) = v4.quote(address(usdg), address(nvda), 1_000e6);
        assertEq(out, 0);
    }

    function test_v4_quoteShortCircuits() public {
        (uint256 out,,) = v4.quote(address(usdg), address(nvda), 0);
        assertEq(out, 0);
        (out,,) = v4.quote(address(usdg), address(usdg), 1);
        assertEq(out, 0);
        (out,,) = v4.quote(address(weth), address(nvda), 1e18); // no V4 pool for this pair
        assertEq(out, 0);
    }

    function test_v4_swapWithZeroOutputPool() public {
        // Pool returns 0 output (maxOut = tiny, rounds to 0 input) -> adapter returns (0, 0) and router reverts on minOut
        pm.setMaxOut(v4NvdaKey, 1);
        Route[] memory p = new Route[](1);
        p[0] = Route({
            protocol: 2, tokenIn: address(usdg), tokenOut: address(nvda), fee: 100, extra: abi.encode(v4NvdaKey)
        });
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.InsufficientOutput.selector, 1, 2));
        router.swapWithRoute(address(usdg), address(nvda), 1_000e6, 2, user, p);
    }

    function test_v3_quoteShortCircuits() public {
        (uint256 out,,) = uni.quote(address(usdg), address(nvda), 0);
        assertEq(out, 0);
        (out,,) = uni.quote(address(usdg), address(usdg), 1);
        assertEq(out, 0);
        MockERC20 x = new MockERC20("X", "X", 18);
        (out,,) = uni.quote(address(x), address(nvda), 1e18);
        assertEq(out, 0, "no pools for pair");
    }

    function test_v3_midOutDefensive() public {
        // Pool whose slot0 reports a zero price -> mid 0 -> impact maximal -> excluded
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        uniNvda500.setPrice(0);
        // With price 0 the mock's swap output is also 0, so the 500 tier just loses; 3000 tier wins.
        (, Route[] memory path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].fee, 3000);
    }

    function test_v3_unregisterUnknownPoolIsNoop() public {
        vm.prank(owner);
        uni.unregisterPool(address(uniNvda500)); // factory pool, never in extras
        assertEq(uni.extraPoolCount(), 0);
        assertFalse(uni.verifiedPool(address(uniNvda500)), "verification cleared; factory re-verifies on demand");
        (uint256 out,,) = uni.quote(address(usdg), address(nvda), 1_000e6);
        assertGt(out, 0);
        assertTrue(uni.verifiedPool(address(uniNvda500)));
    }

    function test_v3_registerPoolIdempotentAndRejectsBadTokens() public {
        vm.startPrank(owner);
        uni.registerPool(address(ramsesNvda3000));
        uni.registerPool(address(ramsesNvda3000));
        assertEq(uni.extraPoolCount(), 1);
        EvilPool weird = new EvilPool(address(usdg), address(nvda));
        uni.registerPool(address(weird)); // token0 < token1 holds, accepted (owner responsibility)
        assertEq(uni.extraPoolCount(), 2);
        vm.stopPrank();
    }

    function test_v3_verifyFactoryPoolFailsForNonPool() public {
        Route[] memory p = new Route[](1);
        p[0] = Route({
            protocol: 1, tokenIn: address(usdg), tokenOut: address(nvda), fee: 500, extra: abi.encode(address(0xbeef))
        });
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(UniV3Adapter.UnknownPool.selector, address(0xbeef)));
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);
        // factory-less adapter can never verify via factory
        UniV3Adapter bare = new UniV3Adapter(1, address(router), address(0), tiers, owner);
        vm.prank(owner);
        router.setAdapter(1, address(bare));
        p[0].extra = abi.encode(address(uniNvda500));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(UniV3Adapter.UnknownPool.selector, address(uniNvda500)));
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);
    }

    function test_router_adapterQuoteRevertIsSkipped() public {
        // An adapter that reverts on quote must not brick the router.
        RevertingAdapter bad = new RevertingAdapter();
        vm.prank(owner);
        router.setAdapter(4, address(bad));
        (uint256 out,,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertGt(out, 0);
        vm.prank(owner);
        router.setAdapter(4, address(0));
    }

    function test_router_hopWithZeroFirstLegIsIgnored() public {
        vm.prank(owner);
        v4.removePool(v4NvdaKey);
        uniWethUsdg500.setBroken(true); // no USDG->WETH leg
        uniNvda500.setImpact(200);
        uniNvda3000.setImpact(200);
        ramsesNvda3000.setImpact(200);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quote(address(usdg), address(nvda), 1_000e6);
    }
}

contract RevertingAdapter {
    function protocolId() external pure returns (uint8) {
        return 4;
    }

    function enabled() external pure returns (bool) {
        return true;
    }

    function quote(address, address, uint256) external pure returns (uint256, uint256, Route memory) {
        revert("boom");
    }
}
