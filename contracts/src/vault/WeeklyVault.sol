// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlanVault} from "./PlanVault.sol";
import {VaultParams} from "./VaultTypes.sol";

/// @title WeeklyVault
/// @notice 7-day epochs, 50 bps default purchase fee. Origin should be aligned to Monday 00:00 UTC.
contract WeeklyVault is PlanVault {
    uint32 public constant EPOCH_LENGTH = 7 days;
    uint16 public constant DEFAULT_PURCHASE_FEE_BPS = 50;

    constructor(VaultParams memory p) PlanVault(_withDefaults(p)) {}

    function _withDefaults(VaultParams memory p) internal pure returns (VaultParams memory) {
        p.epochLength = EPOCH_LENGTH;
        p.purchaseFeeBps = DEFAULT_PURCHASE_FEE_BPS;
        return p;
    }

    /// @notice Human-readable vault kind for frontends.
    function vaultKind() external pure returns (string memory) {
        return "weekly";
    }
}
