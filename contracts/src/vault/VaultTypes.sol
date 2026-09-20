// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One DCA plan. Field order is chosen for storage packing (5 slots).
struct Plan {
    // slot 0
    address owner;
    uint96 amountPerEpoch; // USDG units per epoch (vault.usdgDecimals)
    // slot 1
    address recipient; // receives stock (auto-distribute and claim)
    uint32 lastEpochId; // last epoch this plan was filled in
    uint16 maxWethSlippageBps; // 0 = vault default
    bool paused; // paused plans skip spend but keep balances
    bool zapWethEachEpoch; // true: hold WETH until epoch; false: zap WETH -> USDG on deposit
    // slot 2
    address stock; // registry-approved Stock Token
    // slot 3
    uint128 usdgIdle; // USDG reserved for future epochs
    uint128 wethIdle; // WETH reserved for future epochs (only meaningful when zapWethEachEpoch)
    // slot 4
    uint128 stockAccrued; // unclaimed stock (claim path)
}

/// @notice Every fee / tolerance knob on a vault, in bps.
struct FeeConfig {
    uint16 purchaseFeeBps; // on spend, at epoch, before swap        [0, 90]
    uint16 depositFeeBps; // on deposit                                [0, 90], default 0
    uint16 withdrawFeeBps; // on idle withdrawals                      [0, 90], default 25
    uint16 claimFeeBps; // on claim path (0 for auto-distribute users) [0, 90], default 25
    uint16 keeperTipBps; // share of purchase fees paid to the caller of advanceEpoch [0, 5000], default 0
    uint16 swapSlippageBps; // minOut = quote * (1 - this)             [0, 500], default 50
    uint16 maxWethSlippageBps; // default WETH->USDG impact cap for zap-at-epoch plans [0, 1000], default 100
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
