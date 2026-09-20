// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IEpochAdvanceable
/// @notice V2 hook point. A Uniswap V4 hook (afterSwap) or any scheduler can call `advanceEpoch`
///         on a vault. V1 vaults implement this via `advanceEpoch(stock, limit, routeOverride)`;
///         this narrower shape is what an external trigger would bind to. Nothing in V1 depends on it.
interface IEpochAdvanceable {
    /// @notice Advance the current epoch for `stock`, processing as many plans as `data` allows.
    /// @param stock Registry-approved Stock Token.
    /// @param data  Implementation-defined (V1: abi.encode(uint256 limit, bytes routeOverride)).
    function advanceEpoch(address stock, bytes calldata data) external;
}
