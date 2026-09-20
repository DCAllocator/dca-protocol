// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlanVault} from "../../src/vault/PlanVault.sol";
import {VaultParams} from "../../src/vault/VaultTypes.sol";

/// @title TestVault
/// @notice Local-development vault with a short, configurable epoch (minutes instead of days) so a scheduler
///         can be watched advancing epochs without waiting for a daily boundary. Same `PlanVault` code as
///         Daily / Weekly / Monthly; only `epochLength` differs. Deployed by `script/DeployLocal.s.sol` only —
///         NEVER part of a production deployment (see script/Deploy.s.sol, which does not know about it).
contract TestVault is PlanVault {
    uint16 public constant DEFAULT_PURCHASE_FEE_BPS = 75;

    constructor(VaultParams memory p, uint32 epochLength_) PlanVault(_withDefaults(p, epochLength_)) {}

    function _withDefaults(VaultParams memory p, uint32 epochLength_) internal pure returns (VaultParams memory) {
        p.epochLength = epochLength_;
        p.purchaseFeeBps = DEFAULT_PURCHASE_FEE_BPS;
        return p;
    }

    /// @notice Human-readable vault kind for frontends / keepers.
    function vaultKind() external pure returns (string memory) {
        return "test";
    }
}
