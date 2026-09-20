// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AggregatorRouter} from "../src/router/AggregatorRouter.sol";
import {Route} from "../src/router/IAggregatorRouter.sol";
import {IUniswapV3Pool} from "../src/interfaces/IUniswapV3.sol";
import {PoolKey} from "../src/interfaces/IUniswapV4.sol";

/// @title ApproveRoutes
/// @notice Owner helper: approve router hops after deployment (the router only ever trades approved hops).
///
///   # V3-style pool (Uniswap V3 = protocol 1, Ramses V3 = 3): approves tokenIn->tokenOut only
///   forge script script/ApproveRoutes.s.sol --sig "v3(address,uint8,address,address,address)" \
///       $ROUTER 1 $POOL $USDG $SPY --rpc-url $RH_RPC --broadcast
///
///   # Uniswap V4 pool by key (protocol 2); register it on the UniV4Adapter first (`addPool`)
///   forge script script/ApproveRoutes.s.sol --sig "v4(address,address,address,uint24,int24,address,address,address)" \
///       $ROUTER $CURRENCY0 $CURRENCY1 $FEE $TICK_SPACING $HOOKS $TOKEN_IN $TOKEN_OUT --rpc-url $RH_RPC --broadcast
contract ApproveRoutes is Script {
    function v3(address router, uint8 protocol, address pool, address tokenIn, address tokenOut) external {
        uint24 fee = IUniswapV3Pool(pool).fee();
        Route memory r =
            Route({protocol: protocol, tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, extra: abi.encode(pool)});
        vm.startBroadcast();
        AggregatorRouter(router).approveHop(r);
        vm.stopBroadcast();
        console2.log("approved hop", uint256(AggregatorRouter(router).hopKey(r)));
    }

    function v4(
        address router,
        address currency0,
        address currency1,
        uint24 fee,
        int24 tickSpacing,
        address hooks,
        address tokenIn,
        address tokenOut
    ) external {
        PoolKey memory key = PoolKey({
            currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: hooks
        });
        Route memory r = Route({protocol: 2, tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, extra: abi.encode(key)});
        vm.startBroadcast();
        AggregatorRouter(router).approveHop(r);
        vm.stopBroadcast();
        console2.log("approved hop", uint256(AggregatorRouter(router).hopKey(r)));
    }
}
