// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAggregatorRouter, Route} from "./IAggregatorRouter.sol";
import {ISwapAdapter} from "./adapters/ISwapAdapter.sol";
import {FeeMath} from "../libraries/FeeMath.sol";

/// @title AggregatorRouter
/// @notice Best-of-N single-path router over Uniswap V3 / Uniswap V4 / Ramses V3, restricted to an
///         owner-approved allowlist of hops. A hop is (protocol, tokenIn, tokenOut, pool). For a quote the
///         router tries every approved direct hop and every approved (tokenIn -> WETH) x (WETH -> tokenOut)
///         combination, and picks the highest output whose price impact (vs pool mid-price) is within
///         `maxPriceImpactBps` — i.e. the lowest effective fee + slippage among approved routes.
///
/// @dev Approval model: callers approve THIS contract only. Tokens are moved straight into the first
///      adapter, and adapters pay pools from their own transient balance, so no approvals to third-party
///      routers ever exist. `swapWithRoute` refuses any path containing an unapproved hop, so a caller-supplied
///      path (e.g. a vault keeper's override) can only ever select among approved pools, and `quotePath`
///      applies the same impact cap to it. Every hop must fill in full (`PartialFill` otherwise): adapters
///      report a hop that cannot consume its whole input as "no fill" at quote time, and execution reverts.
///      Split routes are a V2 item; V1 is single-pool per hop.
contract AggregatorRouter is IAggregatorRouter, Ownable2Step {
    using SafeERC20 for IERC20;

    address public immutable weth;
    uint16 public maxPriceImpactBps = 150;
    uint16 internal constant MAX_IMPACT_CAP = 1_000;
    uint8 internal constant MAX_PROTOCOLS = 8;
    uint256 internal constant MAX_HOPS_PER_PAIR = 8;

    mapping(uint8 => ISwapAdapter) public adapters;
    /// @dev directional pair key => approved hops
    mapping(bytes32 => Route[]) private _hops;
    /// @notice hopKey(route) => approved
    mapping(bytes32 => bool) public isApprovedHop;

    struct Leg {
        bool ok;
        uint256 out;
        uint256 mid;
        uint256 impact;
        Route route;
    }

    error ZeroAddress();
    error ProtocolIdOutOfRange(uint8 protocol);
    error ImpactCapOutOfRange(uint16 bps);
    error AdapterProtocolMismatch(uint8 expected, uint8 actual);
    error InvalidRoute();
    error TooManyHops(bytes32 pairKey);
    error HopAlreadyApproved(bytes32 hopKey);
    error HopNotApproved(bytes32 hopKey);

    constructor(address weth_, address owner_) Ownable(owner_) {
        if (weth_ == address(0)) revert ZeroAddress();
        weth = weth_;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice Set or clear (address(0)) the adapter for a protocol id (1 = UniV3, 2 = UniV4, 3 = RamsesV3).
    function setAdapter(uint8 protocol, address adapter) external onlyOwner {
        if (protocol == 0 || protocol > MAX_PROTOCOLS) revert ProtocolIdOutOfRange(protocol);
        if (adapter != address(0)) {
            uint8 actual = ISwapAdapter(adapter).protocolId();
            if (actual != protocol) revert AdapterProtocolMismatch(protocol, actual);
        }
        adapters[protocol] = ISwapAdapter(adapter);
        emit AdapterSet(protocol, adapter);
    }

    /// @notice Global price-impact cap vs pool mid-price (bps, <= 1000).
    function setMaxPriceImpactBps(uint16 bps) external onlyOwner {
        if (bps > MAX_IMPACT_CAP) revert ImpactCapOutOfRange(bps);
        maxPriceImpactBps = bps;
        emit MaxPriceImpactSet(bps);
    }

    /// @notice Approve one directional hop. The adapter must recognise the pool and its tokens must match.
    ///         Approve both directions separately if both are needed (e.g. WETH->USDG for deposits and
    ///         USDG->WETH as the first leg of a two-hop stock route).
    function approveHop(Route calldata route) external onlyOwner {
        if (route.tokenIn == address(0) || route.tokenOut == address(0) || route.tokenIn == route.tokenOut) {
            revert InvalidRoute();
        }
        if (!_adapter(route.protocol).validateRoute(route)) revert InvalidRoute();
        bytes32 key = hopKey(route);
        if (isApprovedHop[key]) revert HopAlreadyApproved(key);
        bytes32 pair = _pairKey(route.tokenIn, route.tokenOut);
        Route[] storage list = _hops[pair];
        if (list.length >= MAX_HOPS_PER_PAIR) revert TooManyHops(pair);
        list.push(route);
        isApprovedHop[key] = true;
        emit HopApproved(key, route);
    }

    /// @notice Revoke a hop. Paths containing it can no longer be quoted or executed.
    function revokeHop(Route calldata route) external onlyOwner {
        bytes32 key = hopKey(route);
        if (!isApprovedHop[key]) revert HopNotApproved(key);
        Route[] storage list = _hops[_pairKey(route.tokenIn, route.tokenOut)];
        for (uint256 i; i < list.length; ++i) {
            if (hopKey(list[i]) == key) {
                if (i != list.length - 1) list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
        isApprovedHop[key] = false;
        emit HopRevoked(key, route);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Identity of a hop: every field, so two pools on the same pair are distinct hops.
    function hopKey(Route memory r) public pure returns (bytes32) {
        return keccak256(abi.encode(r.protocol, r.tokenIn, r.tokenOut, r.fee, r.extra));
    }

    /// @notice Approved hops for a directional pair.
    function approvedHops(address tokenIn, address tokenOut) external view returns (Route[] memory) {
        return _hops[_pairKey(tokenIn, tokenOut)];
    }

    // ------------------------------------------------------------------
    // Quotes
    // ------------------------------------------------------------------

    /// @inheritdoc IAggregatorRouter
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        public
        returns (uint256 amountOut, Route[] memory path)
    {
        (amountOut, path,) = quoteWithImpact(tokenIn, tokenOut, amountIn);
    }

    /// @inheritdoc IAggregatorRouter
    function quoteWithImpact(address tokenIn, address tokenOut, uint256 amountIn)
        public
        returns (uint256 amountOut, Route[] memory path, uint256 impactBps)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn == tokenOut) revert InvalidPath();

        // Both selectors only ever return candidates within the impact cap, so the comparison below is purely
        // "highest output" — the lowest effective fee + slippage among approved routes.
        Leg memory direct = _bestHop(tokenIn, tokenOut, amountIn);
        Leg memory l1;
        Leg memory l2;
        uint256 hopImpact = FeeMath.BPS;
        if (tokenIn != weth && tokenOut != weth) {
            (l1, l2, hopImpact) = _bestTwoHop(tokenIn, tokenOut, amountIn);
        }

        if (direct.ok && (!l2.ok || direct.out >= l2.out)) {
            path = new Route[](1);
            path[0] = direct.route;
            return (direct.out, path, direct.impact);
        }
        if (l2.ok) {
            path = new Route[](2);
            path[0] = l1.route;
            path[1] = l2.route;
            return (l2.out, path, hopImpact);
        }
        revert NoRoute(tokenIn, tokenOut);
    }

    /// @notice Simulated output of an explicit path (every hop must be approved). Used by vaults to floor a
    ///         route override's `minOut` at what that path would deliver right now. Reverts if any hop is
    ///         unapproved or cannot fill in full, and — like the automatic selection — if the path's
    ///         end-to-end impact against the pools' mid-prices exceeds `maxPriceImpactBps`, so an override can
    ///         never accept more impact than the auto-route would (audit v0.3 M-02).
    function quotePath(Route[] calldata path, uint256 amountIn) external returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        uint256 n = path.length;
        if (n == 0 || n > 3) revert InvalidPath();
        amountOut = amountIn;
        uint256 zeroImpactOut = amountIn; // what the same input would yield at every hop's current mid-price
        for (uint256 i; i < n; ++i) {
            if (i + 1 < n && path[i].tokenOut != path[i + 1].tokenIn) revert InvalidPath();
            bytes32 key = hopKey(path[i]);
            if (!isApprovedHop[key]) revert RouteNotApproved(key);
            uint256 hopIn = amountOut;
            uint256 mid;
            (amountOut, mid) = _adapter(path[i].protocol).quoteRoute(path[i], hopIn);
            if (amountOut == 0 || mid == 0) revert NoRoute(path[i].tokenIn, path[i].tokenOut);
            zeroImpactOut = Math.mulDiv(zeroImpactOut, mid, hopIn);
        }
        uint256 impact = FeeMath.impactBps(amountOut, zeroImpactOut);
        if (impact > maxPriceImpactBps) revert PriceImpactTooHigh(impact, maxPriceImpactBps);
    }

    // ------------------------------------------------------------------
    // Swaps
    // ------------------------------------------------------------------

    /// @inheritdoc IAggregatorRouter
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        (, Route[] memory path) = quote(tokenIn, tokenOut, amountIn);
        return _execute(tokenIn, tokenOut, amountIn, minOut, recipient, path);
    }

    /// @inheritdoc IAggregatorRouter
    function swapWithRoute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        Route[] calldata path
    ) external returns (uint256 amountOut) {
        return _execute(tokenIn, tokenOut, amountIn, minOut, recipient, path);
    }

    function _execute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        Route[] memory path
    ) internal returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        uint256 n = path.length;
        if (n == 0 || n > 3 || path[0].tokenIn != tokenIn || path[n - 1].tokenOut != tokenOut) revert InvalidPath();
        for (uint256 i; i < n; ++i) {
            if (i + 1 < n && path[i].tokenOut != path[i + 1].tokenIn) revert InvalidPath();
            bytes32 key = hopKey(path[i]);
            if (!isApprovedHop[key]) revert RouteNotApproved(key);
        }

        ISwapAdapter first = _adapter(path[0].protocol);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(first), amountIn);

        uint256 amt = amountIn;
        for (uint256 i; i < n; ++i) {
            ISwapAdapter a = _adapter(path[i].protocol);
            address next = i + 1 < n ? address(_adapter(path[i + 1].protocol)) : recipient;
            // Full fills only: a hop that cannot consume its whole input has exhausted the pool's in-range
            // liquidity, and any unspent intermediate would be the caller's money sitting in the wrong token
            // (audit v0.3 M-02 / L-02). The adapter's own refund is undone by this revert.
            uint256 hopIn = amt;
            uint256 used;
            (amt, used) = a.swap(path[i], hopIn, next, i == 0 ? msg.sender : recipient);
            if (used < hopIn) revert PartialFill(i);
            if (amt == 0) break;
        }
        amountOut = amt;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Highest-output approved hop for a pair among those within the impact cap (adapter reverts skipped).
    function _bestHop(address tokenIn, address tokenOut, uint256 amountIn) internal returns (Leg memory best) {
        Route[] storage list = _hops[_pairKey(tokenIn, tokenOut)];
        uint16 cap = maxPriceImpactBps;
        for (uint256 i; i < list.length; ++i) {
            Route memory r = list[i];
            ISwapAdapter a = adapters[r.protocol];
            if (address(a) == address(0)) continue;
            try a.quoteRoute(r, amountIn) returns (uint256 out, uint256 mid) {
                if (out == 0 || out <= best.out) continue;
                uint256 impact = FeeMath.impactBps(out, mid);
                if (impact > cap) continue;
                best = Leg({ok: true, out: out, mid: mid, impact: impact, route: r});
            } catch {}
        }
    }

    /// @dev Highest-output (tokenIn -> WETH) x (WETH -> tokenOut) combination whose END-TO-END impact is within
    ///      the cap. Each leg is the best hop of its pair; the second leg's own impact check is against its own
    ///      mid, the combination is re-checked against hop-1's zero-impact output.
    function _bestTwoHop(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (Leg memory l1, Leg memory l2, uint256 impact)
    {
        impact = FeeMath.BPS;
        uint16 cap = maxPriceImpactBps;
        Route[] storage firsts = _hops[_pairKey(tokenIn, weth)];
        for (uint256 i; i < firsts.length; ++i) {
            Route memory r1 = firsts[i];
            ISwapAdapter a1 = adapters[r1.protocol];
            if (address(a1) == address(0)) continue;
            uint256 o1;
            uint256 m1;
            try a1.quoteRoute(r1, amountIn) returns (uint256 out, uint256 mid) {
                o1 = out;
                m1 = mid;
            } catch {
                continue;
            }
            if (o1 == 0) continue;
            Leg memory c2 = _bestHop(weth, tokenOut, o1);
            if (!c2.ok || c2.out <= l2.out) continue;
            // Scale hop-2 mid to what it would be on hop-1's zero-impact output.
            uint256 midTotal = Math.mulDiv(c2.mid, m1, o1);
            uint256 comboImpact = FeeMath.impactBps(c2.out, midTotal);
            if (comboImpact > cap) continue;
            l1 = Leg({ok: true, out: o1, mid: m1, impact: FeeMath.impactBps(o1, m1), route: r1});
            l2 = c2;
            impact = comboImpact;
        }
    }

    function _adapter(uint8 protocol) internal view returns (ISwapAdapter a) {
        a = adapters[protocol];
        if (address(a) == address(0)) revert AdapterNotSet(protocol);
    }

    function _pairKey(address tokenIn, address tokenOut) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenIn, tokenOut));
    }
}
