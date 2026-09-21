// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {PlanVault} from "../../src/vault/PlanVault.sol";
import {Plan} from "../../src/vault/VaultTypes.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockDCA} from "../mocks/MockDCA.sol";
import {MockMorpho} from "../mocks/MockMorpho.sol";
import {MorphoBlueStrategy} from "../../src/boost/MorphoBlueStrategy.sol";
import {Id} from "../../src/interfaces/IMorpho.sol";

/// @dev Random-walk handler over one vault with two stocks. Every action is wrapped so reverts on
///      nonsensical inputs are swallowed (fail_on_revert = false) but state stays consistent. Boost is part of
///      the walk: plans are created boosted or not, toggled, time passes (yield), the Morpho market runs dry
///      and recovers, and bad debt is written off.
contract VaultHandler is Test {
    PlanVault public vault;
    MockERC20 public usdg;
    MockWETH public weth;
    MockDCA public dca;
    MockRouter public router;
    MockMorpho public morpho;
    MorphoBlueStrategy public strategy;
    Id public marketId;
    address public dcaOwner;
    address public keeperAddr;
    address public borrower = makeAddr("handlerBorrower");
    address[] public stocks;
    address[] public actors;
    uint256[] public planIds;

    uint256 public calls;
    uint256 public epochsRun;
    uint256 public swaps;
    uint256 public boostedFills;
    uint256 public boostToggles;
    uint256 public boostWithdrawFailures;

    constructor(
        PlanVault _vault,
        MockERC20 _usdg,
        MockWETH _weth,
        MockDCA _dca,
        MockRouter _router,
        address _dcaOwner,
        address _keeper,
        address[] memory _stocks,
        MockMorpho _morpho,
        MorphoBlueStrategy _strategy,
        Id _marketId
    ) {
        vault = _vault;
        keeperAddr = _keeper;
        usdg = _usdg;
        weth = _weth;
        dca = _dca;
        router = _router;
        morpho = _morpho;
        strategy = _strategy;
        marketId = _marketId;
        dcaOwner = _dcaOwner;
        stocks = _stocks;
        vm.prank(borrower);
        usdg.approve(address(morpho), type(uint256).max);
        for (uint256 i; i < 6; ++i) {
            address a = makeAddr(string(abi.encodePacked("actor", i)));
            actors.push(a);
            usdg.mint(a, 10_000_000e6);
            weth.mint(a, 10_000 ether);
            vm.deal(a, 1_000 ether);
            vm.startPrank(a);
            usdg.approve(address(vault), type(uint256).max);
            weth.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    function planCount() external view returns (uint256) {
        return planIds.length;
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % actors.length];
    }

    function _stock(uint256 s) internal view returns (address) {
        return stocks[s % stocks.length];
    }

    function _plan(uint256 s) internal view returns (uint256) {
        if (planIds.length == 0) return 0;
        return planIds[s % planIds.length];
    }

    // ---- actions ----

    function createPlan(uint256 a, uint256 st, uint96 amount, uint128 usdgDep, uint128 wethDep) external {
        calls++;
        amount = uint96(bound(amount, 1, 20_000e6)); // below-minimum values exercise the BelowMinimum path
        usdgDep = uint128(bound(usdgDep, 0, 100_000e6));
        wethDep = uint128(bound(wethDep, 0, 10 ether));
        bool boost = (a + st) % 3 == 0; // a third of new plans start boosted
        vm.prank(_actor(a));
        try vault.createPlan(_stock(st), amount, address(0), usdgDep, wethDep, 0, boost) returns (uint256 id) {
            planIds.push(id);
        } catch {}
    }

    function toggleBoost(uint256 p, bool enabled) external {
        calls++;
        uint256 id = _plan(p);
        Plan memory pl = vault.getPlan(id);
        if (pl.owner == address(0)) return;
        vm.prank(pl.owner);
        try vault.setPlanBoost(id, enabled) {
            boostToggles++;
        } catch {}
    }

    /// @dev Time passes: interest accrues on the Morpho market (never crosses an epoch boundary by itself).
    function warp(uint32 dt) external {
        calls++;
        vm.warp(block.timestamp + bound(dt, 1, 6 hours));
    }

    /// @dev Drain the market's free liquidity (boosted withdrawals / spends fail) or repay to restore it.
    function liquidity(uint256 seed, bool drain) external {
        calls++;
        if (drain) {
            uint256 free = strategy.liquidity();
            if (free == 0) return;
            // even seeds drain the market completely (boosted spends fail), odd ones only tighten it
            morpho.mockBorrow(marketId, seed % 2 == 0 ? free : bound(seed, free / 2, free), borrower);
        } else {
            uint256 bal = usdg.balanceOf(borrower);
            if (bal == 0) return;
            uint256 amt = bound(seed, 1, bal);
            vm.prank(borrower);
            try morpho.mockRepay(marketId, amt) {} catch {}
        }
    }

    /// @dev Bad debt: up to 1% of the market's debt is written off against suppliers.
    function loss(uint256 seed) external {
        calls++;
        uint256 debt = morpho.market(marketId).totalBorrowAssets;
        if (debt == 0) return;
        morpho.mockLoss(marketId, bound(seed, 0, debt / 100));
    }

    function depositUSDG(uint256 p, uint256 a, uint128 amt) external {
        calls++;
        amt = uint128(bound(amt, 1, 50_000e6));
        vm.prank(_actor(a));
        try vault.depositUSDG(_plan(p), amt) {} catch {}
    }

    function depositWETH(uint256 p, uint256 a, uint128 amt) external {
        calls++;
        amt = uint128(bound(amt, 1e9, 5 ether));
        vm.prank(_actor(a));
        try vault.depositWETH(_plan(p), amt, 0) {} catch {}
    }

    function depositETH(uint256 p, uint256 a, uint128 amt) external {
        calls++;
        amt = uint128(bound(amt, 1e9, 2 ether));
        address who = _actor(a);
        vm.deal(who, who.balance + amt);
        vm.prank(who);
        try vault.depositETH{value: amt}(_plan(p), 0) {} catch {}
    }

    function withdrawIdle(uint256 p, uint256 uFrac) external {
        calls++;
        uint256 id = _plan(p);
        Plan memory pl = vault.getPlan(id);
        if (pl.owner == address(0)) return;
        uint256 avail = pl.usdgIdle;
        if (pl.boostShares > 0) {
            avail += (uint256(pl.boostShares) * (vault.boostAssets() + 1)) / (vault.totalBoostShares() + 1);
        }
        uint256 u = avail == 0 ? 0 : bound(uFrac, 0, avail + 1); // +1 exercises the InsufficientIdle path
        vm.prank(pl.owner);
        try vault.withdrawIdle(id, u) {} catch {}
    }

    function claim(uint256 p, uint256 frac) external {
        calls++;
        uint256 id = _plan(p);
        Plan memory pl = vault.getPlan(id);
        if (pl.owner == address(0) || pl.stockAccrued == 0) return;
        uint256 amt = bound(frac, 1, pl.stockAccrued);
        vm.prank(pl.owner);
        try vault.claim(id, amt) {} catch {}
    }

    function claimAll(uint256 a, uint256 st) external {
        calls++;
        vm.prank(_actor(a));
        try vault.claimAll(_stock(st)) {} catch {}
    }

    function togglePause(uint256 p, bool paused) external {
        calls++;
        uint256 id = _plan(p);
        Plan memory pl = vault.getPlan(id);
        if (pl.owner == address(0)) return;
        vm.prank(pl.owner);
        vault.setPlanPaused(id, paused);
    }

    function setAmount(uint256 p, uint96 amount) external {
        calls++;
        uint256 id = _plan(p);
        Plan memory pl = vault.getPlan(id);
        if (pl.owner == address(0)) return;
        amount = uint96(bound(amount, 10e6, 20_000e6));
        vm.prank(pl.owner);
        vault.setPlanAmount(id, amount);
    }

    function giveDca(uint256 a, uint32 whole) external {
        calls++;
        whole = uint32(bound(whole, 0, 120_000));
        address who = _actor(a);
        uint256 have = dca.balanceOf(who);
        uint256 want = uint256(whole) * 1e18;
        if (want > have) {
            vm.prank(dcaOwner);
            dca.mint(who, want - have);
        } else if (have > want) {
            vm.prank(who);
            require(dca.transfer(dcaOwner, have - want));
        }
    }

    /// @dev Partial fills on either leg exercise residual / dust accounting and WETH refunds.
    function setFill(uint256 which, uint16 bps) external {
        calls++;
        bps = uint16(bound(bps, 2_000, 10_000));
        if (which % 3 == 0) router.setFill(address(usdg), address(nvdaOf(0)), bps);
        else if (which % 3 == 1) router.setFill(address(usdg), address(nvdaOf(1)), bps);
        else router.setFill(address(weth), address(usdg), bps);
    }

    /// @dev Temporarily break / restore the stock route so the skip-not-revert path is walked.
    function toggleRoute(uint256 st, bool on) external {
        calls++;
        address stock = _stock(st);
        if (on) router.setRate(address(usdg), stock, 1e18, stock == stocks[0] ? 500e6 : 200e6);
        else router.removePair(address(usdg), stock);
    }

    function nvdaOf(uint256 i) internal view returns (address) {
        return stocks[i % stocks.length];
    }

    function advanceEpoch(uint256 st, uint256 limit, uint256 warpEpochs) external {
        calls++;
        warpEpochs = bound(warpEpochs, 0, 3);
        if (warpEpochs > 0) vm.warp(block.timestamp + warpEpochs * vault.epochLength());
        limit = bound(limit, 1, 4);
        uint256 before = router.swapCount();
        uint256 poolBefore = vault.totalBoostShares();
        vm.recordLogs();
        vm.prank(keeperAddr);
        try vault.advanceEpoch(_stock(st), limit, "") {
            epochsRun++;
        } catch {}
        swaps += router.swapCount() - before;
        if (vault.totalBoostShares() < poolBefore) boostedFills++;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 failed = keccak256("BoostWithdrawFailed(address,uint32,uint256,bytes)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == failed) boostWithdrawFailures++;
        }
    }

    function prune(uint256 p) external {
        calls++;
        try vault.prunePlan(_plan(p)) {} catch {}
    }
}
