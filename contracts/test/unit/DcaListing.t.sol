// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockDCA} from "../mocks/MockDCA.sol";
import {MockV3Pool, MockV3Factory} from "../mocks/MockV3.sol";
import {MockAggregatorV3} from "../mocks/MockChainlink.sol";
import {TestVault} from "../mocks/TestVault.sol";
import {StockRegistry} from "../../src/registries/StockRegistry.sol";
import {IStockRegistry} from "../../src/interfaces/IStockRegistry.sol";
import {AggregatorRouter} from "../../src/router/AggregatorRouter.sol";
import {Route} from "../../src/router/IAggregatorRouter.sol";
import {UniV3Adapter} from "../../src/router/adapters/UniV3Adapter.sol";
import {DailyVault} from "../../src/vault/DailyVault.sol";
import {PlanVault} from "../../src/vault/PlanVault.sol";
import {VaultParams} from "../../src/vault/VaultTypes.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {EpochKeeper} from "../../src/keeper/EpochKeeper.sol";
import {FeeReceiver} from "../../src/treasury/FeeReceiver.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";

/// @dev $DCA as a plan asset, wired the way script/DeployLocal.s.sol (and script/ListDca.s.sol) wires it: the mock
///      $DCA listed in the registry as "DCA" (approved, not fee-on-transfer), bought through the real router +
///      UniV3Adapter from the same mDCA/USDG pool at 0.10 USDG that the FeeReceiver buys back on, with a keeper job
///      and a 0.10 USD mock Chainlink feed on each vault and the price guard at its fail-closed default. No contract
///      treats $DCA specially as a stock; these pin what follows from it also being the perk token and the burn token.
contract DcaListingTest is Test {
    uint32 internal constant EPOCH = 120;
    uint256 internal constant DCA_PRICE_USDG = 0.1e6;
    uint24 internal constant POOL_FEE = 3000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal bot = makeAddr("bot");
    address internal alice = makeAddr("alice"); // 150k $DCA, over both perks (DeployLocal's test wallets)
    address internal bob = makeAddr("bob"); // no $DCA
    address internal carol = makeAddr("carol"); // 95k $DCA, just under the perks

    MockERC20 internal usdg;
    MockWETH internal weth;
    MockDCA internal dca;
    MockV3Factory internal factory;
    MockV3Pool internal dcaPool;
    StockRegistry internal registry;
    AggregatorRouter internal router;
    FeeReceiver internal feeReceiver;
    TestVault internal testVault;
    DailyVault internal daily;
    EpochKeeper internal keeper;
    MockAggregatorV3 internal dcaFeed;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.startPrank(owner);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        weth = new MockWETH();
        dca = new MockDCA(owner);
        factory = new MockV3Factory();
        registry = new StockRegistry(owner);
        router = new AggregatorRouter(address(weth), owner);
        UniV3Adapter adapter = new UniV3Adapter(1, address(router), address(factory), owner);
        router.setAdapter(1, address(adapter));

        dcaPool = MockV3Pool(factory.createPool(address(dca), address(usdg), POOL_FEE, _sqrtPrice(DCA_PRICE_USDG)));
        usdg.mint(address(dcaPool), 100_000_000e6);
        dca.mint(address(dcaPool), 1_000_000_000e18);
        router.approveHop(_route(address(usdg), address(dca)));
        router.approveHop(_route(address(dca), address(usdg)));

        feeReceiver = new FeeReceiver(address(usdg), address(weth), address(dca), address(router), treasury, owner);
        VaultParams memory vp = VaultParams({
            owner: owner,
            usdg: address(usdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: address(feeReceiver),
            epochLength: 0,
            origin: EpochLib.alignToDay(block.timestamp),
            purchaseFeeBps: 0
        });
        daily = new DailyVault(vp);
        vp.origin = uint64(block.timestamp - (block.timestamp % EPOCH));
        testVault = new TestVault(vp, EPOCH);

        keeper = new EpochKeeper(address(usdg), owner);
        keeper.setOperator(bot, true);
        testVault.setKeeper(address(keeper), true);
        daily.setKeeper(address(keeper), true);
        dcaFeed = new MockAggregatorV3(8, 0.1e8); // 0.10 USD, 8 decimals like DeployLocal's feeds

        dca.mint(alice, 150_000e18);
        dca.mint(carol, 95_000e18);
        vm.stopPrank();

        _fund(alice);
        _fund(bob);
        _fund(carol);
    }

    // ------------------------------------------------------------------
    // Listing
    // ------------------------------------------------------------------

    function test_listing_makesDcaPurchasableUnderTheFailClosedGuard() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.StockNotPurchasable.selector, address(dca)));
        testVault.createPlan(address(dca), 100e6, address(0), 1_000e6, 0, 0, false);

        _listDca();
        IStockRegistry.StockInfo memory info = registry.info(address(dca));
        assertEq(info.symbol, "DCA");
        assertEq(info.decimals, 18);
        assertFalse(info.feeOnTransfer);
        assertTrue(registry.isPurchasable(address(dca)));
        assertEq(registry.approvedStocks()[0], address(dca));
        (, bool requireFeed,,) = testVault.priceGuard();
        assertTrue(requireFeed, "guard stays fail-closed: the feed is what lets $DCA through");
        assertEq(keeper.job(0).stock, address(dca));
        assertEq(keeper.job(1).stock, address(dca));
    }

    // ------------------------------------------------------------------
    // Fills
    // ------------------------------------------------------------------

    /// @dev What the scheduler does: EpochKeeper.run on the TestVault job. Alice holds the perks, so the $DCA goes
    ///      straight to her wallet (auto-distribute) and she pays the halved purchase fee.
    function test_planFillsThroughKeeper_autoDistributedToHolder() public {
        _listDca();
        vm.prank(alice);
        uint256 id = testVault.createPlan(address(dca), 100e6, address(0), 1_000e6, 0, 0, false);
        vm.warp(testVault.nextEpochStart());

        uint256 fee = FeeMath.feeOf(100e6, FeeMath.halve(75));
        uint256 out = _poolOut(100e6 - fee);
        uint256 before = dca.balanceOf(alice);
        vm.expectEmit(address(testVault));
        emit IPlanVault.PlanFilled(id, 1, 100e6, fee, out, true);
        vm.prank(bot);
        assertTrue(keeper.run(0, 0, ""));

        assertEq(dca.balanceOf(alice) - before, out);
        assertEq(testVault.getPlan(id).stockAccrued, 0);
        assertEq(testVault.getPlan(id).usdgIdle, 900e6);
        assertEq(usdg.balanceOf(address(feeReceiver)), fee);
        _assertBooked(testVault);
    }

    /// @dev advanceEpoch called directly (the owner is always allowed). Bob holds no $DCA: it accrues in the vault,
    ///      the claim pays the 25 bps claim fee in $DCA to the FeeReceiver, which splits it 70/30 and burns its 30%
    ///      directly (a $DCA reserve needs no swap).
    function test_planFillsViaAdvanceEpoch_accruesThenClaims() public {
        _listDca();
        vm.prank(bob);
        uint256 id = daily.createPlan(address(dca), 100e6, address(0), 1_000e6, 0, 0, false);
        vm.warp(daily.nextEpochStart());

        uint256 fee = FeeMath.feeOf(100e6, 75);
        vm.prank(owner);
        assertTrue(daily.advanceEpoch(address(dca), 0, ""));
        uint256 accrued = daily.getPlan(id).stockAccrued;
        assertEq(accrued, _poolOut(100e6 - fee));
        assertEq(dca.balanceOf(bob), 0);
        _assertBooked(daily);

        vm.prank(bob);
        daily.claim(id, type(uint256).max);
        uint256 claimFee = FeeMath.feeOf(accrued, 25);
        assertEq(dca.balanceOf(bob), accrued - claimFee);
        assertEq(dca.balanceOf(address(feeReceiver)), claimFee);
        _assertBooked(daily);

        vm.startPrank(owner);
        feeReceiver.distribute(address(dca));
        feeReceiver.buyback(address(dca), type(uint256).max, 0);
        vm.stopPrank();
        uint256 toTreasury = FeeMath.feeOf(claimFee, 7_000);
        assertEq(dca.balanceOf(treasury), toTreasury);
        assertEq(dca.balanceOf(DEAD), claimFee - toTreasury, "MockDCA has no burn(): sent to 0x...dEaD");
        assertEq(feeReceiver.totalBurned(), claimFee - toTreasury);
    }

    /// @dev Perks read the OWNER's wallet at execution / claim time. $DCA a plan has bought but not yet paid out
    ///      does not count: carol's wallet plus her accrued $DCA clears 100k, yet she keeps the full fee and keeps
    ///      accruing until she claims.
    function test_accruedDcaCountsForPerksOnlyOnceClaimed() public {
        _listDca();
        vm.prank(carol);
        uint256 id = testVault.createPlan(address(dca), 1_000e6, address(0), 5_000e6, 0, 0, false);
        vm.warp(testVault.nextEpochStart());
        vm.prank(bot);
        keeper.run(0, 0, "");
        uint256 accrued = testVault.getPlan(id).stockAccrued;
        assertEq(accrued, _poolOut(1_000e6 - FeeMath.feeOf(1_000e6, 75)));
        assertGe(dca.balanceOf(carol) + accrued, 100_000e18);
        assertFalse(testVault.isAutoDistribute(carol));
        assertEq(testVault.effectivePurchaseFeeBps(carol), 75);

        vm.prank(carol);
        testVault.claim(id, type(uint256).max);
        assertTrue(testVault.isAutoDistribute(carol));
        assertEq(testVault.effectivePurchaseFeeBps(carol), 37);

        vm.warp(testVault.nextEpochStart());
        uint256 fee = FeeMath.feeOf(1_000e6, 37);
        vm.expectEmit(address(testVault));
        emit IPlanVault.PlanFilled(id, 2, 1_000e6, fee, _poolOut(1_000e6 - fee), true);
        vm.prank(bot);
        keeper.run(0, 0, "");
        _assertBooked(testVault);
    }

    // ------------------------------------------------------------------
    // Admin paths
    // ------------------------------------------------------------------

    /// @dev Listing flips $DCA from "rescuable stray token" to "may be plan accounting" for good (`known` is never
    ///      cleared): rescueERC20 refuses it and skim hands any unbooked $DCA to the $DCA plans at the next epoch.
    ///      Stray $DCA sitting in a vault should be rescued before listing if it is not meant for the plans.
    function test_listedDcaIsSkimmedIntoPlans_notRescued() public {
        vm.prank(alice);
        assertTrue(dca.transfer(address(daily), 1_000e18));
        vm.prank(owner);
        daily.rescueERC20(address(dca), treasury, 1_000e18);
        assertEq(dca.balanceOf(treasury), 1_000e18);

        _listDca();
        vm.prank(bob);
        uint256 id = daily.createPlan(address(dca), 100e6, address(0), 1_000e6, 0, 0, false);
        vm.prank(alice);
        assertTrue(dca.transfer(address(daily), 1_000e18));
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.TokenNotRescuable.selector, address(dca)));
        daily.rescueERC20(address(dca), treasury, 1_000e18);
        daily.skim(address(dca));
        vm.stopPrank();
        assertEq(daily.dustPot(address(dca)), 1_000e18);
        _assertBooked(daily);

        vm.warp(daily.nextEpochStart());
        vm.prank(bot);
        keeper.run(1, 0, "");
        assertEq(daily.getPlan(id).stockAccrued, _poolOut(100e6 - FeeMath.feeOf(100e6, 75)) + 1_000e18);
        assertEq(daily.dustPot(address(dca)), 0);
        _assertBooked(daily);
    }

    // ------------------------------------------------------------------
    // Price guard
    // ------------------------------------------------------------------

    /// @dev A page at the vault's default notional cap (100k USDG) passes the guard: the pool fee (0.3%) plus
    ///      `swapSlippageBps` (0.5%) is well inside `maxDeviationBps` (3%). The headroom left is how far the pool may
    ///      trade above the feed: minOut = out x 0.995 must stay >= feed out x 0.97, i.e. about 2.27% here — the
    ///      budget a real $DCA pool's launchpad fee, creator tax and impact would all have to fit in.
    function test_pageAtCapPassesPriceGuard_feedHeadroom() public {
        _listDca();
        vm.prank(bob);
        uint256 id = daily.createPlan(address(dca), 100_000e6, address(0), 300_000e6, 0, 0, false);
        assertEq(daily.maxPageNotional(), 100_000e6);

        vm.warp(daily.nextEpochStart());
        vm.prank(bot);
        keeper.run(1, 0, "");
        assertEq(daily.getPlan(id).lastEpochId, 1);

        dcaPool.setPrice(_sqrtPrice(0.102e6)); // pool 2% above the feed: still fills
        vm.warp(daily.nextEpochStart());
        vm.prank(bot);
        keeper.run(1, 0, "");
        assertEq(daily.getPlan(id).lastEpochId, 2);

        dcaPool.setPrice(_sqrtPrice(0.1025e6)); // 2.5% above: refused, nothing consumed
        vm.warp(daily.nextEpochStart());
        vm.prank(bot);
        vm.expectPartialRevert(IPlanVault.PriceDeviates.selector);
        keeper.run(1, 0, "");
        assertEq(daily.getPlan(id).lastEpochId, 2);
        assertEq(daily.getPlan(id).usdgIdle, 100_000e6);
        _assertBooked(daily);
    }

    // ------------------------------------------------------------------
    // FeeReceiver interplay
    // ------------------------------------------------------------------

    /// @dev An epoch page buying $DCA and the FeeReceiver's buyback trade the same pool in the same block without
    ///      touching each other's books. (MockV3Pool is constant-price: on a real pool whichever trades second pays
    ///      the first one's impact, and a large $DCA page can push the spot tick outside the receiver's TWAP guard,
    ///      which then refuses the buyback until the TWAP catches up.)
    function test_dcaPageAndBuybackInOneBlock() public {
        _listDca();
        vm.prank(alice);
        testVault.createPlan(address(dca), 100e6, address(0), 1_000e6, 0, 0, false);
        vm.warp(testVault.nextEpochStart());
        vm.prank(bot);
        keeper.run(0, 0, "");
        vm.prank(owner);
        (, uint256 reserve) = feeReceiver.distribute(address(usdg));
        assertGt(reserve, 0);

        vm.warp(testVault.nextEpochStart());
        uint256 aliceBefore = dca.balanceOf(alice);
        vm.prank(bot);
        keeper.run(0, 0, "");
        vm.prank(owner);
        (uint256 spent, uint256 burned) = feeReceiver.buyback(address(usdg), type(uint256).max, 0);

        assertEq(spent, reserve);
        assertEq(burned, _poolOut(reserve));
        assertEq(dca.balanceOf(DEAD), burned);
        assertEq(dca.balanceOf(alice) - aliceBefore, _poolOut(100e6 - FeeMath.feeOf(100e6, 37)));
        assertEq(feeReceiver.buybackReserve(address(usdg)), 0);
        _assertBooked(testVault);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /// @dev DeployLocal's $DCA wiring: listed (the only stock here, so first), a job (TestVault = job 0, daily = job
    ///      1) and the feed on each vault.
    function _listDca() internal {
        vm.startPrank(owner);
        registry.listStock(address(dca), "DCA", false, true);
        PlanVault[2] memory vaults = [PlanVault(testVault), PlanVault(daily)];
        for (uint256 v; v < 2; ++v) {
            keeper.addJob(address(vaults[v]), address(dca));
            vaults[v].setPriceFeed(address(dca), address(dcaFeed), 365 days);
        }
        vm.stopPrank();
    }

    function _fund(address user) internal {
        usdg.mint(user, 1_000_000e6);
        vm.startPrank(user);
        usdg.approve(address(testVault), type(uint256).max);
        usdg.approve(address(daily), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev The vault invariant for a stock: every $DCA it holds is booked to a plan or waiting in the dust pot.
    function _assertBooked(PlanVault v) internal view {
        assertEq(dca.balanceOf(address(v)), v.totalStockAccrued(address(dca)) + v.dustPot(address(dca)));
    }

    /// @dev $DCA the pool pays for `usdgIn` (MockV3Pool: mid price less the pool fee).
    function _poolOut(uint256 usdgIn) internal view returns (uint256) {
        return (dcaPool.midOut(address(usdg) < address(dca), usdgIn) * (1_000_000 - POOL_FEE)) / 1_000_000;
    }

    /// @dev sqrtPriceX96 of the mDCA/USDG pool at `usdgPerDca` (1e6-scaled USDG per whole $DCA).
    function _sqrtPrice(uint256 usdgPerDca) internal view returns (uint160) {
        (uint256 num, uint256 den) =
            address(dca) < address(usdg) ? (usdgPerDca, uint256(1e18)) : (uint256(1e18), usdgPerDca);
        return uint160(Math.sqrt(Math.mulDiv(2 ** 192, num, den)));
    }

    function _route(address tokenIn, address tokenOut) internal view returns (Route memory) {
        return Route({protocol: 1, tokenIn: tokenIn, tokenOut: tokenOut, fee: POOL_FEE, extra: abi.encode(dcaPool)});
    }
}
