// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ISwapAdapter} from "./ISwapAdapter.sol";
import {Route} from "../IAggregatorRouter.sol";
import {IPoolManager, IUnlockCallback, PoolKey, V4SwapParams} from "../../interfaces/IUniswapV4.sol";

/// @title UniV4Adapter
/// @notice Uniswap V4 adapter talking to the PoolManager directly through the unlock/callback pattern
///         (no Universal Router, no Permit2). Pools are registered explicitly by the owner because V4 has
///         no on-chain factory enumeration. With `poolManager == address(0)` the adapter is disabled and the
///         router skips it.
///
/// @dev Only ERC-20 / ERC-20 pools are supported (currency0 != address(0)); native-ETH pools are rejected
///      at registration. Quotes use the same unlock -> swap -> sentinel-revert technique as the V3 adapter.
contract UniV4Adapter is ISwapAdapter, IUnlockCallback, Ownable2Step {
    using SafeERC20 for IERC20;

    uint8 public constant PROTOCOL_ID = 2;
    address public immutable router;
    IPoolManager public immutable poolManager;

    /// @dev Storage slot of `mapping(PoolId => Pool.State) _pools` in PoolManager (StateLibrary.POOLS_SLOT).
    bytes32 public poolsSlot = bytes32(uint256(6));

    mapping(bytes32 => PoolKey[]) private _pools; // pairKey => keys
    mapping(bytes32 => bool) public knownPool; // poolId => registered
    uint256 public poolCount;

    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant Q96 = 2 ** 96;
    bytes32 internal constant QUOTE_SENTINEL = keccak256("DCA_V4_QUOTE");

    uint8 internal constant MODE_SIMULATE = 0;
    uint8 internal constant MODE_EXECUTE = 1;

    struct CallbackData {
        uint8 mode;
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        address recipient;
    }

    error OnlyRouter();
    error OnlyPoolManager();
    error UnknownPool(bytes32 poolId);
    error InvalidPoolKey();
    error PoolTokenMismatch();

    event PoolAdded(bytes32 indexed poolId, PoolKey key);
    event PoolRemoved(bytes32 indexed poolId);
    event PoolsSlotSet(bytes32 slot);

    constructor(address router_, address poolManager_, address owner_) Ownable(owner_) {
        router = router_;
        poolManager = IPoolManager(poolManager_);
    }

    modifier onlyRouter() {
        if (msg.sender != router) revert OnlyRouter();
        _;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice Register a V4 pool by its key. Only ERC-20 pairs; currency0 must sort below currency1.
    function addPool(PoolKey calldata key) external onlyOwner {
        if (key.currency0 == address(0) || key.currency1 == address(0) || key.currency0 >= key.currency1) {
            revert InvalidPoolKey();
        }
        bytes32 id = poolId(key);
        if (knownPool[id]) return;
        knownPool[id] = true;
        _pools[_pairKey(key.currency0, key.currency1)].push(key);
        poolCount += 1;
        emit PoolAdded(id, key);
    }

    /// @notice Unregister a pool.
    function removePool(PoolKey calldata key) external onlyOwner {
        bytes32 id = poolId(key);
        if (!knownPool[id]) return;
        knownPool[id] = false;
        PoolKey[] storage arr = _pools[_pairKey(key.currency0, key.currency1)];
        for (uint256 i; i < arr.length; ++i) {
            if (poolId(arr[i]) == id) {
                arr[i] = arr[arr.length - 1];
                arr.pop();
                break;
            }
        }
        poolCount -= 1;
        emit PoolRemoved(id);
    }

    /// @notice Override the PoolManager `_pools` storage slot if a deployment differs from v4-core.
    function setPoolsSlot(bytes32 slot) external onlyOwner {
        poolsSlot = slot;
        emit PoolsSlotSet(slot);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @inheritdoc ISwapAdapter
    function protocolId() external pure returns (uint8) {
        return PROTOCOL_ID;
    }

    /// @inheritdoc ISwapAdapter
    function enabled() public view returns (bool) {
        return address(poolManager) != address(0) && poolCount > 0;
    }

    function pools(address tokenA, address tokenB) external view returns (PoolKey[] memory) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return _pools[_pairKey(t0, t1)];
    }

    /// @notice keccak256(abi.encode(key)), identical to v4-core PoolIdLibrary.toId.
    function poolId(PoolKey memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    // ------------------------------------------------------------------
    // ISwapAdapter
    // ------------------------------------------------------------------

    /// @inheritdoc ISwapAdapter
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        returns (uint256 amountOut, uint256 midOut, Route memory route)
    {
        if (!enabled() || amountIn == 0 || tokenIn == tokenOut) return (0, 0, route);
        (address t0, address t1) = tokenIn < tokenOut ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        PoolKey[] storage keys = _pools[_pairKey(t0, t1)];
        bool zeroForOne = tokenIn < tokenOut;
        uint256 bestIdx = type(uint256).max;
        for (uint256 i; i < keys.length; ++i) {
            uint256 out = _simulate(keys[i], zeroForOne, amountIn);
            if (out > amountOut) {
                amountOut = out;
                bestIdx = i;
            }
        }
        if (bestIdx == type(uint256).max) return (0, 0, route);
        PoolKey memory best = keys[bestIdx];
        midOut = _midOut(best, zeroForOne, amountIn);
        route = Route({
            protocol: PROTOCOL_ID, tokenIn: tokenIn, tokenOut: tokenOut, fee: best.fee, extra: abi.encode(best)
        });
    }

    /// @inheritdoc ISwapAdapter
    function swap(Route calldata route, uint256 amountIn, address recipient, address refundTo)
        external
        onlyRouter
        returns (uint256 amountOut, uint256 amountInUsed)
    {
        PoolKey memory key = abi.decode(route.extra, (PoolKey));
        if (!knownPool[poolId(key)]) revert UnknownPool(poolId(key));
        (address t0, address t1) =
            route.tokenIn < route.tokenOut ? (route.tokenIn, route.tokenOut) : (route.tokenOut, route.tokenIn);
        if (key.currency0 != t0 || key.currency1 != t1) revert PoolTokenMismatch();

        bytes memory result = poolManager.unlock(
            abi.encode(
                CallbackData({
                    mode: MODE_EXECUTE,
                    key: key,
                    zeroForOne: route.tokenIn < route.tokenOut,
                    amountIn: amountIn,
                    recipient: recipient
                })
            )
        );
        (amountOut, amountInUsed) = abi.decode(result, (uint256, uint256));
        if (amountInUsed < amountIn) {
            IERC20(route.tokenIn).safeTransfer(refundTo, amountIn - amountInUsed);
        }
    }

    // ------------------------------------------------------------------
    // V4 unlock callback
    // ------------------------------------------------------------------

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        CallbackData memory d = abi.decode(data, (CallbackData));

        int256 delta = poolManager.swap(
            d.key,
            V4SwapParams({
                zeroForOne: d.zeroForOne,
                amountSpecified: -SafeCast.toInt256(d.amountIn),
                sqrtPriceLimitX96: d.zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 a0, int128 a1) = _unpack(delta);
        int128 outDelta = d.zeroForOne ? a1 : a0;
        int128 inDelta = d.zeroForOne ? a0 : a1;
        uint256 amountOut = outDelta > 0 ? SafeCast.toUint256(int256(outDelta)) : 0;
        uint256 amountInUsed = inDelta < 0 ? SafeCast.toUint256(-int256(inDelta)) : 0;

        if (d.mode == MODE_SIMULATE) {
            bytes32 sentinel = QUOTE_SENTINEL;
            assembly ("memory-safe") {
                let ptr := mload(0x40)
                mstore(ptr, sentinel)
                mstore(add(ptr, 0x20), amountOut)
                revert(ptr, 0x40)
            }
        }

        address cin = d.zeroForOne ? d.key.currency0 : d.key.currency1;
        address cout = d.zeroForOne ? d.key.currency1 : d.key.currency0;
        if (amountInUsed > 0) {
            poolManager.sync(cin);
            IERC20(cin).safeTransfer(address(poolManager), amountInUsed);
            poolManager.settle();
        }
        if (amountOut > 0) poolManager.take(cout, d.recipient, amountOut);
        return abi.encode(amountOut, amountInUsed);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _simulate(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal returns (uint256) {
        try poolManager.unlock(
            abi.encode(
                CallbackData({
                    mode: MODE_SIMULATE, key: key, zeroForOne: zeroForOne, amountIn: amountIn, recipient: address(0)
                })
            )
        ) {
            return 0; // unreachable
        } catch (bytes memory reason) {
            if (reason.length != 64) return 0;
            (bytes32 sentinel, uint256 out) = abi.decode(reason, (bytes32, uint256));
            return sentinel == QUOTE_SENTINEL ? out : 0;
        }
    }

    /// @dev Zero-impact output at the pool's current sqrt price, read via extsload (StateLibrary.getSlot0).
    function _midOut(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal view returns (uint256) {
        bytes32 stateSlot = keccak256(abi.encodePacked(poolId(key), poolsSlot));
        bytes32 slot0 = poolManager.extsload(stateSlot);
        uint160 sqrtP = uint160(uint256(slot0));
        if (sqrtP == 0) return 0;
        if (zeroForOne) {
            return Math.mulDiv(Math.mulDiv(amountIn, sqrtP, Q96), sqrtP, Q96);
        }
        return Math.mulDiv(Math.mulDiv(amountIn, Q96, sqrtP), Q96, sqrtP);
    }

    /// @dev BalanceDelta: upper 128 bits amount0, lower 128 bits amount1 (both signed).
    function _unpack(int256 delta) internal pure returns (int128 a0, int128 a1) {
        assembly ("memory-safe") {
            a0 := sar(128, delta)
            a1 := signextend(15, delta)
        }
    }

    function _pairKey(address t0, address t1) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(t0, t1));
    }
}
