// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";

contract FeeMathHarness {
    function validate(uint16 bps) external pure {
        FeeMath.validate(bps);
    }

    function feeOf(uint256 a, uint16 bps) external pure returns (uint256) {
        return FeeMath.feeOf(a, bps);
    }

    function split(uint256 a, uint16 bps) external pure returns (uint256, uint256) {
        return FeeMath.split(a, bps);
    }

    function halve(uint16 bps) external pure returns (uint16) {
        return FeeMath.halve(bps);
    }

    function applySlippage(uint256 a, uint16 bps) external pure returns (uint256) {
        return FeeMath.applySlippage(a, bps);
    }

    function impactBps(uint256 a, uint256 m) external pure returns (uint256) {
        return FeeMath.impactBps(a, m);
    }
}

contract FeeMathTest is Test {
    FeeMathHarness h;

    function setUp() public {
        h = new FeeMathHarness();
    }

    function test_validate_boundaries() public {
        h.validate(0);
        h.validate(90);
        vm.expectRevert(abi.encodeWithSelector(FeeMath.FeeTooHigh.selector, 91, 90));
        h.validate(91);
    }

    function test_feeOf_zeroBps() public view {
        assertEq(h.feeOf(1_000_000e6, 0), 0);
    }

    function test_feeOf_maxBps() public view {
        // 0.90% of 200 USDG = 1.80 USDG
        assertEq(h.feeOf(200e6, 90), 1.8e6);
    }

    function test_feeOf_roundsDown() public view {
        // 1 wei * 90 / 10000 = 0
        assertEq(h.feeOf(1, 90), 0);
        // 111 * 25 / 10000 = 0.2775 -> 0
        assertEq(h.feeOf(111, 25), 0);
        // 10_000 * 25 / 10000 = 25
        assertEq(h.feeOf(10_000, 25), 25);
    }

    function test_split_sumsToAmount() public view {
        (uint256 net, uint256 fee) = h.split(200e6, 50);
        assertEq(fee, 1e6); // "you pay 0.50% of $200 = $1.00"
        assertEq(net, 199e6);
        assertEq(net + fee, 200e6);
    }

    function test_halve_floorsOdd() public view {
        assertEq(h.halve(75), 37);
        assertEq(h.halve(50), 25);
        assertEq(h.halve(25), 12);
        assertEq(h.halve(1), 0);
        assertEq(h.halve(0), 0);
        assertEq(h.halve(90), 45);
    }

    function test_applySlippage() public view {
        assertEq(h.applySlippage(1e18, 50), 0.995e18);
        assertEq(h.applySlippage(1e18, 0), 1e18);
        assertEq(h.applySlippage(1e18, 10_000), 0);
        assertEq(h.applySlippage(1e18, 20_000), 0);
    }

    function test_impactBps() public view {
        assertEq(h.impactBps(100, 100), 0);
        assertEq(h.impactBps(101, 100), 0); // better than mid: no impact
        assertEq(h.impactBps(985, 1000), 150);
        assertEq(h.impactBps(0, 1000), 10_000);
        assertEq(h.impactBps(50, 0), 10_000); // no reference => maximal
    }

    function testFuzz_split_conserves(uint128 amount, uint16 bps) public view {
        bps = uint16(bound(bps, 0, 90));
        (uint256 net, uint256 fee) = h.split(amount, bps);
        assertEq(net + fee, amount);
        assertLe(fee, (uint256(amount) * 90) / 10_000);
    }

    function testFuzz_halve_neverExceedsHalf(uint16 bps) public view {
        uint16 hv = h.halve(bps);
        assertLe(uint256(hv) * 2, bps);
        assertGe(uint256(hv) * 2 + 1, bps);
    }
}
