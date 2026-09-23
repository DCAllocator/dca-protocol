// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IPlanVault} from "../interfaces/IPlanVault.sol";
import {Plan} from "../vault/VaultTypes.sol";
import {BoostLib} from "./BoostLib.sol";
import {FeeMath} from "./FeeMath.sol";

/// @title PlanExitLib
/// @notice The ways value and a plan leave a vault: `withdrawIdle`, `claim` / `claimAll`, `prunePlan` and the
///         one-transaction `closePlan`. Linked as an EXTERNAL library and delegatecalled on the vault's own
///         storage (`Plan` and the index / aggregate mappings are storage pointers), the same pattern as
///         BoostLib and VaultAdminLib, so that PlanVault stays under the EIP-170 size limit. Events and errors are
///         the vault's (IPlanVault); `msg.sender` is the vault's caller (delegatecall preserves it), which is who
///         idle USDG is paid to.
///
/// @dev Every state-changing entry point here is reached ONLY through a `nonReentrant` vault function
///      (`withdrawIdle`, `claim`, `claimAll`, `prunePlan`, `closePlan`): the deltas this library returns for the
///      vault's value-type aggregates (`totalUsdgIdle`) are applied by the vault after the call, which is only
///      sound while nothing can re-enter in between. A direct CALL to the library address reverts (Solidity's
///      library call protection), so there is no unguarded path to these functions.
///
///      `close` composes the legs the frontend's "Withdraw & remove" sequence used to send one by one: pay out
///      every idle USDG (withdraw fee), claim every accrued stock (claim fee unless the owner holds the
///      auto-distribute perk), then drop the plan from epoch iteration. The vault unboosts FIRST (the
///      `BoostLib.setPlanBoost` leg stays in the vault stub, next to `setPlanBoost` itself), which is why `close`
///      refuses a plan that still holds boost shares instead of unindexing value; the only BoostLib call made from
///      here is the partial-withdraw path of `withdrawIdle`. While an epoch page is pending for the plan's stock the
///      swap-and-pop unindex would move a plan across the page cursor, so a plan that is still in the list is
///      paused and left indexed instead (`PlanClosed(..., unindexed = false)`); a later `prunePlan` (or a second
///      `closePlan`) drops it once the epoch is over. A plan that is already out of the list is never parked.
///      Nothing here is permanent: a later deposit re-indexes the record exactly as after a prune.
library PlanExitLib {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ------------------------------------------------------------------
    // Withdraw
    // ------------------------------------------------------------------

    /// @notice `withdrawIdle` body: `usdgIdle` first, then (boosted plans) the strategy, minus the withdraw fee,
    ///         paid to `msg.sender` (`type(uint256).max` = all). Returns the part that came out of `usdgIdle` so the
    ///         vault can debit `totalUsdgIdle`.
    function withdrawIdle(
        BoostLib.Pool storage pool,
        Plan storage p,
        uint256 planId,
        uint256 amount,
        IERC20 usdg,
        address feeRecipient,
        uint16 feeBps
    ) external returns (uint256 fromIdle) {
        // the boost library does the checks (ZeroAmount / InsufficientIdle) and debits the plan
        (amount, fromIdle) = BoostLib.withdrawIdle(pool, p, planId, amount);
        _payIdle(planId, amount, usdg, feeRecipient, feeBps);
    }

    // ------------------------------------------------------------------
    // Claim
    // ------------------------------------------------------------------

    /// @notice `claim` body: `amount` of accrued stock (`type(uint256).max` = all) to the plan's recipient, minus
    ///         `feeBps` (0 for a perk holder — the vault decides, it owns the $DCA thresholds).
    function claim(
        Plan storage p,
        uint256 planId,
        uint256 amount,
        mapping(address => uint256) storage totalStockAccrued,
        mapping(address => mapping(address => uint256)) storage userStockAccrued,
        address feeRecipient,
        uint16 feeBps
    ) external {
        uint256 accrued = p.stockAccrued;
        if (amount == type(uint256).max) amount = accrued;
        if (amount == 0) revert IPlanVault.ZeroAmount();
        if (amount > accrued) revert IPlanVault.InsufficientAccrued(amount, accrued);
        _claim(p, planId, amount, totalStockAccrued, userStockAccrued, feeRecipient, feeBps);
    }

    // ------------------------------------------------------------------
    // Prune / close
    // ------------------------------------------------------------------

    /// @notice `prunePlan` body: drop an EMPTY plan from epoch iteration (permissionless; idempotent). Reverts
    ///         `PlanNotEmpty` while the plan holds idle USDG, accrued stock or boost shares, and `EpochInProgress`
    ///         while a page cursor is open for its stock (the swap-and-pop would move a plan across it).
    function prune(
        Plan storage p,
        uint256 planId,
        bool epochPending,
        mapping(address => uint256[]) storage stockPlans,
        mapping(uint256 => uint256) storage stockPlanIndex
    ) external {
        if (p.owner == address(0)) {
            revert IPlanVault.PlanNotFound(planId);
        }
        if (p.usdgIdle > 0 || p.stockAccrued > 0 || p.boostShares > 0) revert IPlanVault.PlanNotEmpty(planId);
        if (epochPending) revert IPlanVault.EpochInProgress(p.stock);
        _unindex(planId, p.stock, stockPlans, stockPlanIndex);
    }

    /// @notice `closePlan` body, after the vault unboosted the plan: pay out all idle USDG (withdraw fee, to
    ///         `msg.sender`), claim all accrued stock (claim fee unless `claimFeeBps == 0`, to the recipient), then
    ///         unindex — or, while an epoch page is pending for the stock AND the plan is still indexed, pause the
    ///         plan and leave it indexed so `prunePlan` can finish the job after the epoch. Every leg is gated on a
    ///         non-zero balance, so an empty or already pruned plan closes without reverting (and is never parked).
    ///         Returns the idle USDG that left the vault (gross, fee included) so the vault can debit
    ///         `totalUsdgIdle`.
    /// @dev Reverts `PlanNotEmpty` if boost shares are still attached: unindexing a plan that holds value would
    ///      break "non-empty plans are always indexed", and only the vault's unboost leg may burn shares.
    function close(
        Plan storage p,
        uint256 planId,
        mapping(address => uint256) storage totalStockAccrued,
        mapping(address => mapping(address => uint256)) storage userStockAccrued,
        mapping(address => uint256[]) storage stockPlans,
        mapping(uint256 => uint256) storage stockPlanIndex,
        IERC20 usdg,
        address feeRecipient,
        uint16 withdrawFeeBps,
        uint16 claimFeeBps,
        bool epochPending
    ) external returns (uint256 usdgOut) {
        if (p.boostShares != 0) revert IPlanVault.PlanNotEmpty(planId);

        usdgOut = p.usdgIdle;
        if (usdgOut > 0) {
            p.usdgIdle = 0;
            _payIdle(planId, usdgOut, usdg, feeRecipient, withdrawFeeBps);
        }

        uint256 stockOut = p.stockAccrued;
        if (stockOut > 0) {
            _claim(p, planId, stockOut, totalStockAccrued, userStockAccrued, feeRecipient, claimFeeBps);
        }

        // The deferral exists only to keep the swap-and-pop away from an open page cursor, so it applies only
        // while the plan is actually in its stock's list: a plan that is already out of it (closed or pruned
        // earlier) has nothing to protect and must not be parked (review CP-01) — `_unindex` is then a no-op and
        // the close reports `unindexed = true`, exactly like the non-pending idempotent case.
        bool unindexed;
        if (!epochPending || stockPlanIndex[planId] == 0) {
            _unindex(planId, p.stock, stockPlans, stockPlanIndex);
            unindexed = true;
        } else if (!p.paused) {
            // deferred unindex: an empty, paused plan costs the page one storage read and is never filled
            p.paused = true;
            emit IPlanVault.PlanPausedSet(planId, true);
        }
        emit IPlanVault.PlanClosed(planId, p.owner, usdgOut, stockOut, unindexed);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev `amount` of USDG is already debited from the plan and sits in the vault: split the withdraw fee off
    ///      and pay the rest to the caller.
    function _payIdle(uint256 planId, uint256 amount, IERC20 usdg, address feeRecipient, uint16 feeBps) private {
        (uint256 net, uint256 fee) = FeeMath.split(amount, feeBps);
        if (fee > 0) usdg.safeTransfer(feeRecipient, fee);
        usdg.safeTransfer(msg.sender, net);
        emit IPlanVault.IdleWithdrawn(planId, amount, fee);
    }

    /// @dev Debit `amount` (already validated, > 0, <= accrued) from the plan and the per-stock / per-user
    ///      aggregates, then pay recipient and treasury. Effects before interactions. The recipient is read ONCE,
    ///      before the transfers: `setPlanRecipient` is owner-gated but not `nonReentrant`, so an owner contract
    ///      could change it from a transfer hook of the stock — the event must name who was actually paid
    ///      (review CP-02). `p.owner` needs no such care: it is set in `createPlan` and never reassigned.
    function _claim(
        Plan storage p,
        uint256 planId,
        uint256 amount,
        mapping(address => uint256) storage totalStockAccrued,
        mapping(address => mapping(address => uint256)) storage userStockAccrued,
        address feeRecipient,
        uint16 feeBps
    ) private {
        (uint256 net, uint256 fee) = FeeMath.split(amount, feeBps);

        address stock = p.stock;
        address to = p.recipient;
        p.stockAccrued -= amount.toUint128();
        totalStockAccrued[stock] -= amount;
        userStockAccrued[p.owner][stock] -= amount;

        if (fee > 0) IERC20(stock).safeTransfer(feeRecipient, fee);
        IERC20(stock).safeTransfer(to, net);
        emit IPlanVault.Claimed(planId, stock, to, amount, fee);
    }

    /// @dev Swap-and-pop the plan out of its stock's iteration list. No-op when it is not indexed.
    function _unindex(
        uint256 planId,
        address stock,
        mapping(address => uint256[]) storage stockPlans,
        mapping(uint256 => uint256) storage stockPlanIndex
    ) private {
        uint256 idx = stockPlanIndex[planId];
        if (idx == 0) return;
        uint256[] storage arr = stockPlans[stock];
        uint256 last = arr[arr.length - 1];
        arr[idx - 1] = last;
        stockPlanIndex[last] = idx;
        arr.pop();
        stockPlanIndex[planId] = 0;
        emit IPlanVault.PlanIndexed(planId, stock, false);
    }
}
