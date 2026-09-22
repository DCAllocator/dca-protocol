// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev A strategy that takes the assets and mints nothing (what an empty, donated-to OZ ERC-4626 did).
contract ZeroShareStrategy is ERC4626 {
    constructor(IERC20 asset_) ERC20("Zero", "Z") ERC4626(asset_) {}

    function previewDeposit(uint256) public pure override returns (uint256) {
        return 0;
    }
}

/// @title AUDIT v0.3 / M-01 regression — a donation to an empty strategy can no longer swallow deposits
///
/// Finding: MorphoBlueStrategy had OZ's default single virtual share and no zero-share guard, and anyone can grow
/// its Morpho position (`supply` on its behalf, `skim`). While the strategy had no shares, every boosted deposit
/// <= the donated amount minted zero strategy shares: the USDG was pulled and the plan was worth 0 forever.
/// Fix: (1) 10^6 virtual shares (`_decimalsOffset = 6`), so a donation is mostly handed to the next depositor
/// instead; (2) BoostLib refuses any deposit the strategy does not credit (`BoostDepositLost`); (3) Deploy.s.sol
/// seeds the strategy with dead shares.
contract Audit3_M01_StrategyDonation is BaseTest {
    address internal attacker = makeAddr("attacker");

    function _donate(uint256 amount) internal {
        usdg.mint(attacker, amount);
        vm.startPrank(attacker);
        usdg.approve(address(morpho), amount);
        morpho.supply(marketParams, amount, 0, address(strategy), ""); // Morpho Blue: anyone may supply onBehalf
        vm.stopPrank();
    }

    function test_baseline_noDonation_valueIsKept() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 10e6, 10e6);
        assertApproxEqAbs(_boostValue(daily, a), 10e6, 2);
    }

    function test_donationBeforeFirstDeposit_noLongerSwallowsDeposits() public {
        assertEq(strategy.totalSupply(), 0, "strategy is fresh");
        _donate(11e6);
        assertEq(strategy.totalSupply(), 0);

        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 10e6, 10e6);
        assertGt(strategy.balanceOf(address(daily)), 0, "vault received strategy shares");
        assertApproxEqAbs(_boostValue(daily, a), 10e6, 10, "alice keeps her 10 USDG");

        uint256 b = _createBoostedPlan(daily, bob, address(nvda), 10e6, 20e6);
        assertApproxEqAbs(_boostValue(daily, b), 20e6, 10);

        vm.prank(alice);
        daily.withdrawIdle(a, type(uint256).max);
        assertGe(usdg.balanceOf(alice), 1_000_000e6 - 10e6 + 9.97e6, "withdrawable, minus the 25 bps fee");
    }

    function test_skimDonation_noLongerSwallowsDeposits() public {
        usdg.mint(attacker, 11e6);
        vm.prank(attacker);
        usdg.transfer(address(strategy), 11e6);
        strategy.skim();
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 10e6, 10e6);
        assertApproxEqAbs(_boostValue(daily, a), 10e6, 10);
    }

    function test_reopenedWindow_noLongerSwallowsDeposits() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 10e6, 10e6);
        vm.prank(alice);
        daily.setPlanBoost(a, false); // supply back to dust shares
        _donate(1_000e6);
        uint256 b = _createBoostedPlan(daily, bob, address(nvda), 10e6, 50e6);
        assertApproxEqAbs(_boostValue(daily, b), 50e6, 1_000, "bob keeps his 50 USDG");
    }

    /// The vault-side guard: a strategy that credits nothing makes the deposit revert instead of vanishing.
    function test_strategyThatCreditsNothing_depositReverts() public {
        ZeroShareStrategy zero = new ZeroShareStrategy(IERC20(address(usdg)));
        vm.prank(owner);
        daily.setBoostStrategy(address(zero));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.BoostDepositLost.selector, 10e6, 0));
        daily.createPlan(address(nvda), 10e6, address(0), 10e6, 0, 0, true);
        assertEq(usdg.balanceOf(alice), 1_000_000e6, "nothing left alice's wallet");
    }
}
