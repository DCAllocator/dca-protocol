// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title EpochLib
/// @notice Epoch arithmetic. Epochs are `origin + n * epochLength` half-open intervals; `epochId = n`.
/// @dev Alignment policy (deploy script):
///      - Hourly  : origin = hh:00:00 UTC of the deploy hour   -> fires on the hour, every hour (24/7)
///      - Daily   : origin = 00:00 UTC of deploy day          -> fires at 00:00 UTC every day
///      - Weekly  : origin = 00:00 UTC of the Monday <= deploy -> fires Monday 00:00 UTC
///      - Monthly : origin = 00:00 UTC of deploy day, 30-day epochs (calendar months are not used; see README)
///      Epoch 0 is the (partial) epoch containing deployment and is never executed; the first fire is epoch 1.
///      The tighter the alignment, the shorter the window in which the vault's creation tx must land: `PlanVault`
///      requires `origin <= now < origin + epochLength` (`BadOrigin`), so a vault aligned with `alignToHour` has
///      to be created before the next top of the hour — deploy scripts create the hourly vault first.
library EpochLib {
    uint256 internal constant HOUR = 1 hours;
    uint256 internal constant DAY = 1 days;
    uint256 internal constant WEEK = 7 days;
    /// @dev Unix epoch (Thursday 1970-01-01) -> Monday 1970-01-05 is +4 days.
    uint256 internal constant MONDAY_OFFSET = 4 days;

    error TimestampBeforeOrigin(uint256 timestamp, uint64 origin);

    /// @notice Current epoch id for `timestamp`.
    function epochAt(uint64 origin, uint32 epochLength, uint256 timestamp) internal pure returns (uint32) {
        if (timestamp < origin) revert TimestampBeforeOrigin(timestamp, origin);
        return SafeCast.toUint32((timestamp - origin) / epochLength);
    }

    /// @notice Start timestamp of `epochId`.
    function epochStart(uint64 origin, uint32 epochLength, uint32 epochId) internal pure returns (uint256) {
        return uint256(origin) + uint256(epochId) * epochLength;
    }

    /// @notice Start of the epoch after the one containing `timestamp` (i.e. next fire time).
    function nextBoundary(uint64 origin, uint32 epochLength, uint256 timestamp) internal pure returns (uint256) {
        return epochStart(origin, epochLength, epochAt(origin, epochLength, timestamp) + 1);
    }

    /// @notice Align `timestamp` down to the top of its hour (hh:00:00 UTC).
    function alignToHour(uint256 timestamp) internal pure returns (uint64) {
        return SafeCast.toUint64(timestamp - (timestamp % HOUR));
    }

    /// @notice Align `timestamp` down to 00:00 UTC.
    function alignToDay(uint256 timestamp) internal pure returns (uint64) {
        return SafeCast.toUint64(timestamp - (timestamp % DAY));
    }

    /// @notice Align `timestamp` down to the most recent Monday 00:00 UTC.
    function alignToMonday(uint256 timestamp) internal pure returns (uint64) {
        // Shift so that Mondays land on multiples of a week, floor, shift back.
        uint256 shifted = timestamp - MONDAY_OFFSET;
        return SafeCast.toUint64(shifted - (shifted % WEEK) + MONDAY_OFFSET);
    }
}
