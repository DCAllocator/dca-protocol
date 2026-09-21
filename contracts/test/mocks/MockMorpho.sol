// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMorpho, IIrm, Id, MarketParams, Market, Position} from "../../src/interfaces/IMorpho.sol";
import {MorphoLib} from "../../src/libraries/MorphoLib.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev Fixed per-second borrow rate (WAD). `borrowRate` and `borrowRateView` agree, like AdaptiveCurveIrm.
contract MockIrm is IIrm {
    uint256 public rate;

    constructor(uint256 ratePerSecond) {
        rate = ratePerSecond;
    }

    function setRate(uint256 ratePerSecond) external {
        rate = ratePerSecond;
    }

    function borrowRate(MarketParams memory, Market memory) external view returns (uint256) {
        return rate;
    }

    function borrowRateView(MarketParams memory, Market memory) external view returns (uint256) {
        return rate;
    }
}

/// @title MockMorpho
/// @notice Morpho Blue's lender-side surface with the real share maths and interest accrual (MorphoLib), for
///         tests and the local anvil stack. No collateral, oracle or liquidations: borrowing is simulated with
///         `mockBorrow` (a phantom borrower that takes loan tokens out) so utilisation — and therefore the supply
///         rate — is non-zero. Interest that accrues on the phantom debt is minted to the mock (the loan token
///         must be a MockERC20), so `balanceOf(mock) == totalSupplyAssets - totalBorrowAssets` always holds and
///         withdrawals are backed exactly as on the real contract. `mockLoss` writes off debt (socialised bad debt).
contract MockMorpho is IMorpho {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using MorphoLib for MarketParams;

    mapping(Id => Market) internal _market;
    mapping(Id => MarketParams) internal _params;
    mapping(Id => mapping(address => Position)) internal _position;
    address public feeRecipient;

    error MarketExists();
    error MarketNotCreated();
    error InconsistentInput();
    error InsufficientShares();
    error InsufficientLiquidity();
    error Unauthorized();

    constructor(address feeRecipient_) {
        feeRecipient = feeRecipient_;
    }

    // ------------------------------------------------------------------
    // Morpho Blue surface
    // ------------------------------------------------------------------

    function createMarket(MarketParams memory p) external returns (Id id) {
        id = p.id();
        if (_market[id].lastUpdate != 0) revert MarketExists();
        _market[id].lastUpdate = block.timestamp.toUint128();
        _params[id] = p;
    }

    function setFee(Id id, uint256 fee) external {
        _accrue(id);
        _market[id].fee = fee.toUint128();
    }

    function supply(MarketParams memory p, uint256 assets, uint256 shares, address onBehalf, bytes memory)
        external
        returns (uint256, uint256)
    {
        Id id = p.id();
        if (_market[id].lastUpdate == 0) revert MarketNotCreated();
        if ((assets == 0) == (shares == 0)) revert InconsistentInput();
        _accrue(id);
        Market storage m = _market[id];
        if (assets > 0) shares = MorphoLib.toSharesDown(assets, m.totalSupplyAssets, m.totalSupplyShares);
        else assets = MorphoLib.toAssetsUp(shares, m.totalSupplyAssets, m.totalSupplyShares);
        _position[id][onBehalf].supplyShares += shares;
        m.totalSupplyShares += shares.toUint128();
        m.totalSupplyAssets += assets.toUint128();
        IERC20(p.loanToken).safeTransferFrom(msg.sender, address(this), assets);
        return (assets, shares);
    }

    function withdraw(MarketParams memory p, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external
        returns (uint256, uint256)
    {
        Id id = p.id();
        if (_market[id].lastUpdate == 0) revert MarketNotCreated();
        if ((assets == 0) == (shares == 0)) revert InconsistentInput();
        if (msg.sender != onBehalf) revert Unauthorized(); // no authorization registry in the mock
        _accrue(id);
        Market storage m = _market[id];
        if (assets > 0) shares = MorphoLib.toSharesUp(assets, m.totalSupplyAssets, m.totalSupplyShares);
        else assets = MorphoLib.toAssetsDown(shares, m.totalSupplyAssets, m.totalSupplyShares);
        Position storage pos = _position[id][onBehalf];
        if (pos.supplyShares < shares) revert InsufficientShares();
        pos.supplyShares -= shares;
        m.totalSupplyShares -= shares.toUint128();
        m.totalSupplyAssets -= assets.toUint128();
        if (m.totalBorrowAssets > m.totalSupplyAssets) revert InsufficientLiquidity();
        IERC20(p.loanToken).safeTransfer(receiver, assets);
        return (assets, shares);
    }

    function accrueInterest(MarketParams memory p) external {
        _accrue(p.id());
    }

    function market(Id id) external view returns (Market memory) {
        return _market[id];
    }

    function position(Id id, address user) external view returns (Position memory) {
        return _position[id][user];
    }

    function idToMarketParams(Id id) external view returns (MarketParams memory) {
        return _params[id];
    }

    // ------------------------------------------------------------------
    // Test hooks
    // ------------------------------------------------------------------

    /// @notice Phantom borrow: `assets` of debt appear (no collateral) and the loan tokens go to `to`.
    function mockBorrow(Id id, uint256 assets, address to) external {
        _accrue(id);
        Market storage m = _market[id];
        uint256 shares = MorphoLib.toSharesUp(assets, m.totalBorrowAssets, m.totalBorrowShares);
        m.totalBorrowAssets += assets.toUint128();
        m.totalBorrowShares += shares.toUint128();
        if (m.totalBorrowAssets > m.totalSupplyAssets) revert InsufficientLiquidity();
        IERC20(_params[id].loanToken).safeTransfer(to, assets);
    }

    /// @notice Repay phantom debt (caller pays).
    function mockRepay(Id id, uint256 assets) external {
        _accrue(id);
        Market storage m = _market[id];
        uint256 shares = MorphoLib.toSharesDown(assets, m.totalBorrowAssets, m.totalBorrowShares);
        m.totalBorrowAssets -= assets.toUint128();
        m.totalBorrowShares -= shares.toUint128();
        IERC20(_params[id].loanToken).safeTransferFrom(msg.sender, address(this), assets);
    }

    /// @notice Realise bad debt: `assets` of phantom debt are written off against suppliers (share price drops).
    function mockLoss(Id id, uint256 assets) external {
        _accrue(id);
        Market storage m = _market[id];
        m.totalBorrowAssets -= assets.toUint128();
        m.totalSupplyAssets -= assets.toUint128();
    }

    /// @dev Real Morpho accrual; the interest on phantom debt is minted so the pool stays fully backed.
    function _accrue(Id id) internal {
        Market storage m = _market[id];
        MarketParams memory p = _params[id];
        uint256 elapsed = block.timestamp - m.lastUpdate;
        if (elapsed == 0) return;
        if (m.totalBorrowAssets != 0 && p.irm != address(0)) {
            uint256 rate = IIrm(p.irm).borrowRate(p, m);
            uint256 interest =
                Math.mulDiv(m.totalBorrowAssets, MorphoLib.wTaylorCompounded(rate, elapsed), MorphoLib.WAD);
            m.totalBorrowAssets += interest.toUint128();
            m.totalSupplyAssets += interest.toUint128();
            if (m.fee != 0) {
                uint256 feeAmount = Math.mulDiv(interest, m.fee, MorphoLib.WAD);
                uint256 feeShares =
                    MorphoLib.toSharesDown(feeAmount, m.totalSupplyAssets - feeAmount, m.totalSupplyShares);
                _position[id][feeRecipient].supplyShares += feeShares;
                m.totalSupplyShares += feeShares.toUint128();
            }
            MockERC20(p.loanToken).mint(address(this), interest);
        }
        m.lastUpdate = block.timestamp.toUint128();
    }
}
