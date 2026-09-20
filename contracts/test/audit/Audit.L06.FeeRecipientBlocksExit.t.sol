// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {BlockingToken} from "../mocks/BlockingToken.sol";
import {FeeConfig} from "../../src/vault/VaultTypes.sol";

/// @title L-06 KNOWN / accepted — push-style fee transfers make `claim` depend on `feeRecipient` being allowed
///
/// Accepted by decision: if the treasury is blocked by a token for reasons outside the protocol's control there
/// is nothing the contracts can do about the underlying restriction; the owner can zero the fee or move the
/// recipient. Documented here so the operational runbook keeps it in view.
contract AuditL06FeeRecipientBlocksExit is BaseTest {
    BlockingToken blk;

    function setUp() public override {
        super.setUp();
        blk = new BlockingToken();
        vm.prank(owner);
        registry.listStock(address(blk), "BLK", false, true);
        router.setRate(address(usdg), address(blk), 1e18, 100e6);
    }

    function test_KNOWN_ACCEPTED_treasuryBlockedOnStockToken_claimRevertsUntilAdminActs() public {
        uint256 id = _createUsdgPlan(daily, alice, address(blk), 100e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(blk));
        blk.setBlocked(treasury, true);
        vm.prank(alice);
        vm.expectRevert("BLK: recipient blocked");
        daily.claim(id, type(uint256).max);
        FeeConfig memory f = daily.fees();
        f.claimFeeBps = 0;
        vm.prank(owner);
        daily.setFees(f);
        vm.prank(alice);
        daily.claim(id, type(uint256).max);
    }
}
