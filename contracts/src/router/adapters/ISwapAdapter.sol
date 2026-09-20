// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Route} from "../IAggregatorRouter.sol";

/// @title ISwapAdapter
/// @notice One DEX protocol behind the AggregatorRouter. Adapters hold tokens only transiently inside a swap.
interface ISwapAdapter {
    /// @notice Protocol id used in `Route.protocol`.
    function protocolId() external view returns (uint8);

    /// @notice False when the adapter has no factory / pool manager configured. The router skips disabled adapters.
    function enabled() external view returns (bool);

    /// @notice Best single-pool quote on this protocol. Returns amountOut == 0 if no pool can fill.
    /// @return amountOut Simulated output.
    /// @return midOut    Output at the pool's current mid-price with zero impact (fee excluded). Impact reference.
    /// @return route     Hop descriptor to pass to `swap`.
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        returns (uint256 amountOut, uint256 midOut, Route memory route);

    /// @notice Execute a hop. `amountIn` of `route.tokenIn` must already sit in this adapter.
    /// @dev Only the router may call. Output is sent to `recipient`; any unspent input is refunded to `refundTo`.
    function swap(Route calldata route, uint256 amountIn, address recipient, address refundTo)
        external
        returns (uint256 amountOut, uint256 amountInUsed);
}
