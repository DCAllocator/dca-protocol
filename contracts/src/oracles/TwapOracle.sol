// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV3Pool} from "../interfaces/IUniswapV3.sol";

/// @title TwapOracle
/// @notice Optional helper: arithmetic-mean tick of a V3-style pool over a window. Keepers use it off-chain
///         (price = 1.0001^tick, adjusted for decimals) to sanity-check `quote` before submitting a route
///         override with a tight `minOut`. Nothing in the vault depends on it in V1.
/// @dev Tick -> sqrtPrice conversion (TickMath) is GPL-licensed upstream and intentionally not vendored here;
///      the conversion is done in the keeper script.
library TwapOracle {
    error WindowTooShort();

    /// @notice Time-weighted mean tick over the last `secondsAgo` seconds.
    function consultTick(address pool, uint32 secondsAgo) internal view returns (int24 meanTick) {
        if (secondsAgo == 0) revert WindowTooShort();
        uint32[] memory ago = new uint32[](2);
        ago[0] = secondsAgo;
        ago[1] = 0;
        (int56[] memory cumulative,) = IUniswapV3Pool(pool).observe(ago);
        int56 delta = cumulative[1] - cumulative[0];
        // A tick delta divided by the window is always inside the int24 tick range (pools enforce it).
        // forge-lint: disable-next-line(unsafe-typecast)
        meanTick = int24(delta / int56(uint56(secondsAgo)));
        // Round toward negative infinity like Uniswap's OracleLibrary.
        if (delta < 0 && (delta % int56(uint56(secondsAgo)) != 0)) meanTick--;
    }
}
