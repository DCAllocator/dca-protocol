// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDCA
/// @notice Minimal view surface of the $DCA protocol token used by the vaults.
/// @dev The vault only reads spot balances at epoch execution / claim time. No transfers, no staking.
///      If the vault is deployed with dca == address(0), every balance is treated as 0 (no perks).
interface IDCA {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}
