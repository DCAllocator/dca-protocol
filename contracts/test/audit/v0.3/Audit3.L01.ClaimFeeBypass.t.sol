// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";

/// @dev AUDIT v0.3 / L-01. Perks are spot $DCA balances read inside the user's own transaction. A claim can
///      therefore be made fee-free by holding >= autoDistributeThreshold $DCA for the duration of one call
///      (a flash loan, a friend's wallet, a lending market). The epoch-time fee halving is operator-timed and
///      only predictable, not atomic; the claim fee is fully bypassable.
contract Audit3_L01_ClaimFeeBypass is BaseTest {
    address internal lender = makeAddr("lender");

    function test_claimFee_bypassedWithTransientDcaBalance() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 1_000e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 accrued = daily.getPlan(id).stockAccrued;
        assertGt(accrued, 0);

        // Honest claim would pay 25 bps.
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        daily.claim(id, type(uint256).max);
        assertEq(nvda.balanceOf(treasury), (accrued * 25) / 10_000);
        vm.revertToState(snap);

        // "Flash" claim: borrow 100k $DCA, claim, give it back, all in one transaction.
        _giveDca(lender, 100_000);
        vm.prank(lender);
        dca.transfer(alice, 100_000e18);
        vm.startPrank(alice);
        daily.claim(id, type(uint256).max);
        dca.transfer(lender, 100_000e18);
        vm.stopPrank();
        assertEq(nvda.balanceOf(treasury), 0, "no claim fee");
        assertEq(nvda.balanceOf(alice), accrued);
    }
}
