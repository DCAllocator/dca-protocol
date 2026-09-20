// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StockRegistry} from "../../src/registries/StockRegistry.sol";
import {IStockRegistry} from "../../src/interfaces/IStockRegistry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract StockRegistryTest is Test {
    StockRegistry reg;
    MockERC20 nvda;
    MockERC20 tsla;
    address owner = makeAddr("owner");

    function setUp() public {
        reg = new StockRegistry(owner);
        nvda = new MockERC20("NVDA", "NVDA", 18);
        tsla = new MockERC20("TSLA", "TSLA", 6);
    }

    function test_listAndQuery() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit IStockRegistry.StockListed(address(nvda), "NVDA", 18, false);
        reg.listStock(address(nvda), "NVDA", false, true);
        assertTrue(reg.isApproved(address(nvda)));
        assertTrue(reg.isKnown(address(nvda)));
        assertTrue(reg.isPurchasable(address(nvda)));
        IStockRegistry.StockInfo memory i = reg.info(address(nvda));
        assertEq(i.symbol, "NVDA");
        assertEq(i.decimals, 18);
        assertEq(reg.allStocks().length, 1);
        assertEq(reg.approvedStocks().length, 1);
    }

    function test_listUnapprovedThenApprove() public {
        vm.startPrank(owner);
        reg.listStock(address(tsla), "TSLA", false, false);
        assertFalse(reg.isApproved(address(tsla)));
        assertTrue(reg.isKnown(address(tsla)));
        assertEq(reg.approvedStocks().length, 0);
        reg.setApproved(address(tsla), true);
        assertEq(reg.approvedStocks().length, 1);
        vm.stopPrank();
    }

    function test_feeOnTransferNotPurchasable() public {
        vm.startPrank(owner);
        reg.listStock(address(nvda), "NVDA", true, true);
        assertTrue(reg.isApproved(address(nvda)));
        assertFalse(reg.isPurchasable(address(nvda)));
        reg.setFeeOnTransfer(address(nvda), false);
        assertTrue(reg.isPurchasable(address(nvda)));
        vm.stopPrank();
    }

    function test_delistKeepsKnown() public {
        vm.startPrank(owner);
        reg.listStock(address(nvda), "NVDA", false, true);
        reg.setApproved(address(nvda), false);
        assertFalse(reg.isApproved(address(nvda)));
        assertTrue(reg.isKnown(address(nvda)));
        assertEq(reg.allStocks().length, 1);
        assertEq(reg.approvedStocks().length, 0);
        vm.stopPrank();
    }

    function test_reverts() public {
        vm.startPrank(owner);
        vm.expectRevert(StockRegistry.ZeroAddress.selector);
        reg.listStock(address(0), "X", false, true);
        vm.expectRevert(abi.encodeWithSelector(StockRegistry.NotAContract.selector, address(0xbeef)));
        reg.listStock(address(0xbeef), "EOA", false, true);
        vm.expectRevert(StockRegistry.EmptySymbol.selector);
        reg.listStock(address(nvda), "", false, true);
        reg.listStock(address(nvda), "NVDA", false, true);
        vm.expectRevert(abi.encodeWithSelector(StockRegistry.AlreadyListed.selector, address(nvda)));
        reg.listStock(address(nvda), "NVDA", false, true);
        vm.expectRevert(abi.encodeWithSelector(StockRegistry.NotListed.selector, address(tsla)));
        reg.setApproved(address(tsla), true);
        vm.expectRevert(abi.encodeWithSelector(StockRegistry.NotListed.selector, address(tsla)));
        reg.setFeeOnTransfer(address(tsla), true);
        vm.stopPrank();
        vm.prank(makeAddr("x"));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, makeAddr("x")));
        reg.listStock(address(tsla), "TSLA", false, true);
    }
}
