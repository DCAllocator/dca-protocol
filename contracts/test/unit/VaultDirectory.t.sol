// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VaultDirectory} from "../../src/vault/VaultDirectory.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract VaultDirectoryTest is Test {
    VaultDirectory d;
    address owner = makeAddr("owner");

    function setUp() public {
        d = new VaultDirectory(owner);
    }

    function _entry() internal pure returns (VaultDirectory.Entry memory) {
        return VaultDirectory.Entry({
            hourly: address(1),
            daily: address(2),
            weekly: address(3),
            monthly: address(4),
            registry: address(5),
            router: address(6),
            usdg: address(7),
            weth: address(8),
            dca: address(9)
        });
    }

    function test_setAndGet() public {
        VaultDirectory.Entry memory e = _entry();
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit VaultDirectory.DirectorySet(e);
        d.set(e);
        // every field round-trips
        VaultDirectory.Entry memory g = d.get();
        assertEq(g.hourly, address(1));
        assertEq(g.daily, address(2));
        assertEq(g.weekly, address(3));
        assertEq(g.monthly, address(4));
        assertEq(g.registry, address(5));
        assertEq(g.router, address(6));
        assertEq(g.usdg, address(7));
        assertEq(g.weth, address(8));
        assertEq(g.dca, address(9));
        vm.prank(address(10));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(10)));
        d.set(e);
    }

    /// `vaults()` is the documented [hourly, daily, weekly, monthly] order — fastest cadence first — and nothing else.
    function test_vaults_orderIsHourlyDailyWeeklyMonthly() public {
        vm.prank(owner);
        d.set(_entry());
        address[4] memory v = d.vaults();
        assertEq(v.length, 4);
        assertEq(v[0], address(1), "hourly");
        assertEq(v[1], address(2), "daily");
        assertEq(v[2], address(3), "weekly");
        assertEq(v[3], address(4), "monthly");
    }

    function test_unset_isAllZero() public view {
        VaultDirectory.Entry memory g = d.get();
        assertEq(g.hourly, address(0));
        assertEq(g.monthly, address(0));
        address[4] memory v = d.vaults();
        for (uint256 i; i < 4; ++i) {
            assertEq(v[i], address(0));
        }
    }
}
