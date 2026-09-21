// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IMorpho, IIrm, Id, MarketParams, Market} from "../interfaces/IMorpho.sol";

/// @title MorphoLib
/// @notice Morpho Blue share math and interest projection, so a position can be valued in a `view` exactly as
///         Morpho itself will value it when the next state-changing call accrues interest.
/// @dev Formulae and rounding follow morpho-blue's `SharesMathLib`, `MathLib` and `MorphoBalancesLib`
///      (virtual shares / assets, third-order Taylor compounding). Reimplemented so the build carries no
///      external dependency beyond OpenZeppelin.
library MorphoLib {
    using SafeCast for uint256;

    uint256 internal constant WAD = 1e18;
    /// @dev Morpho's virtual offsets: every market starts with 1e6 virtual shares backing 1 virtual asset.
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    function id(MarketParams memory p) internal pure returns (Id) {
        return Id.wrap(keccak256(abi.encode(p)));
    }

    function toSharesDown(uint256 assets, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return Math.mulDiv(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    function toAssetsDown(uint256 shares, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return Math.mulDiv(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    function toSharesUp(uint256 assets, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return Math.mulDiv(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS, Math.Rounding.Ceil);
    }

    function toAssetsUp(uint256 shares, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return Math.mulDiv(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES, Math.Rounding.Ceil);
    }

    /// @dev Continuous compounding of a per-second rate `x` (WAD) over `n` seconds, to the third Taylor term.
    function wTaylorCompounded(uint256 x, uint256 n) internal pure returns (uint256) {
        uint256 firstTerm = x * n;
        uint256 secondTerm = Math.mulDiv(firstTerm, firstTerm, 2 * WAD);
        uint256 thirdTerm = Math.mulDiv(secondTerm, firstTerm, 3 * WAD);
        return firstTerm + secondTerm + thirdTerm;
    }

    /// @notice Market totals as they will be once interest is accrued at the current block.
    function expectedMarket(IMorpho morpho, MarketParams memory p) internal view returns (Market memory m) {
        m = morpho.market(id(p));
        uint256 elapsed = block.timestamp - m.lastUpdate;
        if (elapsed == 0 || m.totalBorrowAssets == 0 || p.irm == address(0)) return m;
        uint256 rate = IIrm(p.irm).borrowRateView(p, m);
        uint256 interest = Math.mulDiv(m.totalBorrowAssets, wTaylorCompounded(rate, elapsed), WAD);
        m.totalBorrowAssets += interest.toUint128();
        m.totalSupplyAssets += interest.toUint128();
        if (m.fee != 0) {
            uint256 feeAmount = Math.mulDiv(interest, m.fee, WAD);
            uint256 feeShares = toSharesDown(feeAmount, m.totalSupplyAssets - feeAmount, m.totalSupplyShares);
            m.totalSupplyShares += feeShares.toUint128();
        }
    }

    /// @notice Loan tokens `user` could withdraw right now for its whole supply position, interest included.
    function expectedSupplyAssets(IMorpho morpho, MarketParams memory p, address user) internal view returns (uint256) {
        Market memory m = expectedMarket(morpho, p);
        return toAssetsDown(morpho.position(id(p), user).supplyShares, m.totalSupplyAssets, m.totalSupplyShares);
    }
}
