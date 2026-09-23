// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockRouter} from "./mocks/MockRouter.sol";
import {MockDCA} from "./mocks/MockDCA.sol";
import {MockMorpho, MockIrm} from "./mocks/MockMorpho.sol";
import {MorphoBlueStrategy} from "../src/boost/MorphoBlueStrategy.sol";
import {Id, MarketParams} from "../src/interfaces/IMorpho.sol";
import {StockRegistry} from "../src/registries/StockRegistry.sol";
import {HourlyVault} from "../src/vault/HourlyVault.sol";
import {DailyVault} from "../src/vault/DailyVault.sol";
import {WeeklyVault} from "../src/vault/WeeklyVault.sol";
import {MonthlyVault} from "../src/vault/MonthlyVault.sol";
import {PlanVault} from "../src/vault/PlanVault.sol";
import {VaultParams, Plan, FeeConfig} from "../src/vault/VaultTypes.sol";
import {EpochLib} from "../src/libraries/EpochLib.sol";
import {IPlanVault} from "../src/interfaces/IPlanVault.sol";

/// @dev Shared fixture: tokens, registry, mock router with fixed rates, four vaults, funded users, and a mock
///      Morpho Blue USDG market (~5% supply APY at 90% utilisation) behind a MorphoBlueStrategy that every
///      vault has as its boost strategy. Plans are unboosted unless a test opts in.
abstract contract BaseTest is Test {
    // 1_800_000_000 = 2027-01-15 08:00:00 UTC (a Friday); T0 = 14:00:00 that day. Daily/monthly origin is that
    // day's 00:00 (first boundary T0 + 10h), weekly origin the Monday before (2027-01-11), and the hourly origin is
    // T0 itself (14:00:00 is on the hour; its first boundary is 15:00).
    uint256 internal constant T0 = 1_800_000_000 + 6 hours;

    uint256 internal constant USDG_UNIT = 1e6;
    uint256 internal constant NVDA_PER_USDG_NUM = 1e18; // 1 NVDA = 500 USDG
    uint256 internal constant NVDA_PER_USDG_DEN = 500e6;
    uint256 internal constant USDG_PER_WETH_NUM = 3000e6; // 1 WETH = 3000 USDG
    uint256 internal constant USDG_PER_WETH_DEN = 1e18;
    /// @dev Mock IRM borrow rate: 5.5% APR per second in WAD => ~4.95% supply APY at 90% utilisation, no fee.
    uint256 internal constant BORROW_RATE_PER_SECOND = uint256(0.055e18) / 365 days;
    uint256 internal constant MORPHO_SEED_SUPPLY = 10_000_000e6;
    uint256 internal constant MORPHO_SEED_BORROW = 9_000_000e6;

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
    HourlyVault internal hourly;
    DailyVault internal daily;
    WeeklyVault internal weekly;
    MonthlyVault internal monthly;
    MockMorpho internal morpho;
    MockIrm internal irm;
    Id internal marketId;
    MarketParams internal marketParams;
    MorphoBlueStrategy internal strategy;
    address internal morphoSeeder = makeAddr("morphoSeeder");
    address internal borrower = makeAddr("borrower");

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
        p.origin = EpochLib.alignToHour(block.timestamp);
        hourly = new HourlyVault(p);
        p.origin = EpochLib.alignToDay(block.timestamp);
        daily = new DailyVault(p);
        p.origin = EpochLib.alignToMonday(block.timestamp);
        weekly = new WeeklyVault(p);
        p.origin = EpochLib.alignToDay(block.timestamp);
        monthly = new MonthlyVault(p);

        vm.startPrank(owner);
        hourly.setKeeper(keeper, true);
        daily.setKeeper(keeper, true);
        weekly.setKeeper(keeper, true);
        monthly.setKeeper(keeper, true);
        // The Chainlink price guard (audit v0.3 H-01) is fail-closed by default; it has its own suite
        // (PlanVault.PriceGuard.t.sol, audit/v0.3/Audit3.H01). Everything else runs with it off.
        hourly.setPriceGuard(300, false, address(0), 0);
        daily.setPriceGuard(300, false, address(0), 0);
        weekly.setPriceGuard(300, false, address(0), 0);
        monthly.setPriceGuard(300, false, address(0), 0);
        vm.stopPrank();

        _deployMorpho();

        _fund(alice);
        _fund(bob);
        _fund(carol);
    }

    /// @dev Mock Morpho USDG market seeded with a third-party supplier and a phantom borrower so the supply
    ///      rate is non-zero and boosted balances visibly grow with `vm.warp`.
    function _deployMorpho() internal {
        irm = new MockIrm(BORROW_RATE_PER_SECOND);
        morpho = new MockMorpho(treasury);
        marketParams = MarketParams({
            loanToken: address(usdg),
            collateralToken: address(weth),
            oracle: address(0),
            irm: address(irm),
            lltv: 0.86e18
        });
        marketId = morpho.createMarket(marketParams);
        usdg.mint(morphoSeeder, MORPHO_SEED_SUPPLY);
        vm.startPrank(morphoSeeder);
        usdg.approve(address(morpho), type(uint256).max);
        morpho.supply(marketParams, MORPHO_SEED_SUPPLY, 0, morphoSeeder, "");
        vm.stopPrank();
        morpho.mockBorrow(marketId, MORPHO_SEED_BORROW, borrower);

        strategy = new MorphoBlueStrategy(address(morpho), marketParams, owner);
        vm.startPrank(owner);
        strategy.setDepositor(address(hourly), true);
        strategy.setDepositor(address(daily), true);
        strategy.setDepositor(address(weekly), true);
        strategy.setDepositor(address(monthly), true);
        hourly.setBoostStrategy(address(strategy));
        daily.setBoostStrategy(address(strategy));
        weekly.setBoostStrategy(address(strategy));
        monthly.setBoostStrategy(address(strategy));
        vm.stopPrank();
    }

    function _fund(address user) internal {
        usdg.mint(user, 1_000_000 * USDG_UNIT);
        weth.mint(user, 1_000 ether);
        vm.deal(user, 1_000 ether);
        vm.startPrank(user);
        usdg.approve(address(hourly), type(uint256).max);
        usdg.approve(address(daily), type(uint256).max);
        usdg.approve(address(weekly), type(uint256).max);
        usdg.approve(address(monthly), type(uint256).max);
        weth.approve(address(hourly), type(uint256).max);
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
        planId = v.createPlan(stock, perEpoch, address(0), deposit, 0, 0, false);
    }

    function _createBoostedPlan(PlanVault v, address user, address stock, uint96 perEpoch, uint256 deposit)
        internal
        returns (uint256 planId)
    {
        vm.prank(user);
        planId = v.createPlan(stock, perEpoch, address(0), deposit, 0, 0, true);
    }

    /// @dev A plan's boosted balance right now (same maths as BoostLib.valueOf / ClaimHelper.boostValueOf).
    function _boostValue(PlanVault v, uint256 id) internal view returns (uint256) {
        uint256 shares = v.getPlan(id).boostShares;
        if (shares == 0) return 0;
        return (shares * (v.boostAssets() + 1)) / (v.totalBoostShares() + 1);
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

    /// @dev Storage slot of `PlanVault._stockPlanIndex` (`forge inspect DailyVault storage-layout`). The vault
    ///      exposes no "is this plan indexed" view (bytes), so tests read the mapping directly; a plan is in its
    ///      stock's iteration list iff its entry is non-zero. `PlanVault.Close.t.sol` pins the slot against the
    ///      `PlanIndexed` events, so a layout change fails loudly there rather than silently here.
    uint256 internal constant STOCK_PLAN_INDEX_SLOT = 24;

    function _isIndexed(PlanVault v, uint256 id) internal view returns (bool) {
        return vm.load(address(v), keccak256(abi.encode(id, STOCK_PLAN_INDEX_SLOT))) != bytes32(0);
    }

    /// @dev Expected NVDA for `usdgNet` under the mock rate.
    function _nvdaFor(uint256 usdgNet) internal pure returns (uint256) {
        return (usdgNet * NVDA_PER_USDG_NUM) / NVDA_PER_USDG_DEN;
    }
}
