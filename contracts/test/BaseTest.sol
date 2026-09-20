// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockRouter} from "./mocks/MockRouter.sol";
import {MockDCA} from "../src/token/MockDCA.sol";
import {StockRegistry} from "../src/registries/StockRegistry.sol";
import {DailyVault} from "../src/vault/DailyVault.sol";
import {WeeklyVault} from "../src/vault/WeeklyVault.sol";
import {MonthlyVault} from "../src/vault/MonthlyVault.sol";
import {PlanVault} from "../src/vault/PlanVault.sol";
import {VaultParams, Plan, FeeConfig} from "../src/vault/VaultTypes.sol";
import {EpochLib} from "../src/libraries/EpochLib.sol";
import {IPlanVault} from "../src/interfaces/IPlanVault.sol";

/// @dev Shared fixture: tokens, registry, mock router with fixed rates, three vaults, funded users.
abstract contract BaseTest is Test {
    // 2027-01-18 00:00:00 UTC is a Monday -> +6h so daily/monthly origin is that day, weekly origin that Monday.
    uint256 internal constant T0 = 1_800_000_000 + 6 hours; // 1_800_000_000 = 2027-01-15 08:00 UTC (Friday)

    uint256 internal constant USDG_UNIT = 1e6;
    uint256 internal constant NVDA_PER_USDG_NUM = 1e18; // 1 NVDA = 500 USDG
    uint256 internal constant NVDA_PER_USDG_DEN = 500e6;
    uint256 internal constant USDG_PER_WETH_NUM = 3000e6; // 1 WETH = 3000 USDG
    uint256 internal constant USDG_PER_WETH_DEN = 1e18;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    MockERC20 internal usdg;
    MockWETH internal weth;
    MockDCA internal dca;
    MockERC20 internal nvda;
    MockERC20 internal aapl;
    StockRegistry internal registry;
    MockRouter internal router;
    DailyVault internal daily;
    WeeklyVault internal weekly;
    MonthlyVault internal monthly;

    function setUp() public virtual {
        vm.warp(T0);

        usdg = new MockERC20("Global Dollar", "USDG", 6);
        weth = new MockWETH();
        dca = new MockDCA(owner);
        nvda = new MockERC20("NVIDIA Stock Token", "NVDAst", 18);
        aapl = new MockERC20("Apple Stock Token", "AAPLst", 18);

        registry = new StockRegistry(owner);
        vm.startPrank(owner);
        registry.listStock(address(nvda), "NVDA", false, true);
        registry.listStock(address(aapl), "AAPL", false, true);
        vm.stopPrank();

        router = new MockRouter(address(weth));
        router.setRate(address(usdg), address(nvda), NVDA_PER_USDG_NUM, NVDA_PER_USDG_DEN);
        router.setRate(address(usdg), address(aapl), 1e18, 200e6); // 1 AAPL = 200 USDG
        router.setRate(address(weth), address(usdg), USDG_PER_WETH_NUM, USDG_PER_WETH_DEN);
        router.setRate(address(usdg), address(weth), USDG_PER_WETH_DEN, USDG_PER_WETH_NUM);

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
        p.origin = EpochLib.alignToMonday(block.timestamp);
        weekly = new WeeklyVault(p);
        p.origin = EpochLib.alignToDay(block.timestamp);
        monthly = new MonthlyVault(p);

        vm.startPrank(owner);
        daily.setKeeper(keeper, true);
        weekly.setKeeper(keeper, true);
        monthly.setKeeper(keeper, true);
        vm.stopPrank();

        _fund(alice);
        _fund(bob);
        _fund(carol);
    }

    function _fund(address user) internal {
        usdg.mint(user, 1_000_000 * USDG_UNIT);
        weth.mint(user, 1_000 ether);
        vm.deal(user, 1_000 ether);
        vm.startPrank(user);
        usdg.approve(address(daily), type(uint256).max);
        usdg.approve(address(weekly), type(uint256).max);
        usdg.approve(address(monthly), type(uint256).max);
        weth.approve(address(daily), type(uint256).max);
        weth.approve(address(weekly), type(uint256).max);
        weth.approve(address(monthly), type(uint256).max);
        vm.stopPrank();
    }

    function _giveDca(address user, uint256 wholeTokens) internal {
        vm.prank(owner);
        dca.mint(user, wholeTokens * 1e18);
    }

    function _createUsdgPlan(PlanVault v, address user, address stock, uint96 perEpoch, uint256 deposit)
        internal
        returns (uint256 planId)
    {
        vm.prank(user);
        planId = v.createPlan(stock, perEpoch, false, address(0), deposit, 0, 0);
    }

    function _nextEpoch(PlanVault v) internal {
        vm.warp(v.nextEpochStart());
    }

    function _advance(PlanVault v, address stock) internal returns (bool) {
        vm.prank(keeper);
        return v.advanceEpoch(stock, 0, "");
    }

    function _plan(PlanVault v, uint256 id) internal view returns (Plan memory) {
        return v.getPlan(id);
    }

    /// @dev Expected NVDA for `usdgNet` under the mock rate.
    function _nvdaFor(uint256 usdgNet) internal pure returns (uint256) {
        return (usdgNet * NVDA_PER_USDG_NUM) / NVDA_PER_USDG_DEN;
    }
}
