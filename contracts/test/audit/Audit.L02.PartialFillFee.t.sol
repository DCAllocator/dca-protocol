// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {Plan, FeeConfig} from "../../src/vault/VaultTypes.sol";

/// @title L-02 KNOWN / pinned — purchase fee and keeper tip are charged on `spend`, not on USDG actually bought
///
/// Left as-is by decision (it is not a safety issue; moving fees after the swap affects revenue). This test
/// documents the behaviour so a future change is deliberate.
contract AuditL02PartialFillFee is BaseTest {
    function test_KNOWN_feeChargedOnUnspentUsdgOnPartialFills() public {
        FeeConfig memory f = daily.fees();
        f.keeperTipBps = 1_000; // the cap since audit v0.3 L-04
        vm.prank(owner);
        daily.setFees(f);
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 100e6, 100e6);
        router.setFill(address(usdg), address(nvda), 5_000); // pool takes half; the quote reflects it

        _nextEpoch(daily);
        _advance(daily, address(nvda));
        Plan memory p = _plan(daily, id);
        uint256 fee1 = usdg.balanceOf(treasury) + usdg.balanceOf(keeper);
        assertEq(fee1, 0.75e6, "0.75% of the full 100 USDG although only ~49.6 was bought");
        assertEq(p.usdgIdle, 49.625e6, "unspent net returned to idle, its fee is not");

        router.setFill(address(usdg), address(nvda), 10_000);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 fee2 = usdg.balanceOf(treasury) + usdg.balanceOf(keeper) - fee1;
        assertEq(fee2, uint256(49.625e6) * 75 / 10_000, "the same USDG is charged again next epoch");
    }
}
