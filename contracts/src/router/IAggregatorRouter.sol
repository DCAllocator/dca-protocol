// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One hop of a swap path. `extra` is adapter-specific (V3: abi.encode(pool); V4: abi.encode(PoolKey)).
struct Route {
    uint8 protocol; // 1 = UniV3, 2 = UniV4, 3 = RamsesV3
    address tokenIn;
    address tokenOut;
    uint24 fee; // v3 fee tier (informational for v4 — the PoolKey in `extra` is authoritative)
    bytes extra;
}

/// @title IAggregatorRouter
/// @notice The only swap entry point the vaults call. Considers ONLY owner-approved hops (direct, or one hop via
///         WETH), picks the highest output subject to a price-impact cap, and executes. Every hop of every
///         executed path must be approved — including keeper overrides.
interface IAggregatorRouter {
    error NoRoute(address tokenIn, address tokenOut);
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error InvalidPath();
    error AdapterNotSet(uint8 protocol);
    error ZeroAmount();
    error RouteNotApproved(bytes32 hopKey);
    /// @notice An explicit path's end-to-end price impact exceeds `maxPriceImpactBps` (M-02).
    error PriceImpactTooHigh(uint256 impactBps, uint16 maxBps);
    /// @notice A hop consumed less than its whole input: the router executes full fills only (M-02 / L-02).
    error PartialFill(uint256 hop);

    event AdapterSet(uint8 indexed protocol, address adapter);
    event MaxPriceImpactSet(uint16 bps);
    event HopApproved(bytes32 indexed hopKey, Route route);
    event HopRevoked(bytes32 indexed hopKey, Route route);
    event Swapped(
        address indexed caller, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );

    /// @notice Best quote for `amountIn` of `tokenIn` -> `tokenOut` over approved hops. Not a view: adapters
    ///         simulate swaps.
    /// @return amountOut Expected output.
    /// @return path      Route(s) to execute (1 or 2 hops).
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        returns (uint256 amountOut, Route[] memory path);

    /// @notice Same as `quote` plus the price impact (bps vs pool mid-price) of the chosen path.
    function quoteWithImpact(address tokenIn, address tokenOut, uint256 amountIn)
        external
        returns (uint256 amountOut, Route[] memory path, uint256 impactBps);

    /// @notice Quote then swap along the best path. Pulls `amountIn` from msg.sender (approval required).
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut);

    /// @notice Swap along an explicit path (from `quote`, or a trusted override). Every hop must be approved
    ///         and every hop must consume its whole input: a partial fill on any hop reverts `PartialFill`
    ///         (a partially filled pool is one whose in-range liquidity is exhausted, so the price is at its
    ///         limit anyway). Pulls `amountIn` from msg.sender.
    function swapWithRoute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        Route[] calldata path
    ) external returns (uint256 amountOut);

    /// @notice Simulated output of an explicit path of approved hops. Reverts if a hop is unapproved, cannot
    ///         fill in full, or if the path's end-to-end price impact (vs pool mid-prices) exceeds
    ///         `maxPriceImpactBps` — the same cap the automatic route selection applies.
    function quotePath(Route[] calldata path, uint256 amountIn) external returns (uint256 amountOut);

    function weth() external view returns (address);
    function maxPriceImpactBps() external view returns (uint16);
}
