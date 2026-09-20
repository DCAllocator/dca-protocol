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

    function test_setAndGet() public {
        VaultDirectory.Entry memory e = VaultDirectory.Entry({
            daily: address(1),
            weekly: address(2),
            monthly: address(3),
            registry: address(4),
            router: address(5),
            usdg: address(6),
            weth: address(7),
            dca: address(8)
        });
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit VaultDirectory.DirectorySet(e);
        d.set(e);
        VaultDirectory.Entry memory g = d.get();
        assertEq(g.daily, address(1));
        assertEq(g.dca, address(8));
        address[3] memory v = d.vaults();
        assertEq(v[0], address(1));
        assertEq(v[1], address(2));
        assertEq(v[2], address(3));
        vm.prank(address(9));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(9)));
        d.set(e);
    }
}
