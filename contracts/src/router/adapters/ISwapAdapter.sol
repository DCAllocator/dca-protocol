// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Route} from "../IAggregatorRouter.sol";

/// @title ISwapAdapter
/// @notice One DEX protocol behind the AggregatorRouter. Adapters never discover pools: the router holds the
///         owner-approved hop list and asks the adapter to validate, quote and execute a specific hop.
///         Adapters hold tokens only transiently inside a swap.
interface ISwapAdapter {
    /// @notice Protocol id used in `Route.protocol`.
    function protocolId() external view returns (uint8);

    /// @notice True if `route` describes a pool this adapter can trade (verified pool / registered key, and the
    ///         pool's tokens match `route.tokenIn` / `route.tokenOut`). Used by the router at approval time.
    function validateRoute(Route calldata route) external view returns (bool);

    /// @notice Simulated exact-input quote for one hop. Returns (0, 0) if the hop cannot fill.
    /// @return amountOut Simulated output.
    /// @return midOut    Output at the pool's current mid-price with zero impact (fee excluded). Impact reference.
    function quoteRoute(Route calldata route, uint256 amountIn) external returns (uint256 amountOut, uint256 midOut);

    /// @notice Execute a hop. `amountIn` of `route.tokenIn` must already sit in this adapter.
    /// @dev Only the router may call. Output is sent to `recipient`; any unspent input is refunded to `refundTo`.
    function swap(Route calldata route, uint256 amountIn, address recipient, address refundTo)
        external
        returns (uint256 amountOut, uint256 amountInUsed);
}
