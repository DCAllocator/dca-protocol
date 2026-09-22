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

/// @dev Router + adapters against mock V3 / V4 liquidity. The router only ever considers owner-approved hops:
///      verifies approval / revocation, best-of-N selection among approved hops, impact cap, one-hop via WETH,
///      callback authentication, partial-fill refunds (hop 0 -> caller, later hops -> recipient) and admin.
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

    Route rUni3000;
    Route rUni500;
    Route rRamses3000;
    Route rV4;
    Route rV4Reverse;
    Route rUsdgWeth;
    Route rWethUsdg;
    Route rWethNvda;

    function setUp() public {
        usdg = new MockERC20("USDG", "USDG", 6);
        weth = new MockERC20("WETH", "WETH", 18);
        nvda = new MockERC20("NVDA", "NVDA", 18);

        router = new AggregatorRouter(address(weth), owner);
        uniFactory = new MockV3Factory();
        ramsesFactory = new MockV3Factory();
        pm = new MockV4PoolManager();
        uni = new UniV3Adapter(1, address(router), address(uniFactory), owner);
        ramses = new RamsesV3Adapter(address(router), address(ramsesFactory), owner);
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

        // Approved hops: the four USDG->NVDA candidates, both WETH/USDG directions, WETH->NVDA, NVDA->USDG (V4).
        rUni3000 = _r(1, address(usdg), address(nvda), 3000, abi.encode(uniNvda3000));
        rUni500 = _r(1, address(usdg), address(nvda), 500, abi.encode(uniNvda500));
        rRamses3000 = _r(3, address(usdg), address(nvda), 3000, abi.encode(ramsesNvda3000));
        rV4 = _r(2, address(usdg), address(nvda), 100, abi.encode(v4NvdaKey));
        rV4Reverse = _r(2, address(nvda), address(usdg), 100, abi.encode(v4NvdaKey));
        rUsdgWeth = _r(1, address(usdg), address(weth), 500, abi.encode(uniWethUsdg500));
        rWethUsdg = _r(1, address(weth), address(usdg), 500, abi.encode(uniWethUsdg500));
        rWethNvda = _r(1, address(weth), address(nvda), 3000, abi.encode(uniWethNvda3000));
        vm.startPrank(owner);
        router.approveHop(rUni3000);
        router.approveHop(rUni500);
        router.approveHop(rRamses3000);
        router.approveHop(rV4);
        router.approveHop(rV4Reverse);
        router.approveHop(rUsdgWeth);
        router.approveHop(rWethUsdg);
        router.approveHop(rWethNvda);
        vm.stopPrank();

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

    function _r(uint8 protocol, address tokenIn, address tokenOut, uint24 fee, bytes memory extra)
        internal
        pure
        returns (Route memory)
    {
        return Route({protocol: protocol, tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, extra: extra});
    }

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

    function _expectedOut(uint256 midOut, uint24 fee, uint256 impact) internal pure returns (uint256) {
        uint256 o = (midOut * (1_000_000 - fee)) / 1_000_000;
        return (o * (10_000 - impact)) / 10_000;
    }

    function _revoke(Route memory r) internal {
        vm.prank(owner);
        router.revokeHop(r);
    }

    // ------------------------------------------------------------------
    // Hop approval (the allowlist)
    // ------------------------------------------------------------------

    function test_approveHop_listsAndKeys() public view {
        assertEq(router.approvedHops(address(usdg), address(nvda)).length, 4);
        assertEq(router.approvedHops(address(nvda), address(usdg)).length, 1);
        assertEq(router.approvedHops(address(weth), address(nvda)).length, 1);
        assertTrue(router.isApprovedHop(router.hopKey(rUni500)));
        assertFalse(
            router.isApprovedHop(router.hopKey(_r(1, address(nvda), address(weth), 3000, abi.encode(uniWethNvda3000))))
        );
    }

    function test_approveHop_validation() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(AggregatorRouter.HopAlreadyApproved.selector, router.hopKey(rUni500)));
        router.approveHop(rUni500);
        // zero / same tokens
        vm.expectRevert(AggregatorRouter.InvalidRoute.selector);
        router.approveHop(_r(1, address(0), address(nvda), 500, abi.encode(uniNvda500)));
        vm.expectRevert(AggregatorRouter.InvalidRoute.selector);
        router.approveHop(_r(1, address(usdg), address(usdg), 500, abi.encode(uniNvda500)));
        // adapter not set
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.AdapterNotSet.selector, 7));
        router.approveHop(_r(7, address(usdg), address(nvda), 500, abi.encode(uniNvda500)));
        // wrong protocol for the adapter's pool encoding / unknown pool / token mismatch
        EvilPool evil = new EvilPool(address(usdg), address(nvda));
        vm.expectRevert(AggregatorRouter.InvalidRoute.selector);
        router.approveHop(_r(1, address(usdg), address(nvda), 3000, abi.encode(address(evil))));
        vm.expectRevert(AggregatorRouter.InvalidRoute.selector);
        router.approveHop(_r(1, address(weth), address(nvda), 500, abi.encode(uniNvda500)));
        vm.expectRevert(AggregatorRouter.InvalidRoute.selector);
        router.approveHop(_r(1, address(usdg), address(nvda), 500, ""));
        PoolKey memory k = v4NvdaKey;
        k.fee = 3000; // not registered on the adapter
        vm.expectRevert(AggregatorRouter.InvalidRoute.selector);
        router.approveHop(_r(2, address(usdg), address(nvda), 3000, abi.encode(k)));
        vm.expectRevert(AggregatorRouter.InvalidRoute.selector);
        router.approveHop(_r(2, address(weth), address(nvda), 100, abi.encode(v4NvdaKey)));
        vm.stopPrank();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.approveHop(rUni500);
    }

    function test_approveHop_capPerPair() public {
        // 4 already on USDG->NVDA; fill up to 8 with distinct fee tags (same pool, different `fee` = distinct key)
        vm.startPrank(owner);
        for (uint24 f = 1; f <= 4; ++f) {
            router.approveHop(_r(1, address(usdg), address(nvda), f, abi.encode(uniNvda500)));
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                AggregatorRouter.TooManyHops.selector, keccak256(abi.encodePacked(address(usdg), address(nvda)))
            )
        );
        router.approveHop(_r(1, address(usdg), address(nvda), 9, abi.encode(uniNvda500)));
        vm.stopPrank();
    }

    function test_revokeHop() public {
        bytes32 k = router.hopKey(rV4);
        vm.prank(owner);
        vm.expectEmit(true, false, false, false);
        emit IAggregatorRouter.HopRevoked(k, rV4);
        router.revokeHop(rV4);
        assertFalse(router.isApprovedHop(k));
        assertEq(router.approvedHops(address(usdg), address(nvda)).length, 3);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AggregatorRouter.HopNotApproved.selector, k));
        router.revokeHop(rV4);
        // can be re-approved
        vm.prank(owner);
        router.approveHop(rV4);
        assertTrue(router.isApprovedHop(k));
    }

    // ------------------------------------------------------------------
    // Quote selection among approved hops
    // ------------------------------------------------------------------

    function test_quote_picksHighestOutputAcrossApprovedHops() public {
        // V4 pool has 1 bps fee -> best
        (uint256 out, Route[] memory path, uint256 impact) =
            router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path.length, 1);
        assertEq(path[0].protocol, 2, "V4 wins with 0.01% fee");
        uint256 mid = uniNvda500.midOut(address(usdg) < address(nvda), 1_000e6);
        assertEq(out, _expectedOut(mid, 100, 0));
        assertEq(impact, 1, "impact vs mid == fee (1 bps)");
        assertApproxEqRel(out, 2e18, 0.001e18, "~2 NVDA for 1000 USDG");

        // revoke the V4 hop -> Uni V3 500 tier wins over 3000 tiers
        _revoke(rV4);
        (, path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].protocol, 1);
        assertEq(path[0].fee, 500);
        assertEq(abi.decode(path[0].extra, (address)), address(uniNvda500));

        // degrade the 500 tier -> Uni 3000 and Ramses 3000 tie; first approved wins on strictly-greater
        uniNvda500.setImpact(120);
        (, path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].fee, 3000);
        assertEq(path[0].protocol, 1);

        // make Ramses better
        ramsesNvda3000.setPrice(_sqrtPrice(address(nvda), 1e18, address(usdg), 490e6));
        (, path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].protocol, 3, "Ramses wins with better price");
    }

    /// A thin pool with a marginally better output but impact above the cap must not mask a good pool.
    function test_quote_selectionIsCapAware() public {
        _revoke(rV4);
        _revoke(rRamses3000);
        _revoke(rWethNvda); // no two-hop alternative: compare the two direct pools only
        // uni500: mid 500, 5 bps fee, but 2% impact -> out ~ 0.999*0.98/500. uni3000: 30 bps fee, no impact.
        uniNvda500.setImpact(200);
        uniNvda3000.setPrice(_sqrtPrice(address(nvda), 1e18, address(usdg), 505e6)); // slightly worse mid
        (uint256 out500,) = uni.quoteRoute(rUni500, 1_000e6);
        (uint256 out3000,) = uni.quoteRoute(rUni3000, 1_000e6);
        assertLt(out500, out3000, "sanity: here the capped pool is also worse");
        uniNvda3000.setPrice(_sqrtPrice(address(nvda), 1e18, address(usdg), 520e6)); // now uni500 outputs more
        (out3000,) = uni.quoteRoute(rUni3000, 1_000e6);
        assertGt(out500, out3000, "capped pool has the higher raw output");
        (uint256 out, Route[] memory path, uint256 impact) =
            router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path.length, 1);
        assertEq(path[0].fee, 3000, "the in-cap pool wins even though it outputs less");
        assertEq(out, out3000);
        assertLe(impact, router.maxPriceImpactBps());
    }

    function test_quotePath() public {
        Route[] memory p = new Route[](1);
        p[0] = rUni500;
        (uint256 direct,) = uni.quoteRoute(rUni500, 1_000e6);
        assertEq(router.quotePath(p, 1_000e6), direct);
        p = new Route[](2);
        p[0] = rUsdgWeth;
        p[1] = rWethNvda;
        assertApproxEqRel(router.quotePath(p, 1_000e6), 2e18, 0.01e18);
        // unapproved / broken / malformed
        p = new Route[](1);
        p[0] = _r(1, address(usdg), address(nvda), 10000, abi.encode(uniNvda500));
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.RouteNotApproved.selector, router.hopKey(p[0])));
        router.quotePath(p, 1_000e6);
        uniNvda500.setBroken(true);
        p[0] = rUni500;
        vm.expectRevert(); // adapter's simulate revert bubbles as NoRoute
        router.quotePath(p, 1_000e6);
        p = new Route[](2);
        p[0] = rUsdgWeth;
        p[1] = rUni3000; // discontinuous
        vm.expectRevert(IAggregatorRouter.InvalidPath.selector);
        router.quotePath(p, 1_000e6);
        vm.expectRevert(IAggregatorRouter.ZeroAmount.selector);
        router.quotePath(p, 0);
    }

    /// audit v0.3 M-02: quotePath applies the same impact cap as the automatic selection, direct and two-hop.
    function test_quotePath_enforcesImpactCap() public {
        uniNvda500.setBroken(false);
        Route[] memory p = new Route[](1);
        p[0] = rUni500;
        uniNvda500.setImpact(200); // 2% + 5 bps fee > 150 bps
        vm.expectPartialRevert(IAggregatorRouter.PriceImpactTooHigh.selector);
        router.quotePath(p, 1_000e6);
        uniNvda500.setImpact(100);
        assertGt(router.quotePath(p, 1_000e6), 0, "1% + fee is inside the cap");
        p = new Route[](2);
        p[0] = rUsdgWeth;
        p[1] = rWethNvda;
        uniWethNvda3000.setImpact(200);
        vm.expectPartialRevert(IAggregatorRouter.PriceImpactTooHigh.selector);
        router.quotePath(p, 1_000e6);
        uniWethNvda3000.setImpact(0);
        assertGt(router.quotePath(p, 1_000e6), 0);
    }

    function test_quote_unapprovedPoolIsNeverConsidered() public {
        // A better pool exists in the factory but is not approved: ignored.
        MockV3Pool cheap =
            _v3(uniFactory, address(usdg), address(nvda), 100, _sqrtPrice(address(nvda), 1e18, address(usdg), 400e6));
        (, Route[] memory path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].protocol, 2, "still V4");
        assertTrue(abi.decode(path[0].extra, (address)) != address(cheap) || path[0].protocol != 1);
        vm.prank(owner);
        router.approveHop(_r(1, address(usdg), address(nvda), 100, abi.encode(cheap)));
        (, path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].protocol, 1);
        assertEq(abi.decode(path[0].extra, (address)), address(cheap), "approved -> wins");
    }

    function test_quote_plainQuoteMatchesWithImpact() public {
        (uint256 a, Route[] memory pa) = router.quote(address(usdg), address(nvda), 1_000e6);
        (uint256 b, Route[] memory pb,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(a, b);
        assertEq(pa[0].protocol, pb[0].protocol);
    }

    function test_quote_impactCapRejectsDirectFallsBackToHop() public {
        _revoke(rV4);
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
        assertApproxEqAbs(impact, 35, 1, "0.05% + 0.3% fees ~ 35 bps");
        assertLe(impact, router.maxPriceImpactBps());
        assertApproxEqRel(out, 2e18, 0.005e18);
    }

    function test_quote_hopPreferredWhenBetter() public {
        _revoke(rV4);
        uniNvda500.setImpact(100);
        uniNvda3000.setImpact(100);
        ramsesNvda3000.setImpact(100);
        (, Route[] memory path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path.length, 2, "hop wins on output");
    }

    function test_quote_hopNeedsBothLegsApproved() public {
        _revoke(rV4);
        uniNvda3000.setImpact(200);
        uniNvda500.setImpact(200);
        ramsesNvda3000.setImpact(200);
        _revoke(rWethNvda);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quote(address(usdg), address(nvda), 1_000e6);
    }

    function test_quote_noRouteReverts() public {
        _revoke(rV4);
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
        _revoke(rV4);
        uniNvda500.setBroken(true);
        (, Route[] memory path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].fee, 3000, "broken 500 tier ignored");
    }

    function test_quote_wethLegHasNoHop() public {
        (, Route[] memory path,) = router.quoteWithImpact(address(weth), address(usdg), 1e18);
        assertEq(path.length, 1);
        assertEq(path[0].fee, 500);
    }

    function test_quote_dustAmountReturnsNoRoute() public {
        // 1 wei of WETH rounds to 0 USDG in every pool -> NoRoute (callers must tolerate this: the vault skips)
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(weth), address(usdg)));
        router.quote(address(weth), address(usdg), 1);
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
        _revoke(rV4);
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
        _revoke(rV4);
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

    /// audit v0.3 M-02 / L-02: the router executes FULL fills only. A hop that cannot consume its whole input
    /// (in-range liquidity exhausted) is "no fill" at quote time and `PartialFill` at execution, so no refund
    /// can ever be stranded on a caller that does not expect one (Zap) or forwarded to the wrong party (vault).
    function test_swap_partialFillHop0_isRefusedAtQuoteAndExecution() public {
        _revoke(rV4);
        // Pool runs out of liquidity at 1.98 NVDA (~1% below the ~1.999 full quote: inside the impact cap).
        uniNvda500.setMaxOut(1.98e18);
        uniNvda3000.setBroken(true);
        ramsesNvda3000.setBroken(true);
        uniWethNvda3000.setBroken(true);
        (uint256 out, uint256 mid) = uni.quoteRoute(rUni500, 1_000e6);
        assertEq(out, 0, "partial fill reported as no fill");
        assertEq(mid, 0);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quote(address(usdg), address(nvda), 1_000e6);
        Route[] memory p = new Route[](1);
        p[0] = rUni500;
        uint256 usdgBefore = usdg.balanceOf(user);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.PartialFill.selector, 0));
        router.swapWithRoute(address(usdg), address(nvda), 1_000e6, 0, user, p);
        assertEq(usdg.balanceOf(user), usdgBefore);
        assertEq(usdg.balanceOf(address(uni)), 0);
        // the same pool fills a trade it can absorb in full
        uint256 nvdaBefore = nvda.balanceOf(user);
        vm.prank(user);
        router.swapWithRoute(address(usdg), address(nvda), 500e6, 0, user, p);
        assertApproxEqRel(nvda.balanceOf(user) - nvdaBefore, 1e18, 0.01e18);
    }

    function test_swap_partialFillHop1_isRefusedAtQuoteAndExecution() public {
        _revoke(rV4);
        uniNvda3000.setImpact(200);
        uniNvda500.setImpact(200);
        ramsesNvda3000.setImpact(200);
        (uint256 hop1Out,) = router.quote(address(usdg), address(weth), 1_000e6);
        uint256 full = uniWethNvda3000.midOut(address(weth) < address(nvda), hop1Out) * 997 / 1000;
        uniWethNvda3000.setMaxOut(full * 995 / 1000); // hop 2 would consume only 99.5% of the WETH
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quote(address(usdg), address(nvda), 1_000e6);
        Route[] memory p = new Route[](2);
        p[0] = rUsdgWeth;
        p[1] = rWethNvda;
        address recipient = makeAddr("recipient");
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.PartialFill.selector, 1));
        router.swapWithRoute(address(usdg), address(nvda), 1_000e6, 0, recipient, p);
        assertEq(nvda.balanceOf(recipient), 0);
        assertEq(weth.balanceOf(recipient), 0, "no intermediate forwarded anywhere");
        assertEq(weth.balanceOf(address(uni)), 0, "nothing stranded in the adapter");
        assertEq(weth.balanceOf(address(router)), 0, "nothing stranded in the router");
        assertEq(weth.balanceOf(user), 10_000e18, "caller's WETH untouched");
        assertEq(usdg.balanceOf(user), 10_000_000e6, "caller's USDG untouched");
    }

    function test_swapWithRoute_validation() public {
        Route[] memory p = new Route[](0);
        vm.prank(user);
        vm.expectRevert(IAggregatorRouter.InvalidPath.selector);
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);

        p = new Route[](1);
        p[0] = rWethNvda;
        vm.prank(user);
        vm.expectRevert(IAggregatorRouter.InvalidPath.selector);
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);

        p = new Route[](2);
        p[0] = rUsdgWeth;
        p[1] = rUni500;
        vm.prank(user);
        vm.expectRevert(IAggregatorRouter.InvalidPath.selector);
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);

        p = new Route[](1);
        p[0] = rUni500;
        vm.prank(user);
        vm.expectRevert(IAggregatorRouter.ZeroAmount.selector);
        router.swapWithRoute(address(usdg), address(nvda), 0, 0, user, p);
    }

    /// M-02 regression: the router refuses any hop that is not approved, whoever supplies the path.
    function test_swapWithRoute_unapprovedHopRejected() public {
        MockV3Pool bad = _v3(
            uniFactory, address(usdg), address(nvda), 10000, _sqrtPrice(address(nvda), 1e18, address(usdg), 50_000e6)
        );
        Route[] memory p = new Route[](1);
        p[0] = _r(1, address(usdg), address(nvda), 10000, abi.encode(bad));
        bytes32 k = router.hopKey(p[0]);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.RouteNotApproved.selector, k));
        router.swapWithRoute(address(usdg), address(nvda), 1_000e6, 1, user, p);

        // an EvilPool can't even be approved (adapter validation), let alone executed
        EvilPool evil = new EvilPool(address(usdg), address(nvda));
        p[0] = _r(1, address(usdg), address(nvda), 3000, abi.encode(address(evil)));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.RouteNotApproved.selector, router.hopKey(p[0])));
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);

        // revoked hops are refused too, even if they were approved when quoted
        (, Route[] memory path) = router.quote(address(usdg), address(nvda), 1_000e6);
        _revoke(rV4);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.RouteNotApproved.selector, router.hopKey(rV4)));
        router.swapWithRoute(address(usdg), address(nvda), 1_000e6, 1, user, path);
    }

    function test_swapWithRoute_unknownAdapterOnApprovedKeyImpossible() public {
        // A hop whose adapter was cleared after approval fails closed.
        vm.prank(owner);
        router.setAdapter(2, address(0));
        Route[] memory p = new Route[](1);
        p[0] = rV4;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.AdapterNotSet.selector, 2));
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);
    }

    // ------------------------------------------------------------------
    // Adapter security
    // ------------------------------------------------------------------

    function test_adapter_onlyRouterCanSwap() public {
        vm.prank(user);
        vm.expectRevert(UniV3Adapter.OnlyRouter.selector);
        uni.swap(rUni500, 1e6, user, user);
        vm.prank(user);
        vm.expectRevert(UniV4Adapter.OnlyRouter.selector);
        v4.swap(rV4, 1e6, user, user);
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

    function test_adapter_greedyPoolCannotDrainMoreThanInput() public {
        // Worst case: the owner approves a greedy pool that a compromised factory vouches for. The adapter holds
        // nothing between swaps, so a callback demanding more than this swap's input reverts; the user keeps funds.
        EvilPool evil = new EvilPool(address(usdg), address(nvda));
        uniFactory.forceRegister(address(usdg), address(nvda), 3000, address(evil));
        Route memory r = _r(1, address(usdg), address(nvda), 3000, abi.encode(address(evil)));
        vm.prank(owner);
        router.approveHop(r);
        Route[] memory p = new Route[](1);
        p[0] = r;
        uint256 before = usdg.balanceOf(user);
        vm.prank(user);
        vm.expectRevert(); // ERC20InsufficientBalance inside the callback
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);
        assertEq(usdg.balanceOf(user), before);
        assertEq(usdg.balanceOf(address(uni)), 0);
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
        assertFalse(v4.knownPool(v4.poolId(v4NvdaKey)));
        vm.stopPrank();
        // an approved hop whose key was removed from the adapter quotes 0 and cannot execute
        (uint256 out,) = v4.quoteRoute(rV4, 1_000e6);
        assertEq(out, 0);
        Route[] memory p = new Route[](1);
        p[0] = rV4;
        bytes32 id = v4.poolId(v4NvdaKey);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(UniV4Adapter.UnknownPool.selector, id));
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);
    }

    function test_v4_partialFill_isRefusedAtQuoteAndExecution() public {
        pm.setMaxOut(v4NvdaKey, 1.98e18);
        uniNvda500.setBroken(true);
        uniNvda3000.setBroken(true);
        ramsesNvda3000.setBroken(true);
        uniWethNvda3000.setBroken(true);
        (uint256 out,) = v4.quoteRoute(rV4, 1_000e6);
        assertEq(out, 0, "partial fill reported as no fill");
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quote(address(usdg), address(nvda), 1_000e6);
        Route[] memory p = new Route[](1);
        p[0] = rV4;
        uint256 before = usdg.balanceOf(user);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.PartialFill.selector, 0));
        router.swapWithRoute(address(usdg), address(nvda), 1_000e6, 0, user, p);
        assertEq(usdg.balanceOf(user), before);
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
        UniV3Adapter bare = new UniV3Adapter(3, address(router), address(0), owner);
        vm.prank(owner);
        router.setAdapter(3, address(bare));
        Route memory r = _r(3, address(usdg), address(nvda), 3000, abi.encode(ramsesNvda3000));
        assertFalse(bare.validateRoute(r), "unregistered pool, no factory");
        vm.prank(owner);
        bare.registerPool(address(ramsesNvda3000));
        assertTrue(bare.validateRoute(r));
        (uint256 out, uint256 mid) = bare.quoteRoute(r, 1_000e6);
        assertGt(out, 0);
        assertGt(mid, out);
        vm.prank(owner);
        bare.unregisterPool(address(ramsesNvda3000));
        assertFalse(bare.verifiedPool(address(ramsesNvda3000)));
        assertFalse(bare.validateRoute(r));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(UniV3Adapter.InvalidPool.selector, address(0xdead)));
        bare.registerPool(address(0xdead));
        // the still-approved Ramses hop now fails closed on execution
        Route[] memory p = new Route[](1);
        p[0] = rRamses3000;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(UniV3Adapter.UnknownPool.selector, address(ramsesNvda3000)));
        router.swapWithRoute(address(usdg), address(nvda), 1e6, 0, user, p);
    }

    function test_v3_factoryVerifiedPoolWithoutRegistration() public {
        // Fresh adapter that never saw this pool: swap verifies via the factory and caches it for the callback.
        UniV3Adapter fresh = new UniV3Adapter(1, address(router), address(uniFactory), owner);
        vm.prank(owner);
        router.setAdapter(1, address(fresh));
        Route[] memory p = new Route[](1);
        p[0] = rUni500;
        vm.prank(user);
        uint256 out = router.swapWithRoute(address(usdg), address(nvda), 1_000e6, 1, user, p);
        assertGt(out, 0);
        assertTrue(fresh.verifiedPool(address(uniNvda500)));
    }

    function test_v3_verifyFactoryPoolFailsForNonPool() public {
        // approval already blocks it; the adapter itself also fails closed
        assertFalse(uni.validateRoute(_r(1, address(usdg), address(nvda), 500, abi.encode(address(0xbeef)))));
        (uint256 out,) = uni.quoteRoute(_r(1, address(usdg), address(nvda), 500, abi.encode(address(0xbeef))), 1e6);
        assertEq(out, 0);
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
        vm.expectRevert(abi.encodeWithSelector(AggregatorRouter.AdapterProtocolMismatch.selector, 2, 1));
        router.setAdapter(2, address(uni));
        vm.expectRevert(abi.encodeWithSelector(AggregatorRouter.ImpactCapOutOfRange.selector, 1001));
        router.setMaxPriceImpactBps(1001);
        router.setMaxPriceImpactBps(10);
        assertEq(router.maxPriceImpactBps(), 10);
        router.setAdapter(1, address(0)); // disable
        assertEq(address(router.adapters(1)), address(0));
        vm.stopPrank();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.setAdapter(1, address(uni));
        assertEq(router.weth(), address(weth));
        vm.expectRevert(AggregatorRouter.ZeroAddress.selector);
        new AggregatorRouter(address(0), owner);
        vm.expectRevert(UniV3Adapter.ZeroAddress.selector);
        new UniV3Adapter(1, address(0), address(uniFactory), owner);
        vm.expectRevert(UniV4Adapter.ZeroAddress.selector);
        new UniV4Adapter(address(router), address(0), owner);
    }

    function test_disabledAdapterSkipped() public {
        vm.startPrank(owner);
        router.setAdapter(1, address(0));
        router.setAdapter(3, address(0));
        router.revokeHop(rV4);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.NoRoute.selector, address(usdg), address(nvda)));
        router.quote(address(usdg), address(nvda), 1e6);
    }

    // ------------------------------------------------------------------
    // Edge branches (coverage of defensive paths)
    // ------------------------------------------------------------------

    function test_views() public view {
        assertEq(v4.protocolId(), 2);
        assertEq(v4.poolId(v4NvdaKey), keccak256(abi.encode(v4NvdaKey)));
        assertEq(uni.protocolId(), 1);
        assertEq(ramses.protocolId(), 3);
        assertEq(uni.router(), address(router));
        assertEq(address(v4.poolManager()), address(pm));
    }

    function test_v4_uninitializedRegisteredPoolQuotesZero() public {
        // Registered + approved but never initialised in the PoolManager: simulate reverts with a
        // non-sentinel reason -> treated as "no fill", router falls back to V3.
        PoolKey memory k = v4NvdaKey;
        k.fee = 3000;
        vm.startPrank(owner);
        v4.addPool(k);
        router.approveHop(_r(2, address(usdg), address(nvda), 3000, abi.encode(k)));
        router.revokeHop(rV4);
        vm.stopPrank();
        (, Route[] memory path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].protocol, 1);
        (uint256 out,) = v4.quoteRoute(_r(2, address(usdg), address(nvda), 3000, abi.encode(k)), 1_000e6);
        assertEq(out, 0);
    }

    function test_quoteRoute_shortCircuits() public {
        (uint256 out,) = v4.quoteRoute(rV4, 0);
        assertEq(out, 0);
        (out,) = v4.quoteRoute(_r(2, address(usdg), address(usdg), 100, abi.encode(v4NvdaKey)), 1);
        assertEq(out, 0);
        (out,) = v4.quoteRoute(_r(2, address(weth), address(nvda), 100, abi.encode(v4NvdaKey)), 1e18);
        assertEq(out, 0, "key does not match the tokens");
        (out,) = v4.quoteRoute(_r(2, address(usdg), address(nvda), 100, ""), 1e18);
        assertEq(out, 0, "malformed extra");
        (out,) = uni.quoteRoute(rUni500, 0);
        assertEq(out, 0);
        (out,) = uni.quoteRoute(_r(1, address(usdg), address(usdg), 500, abi.encode(uniNvda500)), 1);
        assertEq(out, 0);
        (out,) = uni.quoteRoute(_r(1, address(weth), address(nvda), 500, abi.encode(uniNvda500)), 1e18);
        assertEq(out, 0, "pool tokens do not match");
        (out,) = uni.quoteRoute(_r(1, address(usdg), address(nvda), 500, ""), 1e18);
        assertEq(out, 0, "malformed extra");
    }

    function test_v4_swapWithZeroOutputPool() public {
        pm.setMaxOut(v4NvdaKey, 1);
        Route[] memory p = new Route[](1);
        p[0] = rV4;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IAggregatorRouter.PartialFill.selector, 0));
        router.swapWithRoute(address(usdg), address(nvda), 1_000e6, 2, user, p);
    }

    function test_v3_midOutDefensive() public {
        _revoke(rV4);
        uniNvda500.setPrice(0);
        // With price 0 the mock's swap output is also 0, so the 500 tier just loses; 3000 tier wins.
        (, Route[] memory path,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertEq(path[0].fee, 3000);
    }

    function test_v3_unregisterFactoryPoolIsReverifiedOnDemand() public {
        vm.prank(owner);
        uni.unregisterPool(address(uniNvda500));
        assertFalse(uni.verifiedPool(address(uniNvda500)), "verification cleared; factory re-verifies on demand");
        (uint256 out,) = uni.quoteRoute(rUni500, 1_000e6);
        assertGt(out, 0);
        assertTrue(uni.verifiedPool(address(uniNvda500)));
    }

    function test_v3_registerPoolIdempotent() public {
        vm.startPrank(owner);
        uni.registerPool(address(ramsesNvda3000));
        uni.registerPool(address(ramsesNvda3000));
        assertTrue(uni.verifiedPool(address(ramsesNvda3000)));
        EvilPool weird = new EvilPool(address(usdg), address(nvda));
        uni.registerPool(address(weird)); // token0 < token1 holds, accepted (owner responsibility)
        assertTrue(uni.verifiedPool(address(weird)));
        vm.stopPrank();
    }

    function test_router_adapterQuoteRevertIsSkipped() public {
        RevertingAdapter bad = new RevertingAdapter();
        vm.prank(owner);
        router.setAdapter(4, address(bad));
        vm.prank(owner);
        router.approveHop(_r(4, address(usdg), address(nvda), 0, ""));
        (uint256 out,,) = router.quoteWithImpact(address(usdg), address(nvda), 1_000e6);
        assertGt(out, 0, "reverting adapter is skipped, others still quote");
    }

    function test_router_hopWithZeroFirstLegIsIgnored() public {
        _revoke(rV4);
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

    function validateRoute(Route calldata) external pure returns (bool) {
        return true;
    }

    function quoteRoute(Route calldata, uint256) external pure returns (uint256, uint256) {
        revert("boom");
    }
}
