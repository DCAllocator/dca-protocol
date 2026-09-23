// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// forge-lint: disable-start(unsafe-typecast)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3SwapCallback} from "../../src/interfaces/IUniswapV3.sol";

/// @dev Constant-price V3-style pool: output = mid(sqrtP) * (1 - fee) * (1 - impact), capped by `maxOut`.
///      Follows the real pool's ordering: pay output, invoke callback, verify input arrived.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint160 public sqrtPriceX96;
    uint256 public impactBps;
    uint256 public maxOut; // 0 = unlimited
    bool public broken;
    uint256 internal constant Q96 = 2 ** 96;

    constructor(address a, address b, uint24 fee_, uint160 sqrtP) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
        sqrtPriceX96 = sqrtP;
    }

    function setPrice(uint160 sqrtP) external {
        sqrtPriceX96 = sqrtP;
    }

    function setImpact(uint256 bps) external {
        impactBps = bps;
    }

    function setMaxOut(uint256 m) external {
        maxOut = m;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function liquidity() external pure returns (uint128) {
        return 1e18;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 0, 0, 0, true);
    }

    /// @dev Flat oracle at tick 0 (the pool never moves), so a TWAP-vs-spot guard always passes here.
    function observe(uint32[] calldata secondsAgos)
        external
        pure
        returns (int56[] memory tickCumulatives, uint160[] memory liq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        liq = new uint160[](secondsAgos.length);
    }

    function midOut(bool zeroForOne, uint256 amountIn) public view returns (uint256) {
        if (zeroForOne) return Math.mulDiv(Math.mulDiv(amountIn, sqrtPriceX96, Q96), sqrtPriceX96, Q96);
        return Math.mulDiv(Math.mulDiv(amountIn, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(!broken, "POOL_BROKEN");
        require(amountSpecified > 0, "exact in only");
        uint256 amountIn = uint256(amountSpecified);
        uint256 out = (midOut(zeroForOne, amountIn) * (1_000_000 - fee)) / 1_000_000;
        out = (out * (10_000 - impactBps)) / 10_000;
        if (maxOut != 0 && out > maxOut) {
            amountIn = (amountIn * maxOut) / out;
            out = maxOut;
        }
        (address tIn, address tOut) = zeroForOne ? (token0, token1) : (token1, token0);
        if (out > 0) require(IERC20(tOut).transfer(recipient, out));
        uint256 balBefore = IERC20(tIn).balanceOf(address(this));
        (amount0, amount1) = zeroForOne ? (int256(amountIn), -int256(out)) : (-int256(out), int256(amountIn));
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(tIn).balanceOf(address(this)) >= balBefore + amountIn, "IIA");
    }
}

contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function createPool(address a, address b, uint24 fee, uint160 sqrtP) external returns (address pool) {
        pool = address(new MockV3Pool(a, b, fee, sqrtP));
        getPool[a][b][fee] = pool;
        getPool[b][a][fee] = pool;
    }

    /// @dev Register a pool the factory did not create (models a "fake" pool for callback-auth tests).
    function forceRegister(address a, address b, uint24 fee, address pool) external {
        getPool[a][b][fee] = pool;
        getPool[b][a][fee] = pool;
    }
}

/// @dev Contract that pretends to be a pool and asks the adapter to pay it.
contract EvilPool {
    address public token0;
    address public token1;
    uint24 public fee = 3000;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (2 ** 96, 0, 0, 0, 0, 0, true);
    }

    /// @dev Greedy: demands far more input than specified and pays 1 wei of output.
    function swap(address, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256, int256)
    {
        int256 greedy = amountSpecified * 1_000_000;
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(greedy, -1, data);
        return (greedy, -1);
    }

    /// @dev Direct attack: call the callback with forged data referencing a real pool.
    function attack(address adapter, bytes calldata data) external {
        IUniswapV3SwapCallback(adapter).uniswapV3SwapCallback(1e18, -1, data);
    }
}
