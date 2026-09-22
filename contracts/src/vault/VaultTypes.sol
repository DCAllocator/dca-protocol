// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One DCA plan. Field order is chosen for storage packing: 4 slots for a plain plan, 6 for a boosted
///         one (slots 4-5 are only ever written for boosted plans). Vaults hold USDG only: ETH/WETH deposits are
///         converted to USDG at deposit time (see PlanVault), never held.
struct Plan {
    // slot 0
    address owner;
    uint96 amountPerEpoch; // USDG units per epoch (vault.usdgDecimals), >= vault.minAmountPerEpoch
    // slot 1
    address recipient; // receives stock (auto-distribute and claim)
    uint32 lastEpochId; // last epoch this plan was filled in
    bool paused; // paused plans skip spend but keep balances
    bool boosted; // idle USDG is parked in the vault's boostStrategy (Morpho Blue) instead of sitting in usdgIdle
    bool claimFeeFree; // owner held the auto-distribute $DCA tier at the last fill: claims of the accrued stock are fee-free
    // slot 2
    address stock; // registry-approved Stock Token
    // slot 3
    uint128 usdgIdle; // USDG reserved for future epochs, held by the vault (0 for a boosted plan, bar residuals)
    uint128 stockAccrued; // unclaimed stock (claim path)
    // slot 4 — boosted plans only
    uint128 boostShares; // this plan's share of the vault's boost pool (see PlanVault.boostValueOf)
    uint128 boostPrincipal; // USDG cost basis of boostShares; value above it is unrealised yield
    // slot 5 — boosted plans only
    uint128 boostEarned; // yield realised so far (USDG), booked whenever boosted funds are spent or withdrawn
}

/// @notice Rounding / reconciliation remainders held by a vault until swept to `feeRecipient` (one struct so the
///         linked VaultAdminLib can take a storage pointer to both).
struct DustState {
    uint256 usdg; // unspent purchase notional that could not be split exactly, plus skimmed USDG
    uint256 weth; // WETH that reached the vault outside a deposit (never expected; swept whenever non-zero)
}

/// @notice Every fee / tolerance knob on a vault, in bps.
struct FeeConfig {
    uint16 purchaseFeeBps; // on spend, at epoch, before swap        [0, 90]
    uint16 depositFeeBps; // on deposit                                [0, 90], default 0
    uint16 withdrawFeeBps; // on idle withdrawals                      [0, 90], default 25
    uint16 claimFeeBps; // on claim path (0 for auto-distribute users) [0, 90], default 25
    uint16 keeperTipBps; // share of purchase fees paid to the caller of advanceEpoch [0, 5000], default 0
    uint16 swapSlippageBps; // minOut = quote * (1 - this)             [0, 500], default 50
}

/// @notice Constructor parameters for a vault deployment.
struct VaultParams {
    address owner;
    address usdg;
    address weth;
    address dca; // may be address(0): perks disabled
    address registry;
    address router;
    address feeRecipient;
    uint32 epochLength;
    uint64 origin; // aligned start of epoch 0; must satisfy origin <= now < origin + epochLength
    uint16 purchaseFeeBps;
}
