// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap V4 PoolManager surface. `Currency`, `BalanceDelta`, `PoolId` are user-defined
///         value types upstream; they ABI-encode as their underlying primitives, which is what we use here.
struct PoolKey {
    address currency0; // Currency
    address currency1; // Currency
    uint24 fee;
    int24 tickSpacing;
    address hooks; // IHooks
}

struct V4SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact input
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    /// @return delta BalanceDelta packed int256: upper 128 bits amount0, lower 128 bits amount1.
    function swap(PoolKey memory key, V4SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32 value);
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
