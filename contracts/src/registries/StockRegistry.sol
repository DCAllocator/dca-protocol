// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IStockRegistry} from "../interfaces/IStockRegistry.sol";

/// @title StockRegistry
/// @notice Owner-curated whitelist of Robinhood Stock Tokens. Vaults only open plans for approved tokens.
/// @dev Tokens are never truly removed: `known` stays true forever so that `rescueERC20` on a vault can
///      never touch a token that might hold user accounting. Delisting = `setApproved(token, false)`.
contract StockRegistry is IStockRegistry, Ownable2Step {
    mapping(address => StockInfo) private _info;
    address[] private _stocks;

    error ZeroAddress();
    error AlreadyListed(address token);
    error NotListed(address token);
    error EmptySymbol();

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice List a Stock Token. Decimals are read from the token.
    /// @param token          ERC-20 Stock Token address.
    /// @param symbol         Display symbol (e.g. "NVDA"). Stored on-chain for the frontend.
    /// @param feeOnTransfer  Flag the token as fee-on-transfer. Vaults refuse such tokens.
    /// @param approved       Whether plans may be opened immediately.
    function listStock(address token, string calldata symbol, bool feeOnTransfer, bool approved) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (_info[token].known) revert AlreadyListed(token);
        if (bytes(symbol).length == 0) revert EmptySymbol();
        uint8 dec = IERC20Metadata(token).decimals();
        _info[token] =
            StockInfo({approved: approved, known: true, feeOnTransfer: feeOnTransfer, decimals: dec, symbol: symbol});
        _stocks.push(token);
        emit StockListed(token, symbol, dec, feeOnTransfer);
        emit StockApprovalSet(token, approved);
    }

    /// @notice Approve or delist a listed token. Delisting stops new plans and epochs; claims/withdrawals continue.
    function setApproved(address token, bool approved) external onlyOwner {
        if (!_info[token].known) revert NotListed(token);
        _info[token].approved = approved;
        emit StockApprovalSet(token, approved);
    }

    /// @notice Update the fee-on-transfer flag (e.g. if a token upgrades).
    function setFeeOnTransfer(address token, bool feeOnTransfer) external onlyOwner {
        if (!_info[token].known) revert NotListed(token);
        _info[token].feeOnTransfer = feeOnTransfer;
        emit StockFeeOnTransferSet(token, feeOnTransfer);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @inheritdoc IStockRegistry
    function isApproved(address token) external view returns (bool) {
        return _info[token].approved;
    }

    /// @inheritdoc IStockRegistry
    function isKnown(address token) external view returns (bool) {
        return _info[token].known;
    }

    /// @inheritdoc IStockRegistry
    function isPurchasable(address token) external view returns (bool) {
        StockInfo storage s = _info[token];
        return s.approved && !s.feeOnTransfer;
    }

    /// @inheritdoc IStockRegistry
    function info(address token) external view returns (StockInfo memory) {
        return _info[token];
    }

    /// @inheritdoc IStockRegistry
    function allStocks() external view returns (address[] memory) {
        return _stocks;
    }

    /// @inheritdoc IStockRegistry
    function approvedStocks() external view returns (address[] memory out) {
        uint256 n;
        for (uint256 i; i < _stocks.length; ++i) {
            if (_info[_stocks[i]].approved) ++n;
        }
        out = new address[](n);
        uint256 j;
        for (uint256 i; i < _stocks.length; ++i) {
            if (_info[_stocks[i]].approved) out[j++] = _stocks[i];
        }
    }
}
