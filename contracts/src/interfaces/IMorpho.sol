// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Morpho Blue market id: keccak256 of the abi-encoded MarketParams.
type Id is bytes32;

/// @dev The five parameters that identify a Morpho Blue market.
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @dev One user's position in a market.
struct Position {
    uint256 supplyShares;
    uint128 borrowShares;
    uint128 collateral;
}

/// @dev Market totals. `fee` is a WAD fraction of interest that goes to Morpho's fee recipient.
struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

/// @title IMorpho
/// @notice The subset of Morpho Blue the protocol uses: supply / withdraw as a lender, plus the views needed to
///         value a position with interest accrued to the current block. ABI-identical to Morpho Blue's own
///         interface for these members (static structs encode as in-place tuples).
interface IMorpho {
    function supply(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsSupplied, uint256 sharesSupplied);
    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);
    function accrueInterest(MarketParams memory marketParams) external;
    function market(Id id) external view returns (Market memory);
    function position(Id id, address user) external view returns (Position memory);
    function idToMarketParams(Id id) external view returns (MarketParams memory);
}

/// @title IIrm
/// @notice Morpho Blue interest-rate model. `borrowRateView` is the per-second borrow rate (WAD) for the market
///         state passed in; `borrowRate` is the same value but lets adaptive models update their state.
interface IIrm {
    function borrowRate(MarketParams memory marketParams, Market memory market) external returns (uint256);
    function borrowRateView(MarketParams memory marketParams, Market memory market) external view returns (uint256);
}
