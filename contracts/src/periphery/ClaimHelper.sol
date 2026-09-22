// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPlanVault} from "../interfaces/IPlanVault.sol";
import {Plan} from "../vault/VaultTypes.sol";
import {FeeMath} from "../libraries/FeeMath.sol";

/// @title ClaimHelper
/// @notice Read-only aggregation across vaults for frontends and bots: positions, claimables, fee previews,
///         boosted balances and earnings.
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
        uint128 stockAccrued;
        uint32 lastEpochId;
        bool paused;
        bool boosted;
        /// @dev Claims of the accrued stock are fee-free (owner held the auto-distribute tier at the last fill).
        bool claimFeeFree;
        /// @dev USDG currently lent through the vault's boost strategy for this plan (principal + unrealised yield).
        uint256 boostValue;
        /// @dev Cost basis of `boostValue`; the difference is yield not yet realised.
        uint128 boostPrincipal;
        /// @dev Yield already realised by spends / withdrawals (cumulative, USDG).
        uint128 boostEarned;
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
            IPlanVault vault = vaults[v];
            uint256[] memory ids = vault.userPlans(user);
            if (ids.length == 0) continue;
            (uint256 poolAssets, uint256 poolShares) = _pool(vault);
            for (uint256 i; i < ids.length; ++i) {
                Plan memory p = vault.getPlan(ids[i]);
                out[k++] = Position({
                    vault: address(vault),
                    planId: ids[i],
                    stock: p.stock,
                    recipient: p.recipient,
                    amountPerEpoch: p.amountPerEpoch,
                    usdgIdle: p.usdgIdle,
                    stockAccrued: p.stockAccrued,
                    lastEpochId: p.lastEpochId,
                    paused: p.paused,
                    boosted: p.boosted,
                    claimFeeFree: p.claimFeeFree,
                    boostValue: _value(p.boostShares, poolAssets, poolShares),
                    boostPrincipal: p.boostPrincipal,
                    boostEarned: p.boostEarned
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

    /// @notice A plan's boosted balance in USDG right now (principal + unrealised yield): its share of the
    ///         vault's boost pool. Spendable at the next epoch and withdrawable, market liquidity permitting.
    function boostValueOf(IPlanVault vault, uint256 planId) public view returns (uint256) {
        uint256 shares = vault.getPlan(planId).boostShares;
        if (shares == 0) return 0;
        (uint256 poolAssets, uint256 poolShares) = _pool(vault);
        return _value(shares, poolAssets, poolShares);
    }

    /// @notice What the next epoch would charge a plan if it ran now (boosted balance included).
    ///         Powers the "you pay 0.50% of $200 = $1.00 this epoch" line.
    function previewFill(IPlanVault vault, uint256 planId)
        external
        view
        returns (uint256 spendUsdg, uint256 feeUsdg, uint16 feeBps, bool autoDistribute)
    {
        Plan memory p = vault.getPlan(planId);
        if (p.owner == address(0) || p.paused) return (0, 0, 0, false);
        uint256 avail = uint256(p.usdgIdle) + boostValueOf(vault, planId);
        spendUsdg = avail < p.amountPerEpoch ? avail : p.amountPerEpoch;
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

    function _pool(IPlanVault vault) internal view returns (uint256 poolAssets, uint256 poolShares) {
        poolShares = vault.totalBoostShares();
        if (poolShares > 0) poolAssets = vault.boostAssets();
    }

    /// @dev Same maths as BoostLib.valueOf (virtual 1 share / 1 asset offset, floor).
    function _value(uint256 shares, uint256 poolAssets, uint256 poolShares) internal pure returns (uint256) {
        return shares == 0 ? 0 : Math.mulDiv(shares, poolAssets + 1, poolShares + 1);
    }
}
