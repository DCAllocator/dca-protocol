// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPlanVault} from "../interfaces/IPlanVault.sol";
import {Plan} from "../vault/VaultTypes.sol";
import {FeeMath} from "../libraries/FeeMath.sol";

/// @title ClaimHelper
/// @notice Read-only aggregation across vaults for frontends and bots: positions, claimables, fee previews.
/// @dev Claims themselves are executed on the vault by the plan owner (`claim` / `claimAll`); this contract
///      never takes custody and cannot act on anyone's behalf.
contract ClaimHelper {
    struct Position {
        address vault;
        uint256 planId;
        address stock;
        address recipient;
        uint96 amountPerEpoch;
        uint128 usdgIdle;
        uint128 wethIdle;
        uint128 stockAccrued;
        uint32 lastEpochId;
        bool paused;
        bool zapWethEachEpoch;
        uint16 maxWethSlippageBps;
    }

    /// @notice Every plan `user` owns across `vaults`.
    function positions(IPlanVault[] calldata vaults, address user) external view returns (Position[] memory out) {
        uint256 total;
        for (uint256 v; v < vaults.length; ++v) {
            total += vaults[v].userPlans(user).length;
        }
        out = new Position[](total);
        uint256 k;
        for (uint256 v; v < vaults.length; ++v) {
            uint256[] memory ids = vaults[v].userPlans(user);
            for (uint256 i; i < ids.length; ++i) {
                Plan memory p = vaults[v].getPlan(ids[i]);
                out[k++] = Position({
                    vault: address(vaults[v]),
                    planId: ids[i],
                    stock: p.stock,
                    recipient: p.recipient,
                    amountPerEpoch: p.amountPerEpoch,
                    usdgIdle: p.usdgIdle,
                    wethIdle: p.wethIdle,
                    stockAccrued: p.stockAccrued,
                    lastEpochId: p.lastEpochId,
                    paused: p.paused,
                    zapWethEachEpoch: p.zapWethEachEpoch,
                    maxWethSlippageBps: p.maxWethSlippageBps
                });
            }
        }
    }

    /// @notice Total unclaimed `stock` for `user` across `vaults`.
    function claimable(IPlanVault[] calldata vaults, address user, address stock)
        external
        view
        returns (uint256 total)
    {
        for (uint256 v; v < vaults.length; ++v) {
            total += vaults[v].userStockAccrued(user, stock);
        }
    }

    /// @notice What the next epoch would charge a plan if it ran now (USDG idle only; WETH zap not simulated).
    ///         Powers the "you pay 0.50% of $200 = $1.00 this epoch" line.
    function previewFill(IPlanVault vault, uint256 planId)
        external
        view
        returns (uint256 spendUsdg, uint256 feeUsdg, uint16 feeBps, bool autoDistribute)
    {
        Plan memory p = vault.getPlan(planId);
        if (p.owner == address(0) || p.paused) return (0, 0, 0, false);
        spendUsdg = p.usdgIdle < p.amountPerEpoch ? p.usdgIdle : p.amountPerEpoch;
        feeBps = vault.effectivePurchaseFeeBps(p.owner);
        feeUsdg = FeeMath.feeOf(spendUsdg, feeBps);
        autoDistribute = vault.isAutoDistribute(p.owner);
    }

    /// @notice Fee preview for a hypothetical plan (before it exists).
    function previewFee(IPlanVault vault, address user, uint256 amountPerEpoch)
        external
        view
        returns (uint256 feeUsdg, uint16 feeBps, bool autoDistribute)
    {
        feeBps = vault.effectivePurchaseFeeBps(user);
        feeUsdg = FeeMath.feeOf(amountPerEpoch, feeBps);
        autoDistribute = vault.isAutoDistribute(user);
    }
}
