// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {ISwapAdapter} from "./ISwapAdapter.sol";
import {Route} from "../IAggregatorRouter.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3SwapCallback} from "../../interfaces/IUniswapV3.sol";

/// @title UniV3Adapter
/// @notice Uniswap V3-style concentrated-liquidity adapter (also used for Ramses V3, which shares the
///         factory / pool / callback ABI). Quotes by simulating the swap and reverting inside the callback
///         (same technique as Uniswap's Quoter), so no external quoter deployment is required.
///
/// @dev Pool discovery: `factory.getPool(tokenIn, tokenOut, tier)` for each configured fee tier, plus any
///      pools the owner registered explicitly (for forks whose factory ABI differs). Every pool that may call
///      back into this contract must be verified first (`verifiedPool`), which guards the callback against
///      arbitrary contracts asking to be paid.
///
///      Token flow: the router transfers `amountIn` here, `swap` calls `pool.swap`, the pool pushes output to
///      `recipient` and pulls input via `uniswapV3SwapCallback`. The adapter never holds tokens between txs.
contract UniV3Adapter is ISwapAdapter, IUniswapV3SwapCallback, Ownable2Step {
    using SafeERC20 for IERC20;

    uint8 public immutable protocolId;
    address public immutable router;
    IUniswapV3Factory public immutable factory; // address(0) => factory discovery disabled

    uint24[] private _feeTiers;
    mapping(bytes32 => address[]) private _extraPools;
    mapping(address => bool) public verifiedPool;
    uint256 public extraPoolCount;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant Q96 = 2 ** 96;
    bytes32 internal constant QUOTE_SENTINEL = keccak256("DCA_V3_QUOTE");

    uint8 internal constant MODE_SIMULATE = 0;
    uint8 internal constant MODE_EXECUTE = 1;

    struct CallbackData {
        uint8 mode;
        address pool;
        address tokenIn;
        address tokenOut;
    }

    error OnlyRouter();
    error UnknownPool(address pool);
    error UnauthorizedCallback();
    error PoolTokenMismatch(address pool);
    error InvalidPool(address pool);

    event FeeTiersSet(uint24[] tiers);
    event PoolRegistered(address indexed pool, address token0, address token1);
    event PoolUnregistered(address indexed pool);

    constructor(uint8 protocolId_, address router_, address factory_, uint24[] memory feeTiers_, address owner_)
        Ownable(owner_)
    {
        protocolId = protocolId_;
        router = router_;
        factory = IUniswapV3Factory(factory_);
        _feeTiers = feeTiers_;
        emit FeeTiersSet(feeTiers_);
    }

    modifier onlyRouter() {
        if (msg.sender != router) revert OnlyRouter();
        _;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice Replace the fee tiers probed through the factory.
    function setFeeTiers(uint24[] calldata tiers) external onlyOwner {
        _feeTiers = tiers;
        emit FeeTiersSet(tiers);
    }

    /// @notice Register a pool explicitly (for forks whose factory lookup differs, or non-standard tiers).
    function registerPool(address pool) external onlyOwner {
        if (pool.code.length == 0) revert InvalidPool(pool);
        address t0 = IUniswapV3Pool(pool).token0();
        address t1 = IUniswapV3Pool(pool).token1();
        if (t0 == address(0) || t1 == address(0) || t0 >= t1) revert InvalidPool(pool);
        if (!verifiedPool[pool]) {
            _extraPools[_pairKey(t0, t1)].push(pool);
            verifiedPool[pool] = true;
            extraPoolCount += 1;
        }
        emit PoolRegistered(pool, t0, t1);
    }

    /// @notice Drop an explicitly registered pool.
    function unregisterPool(address pool) external onlyOwner {
        address t0 = IUniswapV3Pool(pool).token0();
        address t1 = IUniswapV3Pool(pool).token1();
        address[] storage arr = _extraPools[_pairKey(t0, t1)];
        for (uint256 i; i < arr.length; ++i) {
            if (arr[i] == pool) {
                arr[i] = arr[arr.length - 1];
                arr.pop();
                extraPoolCount -= 1;
                break;
            }
        }
        verifiedPool[pool] = false;
        emit PoolUnregistered(pool);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function feeTiers() external view returns (uint24[] memory) {
        return _feeTiers;
    }

    function extraPools(address tokenA, address tokenB) external view returns (address[] memory) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return _extraPools[_pairKey(t0, t1)];
    }

    /// @inheritdoc ISwapAdapter
    function enabled() public view returns (bool) {
        return address(factory) != address(0) || extraPoolCount > 0;
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
        address[] memory pools = _candidatePools(tokenIn, tokenOut);
        address best;
        for (uint256 i; i < pools.length; ++i) {
            uint256 out = _simulate(pools[i], tokenIn, tokenOut, amountIn);
            if (out > amountOut) {
                amountOut = out;
                best = pools[i];
            }
        }
        if (best == address(0)) return (0, 0, route);
        midOut = _midOut(best, tokenIn < tokenOut, amountIn);
        route = Route({
            protocol: protocolId,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: IUniswapV3Pool(best).fee(),
            extra: abi.encode(best)
        });
    }

    /// @inheritdoc ISwapAdapter
    function swap(Route calldata route, uint256 amountIn, address recipient, address refundTo)
        external
        onlyRouter
        returns (uint256 amountOut, uint256 amountInUsed)
    {
        address pool = abi.decode(route.extra, (address));
        if (!verifiedPool[pool] && !_verifyFactoryPool(pool)) revert UnknownPool(pool);
        _checkTokens(pool, route.tokenIn, route.tokenOut);

        bool zeroForOne = route.tokenIn < route.tokenOut;
        (int256 a0, int256 a1) = IUniswapV3Pool(pool)
            .swap(
                recipient,
                zeroForOne,
                SafeCast.toInt256(amountIn),
                zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                abi.encode(
                    CallbackData({mode: MODE_EXECUTE, pool: pool, tokenIn: route.tokenIn, tokenOut: route.tokenOut})
                )
            );
        int256 inDelta = zeroForOne ? a0 : a1;
        int256 outDelta = zeroForOne ? a1 : a0;
        amountInUsed = inDelta > 0 ? SafeCast.toUint256(inDelta) : 0;
        amountOut = outDelta < 0 ? SafeCast.toUint256(-outDelta) : 0;

        if (amountInUsed < amountIn) {
            IERC20(route.tokenIn).safeTransfer(refundTo, amountIn - amountInUsed);
        }
    }

    // ------------------------------------------------------------------
    // Uniswap V3 callback
    // ------------------------------------------------------------------

    /// @inheritdoc IUniswapV3SwapCallback
    /// @dev Only verified pools may call. In SIMULATE mode the output is returned via a sentinel revert.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        CallbackData memory d = abi.decode(data, (CallbackData));
        if (msg.sender != d.pool || !verifiedPool[d.pool]) revert UnauthorizedCallback();

        bool zeroForOne = d.tokenIn < d.tokenOut;
        if (d.mode == MODE_SIMULATE) {
            int256 outDelta = zeroForOne ? amount1Delta : amount0Delta;
            uint256 out = outDelta < 0 ? SafeCast.toUint256(-outDelta) : 0;
            bytes32 sentinel = QUOTE_SENTINEL;
            assembly ("memory-safe") {
                let ptr := mload(0x40)
                mstore(ptr, sentinel)
                mstore(add(ptr, 0x20), out)
                revert(ptr, 0x40)
            }
        }
        int256 inDelta = zeroForOne ? amount0Delta : amount1Delta;
        if (inDelta > 0) IERC20(d.tokenIn).safeTransfer(msg.sender, SafeCast.toUint256(inDelta));
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _candidatePools(address tokenIn, address tokenOut) internal returns (address[] memory pools) {
        (address t0, address t1) = tokenIn < tokenOut ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        address[] storage extras = _extraPools[_pairKey(t0, t1)];
        uint256 tiers = address(factory) == address(0) ? 0 : _feeTiers.length;
        pools = new address[](tiers + extras.length);
        uint256 n;
        for (uint256 i; i < tiers; ++i) {
            address p = factory.getPool(t0, t1, _feeTiers[i]);
            if (p == address(0)) continue;
            if (!verifiedPool[p]) verifiedPool[p] = true; // factory-derived => trusted
            pools[n++] = p;
        }
        for (uint256 i; i < extras.length; ++i) {
            pools[n++] = extras[i];
        }
        assembly ("memory-safe") {
            mstore(pools, n)
        }
    }

    /// @dev Exact-input simulation through the real pool; the callback reverts with the output.
    function _simulate(address pool, address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint256) {
        bool zeroForOne = tokenIn < tokenOut;
        try IUniswapV3Pool(pool)
            .swap(
                address(this),
                zeroForOne,
                SafeCast.toInt256(amountIn),
                zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                abi.encode(CallbackData({mode: MODE_SIMULATE, pool: pool, tokenIn: tokenIn, tokenOut: tokenOut}))
            ) {
            return 0; // unreachable: simulate mode always reverts
        } catch (bytes memory reason) {
            if (reason.length != 64) return 0;
            (bytes32 sentinel, uint256 out) = abi.decode(reason, (bytes32, uint256));
            return sentinel == QUOTE_SENTINEL ? out : 0;
        }
    }

    /// @dev Zero-impact output at the current sqrt price (fees excluded). Decodes only the first slot0 word
    ///      so forks with extra slot0 fields still work.
    function _midOut(address pool, bool zeroForOne, uint256 amountIn) internal view returns (uint256) {
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSelector(IUniswapV3Pool.slot0.selector));
        if (!ok || ret.length < 32) return 0;
        uint160 sqrtP = abi.decode(ret, (uint160));
        if (sqrtP == 0) return 0;
        if (zeroForOne) {
            return Math.mulDiv(Math.mulDiv(amountIn, sqrtP, Q96), sqrtP, Q96);
        }
        return Math.mulDiv(Math.mulDiv(amountIn, Q96, sqrtP), Q96, sqrtP);
    }

    function _verifyFactoryPool(address pool) internal returns (bool) {
        if (address(factory) == address(0) || pool.code.length == 0) return false;
        address t0 = IUniswapV3Pool(pool).token0();
        address t1 = IUniswapV3Pool(pool).token1();
        uint24 fee = IUniswapV3Pool(pool).fee();
        if (factory.getPool(t0, t1, fee) != pool) return false;
        verifiedPool[pool] = true;
        return true;
    }

    function _checkTokens(address pool, address tokenIn, address tokenOut) internal view {
        (address t0, address t1) = tokenIn < tokenOut ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        if (IUniswapV3Pool(pool).token0() != t0 || IUniswapV3Pool(pool).token1() != t1) {
            revert PoolTokenMismatch(pool);
        }
    }

    function _pairKey(address t0, address t1) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(t0, t1));
    }
}
