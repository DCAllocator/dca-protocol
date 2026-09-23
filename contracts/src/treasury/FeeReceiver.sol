// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAggregatorRouter, Route} from "../router/IAggregatorRouter.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {IUniswapV3Pool} from "../interfaces/IUniswapV3.sol";
import {FeeMath} from "../libraries/FeeMath.sol";
import {TwapOracle} from "../oracles/TwapOracle.sol";

/// @dev The optional `burn(uint256)` of an ERC20Burnable-style token.
interface IBurnable {
    function burn(uint256 amount) external;
}

/// @title FeeReceiver
/// @notice The protocol's fee sink. Every vault pushes its fees here as `feeRecipient` (USDG purchase / deposit /
///         withdraw fees and dust, WETH dust, Stock Token claim fees). Operators then split each token's balance
///         70 / 30: 70% is forwarded to the treasury, 30% is reserved for buying $DCA back through the protocol's
///         own router and burning it.
///
/// @dev Accounting model
///      - Nothing has to notify this contract when a fee lands. For every token
///            pending(token) = balanceOf(this) - buybackReserve[token]
///        is what arrived since the last `distribute`. `distribute` moves 70% of it to `treasury` (floored, so
///        rounding favours the buyback) and books the rest into `buybackReserve[token]`.
///      - A reserve can leave the contract in exactly two ways, both operator-only, both through the owner-approved
///        router at a price no worse than `quote × (1 − maxSlippageBps)`:
///            buyback(token)            token -> $DCA, burned in the same transaction;
///            convert(stock -> base)    a Stock Token's reserve -> USDG / WETH reserve. Stock tokens rarely have a
///                                      route to $DCA; the base tokens do. USDG, WETH and $DCA reserves are NOT
///                                      convertible, so no reserve can be churned back and forth through the DEX.
///        There is no rescue, sweep or withdraw for any token: nothing bypasses the split.
///      - Invariant: `balanceOf(this) >= buybackReserve[token]` for every token.
///      - Burn: `$DCA.burn(amount)` when the token has one (verified by balance), otherwise a transfer to
///        0x…dEaD. `totalBurned` counts both.
///      - ETH is accepted (`receive`) and wrapped by anyone via `wrapEth()`; it then flows as WETH.
///      - Price guard: the `minOut` floor is taken from a quote in the same transaction, so on its own it cannot
///        see a sandwich (the push moves the quote too — the vault epochs' H-02 residual). Every swap therefore
///        also checks each V3-style pool ON THE PATH IT IS ABOUT TO EXECUTE: the pool's spot tick must be within
///        `guardMaxTicks` of its `guardWindow`-second TWAP (1 tick ≈ 1 bp), otherwise the swap reverts
///        (`PriceDeviates`) instead of overpaying. A push inside the block, or a few blocks earlier, cannot move a
///        30-minute TWAP; holding a pushed price for the whole window is what an attacker would have to pay for.
///        Hops with no on-chain oracle (Uniswap V4 keys) are refused while the guard is on unless the owner opts in
///        with `allowUnguardedHops`. `guardWindow = 0` switches the guard off. Pools on the buyback routes need
///        enough observation cardinality for the window (`increaseObservationCardinalityNext`).
///
///      Trust. The owner (multisig) sets the treasury, router, operators, slippage tolerance and the guard.
///      Operators only choose WHEN and HOW MUCH to distribute / convert / buy back; they cannot direct funds
///      anywhere but the treasury, a reserve or a burn. With the guard on, the most a rogue operator can cost a
///      buyback is `maxSlippageBps` + `guardMaxTicks` below the pool's TWAP per swap; with it off, the block-level
///      sandwich residual applies (submit through a private relay and pass a reference `minOut`).
contract FeeReceiver is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Share of every distribution forwarded to the treasury (70%). Fixed for the life of the contract;
    ///         a different split is a new FeeReceiver + `vault.setFeeRecipient`, visible on-chain.
    uint16 public constant TREASURY_BPS = 7_000;
    /// @notice Share of every distribution reserved for $DCA buybacks (30%). `TREASURY_BPS + BUYBACK_BPS == BPS`.
    uint16 public constant BUYBACK_BPS = 3_000;
    /// @notice Where bought-back $DCA goes when the token has no `burn(uint256)`.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint16 internal constant MAX_SLIPPAGE_BPS = 500;

    IERC20 public immutable usdg;
    IWETH public immutable weth;
    IERC20 public immutable dca;

    address public treasury;
    IAggregatorRouter public router;
    /// @notice Every swap's `minOut` is at least `quote × (1 − maxSlippageBps)`. Default 50 bps, max 500.
    uint16 public maxSlippageBps = 50;
    mapping(address => bool) public isOperator;
    /// @notice Per token: the part of this contract's balance already earmarked for buybacks (see `pending`).
    mapping(address => uint256) public buybackReserve;
    /// @notice Lifetime $DCA removed from circulation by this contract (burned or sent to `DEAD`).
    uint256 public totalBurned;

    /// @notice TWAP window (seconds) of the on-path price guard; 0 switches the guard off. Default 30 minutes.
    uint32 public guardWindow = 30 minutes;
    /// @notice Largest |spot − TWAP| in ticks a pool on the path may show (1 tick ≈ 1 bp). Default 300 (≈ 3%).
    uint24 public guardMaxTicks = 300;
    /// @notice Whether hops without a V3 oracle (Uniswap V4 keys) may execute while the guard is on. Default false.
    bool public allowUnguardedHops;

    error ZeroAddress();
    error ZeroAmount();
    error NotOperator();
    error NotAContract(address token);
    error TokensNotDistinct();
    error InvalidTreasury(address treasury);
    error SlippageOutOfRange(uint16 bps, uint16 max);
    error NothingToDistribute(address token);
    error InsufficientReserve(address token, uint256 requested, uint256 reserve);
    error NotConvertible(address token);
    error InvalidConversionTarget(address token);
    error QuoteTooSmall();
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error BurnFailed();
    error RouterWethMismatch(address router);
    error InvalidGuard();
    error UnguardedHop(uint256 hopIndex);
    error GuardUnavailable(address pool);
    error PriceDeviates(address pool, int24 spotTick, int24 twapTick, uint24 maxTicks);

    event TreasurySet(address indexed treasury);
    event RouterSet(address indexed router);
    event OperatorSet(address indexed operator, bool allowed);
    event MaxSlippageSet(uint16 bps);
    event GuardSet(uint32 window, uint24 maxTicks, bool allowUnguardedHops);
    event Distributed(address indexed token, address indexed treasury, uint256 toTreasury, uint256 toBuyback);
    event Converted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event BoughtBack(address indexed tokenIn, uint256 amountIn, uint256 dcaOut);
    event Burned(uint256 amount, bool viaBurn);
    event EthWrapped(uint256 amount);

    constructor(address usdg_, address weth_, address dca_, address router_, address treasury_, address owner_)
        Ownable(owner_)
    {
        if (usdg_ == address(0) || weth_ == address(0) || dca_ == address(0)) revert ZeroAddress();
        if (usdg_ == weth_ || usdg_ == dca_ || weth_ == dca_) revert TokensNotDistinct();
        if (dca_.code.length == 0) revert NotAContract(dca_);
        usdg = IERC20(usdg_);
        weth = IWETH(weth_);
        dca = IERC20(dca_);
        _setRouter(router_);
        _setTreasury(treasury_);
    }

    modifier onlyOperator() {
        if (msg.sender != owner() && !isOperator[msg.sender]) revert NotOperator();
        _;
    }

    // ------------------------------------------------------------------
    // Fee flow (operators)
    // ------------------------------------------------------------------

    /// @notice Split everything of `token` that arrived since the last distribution: 70% to the treasury now,
    ///         30% into `buybackReserve[token]`.
    function distribute(address token)
        external
        onlyOperator
        nonReentrant
        returns (uint256 toTreasury, uint256 toBuyback)
    {
        (toTreasury, toBuyback) = _distribute(token);
        if (toTreasury + toBuyback == 0) revert NothingToDistribute(token);
    }

    /// @notice `distribute` for several tokens; tokens with nothing pending are skipped instead of reverting.
    function distributeMany(address[] calldata tokens) external onlyOperator nonReentrant {
        for (uint256 i; i < tokens.length; ++i) {
            _distribute(tokens[i]);
        }
    }

    /// @notice Buy $DCA with up to `amountIn` of `tokenIn`'s reserve (`type(uint256).max` = all of it) and burn it.
    ///         `minOut` is floored at the router's quote less `maxSlippageBps`; pass a higher reference-price value
    ///         under MEV. `tokenIn == dca` burns the reserve directly (no swap).
    function buyback(address tokenIn, uint256 amountIn, uint256 minOut)
        external
        onlyOperator
        nonReentrant
        returns (uint256 spent, uint256 burned)
    {
        uint256 r = buybackReserve[tokenIn];
        if (amountIn == type(uint256).max) amountIn = r;
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > r) revert InsufficientReserve(tokenIn, amountIn, r);

        if (tokenIn == address(dca)) {
            buybackReserve[tokenIn] = r - amountIn;
            _burn(amountIn);
            emit BoughtBack(tokenIn, amountIn, amountIn);
            return (amountIn, amountIn);
        }

        (spent, burned) = _swap(tokenIn, address(dca), amountIn, minOut);
        buybackReserve[tokenIn] = r - spent;
        _burn(burned);
        emit BoughtBack(tokenIn, spent, burned);
    }

    /// @notice Move a Stock Token's reserve into the USDG or WETH reserve (the tokens that have a $DCA route).
    ///         Never USDG, WETH or $DCA as `tokenIn`: a base reserve can only ever go to `buyback`.
    function convert(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        onlyOperator
        nonReentrant
        returns (uint256 spent, uint256 out)
    {
        if (tokenIn == address(usdg) || tokenIn == address(weth) || tokenIn == address(dca)) {
            revert NotConvertible(tokenIn);
        }
        if (tokenOut != address(usdg) && tokenOut != address(weth)) revert InvalidConversionTarget(tokenOut);

        uint256 r = buybackReserve[tokenIn];
        if (amountIn == type(uint256).max) amountIn = r;
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > r) revert InsufficientReserve(tokenIn, amountIn, r);

        (spent, out) = _swap(tokenIn, tokenOut, amountIn, minOut);
        buybackReserve[tokenIn] = r - spent;
        buybackReserve[tokenOut] += out;
        emit Converted(tokenIn, tokenOut, spent, out);
    }

    /// @notice Wrap any ETH sitting here into WETH so it flows through `distribute`. Anyone may call.
    function wrapEth() external nonReentrant {
        uint256 bal = address(this).balance;
        if (bal == 0) revert ZeroAmount();
        weth.deposit{value: bal}();
        emit EthWrapped(bal);
    }

    receive() external payable {}

    // ------------------------------------------------------------------
    // Admin (owner)
    // ------------------------------------------------------------------

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    /// @notice Swap the router. This contract holds no standing approvals, so there is nothing to revoke.
    function setRouter(address router_) external onlyOwner {
        _setRouter(router_);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setMaxSlippageBps(uint16 bps) external onlyOwner {
        if (bps > MAX_SLIPPAGE_BPS) revert SlippageOutOfRange(bps, MAX_SLIPPAGE_BPS);
        maxSlippageBps = bps;
        emit MaxSlippageSet(bps);
    }

    /// @notice Tune the on-path price guard. `window = 0` turns it off (then `maxTicks` is ignored);
    ///         `allowUnguarded` lets hops without a V3 oracle (V4) execute unchecked while the guard is on.
    function setGuard(uint32 window, uint24 maxTicks, bool allowUnguarded) external onlyOwner {
        if (window != 0 && maxTicks == 0) revert InvalidGuard();
        guardWindow = window;
        guardMaxTicks = maxTicks;
        allowUnguardedHops = allowUnguarded;
        emit GuardSet(window, maxTicks, allowUnguarded);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice `token` received since the last distribution: balance not yet earmarked for buybacks.
    function pending(address token) public view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 r = buybackReserve[token];
        return bal > r ? bal - r : 0;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _distribute(address token) internal returns (uint256 toTreasury, uint256 toBuyback) {
        uint256 amount = pending(token);
        if (amount == 0) return (0, 0);
        toTreasury = FeeMath.feeOf(amount, TREASURY_BPS);
        toBuyback = amount - toTreasury;
        buybackReserve[token] += toBuyback;
        address to = treasury;
        if (toTreasury > 0) IERC20(token).safeTransfer(to, toTreasury);
        emit Distributed(token, to, toTreasury, toBuyback);
    }

    /// @dev Quote on the router, floor `minOut` at quote × (1 − maxSlippageBps), swap along the quoted path with a
    ///      one-shot exact approval, and measure what really moved. A partially filled second hop refunds its
    ///      unspent WETH here (router semantics): that stays in the WETH reserve.
    function _swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 spent, uint256 out)
    {
        IAggregatorRouter r = router;
        (uint256 quoted, Route[] memory path) = r.quote(tokenIn, tokenOut, amountIn);
        _checkPath(path);
        uint256 floor = FeeMath.applySlippage(quoted, maxSlippageBps);
        if (floor == 0) revert QuoteTooSmall();
        if (minOut < floor) minOut = floor;

        IERC20 tin = IERC20(tokenIn);
        IERC20 tout = IERC20(tokenOut);
        bool trackWeth = tokenIn != address(weth) && tokenOut != address(weth);
        uint256 inBefore = tin.balanceOf(address(this));
        uint256 outBefore = tout.balanceOf(address(this));
        uint256 wethBefore = trackWeth ? weth.balanceOf(address(this)) : 0;

        tin.forceApprove(address(r), amountIn);
        r.swapWithRoute(tokenIn, tokenOut, amountIn, minOut, address(this), path);
        tin.forceApprove(address(r), 0);

        spent = inBefore - tin.balanceOf(address(this));
        out = tout.balanceOf(address(this)) - outBefore;
        if (out < minOut) revert InsufficientOutput(out, minOut);
        if (trackWeth) {
            uint256 wethIn = weth.balanceOf(address(this)) - wethBefore;
            if (wethIn > 0) buybackReserve[address(weth)] += wethIn;
        }
    }

    /// @dev `burn(amount)` if the token has one and it really burned; otherwise send to `DEAD`. Reverts if a
    ///      "burn" moved some other amount.
    function _burn(uint256 amount) internal {
        uint256 before = dca.balanceOf(address(this));
        (bool ok,) = address(dca).call(abi.encodeCall(IBurnable.burn, (amount)));
        uint256 after_ = dca.balanceOf(address(this));
        bool viaBurn;
        if (ok && after_ == before - amount) {
            viaBurn = true;
        } else if (after_ == before) {
            dca.safeTransfer(DEAD, amount);
        } else {
            revert BurnFailed();
        }
        totalBurned += amount;
        emit Burned(amount, viaBurn);
    }

    /// @dev Revert unless every V3-style pool on `path` is trading within `guardMaxTicks` of its TWAP. A V3 /
    ///      Ramses hop carries `abi.encode(pool)` in `extra`; anything else has no oracle here.
    function _checkPath(Route[] memory path) internal view {
        uint32 window = guardWindow;
        if (window == 0) return;
        uint24 maxTicks = guardMaxTicks;
        bool allowUnguarded = allowUnguardedHops;
        for (uint256 i; i < path.length; ++i) {
            if (path[i].extra.length != 32) {
                if (allowUnguarded) continue;
                revert UnguardedHop(i);
            }
            address pool = abi.decode(path[i].extra, (address));
            int24 twap = TwapOracle.consultTick(pool, window);
            int24 spot = _spotTick(pool);
            int256 dev = int256(spot) - int256(twap);
            if (dev < 0) dev = -dev;
            // casting to 'uint256' is safe: `dev` is the absolute value of a difference of two int24s (>= 0)
            // forge-lint: disable-next-line(unsafe-typecast)
            if (uint256(dev) > maxTicks) revert PriceDeviates(pool, spot, twap, maxTicks);
        }
    }

    /// @dev Current tick from `slot0`, decoding only the first two words so forks with extra fields still work.
    function _spotTick(address pool) internal view returns (int24 tick) {
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSelector(IUniswapV3Pool.slot0.selector));
        if (!ok || ret.length < 64) revert GuardUnavailable(pool);
        (, tick) = abi.decode(ret, (uint160, int24));
    }

    function _setTreasury(address treasury_) internal {
        if (treasury_ == address(0) || treasury_ == address(this)) revert InvalidTreasury(treasury_);
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _setRouter(address router_) internal {
        if (router_ == address(0)) revert ZeroAddress();
        if (IAggregatorRouter(router_).weth() != address(weth)) revert RouterWethMismatch(router_);
        router = IAggregatorRouter(router_);
        emit RouterSet(router_);
    }
}
