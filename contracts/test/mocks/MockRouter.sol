// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAggregatorRouter, Route} from "../../src/router/IAggregatorRouter.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev Deterministic router: amountOut = amountIn * num / den per pair. Mints tokenOut to the recipient.
contract MockRouter is IAggregatorRouter {
    using SafeERC20 for IERC20;

    struct Pair {
        bool exists;
        uint256 num;
        uint256 den;
        uint256 impactBps;
        uint16 fillBps; // fraction of amountIn actually consumed (10_000 = full)
    }

    address public immutable weth;
    uint16 public maxPriceImpactBps = 150;
    mapping(address => mapping(address => Pair)) public pairs;
    uint256 public swapCount;
    uint256 public lastAmountIn;
    uint256 public lastMinOut;
    Route[] public lastPath;
    bool public revertOnSwap;

    constructor(address weth_) {
        weth = weth_;
    }

    // ---- test knobs ----
    function setRate(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        Pair storage p = pairs[tokenIn][tokenOut];
        p.exists = true;
        p.num = num;
        p.den = den;
        if (p.fillBps == 0) p.fillBps = 10_000;
    }

    function setImpact(address tokenIn, address tokenOut, uint256 bps) external {
        pairs[tokenIn][tokenOut].impactBps = bps;
    }

    function setFill(address tokenIn, address tokenOut, uint16 bps) external {
        pairs[tokenIn][tokenOut].fillBps = bps;
    }

    function removePair(address tokenIn, address tokenOut) external {
        delete pairs[tokenIn][tokenOut];
    }

    function setRevertOnSwap(bool v) external {
        revertOnSwap = v;
    }

    function setMaxPriceImpactBps(uint16 bps) external {
        maxPriceImpactBps = bps;
    }

    function lastPathLength() external view returns (uint256) {
        return lastPath.length;
    }

    // ---- IAggregatorRouter ----
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, Route[] memory path)
    {
        (amountOut, path,) = quoteWithImpact(tokenIn, tokenOut, amountIn);
    }

    function quoteWithImpact(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, Route[] memory path, uint256 impactBps)
    {
        if (amountIn == 0) revert ZeroAmount();
        Pair storage p = pairs[tokenIn][tokenOut];
        if (!p.exists) revert NoRoute(tokenIn, tokenOut);
        amountOut = (amountIn * p.num) / p.den;
        path = new Route[](1);
        path[0] = Route({protocol: 1, tokenIn: tokenIn, tokenOut: tokenOut, fee: 3000, extra: ""});
        impactBps = p.impactBps;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        (, Route[] memory path) = quote(tokenIn, tokenOut, amountIn);
        return _swap(tokenIn, tokenOut, amountIn, minOut, recipient, path);
    }

    function swapWithRoute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        Route[] calldata path
    ) external returns (uint256 amountOut) {
        return _swap(tokenIn, tokenOut, amountIn, minOut, recipient, path);
    }

    function _swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        Route[] memory path
    ) internal returns (uint256 amountOut) {
        if (revertOnSwap) revert("MockRouter: forced revert");
        if (path.length == 0 || path[0].tokenIn != tokenIn || path[path.length - 1].tokenOut != tokenOut) {
            revert InvalidPath();
        }
        Pair storage p = pairs[tokenIn][tokenOut];
        if (!p.exists) revert NoRoute(tokenIn, tokenOut);
        uint256 used = (amountIn * p.fillBps) / 10_000;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), used);
        amountOut = (used * p.num) / p.den;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        MockERC20(tokenOut).mint(recipient, amountOut);
        swapCount++;
        lastAmountIn = amountIn;
        lastMinOut = minOut;
        delete lastPath;
        for (uint256 i; i < path.length; ++i) {
            lastPath.push(path[i]);
        }
        emit Swapped(msg.sender, tokenIn, tokenOut, used, amountOut);
    }
}
