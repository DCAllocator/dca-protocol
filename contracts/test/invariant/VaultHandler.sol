// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlanVault} from "../../src/vault/PlanVault.sol";
import {Plan} from "../../src/vault/VaultTypes.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockDCA} from "../../src/token/MockDCA.sol";

/// @dev Random-walk handler over one vault with two stocks. Every action is wrapped so reverts on
///      nonsensical inputs are swallowed (fail_on_revert = false) but state stays consistent.
contract VaultHandler is Test {
    PlanVault public vault;
    MockERC20 public usdg;
    MockWETH public weth;
    MockDCA public dca;
    MockRouter public router;
    address public dcaOwner;
    address[] public stocks;
    address[] public actors;
    uint256[] public planIds;

    uint256 public calls;
    uint256 public epochsRun;
    uint256 public swaps;

    constructor(
        PlanVault _vault,
        MockERC20 _usdg,
        MockWETH _weth,
        MockDCA _dca,
        MockRouter _router,
        address _dcaOwner,
        address[] memory _stocks
    ) {
        vault = _vault;
        usdg = _usdg;
        weth = _weth;
        dca = _dca;
        router = _router;
        dcaOwner = _dcaOwner;
        stocks = _stocks;
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

    function createPlan(uint256 a, uint256 st, uint96 amount, uint128 usdgDep, uint128 wethDep, bool zapLater)
        external
    {
        calls++;
        amount = uint96(bound(amount, 1, 20_000e6));
        usdgDep = uint128(bound(usdgDep, 0, 100_000e6));
        wethDep = uint128(bound(wethDep, 0, 10 ether));
        vm.prank(_actor(a));
        try vault.createPlan(_stock(st), amount, zapLater, address(0), usdgDep, wethDep, 0) returns (uint256 id) {
            planIds.push(id);
        } catch {}
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

    function withdrawIdle(uint256 p, uint256 uFrac, uint256 wFrac, bool unwrap) external {
        calls++;
        uint256 id = _plan(p);
        Plan memory pl = vault.getPlan(id);
        if (pl.owner == address(0)) return;
        uint256 u = pl.usdgIdle == 0 ? 0 : bound(uFrac, 0, pl.usdgIdle);
        uint256 w = pl.wethIdle == 0 ? 0 : bound(wFrac, 0, pl.wethIdle);
        if (unwrap && w > 0) vm.deal(address(weth), address(weth).balance + w);
        vm.prank(pl.owner);
        try vault.withdrawIdle(id, u, w, unwrap) {} catch {}
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
        amount = uint96(bound(amount, 1, 20_000e6));
        vm.prank(pl.owner);
        vault.setPlanAmount(id, amount);
    }

    function giveDca(uint256 a, uint32 whole) external {
        calls++;
        whole = uint32(bound(whole, 0, 60_000));
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

    function setImpact(uint256 bps) external {
        calls++;
        router.setImpact(address(weth), address(usdg), bound(bps, 0, 300));
    }

    function advanceEpoch(uint256 st, uint256 limit, uint256 warpEpochs) external {
        calls++;
        warpEpochs = bound(warpEpochs, 0, 3);
        if (warpEpochs > 0) vm.warp(block.timestamp + warpEpochs * vault.epochLength());
        limit = bound(limit, 1, 4);
        uint256 before = router.swapCount();
        try vault.advanceEpoch(_stock(st), limit, "") {
            epochsRun++;
        } catch {}
        swaps += router.swapCount() - before;
    }

    function prune(uint256 p) external {
        calls++;
        try vault.prunePlan(_plan(p)) {} catch {}
    }
}
