// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IStockRegistry
/// @notice Whitelist of Robinhood Stock Tokens the vaults may buy.
interface IStockRegistry {
    struct StockInfo {
        bool approved; // can open plans / run epochs
        bool known; // ever listed; never cleared (protects user accounting from rescueERC20)
        bool feeOnTransfer; // vault refuses fee-on-transfer stocks
        uint8 decimals;
        string symbol;
    }

    event StockListed(address indexed token, string symbol, uint8 decimals, bool feeOnTransfer);
    event StockApprovalSet(address indexed token, bool approved);
    event StockFeeOnTransferSet(address indexed token, bool feeOnTransfer);

    /// @notice True if plans may be created / epochs executed for `token`.
    function isApproved(address token) external view returns (bool);
    /// @notice True if `token` was ever listed (even if later delisted).
    function isKnown(address token) external view returns (bool);
    /// @notice True if the vault may hold and purchase `token` right now (approved and not fee-on-transfer).
    function isPurchasable(address token) external view returns (bool);
    function info(address token) external view returns (StockInfo memory);
    function allStocks() external view returns (address[] memory);
    function approvedStocks() external view returns (address[] memory);
}
