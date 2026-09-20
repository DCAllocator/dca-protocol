// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockV3Pool, MockV3Factory} from "../mocks/MockV3.sol";
import {CPMMPool, Trader} from "./mocks/CPMMPool.sol";
import {MockDCA} from "../mocks/MockDCA.sol";
import {StockRegistry} from "../../src/registries/StockRegistry.sol";
import {AggregatorRouter} from "../../src/router/AggregatorRouter.sol";
import {Route} from "../../src/router/IAggregatorRouter.sol";
import {UniV3Adapter} from "../../src/router/adapters/UniV3Adapter.sol";
import {DailyVault} from "../../src/vault/DailyVault.sol";
import {PlanVault} from "../../src/vault/PlanVault.sol";
import {VaultParams, Plan, FeeConfig} from "../../src/vault/VaultTypes.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {EpochKeeper} from "../../src/keeper/EpochKeeper.sol";

/// @dev AUDIT FIXTURE (regression suite for the v0.1 audit findings). Unlike test/BaseTest.sol (MockRouter with
///      fixed rates), this wires the REAL AggregatorRouter + UniV3Adapter to a mock V3 factory, so quotes go
///      through the real adapter math (fee rounding, zero-output dust, impact-vs-slot0) and pools can be
///      constant-price (MockV3Pool) or constant-product (CPMMPool, price moves with trades). Every pool used by a
///      test must be approved on the router (`_approve*`), mirroring production.
abstract contract AuditBase is Test {
    uint256 internal constant T0 = 1_800_000_000 + 6 hours; // Mon 2027-01-18 06:00 UTC
    uint256 internal constant Q96 = 2 ** 96;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper"); // vault keeper EOA + EpochKeeper operator
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal mallory = makeAddr("mallory");

    MockERC20 internal usdg;
    MockWETH internal weth;
    MockDCA internal dca;
    MockERC20 internal nvda;
    StockRegistry internal registry;
    AggregatorRouter internal router;
    UniV3Adapter internal adapter;
    MockV3Factory internal factory;
    DailyVault internal daily;
    EpochKeeper internal epochKeeper;

    function setUp() public virtual {
        vm.warp(T0);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        weth = new MockWETH();
        dca = new MockDCA(owner);
        nvda = new MockERC20("NVIDIA Stock Token", "NVDAst", 18);

        registry = new StockRegistry(owner);
        vm.prank(owner);
        registry.listStock(address(nvda), "NVDA", false, true);

        router = new AggregatorRouter(address(weth), owner);
        factory = new MockV3Factory();
        adapter = new UniV3Adapter(1, address(router), address(factory), owner);
        vm.prank(owner);
        router.setAdapter(1, address(adapter));

        VaultParams memory p = VaultParams({
            owner: owner,
            usdg: address(usdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: treasury,
            epochLength: 0,
            origin: 0,
            purchaseFeeBps: 0
        });
        p.origin = EpochLib.alignToDay(block.timestamp);
        daily = new DailyVault(p);

        epochKeeper = new EpochKeeper(address(usdg), owner);
        vm.startPrank(owner);
        daily.setKeeper(keeper, true);
        daily.setKeeper(address(epochKeeper), true);
        epochKeeper.setOperator(keeper, true);
        epochKeeper.addJob(address(daily), address(nvda));
        vm.stopPrank();

        _fund(alice);
        _fund(bob);
        _fund(carol);
        _fund(mallory);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _fund(address user) internal {
        usdg.mint(user, 10_000_000e6);
        weth.mint(user, 10_000 ether);
        vm.deal(user, 1_000 ether);
        vm.startPrank(user);
        usdg.approve(address(daily), type(uint256).max);
        weth.approve(address(daily), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev sqrtPriceX96 such that `baseAmt` of `base` == `quoteAmt` of `quote` (raw units).
    function _sqrtPrice(address base, uint256 baseAmt, address quote, uint256 quoteAmt)
        internal
        pure
        returns (uint160)
    {
        (uint256 num, uint256 den) = base < quote ? (quoteAmt, baseAmt) : (baseAmt, quoteAmt);
        return uint160(Math.sqrt(Math.mulDiv(2 ** 192, num, den)));
    }

    function _route(address tokenIn, address tokenOut, uint24 fee, address pool) internal pure returns (Route memory) {
        return Route({protocol: 1, tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, extra: abi.encode(pool)});
    }

    /// @dev Approve both directions of a V3-style pool on the router (what Deploy.s.sol's V3_POOLS does).
    function _approveBoth(address a, address b, uint24 fee, address pool) internal {
        vm.startPrank(owner);
        router.approveHop(_route(a, b, fee, pool));
        router.approveHop(_route(b, a, fee, pool));
        vm.stopPrank();
    }

    /// @dev Constant-price V3 mock pool, deep on both sides, approved both ways.
    function _constPool(address a, address b, uint24 fee, uint160 sqrtP) internal returns (MockV3Pool pool) {
        pool = MockV3Pool(factory.createPool(a, b, fee, sqrtP));
        MockERC20(a).mint(address(pool), 1_000_000_000e18);
        MockERC20(b).mint(address(pool), 1_000_000_000e18);
        _approveBoth(a, b, fee, address(pool));
    }

    /// @dev Constant-product pool registered in the factory at `fee`, seeded with the given reserves, approved both ways.
    function _cpmmPool(address a, uint256 amtA, address b, uint256 amtB, uint24 fee) internal returns (CPMMPool pool) {
        pool = new CPMMPool(a, b, fee);
        factory.forceRegister(a, b, fee, address(pool));
        MockERC20(a).mint(address(pool), amtA);
        MockERC20(b).mint(address(pool), amtB);
        _approveBoth(a, b, fee, address(pool));
    }

    /// @dev Standard WETH/USDG constant-price pool at 3000 USDG per WETH, 5 bps fee.
    function _wethUsdgPool() internal returns (MockV3Pool) {
        return _constPool(address(weth), address(usdg), 500, _sqrtPrice(address(weth), 1e18, address(usdg), 3000e6));
    }

    /// @dev Standard USDG/NVDA constant-price pool at 500 USDG per NVDA, 5 bps fee.
    function _usdgNvdaPool() internal returns (MockV3Pool) {
        return _constPool(address(usdg), address(nvda), 500, _sqrtPrice(address(nvda), 1e18, address(usdg), 500e6));
    }

    function _nextEpoch() internal {
        vm.warp(daily.nextEpochStart());
    }

    function _advance(address who) internal returns (bool) {
        vm.prank(who);
        return daily.advanceEpoch(address(nvda), 0, "");
    }

    function _plan(uint256 id) internal view returns (Plan memory) {
        return daily.getPlan(id);
    }
}
