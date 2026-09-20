// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {IPlanVault} from "../interfaces/IPlanVault.sol";
import {IAggregatorRouter} from "../router/IAggregatorRouter.sol";

/// @title Zap
/// @notice Stateless ETH/WETH <-> USDG conveniences on top of the AggregatorRouter, plus "deposit ETH as
///         USDG into a plan" (useful for zap-at-epoch plans whose owner wants USDG credited instead of WETH).
/// @dev Never holds funds between transactions. Approvals: router (for swaps) and vaults (for deposits),
///      granted per call with exact amounts.
contract Zap is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeERC20 for IWETH;

    IWETH public immutable weth;
    IERC20 public immutable usdg;
    IAggregatorRouter public immutable router;

    error ZeroAmount();
    error EthTransferFailed();
    error OnlyWeth();

    event ZappedEthToUsdg(address indexed sender, address indexed recipient, uint256 ethIn, uint256 usdgOut);
    event ZappedUsdgToEth(address indexed sender, address indexed recipient, uint256 usdgIn, uint256 ethOut);
    event ZappedEthToPlan(
        address indexed sender, address indexed vault, uint256 indexed planId, uint256 ethIn, uint256 usdgOut
    );

    constructor(address weth_, address usdg_, address router_) {
        weth = IWETH(weth_);
        usdg = IERC20(usdg_);
        router = IAggregatorRouter(router_);
    }

    receive() external payable {
        if (msg.sender != address(weth)) revert OnlyWeth();
    }

    /// @notice Swap ETH for USDG via the best route.
    function swapEthForUsdg(uint256 minOut, address recipient) external payable nonReentrant returns (uint256 out) {
        if (msg.value == 0) revert ZeroAmount();
        weth.deposit{value: msg.value}();
        out = _wethToUsdg(msg.value, minOut, recipient);
        emit ZappedEthToUsdg(msg.sender, recipient, msg.value, out);
    }

    /// @notice Swap USDG for ETH (unwrapped) via the best route.
    function swapUsdgForEth(uint256 amountIn, uint256 minOut, address recipient)
        external
        nonReentrant
        returns (uint256 out)
    {
        if (amountIn == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amountIn);
        usdg.forceApprove(address(router), amountIn);
        out = router.swap(address(usdg), address(weth), amountIn, minOut, address(this));
        weth.withdraw(out);
        (bool ok,) = recipient.call{value: out}("");
        if (!ok) revert EthTransferFailed();
        emit ZappedUsdgToEth(msg.sender, recipient, amountIn, out);
    }

    /// @notice Wrap + swap ETH to USDG and deposit it into an existing plan (any plan; deposits are open).
    function depositEthAsUsdg(address vault, uint256 planId, uint256 minOut)
        external
        payable
        nonReentrant
        returns (uint256 out)
    {
        if (msg.value == 0) revert ZeroAmount();
        weth.deposit{value: msg.value}();
        out = _wethToUsdg(msg.value, minOut, address(this));
        usdg.forceApprove(vault, out);
        IPlanVault(vault).depositUSDG(planId, out);
        emit ZappedEthToPlan(msg.sender, vault, planId, msg.value, out);
    }

    function _wethToUsdg(uint256 amountIn, uint256 minOut, address recipient) internal returns (uint256) {
        weth.forceApprove(address(router), amountIn);
        return router.swap(address(weth), address(usdg), amountIn, minOut, recipient);
    }
}
