// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {BlockingToken} from "../../mocks/BlockingToken.sol";

/// @title AUDIT v0.3 / L-01 regression — the claim-fee tier is fixed at fill time
///
/// Finding: perks were spot $DCA balances read inside the user's own claim, so a balance held for one call (a
/// flash loan, a friend's wallet) waived the 25 bps claim fee.
/// Fix: `Plan.claimFeeFree` is written at each fill from the tier the owner held then; `claim` reads the flag.
contract Audit3_L01_ClaimFeeBypass is BaseTest {
    address internal lender = makeAddr("lender");

    function test_transientDcaBalance_noLongerWaivesTheClaimFee() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 1_000e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 accrued = daily.getPlan(id).stockAccrued;
        assertGt(accrued, 0);
        assertFalse(daily.getPlan(id).claimFeeFree);

        _giveDca(lender, 100_000);
        vm.prank(lender);
        dca.transfer(alice, 100_000e18);
        vm.startPrank(alice);
        daily.claim(id, type(uint256).max);
        dca.transfer(lender, 100_000e18);
        vm.stopPrank();
        uint256 fee = (accrued * 25) / 10_000;
        assertEq(nvda.balanceOf(treasury), fee, "25 bps claim fee charged");
        assertEq(nvda.balanceOf(alice), accrued - fee);
    }

    function test_tierHeldAtFill_isHonouredAtClaim() public {
        BlockingToken blk = new BlockingToken();
        vm.prank(owner);
        registry.listStock(address(blk), "BLK", false, true);
        router.setRate(address(usdg), address(blk), 1e18, 100e6);
        _giveDca(alice, 100_000);
        blk.setBlocked(alice, true); // auto-distribute fails -> accrues
        uint256 id = _createUsdgPlan(daily, alice, address(blk), 200e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(blk));
        assertTrue(daily.getPlan(id).claimFeeFree);
        vm.prank(alice);
        dca.transfer(bob, 100_000e18); // sold everything since
        blk.setBlocked(alice, false);
        vm.prank(alice);
        daily.claim(id, type(uint256).max);
        assertEq(blk.balanceOf(treasury), 0, "fee-free: the tier was held when the stock was bought");
    }
}
