// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {TestVault} from "../mocks/TestVault.sol";
import {VaultParams} from "../../src/vault/VaultTypes.sol";

/// @dev EIP-170 guard. Every vault is one PlanVault with a different epoch length, and PlanVault sits within a few
///      hundred bytes of the 24,576-byte runtime limit (margins at the time of writing, after closePlan moved into
///      the linked PlanExitLib: Hourly 373, Daily 373, Weekly 372, Monthly 371, TestVault 416 B — see
///      `forge build --sizes`; the kinds differ only by the length of their `vaultKind()` string). Anything added to
///      PlanVault or its linked libraries' call sites can push it over. Forge already refuses an oversized `new`
///      (unless run with `--disable-code-size-limit`), but that surfaces as an opaque setUp failure in every suite at
///      once; this one names the vault, and logs the remaining margin so a shrinking budget is visible in
///      `forge test -vv` before it runs out. It deploys each production vault kind plus the local-dev TestVault
///      through the shared fixture and asserts the deployed runtime stays strictly under the limit. New vault kinds
///      get a test here.
contract ContractSizesTest is BaseTest {
    /// @dev EIP-170: maximum runtime bytecode size of a deployed contract.
    uint256 internal constant EIP170_LIMIT = 24_576;

    function test_hourlyVaultFitsEip170() public {
        _assertFits("HourlyVault", address(hourly));
    }

    function test_dailyVaultFitsEip170() public {
        _assertFits("DailyVault", address(daily));
    }

    function test_weeklyVaultFitsEip170() public {
        _assertFits("WeeklyVault", address(weekly));
    }

    function test_monthlyVaultFitsEip170() public {
        _assertFits("MonthlyVault", address(monthly));
    }

    function test_testVaultFitsEip170() public {
        VaultParams memory p = VaultParams({
            owner: owner,
            usdg: address(usdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: treasury,
            epochLength: 0,
            origin: uint64(block.timestamp - (block.timestamp % 2 minutes)),
            purchaseFeeBps: 0
        });
        TestVault tv = new TestVault(p, 2 minutes);
        _assertFits("TestVault", address(tv));
    }

    function _assertFits(string memory name, address vault) internal {
        uint256 size = vault.code.length;
        assertGt(size, 0, string.concat(name, ": no code deployed"));
        assertLt(size, EIP170_LIMIT, string.concat(name, ": runtime exceeds the EIP-170 limit"));
        emit log_named_uint(string.concat(name, " runtime margin (bytes)"), EIP170_LIMIT - size);
    }
}
