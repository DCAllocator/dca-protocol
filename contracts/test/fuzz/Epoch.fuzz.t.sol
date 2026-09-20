// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {Plan, FeeConfig} from "../../src/vault/VaultTypes.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";

/// @dev Property tests over amountPerEpoch, balances, fee bps and $DCA tiers.
contract EpochFuzzTest is BaseTest {
    uint256 constant MAX_PLANS = 8;

    struct Seed {
        uint96 amount;
        uint128 deposit;
        uint32 dcaWhole;
    }

    function _user(uint256 i) internal returns (address u) {
        u = makeAddr(string(abi.encodePacked("fz", i)));
        _fund(u);
    }

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_epochConservation(uint256 n, uint16 feeBps, uint256 seed) public {
        n = bound(n, 1, MAX_PLANS);
        feeBps = uint16(bound(feeBps, 0, 90));
        FeeConfig memory f = daily.fees();
        f.purchaseFeeBps = feeBps;
        vm.prank(owner);
        daily.setFees(f);

        address[] memory users = new address[](n);
        uint256[] memory ids = new uint256[](n);
        uint256 expectedFees;
        uint256 expectedNet;
        uint256 expectedIdleAfter;

        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint96 amount = uint96(bound(r, 1, 50_000e6));
            uint128 deposit = uint128(bound(r >> 64, 0, 100_000e6));
            uint32 dcaWhole = uint32(bound(r >> 128, 0, 60_000));
            users[i] = _user(i);
            if (dcaWhole > 0) _giveDca(users[i], dcaWhole);
            ids[i] = _createUsdgPlan(daily, users[i], address(nvda), amount, deposit);

            uint256 spend = deposit < amount ? deposit : amount;
            uint16 eff = daily.effectivePurchaseFeeBps(users[i]);
            uint256 fee = FeeMath.feeOf(spend, eff);
            expectedFees += fee;
            expectedNet += spend - fee;
            expectedIdleAfter += deposit - spend;
        }

        _nextEpoch(daily);
        _advance(daily, address(nvda));

        assertEq(usdg.balanceOf(treasury), expectedFees, "fees");
        assertEq(daily.totalUsdgIdle(), expectedIdleAfter, "idle after");
        assertEq(usdg.balanceOf(address(daily)), expectedIdleAfter, "vault usdg == idle");
        assertEq(daily.totalNotionalUsdg(), expectedNet, "notional");

        uint256 amountOut = expectedNet == 0 ? 0 : _nvdaFor(expectedNet);
        uint256 accruedSum;
        uint256 walletSum;
        for (uint256 i; i < n; ++i) {
            Plan memory p = daily.getPlan(ids[i]);
            accruedSum += p.stockAccrued;
            walletSum += nvda.balanceOf(users[i]);
            assertEq(daily.userStockAccrued(users[i], address(nvda)), p.stockAccrued);
            if (daily.isAutoDistribute(users[i])) assertEq(p.stockAccrued, 0, "auto-dist never accrues");
        }
        assertEq(accruedSum + walletSum + daily.dustPot(address(nvda)), amountOut, "stock conserved");
        assertLt(daily.dustPot(address(nvda)), n + 1, "dust < number of plans");
        assertEq(daily.totalStockAccrued(address(nvda)), accruedSum);
        assertEq(
            nvda.balanceOf(address(daily)), accruedSum + daily.dustPot(address(nvda)), "vault stock == accrued + dust"
        );
    }

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_claimConservation(uint128 deposit, uint96 amount, uint16 claimFeeBps, uint256 claimFrac) public {
        amount = uint96(bound(amount, 1, 100_000e6));
        deposit = uint128(bound(deposit, 1, 200_000e6));
        claimFeeBps = uint16(bound(claimFeeBps, 0, 90));
        FeeConfig memory f = daily.fees();
        f.claimFeeBps = claimFeeBps;
        vm.prank(owner);
        daily.setFees(f);

        uint256 id = _createUsdgPlan(daily, alice, address(nvda), amount, deposit);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 accrued = daily.getPlan(id).stockAccrued;
        vm.assume(accrued > 0);
        uint256 claimAmt = bound(claimFrac, 1, accrued);

        vm.prank(alice);
        daily.claim(id, claimAmt);
        uint256 fee = FeeMath.feeOf(claimAmt, claimFeeBps);
        assertEq(nvda.balanceOf(alice), claimAmt - fee);
        assertEq(nvda.balanceOf(treasury), fee);
        assertEq(daily.getPlan(id).stockAccrued, accrued - claimAmt);
        assertEq(nvda.balanceOf(address(daily)), accrued - claimAmt + daily.dustPot(address(nvda)));
    }

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_withdrawConservation(uint128 deposit, uint256 wdFrac, uint16 wdFeeBps) public {
        deposit = uint128(bound(deposit, 1, 500_000e6));
        wdFeeBps = uint16(bound(wdFeeBps, 0, 90));
        FeeConfig memory f = daily.fees();
        f.withdrawFeeBps = wdFeeBps;
        vm.prank(owner);
        daily.setFees(f);
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 1e6, deposit);
        uint256 wd = bound(wdFrac, 1, deposit);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        daily.withdrawIdle(id, wd, 0, false);
        uint256 fee = FeeMath.feeOf(wd, wdFeeBps);
        assertEq(usdg.balanceOf(alice), before + wd - fee);
        assertEq(usdg.balanceOf(treasury), fee);
        assertEq(daily.totalUsdgIdle(), deposit - wd);
        assertEq(usdg.balanceOf(address(daily)), deposit - wd);
    }

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_wethZapSizing(uint96 amount, uint128 usdgDeposit, uint128 wethDeposit) public {
        amount = uint96(bound(amount, 1e6, 100_000e6));
        usdgDeposit = uint128(bound(usdgDeposit, 0, amount)); // deficit always > 0 unless equal
        wethDeposit = uint128(bound(wethDeposit, 1e12, 100 ether));
        vm.prank(alice);
        uint256 id = daily.createPlan(address(nvda), amount, true, address(0), usdgDeposit, wethDeposit, 0);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        Plan memory p = daily.getPlan(id);
        uint256 wethValue = (uint256(wethDeposit) * 3000e6) / 1e18;
        uint256 deficit = amount - usdgDeposit;
        if (deficit == 0) {
            assertEq(p.wethIdle, wethDeposit, "no zap needed");
        } else if (wethValue >= deficit) {
            // zapped just enough (ceil) -> spend == amount, leftover USDG < 1 wei-of-WETH worth
            assertEq(p.lastEpochId, 1);
            assertLt(p.usdgIdle, 2, "at most rounding residue");
            assertLt(p.wethIdle, wethDeposit);
        } else {
            assertEq(p.wethIdle, 0, "all WETH zapped when insufficient");
        }
        assertEq(daily.totalWethIdle(), p.wethIdle);
        assertEq(weth.balanceOf(address(daily)), p.wethIdle);
        assertEq(usdg.balanceOf(address(daily)), p.usdgIdle);
    }
}
