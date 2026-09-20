// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IAggregatorRouter, Route} from "../src/router/IAggregatorRouter.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";

/// @title Quote
/// @notice Keeper helper: prints the best route, price impact, and a ready-to-use `routeOverride` blob for
///         `advanceEpoch(stock, limit, routeOverride)`. Quotes are simulations (state-changing calls), so run
///         WITHOUT --broadcast:
///
///   forge script script/Quote.s.sol --rpc-url $RH_RPC \
///     --sig "run(address,address,address,uint256,uint16)" $ROUTER $USDG $STOCK 1000000000 50
contract Quote is Script {
    function run(address router, address tokenIn, address tokenOut, uint256 amountIn, uint16 slippageBps) external {
        (uint256 out, Route[] memory path, uint256 impact) =
            IAggregatorRouter(router).quoteWithImpact(tokenIn, tokenOut, amountIn);
        console2.log("amountIn      ", amountIn);
        console2.log("amountOut     ", out);
        console2.log("impactBps     ", impact);
        console2.log("hops          ", path.length);
        for (uint256 i; i < path.length; ++i) {
            console2.log("  hop", i);
            console2.log("    protocol  ", uint256(path[i].protocol));
            console2.log("    tokenIn   ", path[i].tokenIn);
            console2.log("    tokenOut  ", path[i].tokenOut);
            console2.log("    fee       ", uint256(path[i].fee));
            console2.log("    extra     ");
            console2.logBytes(path[i].extra);
        }
        uint256 minOut = FeeMath.applySlippage(out, slippageBps);
        console2.log("minOut        ", minOut);
        console2.log("routeOverride (abi.encode(Route[], minOut)):");
        console2.logBytes(abi.encode(path, minOut));
    }
}
