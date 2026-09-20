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
/// @notice Best-of-N single-path router over Uniswap V3 / Uniswap V4 / Ramses V3. Probes each enabled
///         adapter for a direct pool and for a one-hop path through WETH, then picks the highest output
///         whose price impact (vs pool mid-price) is within `maxPriceImpactBps`.
///
/// @dev Approval model: callers approve THIS contract only. Tokens are moved straight into the first
///      adapter, and adapters pay pools from their own transient balance, so no approvals to third-party
///      routers ever exist. Split routes are a V2 item; V1 is single-pool per hop.
contract AggregatorRouter is IAggregatorRouter, Ownable2Step {
    using SafeERC20 for IERC20;

    address public immutable weth;
    uint16 public maxPriceImpactBps = 150;
    uint16 internal constant MAX_IMPACT_CAP = 1_000;
    uint8 internal constant MAX_PROTOCOLS = 8;

    mapping(uint8 => ISwapAdapter) public adapters;
    uint8[] private _protocols;

    struct Leg {
        bool ok;
        uint256 out;
        uint256 mid;
        Route route;
    }

    error ProtocolIdOutOfRange(uint8 protocol);
    error ImpactCapOutOfRange(uint16 bps);

    constructor(address weth_, address owner_) Ownable(owner_) {
        weth = weth_;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice Set or clear (address(0)) the adapter for a protocol id (1 = UniV3, 2 = UniV4, 3 = RamsesV3).
    function setAdapter(uint8 protocol, address adapter) external onlyOwner {
        if (protocol == 0 || protocol > MAX_PROTOCOLS) revert ProtocolIdOutOfRange(protocol);
        bool listed;
        for (uint256 i; i < _protocols.length; ++i) {
            if (_protocols[i] == protocol) listed = true;
        }
        if (!listed && adapter != address(0)) _protocols.push(protocol);
        adapters[protocol] = ISwapAdapter(adapter);
        emit AdapterSet(protocol, adapter);
    }

    /// @notice Global price-impact cap vs pool mid-price (bps, <= 1000).
    function setMaxPriceImpactBps(uint16 bps) external onlyOwner {
        if (bps > MAX_IMPACT_CAP) revert ImpactCapOutOfRange(bps);
        maxPriceImpactBps = bps;
        emit MaxPriceImpactSet(bps);
    }

    function protocols() external view returns (uint8[] memory) {
        return _protocols;
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

        Leg memory direct = _bestLeg(tokenIn, tokenOut, amountIn);
        uint256 directImpact = direct.ok ? FeeMath.impactBps(direct.out, direct.mid) : FeeMath.BPS;
        bool directOk = direct.ok && directImpact <= maxPriceImpactBps;

        Leg memory l1;
        Leg memory l2;
        uint256 hopImpact = FeeMath.BPS;
        bool hopOk;
        if (tokenIn != weth && tokenOut != weth) {
            l1 = _bestLeg(tokenIn, weth, amountIn);
            if (l1.ok && l1.out > 0) {
                l2 = _bestLeg(weth, tokenOut, l1.out);
                if (l2.ok) {
                    // Scale hop-2 mid to what it would be on hop-1's zero-impact output.
                    uint256 midTotal = Math.mulDiv(l2.mid, l1.mid, l1.out);
                    hopImpact = FeeMath.impactBps(l2.out, midTotal);
                    hopOk = hopImpact <= maxPriceImpactBps;
                }
            }
        }

        if (directOk && (!hopOk || direct.out >= l2.out)) {
            path = new Route[](1);
            path[0] = direct.route;
            return (direct.out, path, directImpact);
        }
        if (hopOk) {
            path = new Route[](2);
            path[0] = l1.route;
            path[1] = l2.route;
            return (l2.out, path, hopImpact);
        }
        revert NoRoute(tokenIn, tokenOut);
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
        for (uint256 i; i + 1 < n; ++i) {
            if (path[i].tokenOut != path[i + 1].tokenIn) revert InvalidPath();
        }

        ISwapAdapter first = _adapter(path[0].protocol);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(first), amountIn);

        uint256 amt = amountIn;
        for (uint256 i; i < n; ++i) {
            ISwapAdapter a = _adapter(path[i].protocol);
            address next = i + 1 < n ? address(_adapter(path[i + 1].protocol)) : recipient;
            (amt,) = a.swap(path[i], amt, next, msg.sender);
            if (amt == 0) break;
        }
        amountOut = amt;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _bestLeg(address tokenIn, address tokenOut, uint256 amountIn) internal returns (Leg memory best) {
        for (uint256 i; i < _protocols.length; ++i) {
            ISwapAdapter a = adapters[_protocols[i]];
            if (address(a) == address(0)) continue;
            try a.enabled() returns (bool on) {
                if (!on) continue;
            } catch {
                continue;
            }
            try a.quote(tokenIn, tokenOut, amountIn) returns (uint256 out, uint256 mid, Route memory r) {
                if (out > best.out) {
                    best = Leg({ok: true, out: out, mid: mid, route: r});
                }
            } catch {}
        }
    }

    function _adapter(uint8 protocol) internal view returns (ISwapAdapter a) {
        a = adapters[protocol];
        if (address(a) == address(0)) revert AdapterNotSet(protocol);
    }
}
