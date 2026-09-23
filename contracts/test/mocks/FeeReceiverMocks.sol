// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// forge-lint: disable-start(unsafe-typecast)

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAggregatorRouter, Route} from "../../src/router/IAggregatorRouter.sol";
import {FeeReceiver} from "../../src/treasury/FeeReceiver.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev $DCA stand-in with ERC20Burnable's `burn(uint256)` and a public mint (so MockRouter can pay it out).
contract BurnableDCA is ERC20, ERC20Burnable {
    constructor() ERC20("DCA", "DCA") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Token whose `burn(uint256)` "succeeds" without burning (a proxy fallback that swallows unknown selectors).
contract FakeBurnDCA is ERC20 {
    constructor() ERC20("FakeBurn", "FB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    fallback() external {}
}

/// @dev Token whose `burn(uint256)` burns half of what was asked.
contract HalfBurnDCA is ERC20 {
    constructor() ERC20("HalfBurn", "HB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount / 2);
    }
}

/// @dev V3-style pool surface for the price guard: settable spot tick and TWAP tick, `observe` consistent with
///      the TWAP tick over any window, optional revert (models "OLD" / not enough cardinality).
contract MockOraclePool {
    address public immutable token0;
    address public immutable token1;
    int24 public spotTick;
    int24 public twapTick;
    bool public observeReverts;
    uint256 public extraSlot0Words; // >0 = append fields like a Ramses fork

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function setTicks(int24 spot, int24 twap) external {
        spotTick = spot;
        twapTick = twap;
    }

    function setObserveReverts(bool v) external {
        observeReverts = v;
    }

    function setExtraSlot0Words(uint256 n) external {
        extraSlot0Words = n;
    }

    function slot0() external view returns (bytes memory) {
        // Raw-encoded so the test can model forks that append fields after the canonical seven.
        bytes memory ret = abi.encode(uint160(2 ** 96), spotTick, uint16(0), uint16(0), uint16(0), uint8(0), true);
        for (uint256 i; i < extraSlot0Words; ++i) {
            ret = bytes.concat(ret, abi.encode(uint256(0)));
        }
        assembly {
            return(add(ret, 0x20), mload(ret))
        }
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory liq)
    {
        require(!observeReverts, "OLD");
        tickCumulatives = new int56[](secondsAgos.length);
        liq = new uint160[](secondsAgos.length);
        int56 base = int56(uint56(type(uint32).max));
        for (uint256 i; i < secondsAgos.length; ++i) {
            tickCumulatives[i] = int56(twapTick) * (base - int56(uint56(secondsAgos[i])));
        }
    }
}

/// @dev Router that quotes honestly but delivers only `deliverBps` of it and ignores `minOut`. Also optionally
///      forwards `wethRefund` of WETH to the recipient (models an unspent hop-2 intermediate).
contract LyingRouter is IAggregatorRouter {
    address public immutable weth;
    uint16 public maxPriceImpactBps = 150;
    uint256 public rateNum = 1;
    uint256 public rateDen = 1;
    uint16 public deliverBps = 10_000;
    uint256 public wethRefund;
    bool public pullOnly; // take the input, pay nothing
    bytes[] public extras; // one entry per hop of the quoted path (empty = single hop with no extra)

    constructor(address weth_) {
        weth = weth_;
    }

    function setRate(uint256 num, uint256 den) external {
        rateNum = num;
        rateDen = den;
    }

    function setDeliverBps(uint16 bps) external {
        deliverBps = bps;
    }

    function setWethRefund(uint256 amount) external {
        wethRefund = amount;
    }

    function setPullOnly(bool v) external {
        pullOnly = v;
    }

    function setExtras(bytes[] calldata e) external {
        delete extras;
        for (uint256 i; i < e.length; ++i) {
            extras.push(e[i]);
        }
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, Route[] memory path)
    {
        amountOut = (amountIn * rateNum) / rateDen;
        uint256 n = extras.length == 0 ? 1 : extras.length;
        path = new Route[](n);
        for (uint256 i; i < n; ++i) {
            path[i] = Route({
                protocol: 1,
                tokenIn: i == 0 ? tokenIn : weth,
                tokenOut: i == n - 1 ? tokenOut : weth,
                fee: 3000,
                extra: extras.length == 0 ? bytes("") : extras[i]
            });
        }
    }

    function quoteWithImpact(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, Route[] memory path, uint256 impactBps)
    {
        (amountOut, path) = quote(tokenIn, tokenOut, amountIn);
        impactBps = 0;
    }

    function quotePath(Route[] calldata, uint256 amountIn) external view returns (uint256) {
        return (amountIn * rateNum) / rateDen;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256, address recipient)
        external
        returns (uint256)
    {
        return _swap(tokenIn, tokenOut, amountIn, recipient);
    }

    function swapWithRoute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256,
        address recipient,
        Route[] calldata
    ) external returns (uint256) {
        return _swap(tokenIn, tokenOut, amountIn, recipient);
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        internal
        returns (uint256 out)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        if (pullOnly) return 0;
        out = (((amountIn * rateNum) / rateDen) * deliverBps) / 10_000;
        if (out > 0) MockERC20(tokenOut).mint(recipient, out);
        if (wethRefund > 0) MockERC20(weth).mint(recipient, wethRefund);
    }
}

/// @dev ERC-20 whose `transfer` re-enters the FeeReceiver that is sending it.
contract ReentrantToken is ERC20 {
    enum Mode {
        None,
        Distribute,
        Buyback
    }

    Mode public mode;
    bool public reentered;
    bytes public lastRevert;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode != Mode.None && !reentered) {
            reentered = true;
            FeeReceiver fr = FeeReceiver(payable(msg.sender));
            if (mode == Mode.Distribute) fr.distribute(address(this));
            else fr.buyback(address(this), type(uint256).max, 0);
        }
        return super.transfer(to, amount);
    }
}
