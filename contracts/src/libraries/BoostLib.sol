// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IPlanVault} from "../interfaces/IPlanVault.sol";
import {Plan} from "../vault/VaultTypes.sol";

/// @title BoostLib
/// @notice The vault's boost pool: ONE ERC-4626 strategy position (MorphoBlueStrategy = a Morpho Blue market)
///         split between boosted plans by internal shares. Linked as an EXTERNAL library — the state-changing
///         functions run by `delegatecall` on the vault's own storage (`Pool` and `Plan` are storage pointers),
///         which keeps PlanVault under the EIP-170 size limit. Events and errors are the vault's (IPlanVault).
///
/// @dev Share maths carries a virtual (1 share, 1 asset) offset, so an empty or wiped-out pool never divides by
///      zero and a fresh pool mints shares 1:1. A plan's balance is `valueOf(plan.boostShares, poolAssets,
///      pool.totalShares)`; withdrawals burn shares rounded UP against the plan, and a plan drained to its full
///      value gives up every share (no dust share survives). `boostPrincipal` is the plan's cost basis, reduced
///      pro rata on every burn; the part of a withdrawal above it is booked as `boostEarned` (realised yield).
///      Invariant: sum(plan.boostShares) == pool.totalShares.
library BoostLib {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    struct Pool {
        IERC4626 strategy; // address(0) = boost unavailable
        uint256 totalShares; // internal shares held by every boosted plan combined
    }

    // ------------------------------------------------------------------
    // Pure / view (internal: inlined into the vault)
    // ------------------------------------------------------------------

    /// @notice USDG value of the vault's whole strategy position (yield accrued to this block).
    function poolAssets(Pool storage pool) internal view returns (uint256) {
        IERC4626 s = pool.strategy;
        if (address(s) == address(0)) return 0;
        return s.convertToAssets(s.balanceOf(address(this)));
    }

    /// @notice USDG value of `shares` internal shares at the given pool snapshot (floor).
    function valueOf(uint256 shares, uint256 assets, uint256 totalShares) internal pure returns (uint256) {
        return Math.mulDiv(shares, assets + 1, totalShares + 1);
    }

    // ------------------------------------------------------------------
    // Mutations (external: delegatecalled)
    // ------------------------------------------------------------------

    /// @notice Lend `assets` (already held by the vault) through the strategy on behalf of `planId`.
    ///         Reverts `BoostUnavailable` when no strategy is set.
    function deposit(Pool storage pool, Plan storage p, uint256 planId, uint256 assets) external {
        _deposit(pool, p, planId, assets);
    }

    /// @notice Boost (lend the plan's idle USDG, future deposits included) or unboost (pull everything back into
    ///         `usdgIdle`, realising the yield). Boosting an already boosted plan sweeps any unboosted residual
    ///         into the pool. Returns the USDG moved out of / into `usdgIdle` so the vault can adjust its total.
    function setPlanBoost(Pool storage pool, Plan storage p, uint256 planId, bool enabled)
        external
        returns (uint256 toPool, uint256 fromPool)
    {
        if (enabled) {
            p.boosted = true;
            toPool = p.usdgIdle;
            if (toPool > 0) {
                p.usdgIdle = 0;
                _deposit(pool, p, planId, toPool);
            }
        } else {
            p.boosted = false;
            if (p.boostShares > 0) {
                fromPool = _withdraw(pool, p, planId, type(uint256).max);
                p.usdgIdle += fromPool.toUint128();
            }
        }
        emit IPlanVault.PlanBoostSet(planId, enabled);
    }

    /// @notice `withdrawIdle` for a boosted plan: `usdgIdle` first, then the strategy (type(uint256).max = all).
    ///         Debits the plan and returns the USDG now in the vault for the caller to pay out, plus the part
    ///         that came out of `usdgIdle` (so the vault can adjust `totalUsdgIdle`).
    function withdrawIdle(Pool storage pool, Plan storage p, uint256 planId, uint256 amount)
        external
        returns (uint256 total, uint256 fromIdle)
    {
        uint256 idle = p.usdgIdle;
        uint256 available = idle + valueOf(p.boostShares, poolAssets(pool), pool.totalShares);
        if (amount == type(uint256).max) amount = available;
        if (amount == 0) revert IPlanVault.ZeroAmount();
        if (amount > available) revert IPlanVault.InsufficientIdle(amount, available);
        fromIdle = amount > idle ? idle : amount;
        p.usdgIdle = (idle - fromIdle).toUint128();
        total = fromIdle;
        // Rounding may hand back a hair less than asked: pay out what actually came back.
        if (amount > fromIdle) total += _withdraw(pool, p, planId, amount - fromIdle);
    }

    /// @notice Book a boosted spend that was already pulled by `withdrawPage`: burn the shares behind `assets`
    ///         at the page's pool snapshot.
    function burn(
        Pool storage pool,
        Plan storage p,
        uint256 planId,
        uint256 assets,
        uint256 snapAssets,
        uint256 snapShares
    ) external {
        _burn(pool, p, planId, assets, snapAssets, snapShares);
    }

    /// @notice Pull one epoch page's boosted spend from the strategy. Returns false (and emits) instead of
    ///         reverting when the strategy cannot pay — a fully utilised market must never block the epoch for
    ///         unboosted plans.
    function withdrawPage(Pool storage pool, address stock, uint32 epochId, uint256 amount) external returns (bool) {
        try pool.strategy.withdraw(amount, address(this), address(this)) returns (uint256) {
            return true;
        } catch (bytes memory reason) {
            emit IPlanVault.BoostWithdrawFailed(stock, epochId, amount, reason);
            return false;
        }
    }

    /// @notice Set (or migrate) the strategy. Its asset must be `usdg`. With boosted positions open the whole
    ///         position is redeemed from the old strategy and deposited into the new one here (internal shares
    ///         are untouched); clearing the strategy then reverts `BoostInUse`.
    function setStrategy(Pool storage pool, IERC20 usdg, address strategy) external {
        IERC4626 old = pool.strategy;
        if (strategy != address(0)) {
            address asset = IERC4626(strategy).asset();
            if (asset != address(usdg)) revert IPlanVault.BoostAssetMismatch(asset);
        }
        uint256 moved;
        if (address(old) != address(0)) {
            if (pool.totalShares > 0) {
                if (strategy == address(0)) revert IPlanVault.BoostInUse();
                uint256 held = old.balanceOf(address(this));
                if (held > 0) moved = old.redeem(held, address(this), address(this));
            }
            usdg.forceApprove(address(old), 0);
        }
        pool.strategy = IERC4626(strategy);
        if (strategy != address(0)) {
            usdg.forceApprove(strategy, type(uint256).max);
            if (moved > 0) IERC4626(strategy).deposit(moved, address(this));
        }
        emit IPlanVault.BoostStrategySet(strategy, moved);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _deposit(Pool storage pool, Plan storage p, uint256 planId, uint256 assets) private {
        IERC4626 s = pool.strategy;
        if (address(s) == address(0)) revert IPlanVault.BoostUnavailable();
        uint256 shares = Math.mulDiv(assets, pool.totalShares + 1, poolAssets(pool) + 1);
        s.deposit(assets, address(this));
        p.boostShares += shares.toUint128();
        p.boostPrincipal += assets.toUint128();
        pool.totalShares += shares;
        emit IPlanVault.BoostDeposited(planId, assets, shares);
    }

    /// @dev Pull up to `assets` of `planId`'s boosted balance back into the vault (type(uint256).max = all).
    ///      Returns the USDG that came back, still uncredited.
    function _withdraw(Pool storage pool, Plan storage p, uint256 planId, uint256 assets) private returns (uint256) {
        uint256 snapAssets = poolAssets(pool);
        uint256 snapShares = pool.totalShares;
        uint256 value = valueOf(p.boostShares, snapAssets, snapShares);
        if (assets > value) assets = value;
        if (assets > 0) pool.strategy.withdraw(assets, address(this), address(this));
        _burn(pool, p, planId, assets, snapAssets, snapShares);
        return assets;
    }

    /// @dev Burn the shares behind `assets` of the plan's boosted balance, priced at the given snapshot and
    ///      rounded up against the plan; reduce the cost basis pro rata and book the realised yield.
    function _burn(
        Pool storage pool,
        Plan storage p,
        uint256 planId,
        uint256 assets,
        uint256 snapAssets,
        uint256 snapShares
    ) private {
        uint256 held = p.boostShares;
        uint256 value = valueOf(held, snapAssets, snapShares);
        uint256 shares =
            assets >= value ? held : Math.mulDiv(assets, snapShares + 1, snapAssets + 1, Math.Rounding.Ceil);
        uint256 principalOut = Math.mulDiv(p.boostPrincipal, shares, held);
        p.boostShares = (held - shares).toUint128();
        p.boostPrincipal -= principalOut.toUint128();
        pool.totalShares -= shares;
        uint256 earned;
        if (assets > principalOut) {
            earned = assets - principalOut;
            p.boostEarned += earned.toUint128();
        }
        emit IPlanVault.BoostWithdrawn(planId, assets, shares, earned);
    }
}
