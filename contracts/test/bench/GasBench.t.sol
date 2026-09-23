// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockV3Factory} from "../mocks/MockV3.sol";
import {MockDCA} from "../mocks/MockDCA.sol";
import {MockStrategy} from "../mocks/MockStrategy.sol";
import {TestVault} from "../mocks/TestVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StockRegistry} from "../../src/registries/StockRegistry.sol";
import {AggregatorRouter} from "../../src/router/AggregatorRouter.sol";
import {UniV3Adapter} from "../../src/router/adapters/UniV3Adapter.sol";
import {EpochKeeper} from "../../src/keeper/EpochKeeper.sol";
import {Route} from "../../src/router/IAggregatorRouter.sol";
import {VaultParams} from "../../src/vault/VaultTypes.sol";

/// @dev Gas benchmark for one epoch page. Mirrors the local anvil stack (script/DeployLocal.s.sol): real
///      router + UniV3Adapter, MockV3 constant-price pool, TestVault with a 120s epoch, called through
///      EpochKeeper.run exactly like apps/scheduler does. Numbers print with -vv:
///
///        forge test --match-path test/bench/GasBench.t.sol -vv
///
///      Each measurement is taken on a *warm* stock (epoch 2+), so `lastExecutedEpoch` / `nextPlanIndex` slots
///      are already non-zero, matching steady-state operation rather than the first fill.
contract GasBenchTest is Test {
    uint32 internal constant EPOCH = 120;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal bot = makeAddr("bot");

    MockERC20 internal usdg;
    MockWETH internal weth;
    MockDCA internal dca;
    MockV3Factory internal factory;
    StockRegistry internal registry;
    AggregatorRouter internal router;
    UniV3Adapter internal adapter;
    TestVault internal vault;
    EpochKeeper internal keeper;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.startPrank(owner);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        weth = new MockWETH();
        dca = new MockDCA(owner);
        factory = new MockV3Factory();
        registry = new StockRegistry(owner);
        router = new AggregatorRouter(address(weth), owner);
        adapter = new UniV3Adapter(1, address(router), address(factory), owner);
        router.setAdapter(1, address(adapter));

        address pool =
            factory.createPool(address(weth), address(usdg), 500, _sqrt(address(weth), 1e18, address(usdg), 3000e6));
        usdg.mint(pool, 1_000_000_000e6);
        weth.mint(pool, 1_000_000e18);
        _approveBoth(pool, address(weth), address(usdg), 500);

        VaultParams memory vp = VaultParams({
            owner: owner,
            usdg: address(usdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: treasury,
            epochLength: 0,
            origin: uint64(block.timestamp - (block.timestamp % EPOCH)),
            purchaseFeeBps: 0
        });
        vault = new TestVault(vp, EPOCH);
        vault.setPriceGuard(300, false, address(0), 0); // price guard has its own suite
        keeper = new EpochKeeper(address(usdg), owner);
        keeper.setOperator(bot, true);
        vault.setKeeper(address(keeper), true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Scenarios
    // ------------------------------------------------------------------

    /// @dev Steady state: N accrue-path plans (no $DCA perks), one page, through EpochKeeper.run.
    function test_bench_accrue() public {
        uint16[7] memory sizes = [uint16(1), 5, 10, 25, 50, 100, 150];
        console2.log("--- accrue path (claim later), plans per page -> gas of EpochKeeper.run ---");
        for (uint256 i; i < sizes.length; ++i) {
            (uint256 g, uint256 jobIdx) = _benchStock(sizes[i], false);
            console2.log("plans", sizes[i], "gas", g);
            jobIdx; // silence
        }
    }

    /// @dev Steady state: N auto-distribute plans (>= 100k $DCA): one extra ERC20 transfer per plan.
    function test_bench_autoDistribute() public {
        uint16[7] memory sizes = [uint16(1), 5, 10, 25, 50, 100, 150];
        console2.log("--- auto-distribute path (>=100k DCA), plans per page -> gas of EpochKeeper.run ---");
        for (uint256 i; i < sizes.length; ++i) {
            (uint256 g,) = _benchStock(sizes[i], true);
            console2.log("plans", sizes[i], "gas", g);
        }
    }

    /// @dev Fixed swap leg in isolation: router.quote + router.swapWithRoute against the mock pool. This is the
    ///      part that changes on a real DEX (a real Uniswap V3 single-hop swap is ~100-150k, and the quote
    ///      simulates a full swap and reverts, so it costs about the same again).
    function test_bench_swapLeg() public {
        (address stock,) = _newStock(1, false);
        uint256 amountIn = 100e6;
        vm.startPrank(address(vault));
        uint256 g0 = gasleft();
        (uint256 quoted, Route[] memory path) = router.quote(address(usdg), stock, amountIn);
        uint256 gQuote = g0 - gasleft();
        usdg.mint(address(vault), amountIn);
        usdg.approve(address(router), amountIn);
        g0 = gasleft();
        router.swapWithRoute(address(usdg), stock, amountIn, quoted * 99 / 100, address(vault), path);
        uint256 gSwap = g0 - gasleft();
        vm.stopPrank();
        console2.log("--- swap leg (mock V3 pool) ---");
        console2.log("router.quote gas         ", gQuote);
        console2.log("router.swapWithRoute gas ", gSwap);
    }

    /// @dev First-ever epoch for a stock (cold `lastExecutedEpoch`, `nextPlanIndex`, `dustPot` slots).
    function test_bench_firstEpoch() public {
        (address stock, uint256 jobIdx) = _newStock(1, false);
        vm.warp(vault.nextEpochStart());
        vm.prank(bot);
        uint256 g0 = gasleft();
        keeper.run(jobIdx, 0, "");
        console2.log("--- first epoch for a stock, 1 plan ---");
        console2.log("gas", g0 - gasleft());
    }

    /// @dev A page where nothing is eligible (everyone paused / drained): the cost of a wasted keeper call.
    function test_bench_emptyPage() public {
        (address stock, uint256 jobIdx) = _newStock(1, false);
        _warm(jobIdx);
        // pause the only plan
        uint256 planId = vault.userPlans(_user(0, false))[0];
        vm.prank(_user(0, false));
        vault.setPlanPaused(planId, true);
        vm.warp(vault.nextEpochStart());
        vm.prank(bot);
        uint256 g0 = gasleft();
        keeper.run(jobIdx, 0, "");
        console2.log("--- empty page (all plans paused), 1 plan indexed ---");
        console2.log("gas", g0 - gasleft());
        stock;
    }

    /// @dev One-call exit of a plan that has idle USDG and accrued stock (one fill), plain and boosted (a holding
    ///      ERC-4626 strategy stands in for Morpho: same call shape, no yield). The boosted row includes the
    ///      unboost leg (strategy withdraw + share burn); compare with the 3-4 separate transactions it replaces.
    function test_bench_closePlan() public {
        (, uint256 jobIdx) = _newStock(2, false);
        _warm(jobIdx); // both plans filled once: idle + accrued, epoch complete (no deferred unindex)
        address u0 = _user(0, false);
        address u1 = _user(1, false);
        uint256 plain = vault.userPlans(u0)[0];
        uint256 boosted = vault.userPlans(u1)[0];

        MockStrategy holding = new MockStrategy(IERC20(address(usdg)));
        vm.prank(owner);
        vault.setBoostStrategy(address(holding));
        vm.prank(u1);
        vault.setPlanBoost(boosted, true);

        vm.prank(u0);
        uint256 g0 = gasleft();
        vault.closePlan(plain);
        uint256 gPlain = g0 - gasleft();
        vm.prank(u1);
        g0 = gasleft();
        vault.closePlan(boosted);
        uint256 gBoosted = g0 - gasleft();
        assertEq(vault.getPlan(plain).usdgIdle, 0);
        assertEq(vault.getPlan(boosted).boostShares, 0);

        console2.log("--- closePlan (idle + accrued, epoch complete) ---");
        console2.log("plain   gas", gPlain);
        console2.log("boosted gas", gBoosted);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _benchStock(uint16 n, bool autoDist) internal returns (uint256 gas, uint256 jobIdx) {
        address stock;
        (stock, jobIdx) = _newStock(n, autoDist);
        _warm(jobIdx);
        vm.warp(vault.nextEpochStart());
        vm.prank(bot);
        uint256 g0 = gasleft();
        bool completed = keeper.run(jobIdx, 0, "");
        gas = g0 - gasleft();
        assertTrue(completed, "page should complete");
        assertEq(vault.lastExecutedEpoch(stock), vault.currentEpochId(), "epoch executed");
    }

    /// @dev Run one full epoch so the stock's per-stock slots are non-zero, then it is in steady state.
    function _warm(uint256 jobIdx) internal {
        vm.warp(vault.nextEpochStart());
        vm.prank(bot);
        keeper.run(jobIdx, 0, "");
    }

    /// @dev Fresh stock + pool + keeper job with `n` funded plans from `n` distinct users.
    function _newStock(uint16 n, bool autoDist) internal returns (address stock, uint256 jobIdx) {
        vm.startPrank(owner);
        MockERC20 st = new MockERC20("Stock", "STK", 18);
        registry.listStock(address(st), "STK", false, true);
        address p = factory.createPool(address(st), address(usdg), 3000, _sqrt(address(st), 1e18, address(usdg), 500e6));
        usdg.mint(p, 1_000_000_000e6);
        st.mint(p, 10_000_000e18);
        _approveBoth(p, address(usdg), address(st), 3000);
        jobIdx = keeper.addJob(address(vault), address(st));
        vm.stopPrank();
        stock = address(st);

        for (uint256 i; i < n; ++i) {
            address u = _user(i, autoDist);
            usdg.mint(u, 100_000e6);
            if (autoDist) {
                vm.prank(owner);
                dca.mint(u, 100_000e18);
            }
            vm.startPrank(u);
            usdg.approve(address(vault), type(uint256).max);
            vault.createPlan(stock, 100e6, address(0), 10_000e6, 0, 0, false);
            vm.stopPrank();
        }
    }

    function _user(uint256 i, bool autoDist) internal returns (address) {
        return makeAddr(string.concat(autoDist ? "auto" : "user", vm.toString(i)));
    }

    function _approveBoth(address pool, address a, address b, uint24 fee) internal {
        router.approveHop(Route({protocol: 1, tokenIn: a, tokenOut: b, fee: fee, extra: abi.encode(pool)}));
        router.approveHop(Route({protocol: 1, tokenIn: b, tokenOut: a, fee: fee, extra: abi.encode(pool)}));
    }

    function _sqrt(address base, uint256 baseAmt, address quote, uint256 quoteAmt) internal pure returns (uint160) {
        (uint256 num, uint256 den) = base < quote ? (quoteAmt, baseAmt) : (baseAmt, quoteAmt);
        return uint160(Math.sqrt(Math.mulDiv(2 ** 192, num, den)));
    }
}
