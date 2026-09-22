// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPlanVault} from "../interfaces/IPlanVault.sol";
import {IStockRegistry} from "../interfaces/IStockRegistry.sol";
import {DustState} from "../vault/VaultTypes.sol";

/// @title VaultAdminLib
/// @notice Rarely used owner / feeManager paths of PlanVault (`skim`, `rescueERC20`), linked as an EXTERNAL
///         library and delegatecalled on the vault's storage — the same pattern as BoostLib — so that PlanVault
///         stays under the EIP-170 size limit. Events and errors are the vault's (IPlanVault).
library VaultAdminLib {
    using SafeERC20 for IERC20;

    /// @notice Reconcile a balance the vault did not book (a transfer made directly to it, an issuer
    ///         distribution). The excess of a listed stock goes to that stock's `dustPot` (distributed to its
    ///         plans at the next epoch); excess USDG / WETH goes to the dust sinks swept to `feeRecipient`.
    ///         Afterwards `balance == accounted + dust` holds again for that token (audit v0.3 M-04).
    function skim(
        address token,
        IERC20 usdg,
        IERC20 weth,
        IStockRegistry registry,
        uint256 totalUsdgIdle,
        DustState storage dust,
        mapping(address => uint256) storage totalStockAccrued,
        mapping(address => uint256) storage dustPot
    ) external returns (uint256 excess) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (token == address(usdg)) {
            excess = bal - totalUsdgIdle - dust.usdg;
            dust.usdg += excess;
        } else if (token == address(weth)) {
            excess = bal - dust.weth;
            dust.weth += excess;
        } else if (registry.isKnown(token)) {
            excess = bal - totalStockAccrued[token] - dustPot[token];
            dustPot[token] += excess;
        } else {
            revert IPlanVault.NotSkimmable(token);
        }
        if (excess == 0) revert IPlanVault.ZeroAmount();
        emit IPlanVault.Skimmed(token, excess);
    }

    /// @notice Recover tokens that can never be user accounting: not USDG, not WETH, not the boost strategy's
    ///         shares, never listed as a stock (use `skim` for those).
    function rescue(
        address token,
        address to,
        uint256 amount,
        IERC20 usdg,
        IERC20 weth,
        address strategy,
        IStockRegistry registry
    ) external {
        if (token == address(usdg) || token == address(weth) || token == strategy || registry.isKnown(token)) {
            revert IPlanVault.TokenNotRescuable(token);
        }
        if (to == address(0)) revert IPlanVault.ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit IPlanVault.Rescued(token, to, amount);
    }
}
