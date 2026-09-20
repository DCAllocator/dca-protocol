// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// forge-lint: disable-start(unsafe-typecast)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3SwapCallback} from "../../../src/interfaces/IUniswapV3.sol";

/// @dev AUDIT MOCK. Constant-product (x*y=k) pool exposing the Uniswap-V3 surface the adapters use.
///      Unlike test/mocks/MockV3.sol (constant price), the price MOVES with trades, so sandwiching and
///      size-dependent impact can be demonstrated faithfully. slot0.sqrtPriceX96 is derived from reserves.
///      Follows the real pool ordering: pay output, invoke callback, verify input arrived.
contract CPMMPool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee; // hundredths of a bip, like V3 (500 = 0.05%)
    uint256 internal constant Q192 = 2 ** 192;

    constructor(address a, address b, uint24 fee_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
    }

    function reserves() public view returns (uint256 r0, uint256 r1) {
        r0 = IERC20(token0).balanceOf(address(this));
        r1 = IERC20(token1).balanceOf(address(this));
    }

    function liquidity() external pure returns (uint128) {
        return 1e18;
    }

    /// @dev sqrt(reserve1 / reserve0) * 2^96 — the marginal (mid) price, exactly what the adapter reads.
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        (uint256 r0, uint256 r1) = reserves();
        uint160 sqrtP = uint160(Math.sqrt(Math.mulDiv(r1, Q192, r0)));
        return (sqrtP, 0, 0, 0, 0, 0, true);
    }

    /// @notice Output for an exact-input trade at the current reserves (view helper for tests).
    function getAmountOut(bool zeroForOne, uint256 amountIn) public view returns (uint256) {
        (uint256 r0, uint256 r1) = reserves();
        (uint256 rIn, uint256 rOut) = zeroForOne ? (r0, r1) : (r1, r0);
        uint256 inNet = (amountIn * (1_000_000 - fee)) / 1_000_000;
        return (rOut * inNet) / (rIn + inNet);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(amountSpecified > 0, "exact in only");
        uint256 amountIn = uint256(amountSpecified);
        uint256 out = getAmountOut(zeroForOne, amountIn);
        (address tIn, address tOut) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 balBefore = IERC20(tIn).balanceOf(address(this));
        if (out > 0) require(IERC20(tOut).transfer(recipient, out));
        (amount0, amount1) = zeroForOne ? (int256(amountIn), -int256(out)) : (-int256(out), int256(amountIn));
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(tIn).balanceOf(address(this)) >= balBefore + amountIn, "IIA");
    }
}

/// @dev Minimal EOA-style trader used by the attacker: pays the pool in the callback from its own balance.
contract Trader is IUniswapV3SwapCallback {
    function trade(CPMMPool pool, bool zeroForOne, uint256 amountIn) external returns (uint256 out) {
        address tIn = zeroForOne ? pool.token0() : pool.token1();
        address tOut = zeroForOne ? pool.token1() : pool.token0();
        uint256 before = IERC20(tOut).balanceOf(address(this));
        pool.swap(address(this), zeroForOne, int256(amountIn), 0, abi.encode(tIn));
        out = IERC20(tOut).balanceOf(address(this)) - before;
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        address tIn = abi.decode(data, (address));
        int256 owed = a0 > 0 ? a0 : a1;
        require(IERC20(tIn).transfer(msg.sender, uint256(owed)));
    }
}
