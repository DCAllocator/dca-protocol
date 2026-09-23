// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlanVault} from "./PlanVault.sol";
import {VaultParams} from "./VaultTypes.sol";
import {FeeMath} from "../libraries/FeeMath.sol";

/// @title HourlyVault
/// @notice 1-hour epochs, 90 bps default purchase fee. Origin should be aligned to the top of an hour
///         (`EpochLib.alignToHour`), so every epoch boundary lands on hh:00:00 UTC, 24 times a day, 7 days a week.
/// @dev Same `PlanVault` bytecode as Daily / Weekly / Monthly; only the two constants differ. Two things are
///      specific to this cadence and worth knowing before deploying one:
///      - The 90 bps default IS the protocol-wide inclusive cap (`FeeMath.MAX_FEE_BPS`): `setFees` can lower it
///        but never raise it back above 90, and the vault is not upgradeable, so the tier is fixed for its lifetime.
///        $DCA perk holders pay the halved 45 bps.
///      - Because epoch 0 must contain the deploy block (`PlanVault` reverts `BadOrigin` otherwise), the creation
///        tx has to land in the same wall-clock hour that `alignToHour(block.timestamp)` was computed in. Deploy
///        scripts create this vault first, before anything that could push the broadcast past the next :00.
///      Missed hours are skipped, never caught up (a page that cannot be bought for a whole hour is that hour
///      gone for every plan on the stock), and the per-buy minimum is the same 10 USDG as every other vault, so an
///      hourly plan needs >= 7,200 USDG per 30 days to run continuously.
contract HourlyVault is PlanVault {
    uint32 public constant EPOCH_LENGTH = 1 hours;
    uint16 public constant DEFAULT_PURCHASE_FEE_BPS = FeeMath.MAX_FEE_BPS; // 90: the inclusive cap, see above

    constructor(VaultParams memory p) PlanVault(_withDefaults(p)) {}

    function _withDefaults(VaultParams memory p) internal pure returns (VaultParams memory) {
        p.epochLength = EPOCH_LENGTH;
        p.purchaseFeeBps = DEFAULT_PURCHASE_FEE_BPS;
        return p;
    }

    /// @notice Human-readable vault kind for frontends.
    function vaultKind() external pure returns (string memory) {
        return "hourly";
    }
}
