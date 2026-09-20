// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniV3Adapter} from "./UniV3Adapter.sol";

/// @title RamsesV3Adapter
/// @notice Ramses V3 (concentrated liquidity) shares the Uniswap V3 factory / pool / callback ABI:
///         `factory.getPool(tokenA, tokenB, fee)`, `pool.swap(...)` and `uniswapV3SwapCallback`.
///         Protocol id 3. If the Robinhood Chain deployment diverges (e.g. tick-spacing keyed factory),
///         deploy with factory = address(0) and register pools explicitly via `registerPool`.
contract RamsesV3Adapter is UniV3Adapter {
    constructor(address router_, address factory_, uint24[] memory feeTiers_, address owner_)
        UniV3Adapter(3, router_, factory_, feeTiers_, owner_)
    {}
}
