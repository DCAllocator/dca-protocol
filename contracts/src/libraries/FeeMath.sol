// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FeeMath
/// @notice Basis-point fee arithmetic shared by every DCA contract. 1 bps = 0.01%. No floating point, ever.
/// @dev All fee computations round DOWN in favour of the user. Halving floors (75 bps -> 37 bps).
library FeeMath {
    /// @notice Denominator for basis points.
    uint256 internal constant BPS = 10_000;

    /// @notice Hard cap on every protocol fee (0.90%). Owner cannot exceed it.
    uint16 internal constant MAX_FEE_BPS = 90;

    /// @notice Thrown when an owner tries to set a fee above MAX_FEE_BPS.
    error FeeTooHigh(uint16 bps, uint16 max);

    /// @notice Revert if `bps` is outside the inclusive [0, MAX_FEE_BPS] range.
    function validate(uint16 bps) internal pure {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh(bps, MAX_FEE_BPS);
    }

    /// @notice Fee owed on `amount` at `bps`, rounded down.
    function feeOf(uint256 amount, uint16 bps) internal pure returns (uint256) {
        // amount <= 2^128 and bps <= 2^16 in practice; explicit overflow check kept for fuzzing safety.
        return (amount * bps) / BPS;
    }

    /// @notice Split `amount` into (net, fee) at `bps`. net + fee == amount always.
    function split(uint256 amount, uint16 bps) internal pure returns (uint256 net, uint256 fee) {
        fee = feeOf(amount, bps);
        net = amount - fee;
    }

    /// @notice Halve a fee for $DCA perk holders. Floors odd values (25 -> 12).
    function halve(uint16 bps) internal pure returns (uint16) {
        return bps / 2;
    }

    /// @notice `amount * (BPS - slippageBps) / BPS`, rounded down. Used to turn a quote into a minOut.
    function applySlippage(uint256 amount, uint16 slippageBps) internal pure returns (uint256) {
        if (slippageBps >= BPS) return 0;
        return (amount * (BPS - slippageBps)) / BPS;
    }

    /// @notice Price impact in bps of `actualOut` versus the zero-impact `midOut`. 0 if actual >= mid.
    function impactBps(uint256 actualOut, uint256 midOut) internal pure returns (uint256) {
        if (midOut == 0) return BPS; // no reference price: treat as maximal impact
        if (actualOut >= midOut) return 0;
        return ((midOut - actualOut) * BPS) / midOut;
    }
}
