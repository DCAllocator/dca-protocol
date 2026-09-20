// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";

contract EpochLibHarness {
    function epochAt(uint64 o, uint32 l, uint256 t) external pure returns (uint32) {
        return EpochLib.epochAt(o, l, t);
    }

    function epochStart(uint64 o, uint32 l, uint32 id) external pure returns (uint256) {
        return EpochLib.epochStart(o, l, id);
    }

    function nextBoundary(uint64 o, uint32 l, uint256 t) external pure returns (uint256) {
        return EpochLib.nextBoundary(o, l, t);
    }

    function alignToDay(uint256 t) external pure returns (uint64) {
        return EpochLib.alignToDay(t);
    }

    function alignToMonday(uint256 t) external pure returns (uint64) {
        return EpochLib.alignToMonday(t);
    }
}

contract EpochLibTest is Test {
    EpochLibHarness h;

    function setUp() public {
        h = new EpochLibHarness();
    }

    function test_alignToDay() public view {
        // 1_800_000_000 = 2027-01-15 08:00:00 UTC
        assertEq(h.alignToDay(1_800_000_000), 1_800_000_000 - 8 hours);
        assertEq(h.alignToDay(0), 0);
        assertEq(h.alignToDay(86_399), 0);
        assertEq(h.alignToDay(86_400), 86_400);
    }

    function test_alignToMonday() public view {
        // Unix epoch day 0 is a Thursday. Day 4 (1970-01-05) is the first Monday.
        assertEq(h.alignToMonday(4 days), 4 days);
        assertEq(h.alignToMonday(4 days + 1), 4 days);
        assertEq(h.alignToMonday(10 days + 23 hours), 4 days); // Sunday night -> previous Monday
        assertEq(h.alignToMonday(11 days), 11 days); // next Monday
        // 2027-01-15 is a Friday; the previous Monday is 2027-01-11 00:00 UTC = 1_799_625_600
        assertEq(h.alignToMonday(1_800_000_000), 1_799_625_600);
        // Sanity: result is always a Monday (offset from day 4 divisible by 7 days)
        uint64 m = h.alignToMonday(1_800_000_000);
        assertEq((m - 4 days) % 7 days, 0);
    }

    function test_epochAt_andBoundary() public view {
        uint64 o = 1_000;
        uint32 l = 100;
        assertEq(h.epochAt(o, l, 1_000), 0);
        assertEq(h.epochAt(o, l, 1_099), 0);
        assertEq(h.epochAt(o, l, 1_100), 1);
        assertEq(h.epochStart(o, l, 3), 1_300);
        assertEq(h.nextBoundary(o, l, 1_150), 1_200);
        assertEq(h.nextBoundary(o, l, 1_200), 1_300);
    }

    function test_epochAt_revertsBeforeOrigin() public {
        vm.expectRevert(abi.encodeWithSelector(EpochLib.TimestampBeforeOrigin.selector, 999, 1_000));
        h.epochAt(1_000, 100, 999);
    }

    function testFuzz_epochMonotonic(uint64 o, uint32 l, uint64 a, uint64 b) public view {
        o = uint64(bound(o, 1, type(uint32).max));
        l = uint32(bound(l, 1, 30 days));
        a = uint64(bound(a, o, uint64(o) + 1_000 days));
        b = uint64(bound(b, a, uint64(o) + 1_000 days));
        assertLe(h.epochAt(o, l, a), h.epochAt(o, l, b));
        assertGt(h.nextBoundary(o, l, a), a);
        assertLe(h.nextBoundary(o, l, a) - a, l);
    }
}
