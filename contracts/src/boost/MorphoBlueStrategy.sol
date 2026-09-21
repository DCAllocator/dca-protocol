// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IMorpho, IIrm, Id, MarketParams, Market} from "../interfaces/IMorpho.sol";
import {MorphoLib} from "../libraries/MorphoLib.sol";

/// @title MorphoBlueStrategy
/// @notice ERC-4626 vault over a single Morpho Blue market. Every asset deposited is supplied to the market in
///         the same transaction; every withdrawal is served by withdrawing from the market straight to the
///         receiver, so the contract never holds loan tokens between transactions.
///
///         PlanVaults use it as their `boostStrategy`: idle USDG of boosted plans is deposited here and earns the
///         market's supply rate. Any ERC-4626 with the same asset (a MetaMorpho vault, a plain holding vault)
///         can take its place — this contract is just the Morpho Blue flavour.
///
/// @dev Deposits are restricted to owner-approved depositors (the vaults) so share pricing can never be
///      nudged by third parties; withdrawals are open to any share holder. Share price = Morpho supply
///      position (interest projected to the current block, `MorphoLib.expectedSupplyAssets`) / total shares.
///      Withdrawals are bounded by the market's available liquidity (`totalSupplyAssets - totalBorrowAssets`):
///      a fully utilised market makes `withdraw` revert until borrowers repay or new suppliers arrive. Bad debt
///      realised on the market is socialised across all suppliers, including this contract (share price falls).
contract MorphoBlueStrategy is ERC4626, Ownable2Step {
    using SafeERC20 for IERC20;
    using MorphoLib for MarketParams;

    IMorpho public immutable morpho;
    Id public immutable marketId;
    MarketParams internal _params;
    /// @notice Addresses allowed to deposit / mint (the PlanVaults). Anyone holding shares may withdraw.
    mapping(address => bool) public isDepositor;

    error ZeroAddress();
    error MarketNotCreated(Id id);
    error NotDepositor(address caller);
    error TokenNotRescuable(address token);

    event DepositorSet(address indexed depositor, bool allowed);
    event Skimmed(uint256 assets);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    /// @param morpho_      Morpho Blue singleton.
    /// @param params       The market to lend into; `loanToken` becomes the ERC-4626 asset.
    /// @param initialOwner Manages the depositor list.
    constructor(address morpho_, MarketParams memory params, address initialOwner)
        ERC20(_name(params.loanToken), _symbol(params.loanToken))
        ERC4626(IERC20(params.loanToken))
        Ownable(initialOwner)
    {
        if (morpho_ == address(0)) revert ZeroAddress();
        Id id = params.id();
        if (IMorpho(morpho_).market(id).lastUpdate == 0) revert MarketNotCreated(id);
        morpho = IMorpho(morpho_);
        marketId = id;
        _params = params;
        IERC20(params.loanToken).forceApprove(morpho_, type(uint256).max);
    }

    // ------------------------------------------------------------------
    // ERC-4626
    // ------------------------------------------------------------------

    /// @notice Value of the whole supply position, interest accrued to the current block.
    function totalAssets() public view override returns (uint256) {
        return MorphoLib.expectedSupplyAssets(morpho, _params, address(this));
    }

    /// @notice Withdrawals are capped by what the market can pay out right now.
    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner), liquidity());
    }

    /// @inheritdoc ERC4626
    function maxRedeem(address owner) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner), _convertToShares(liquidity(), Math.Rounding.Floor));
    }

    /// @dev Pull the assets (ERC4626), then lend them on Morpho. Depositors only.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (!isDepositor[caller]) revert NotDepositor(caller);
        super._deposit(caller, receiver, assets, shares);
        morpho.supply(_params, assets, 0, address(this), "");
    }

    /// @dev Burn the shares, then have Morpho pay the receiver directly.
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        if (caller != owner) _spendAllowance(owner, caller, shares);
        _burn(owner, shares);
        morpho.withdraw(_params, assets, 0, address(this), receiver);
        emit Withdraw(caller, receiver, owner, assets, shares);
    }

    // ------------------------------------------------------------------
    // Market views (for frontends / the vault)
    // ------------------------------------------------------------------

    function marketParams() external view returns (MarketParams memory) {
        return _params;
    }

    /// @notice Loan tokens the market can pay out right now (supply minus borrows, interest projected).
    function liquidity() public view returns (uint256) {
        Market memory m = MorphoLib.expectedMarket(morpho, _params);
        return m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0;
    }

    /// @notice Current supply rate per second (WAD): `borrowRate × utilisation × (1 − marketFee)`, the rate
    ///         Morpho pays suppliers of this market at this block. APY = exp(rate × 365 days) − 1.
    function supplyRatePerSecond() external view returns (uint256) {
        if (_params.irm == address(0)) return 0;
        Market memory raw = morpho.market(marketId);
        uint256 borrowRate = IIrm(_params.irm).borrowRateView(_params, raw);
        Market memory m = MorphoLib.expectedMarket(morpho, _params);
        if (m.totalSupplyAssets == 0) return 0;
        uint256 utilization = Math.mulDiv(m.totalBorrowAssets, MorphoLib.WAD, m.totalSupplyAssets);
        uint256 rate = Math.mulDiv(borrowRate, utilization, MorphoLib.WAD);
        return Math.mulDiv(rate, MorphoLib.WAD - m.fee, MorphoLib.WAD);
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setDepositor(address depositor, bool allowed) external onlyOwner {
        if (depositor == address(0)) revert ZeroAddress();
        isDepositor[depositor] = allowed;
        emit DepositorSet(depositor, allowed);
    }

    /// @notice Lend any loan tokens sent here directly (they are not part of `totalAssets` until supplied);
    ///         the value accrues to all share holders. Permissionless.
    function skim() external {
        uint256 bal = IERC20(asset()).balanceOf(address(this));
        if (bal == 0) return;
        morpho.supply(_params, bal, 0, address(this), "");
        emit Skimmed(bal);
    }

    /// @notice Recover tokens that are not the loan token (the loan token is never held; use `skim`).
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        if (token == asset()) revert TokenNotRescuable(token);
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _name(address token) private view returns (string memory) {
        return string.concat("Boosted ", IERC20Metadata(token).symbol());
    }

    function _symbol(address token) private view returns (string memory) {
        return string.concat("b", IERC20Metadata(token).symbol());
    }
}
