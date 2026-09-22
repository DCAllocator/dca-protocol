// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";

/// @title AUDIT v0.3 / L-01 KNOWN / accepted — the claim-fee perk is the live $DCA balance at claim time
///
/// Finding: perks are spot balances read inside the user's own claim, so a balance held for one call (a friend's
/// wallet, a lending market) waives the 25 bps claim fee. A fill-time snapshot was implemented and then reverted
/// by decision: the perk is meant to reward holding $DCA at any time, the fee at stake is 25 bps of a claim, and
/// buying $DCA to qualify is welcome. This test pins the accepted behaviour so a future change is deliberate.
contract Audit3_L01_ClaimFeeBypass is BaseTest {
    address internal lender = makeAddr("lender");

    function test_KNOWN_ACCEPTED_transientDcaBalanceWaivesTheClaimFee() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 1_000e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 accrued = daily.getPlan(id).stockAccrued;
        assertGt(accrued, 0);

        _giveDca(lender, 100_000);
        vm.prank(lender);
        dca.transfer(alice, 100_000e18);
        vm.startPrank(alice);
        daily.claim(id, type(uint256).max);
        dca.transfer(lender, 100_000e18);
        vm.stopPrank();
        assertEq(nvda.balanceOf(treasury), 0, "no claim fee: the tier is the live balance");
        assertEq(nvda.balanceOf(alice), accrued);
    }
}
