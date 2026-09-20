// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlanVault} from "./PlanVault.sol";
import {VaultParams} from "./VaultTypes.sol";

/// @title DailyVault
/// @notice 1-day epochs, 75 bps default purchase fee. Origin should be aligned to 00:00 UTC (see EpochLib).
contract DailyVault is PlanVault {
    uint32 public constant EPOCH_LENGTH = 1 days;
    uint16 public constant DEFAULT_PURCHASE_FEE_BPS = 75;

    constructor(VaultParams memory p) PlanVault(_withDefaults(p)) {}

    function _withDefaults(VaultParams memory p) internal pure returns (VaultParams memory) {
        p.epochLength = EPOCH_LENGTH;
        p.purchaseFeeBps = DEFAULT_PURCHASE_FEE_BPS;
        return p;
    }

    /// @notice Human-readable vault kind for frontends.
    function vaultKind() external pure returns (string memory) {
        return "daily";
    }
}
