// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Plan, FeeConfig} from "../vault/VaultTypes.sol";

/// @title IPlanVault
/// @notice External surface of a DCA frequency vault (Daily / Weekly / Monthly).
interface IPlanVault {
    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error ZeroAddress();
    error ZeroAmount();
    error NotPlanOwner(uint256 planId);
    error PlanNotFound(uint256 planId);
    error StockNotPurchasable(address stock);
    error EpochNotDue(address stock, uint32 currentEpoch);
    error EpochInProgress(address stock);
    error NotKeeper();
    /// @notice Owner-only change attempted by the feeManager (swap slippage / keeper tip).
    error NotOwner();
    error SwapReturnedZero();
    error Overspent(uint256 expected, uint256 actual);
    error InsufficientIdle(uint256 requested, uint256 available);
    error InsufficientAccrued(uint256 requested, uint256 available);
    error PlanNotEmpty(uint256 planId);
    error TokenNotRescuable(address token);
    error BadOrigin();
    error ValueOutOfRange(uint256 value, uint256 max);
    error BelowMinimum(uint256 value, uint256 min);
    error OverrideMinOutTooLow(uint256 minOut, uint256 required);
    /// @notice The page's quote is so small that its minOut rounds to zero.
    error QuoteTooSmall();
    error BoostUnavailable();
    error BoostInUse();
    error BoostAssetMismatch(address asset);
    /// @notice The boost strategy credited fewer shares / less value than the USDG deposited (audit v0.3 M-01).
    error BoostDepositLost(uint256 deposited, uint256 credited);
    /// @notice `skim` only reconciles USDG, WETH and listed stocks; anything else goes through `rescueERC20`.
    error NotSkimmable(address token);
    /// @notice A router must share the vault's WETH (sanity check on `setRouter`).
    error RouterMismatch(address router);
    /// @notice The page's `minOut` is below the reference price floor (audit v0.3 H-01): retry when the pool is fair.
    error PriceDeviates(address stock, uint256 minOut, uint256 floor);
    /// @notice `requireFeed` is on and `stock` has no reference feed.
    error PriceFeedMissing(address stock);
    /// @notice The stock's feed is stale, zero or from the future.
    error PriceFeedStale(address stock);
    /// @notice The L2 sequencer is down or came back too recently (see `setPriceGuard`).
    error SequencerDown();
    /// @notice A feed that does not answer, answers zero, or a zero staleness window.
    error InvalidFeed(address feed);

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event PlanCreated(
        uint256 indexed planId, address indexed owner, address indexed stock, uint96 amountPerEpoch, address recipient
    );
    event PlanAmountSet(uint256 indexed planId, uint96 amountPerEpoch);
    event PlanRecipientSet(uint256 indexed planId, address recipient);
    event PlanPausedSet(uint256 indexed planId, bool paused);
    event PlanBoostSet(uint256 indexed planId, bool boosted);
    /// @notice USDG of a boosted plan lent out through the boost strategy; `shares` are vault-internal pool shares.
    event BoostDeposited(uint256 indexed planId, uint256 usdgIn, uint256 shares);
    /// @notice Boosted USDG pulled back for a spend, a withdrawal or an unboost. `earned` is the yield realised
    ///         by this withdrawal (the part of `usdgOut` above the plan's pro-rata cost basis).
    event BoostWithdrawn(uint256 indexed planId, uint256 usdgOut, uint256 shares, uint256 earned);
    /// @notice The strategy could not pay out this page's boosted spend (e.g. the market is fully utilised):
    ///         boosted plans sit this page out, everyone else is filled as usual.
    event BoostWithdrawFailed(address indexed stock, uint32 indexed epochId, uint256 usdgRequested, bytes reason);
    event BoostStrategySet(address strategy, uint256 migratedUsdg);
    event PlanIndexed(uint256 indexed planId, address indexed stock, bool indexed active);
    /// @notice `closePlan` ran: `usdgOut` idle USDG and `stockOut` accrued stock left the vault (gross; the fees
    ///         are in the accompanying `IdleWithdrawn` / `Claimed`). `unindexed` is false only when an epoch page
    ///         was pending for the stock and the plan was still in its iteration list: it is then paused and stays
    ///         indexed until `prunePlan` (or a later `closePlan`) drops it. A plan that is already out of the list
    ///         (pruned or closed before) reports `unindexed = true` whatever the epoch state.
    event PlanClosed(uint256 indexed planId, address indexed owner, uint256 usdgOut, uint256 stockOut, bool unindexed);
    event Deposited(uint256 indexed planId, address indexed token, address from, uint256 amount, uint256 fee);
    /// @notice WETH/ETH deposit converted to USDG. `wethRefunded` is any unfilled remainder returned to the depositor.
    event WethZapped(uint256 indexed planId, uint256 wethIn, uint256 usdgOut, uint256 wethRefunded);
    event IdleWithdrawn(uint256 indexed planId, uint256 usdgAmount, uint256 usdgFee);
    event PlanFilled(
        uint256 indexed planId,
        uint32 indexed epochId,
        uint256 spendUsdg,
        uint256 feeUsdg,
        uint256 stockShare,
        bool autoDistributed
    );
    event EpochPageExecuted(
        address indexed stock,
        uint32 indexed epochId,
        uint256 fromIndex,
        uint256 toIndex,
        uint256 netUsdg,
        uint256 stockOut,
        uint32 plansFilled
    );
    event EpochExecuted(address indexed stock, uint32 indexed epochId);
    event Claimed(
        uint256 indexed planId, address indexed stock, address indexed recipient, uint256 amount, uint256 fee
    );
    event DustSwept(address indexed token, address indexed to, uint256 amount);
    /// @notice Unaccounted balance of `token` booked into the vault's dust sinks (see `skim`).
    event Skimmed(address indexed token, uint256 amount);
    event FeeConfigSet(FeeConfig fees);
    event ThresholdsSet(uint256 autoDistributeThreshold, uint256 feeHalveThreshold);
    event MinimumsSet(uint256 minAmountPerEpoch, uint256 minDeposit);
    event DustSweepMinSet(uint256 minUsdg);
    event MaxPlansPerTxSet(uint16 maxPlansPerTx);
    /// @notice Page notional cap (USDG) for `stock`, or the vault-wide default when `stock == address(0)`.
    event MaxPageNotionalSet(address indexed stock, uint256 amount);
    /// @notice A plan's spend alone exceeds the page cap: it sat this epoch out (lower `amountPerEpoch`).
    event PlanTooLarge(uint256 indexed planId, uint256 spend, uint256 cap);
    event RouterSet(address router);
    event FeeRecipientSet(address feeRecipient);
    event FeeManagerSet(address feeManager);
    event KeeperSet(address indexed keeper, bool allowed);
    event KeeperOnlySet(bool keeperOnly);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event PriceFeedSet(address indexed stock, address feed, uint32 maxStaleness);
    event PriceGuardSet(uint16 maxDeviationBps, bool requireFeed, address sequencerFeed, uint32 sequencerGrace);

    // ------------------------------------------------------------------
    // Plans
    // ------------------------------------------------------------------
    function createPlan(
        address stock,
        uint96 amountPerEpoch,
        address recipient,
        uint256 usdgAmount,
        uint256 wethAmount,
        uint256 minUsdgOut,
        bool boost
    ) external payable returns (uint256 planId);
    function depositUSDG(uint256 planId, uint256 amount) external;
    function depositWETH(uint256 planId, uint256 amount, uint256 minUsdgOut) external;
    function depositETH(uint256 planId, uint256 minUsdgOut) external payable;
    function withdrawIdle(uint256 planId, uint256 usdgAmount) external;
    function claim(uint256 planId, uint256 amount) external;
    function claimAll(address stock) external;
    function setPlanPaused(uint256 planId, bool paused) external;
    function setPlanBoost(uint256 planId, bool enabled) external;
    function setPlanAmount(uint256 planId, uint96 amountPerEpoch) external;
    function setPlanRecipient(uint256 planId, address recipient) external;
    function prunePlan(uint256 planId) external;
    function closePlan(uint256 planId) external;

    // ------------------------------------------------------------------
    // Epochs
    // ------------------------------------------------------------------
    function advanceEpoch(address stock, uint256 limit, bytes calldata routeOverride) external returns (bool completed);
    function sweepDust() external;
    function skim(address token) external;
    function currentEpochId() external view returns (uint32);
    function nextEpochStart() external view returns (uint256);
    function isEpochDue(address stock) external view returns (bool);
    function isEpochPending(address stock) external view returns (bool);
    function lastExecutedEpoch(address stock) external view returns (uint32);
    function nextPlanIndex(address stock, uint32 epochId) external view returns (uint32);

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    function getPlan(uint256 planId) external view returns (Plan memory);
    function userPlans(address user) external view returns (uint256[] memory);
    function stockPlanCount(address stock) external view returns (uint256);
    function fees() external view returns (FeeConfig memory);
    function setFees(FeeConfig calldata f) external;
    function effectivePurchaseFeeBps(address user) external view returns (uint16);
    function isAutoDistribute(address user) external view returns (bool);
    function epochLength() external view returns (uint32);
    function origin() external view returns (uint64);
    function usdg() external view returns (address);
    function weth() external view returns (address);
    function dca() external view returns (address);
    function registry() external view returns (address);
    function router() external view returns (address);
    function feeRecipient() external view returns (address);
    function autoDistributeThreshold() external view returns (uint256);
    function feeHalveThreshold() external view returns (uint256);
    function minAmountPerEpoch() external view returns (uint256);
    function minDeposit() external view returns (uint256);
    function dustSweepMinUsdg() external view returns (uint256);
    function maxPlansPerTx() external view returns (uint16);
    function totalUsdgIdle() external view returns (uint256);
    function boostStrategy() external view returns (address);
    function setBoostStrategy(address strategy) external;
    function setMaxPageNotional(address stock, uint256 amount) external;
    function maxPageNotional() external view returns (uint256);
    function maxPageNotionalOf(address stock) external view returns (uint256);
    function setPriceFeed(address stock, address feed, uint32 maxStaleness) external;
    function setPriceGuard(uint16 maxDeviationBps, bool requireFeed, address sequencerFeed, uint32 sequencerGrace)
        external;
    function priceFeed(address stock)
        external
        view
        returns (address feed, uint32 maxStaleness, uint8 feedDecimals, uint8 stockDecimals);
    function priceGuard()
        external
        view
        returns (uint16 maxDeviationBps, bool requireFeed, address sequencerFeed, uint32 sequencerGrace);
    function totalBoostShares() external view returns (uint256);
    function boostAssets() external view returns (uint256);
    function totalStockAccrued(address stock) external view returns (uint256);
    function userStockAccrued(address user, address stock) external view returns (uint256);
    function dustPot(address stock) external view returns (uint256);
    function usdgDust() external view returns (uint256);
    function wethDust() external view returns (uint256);
    function totalNotionalUsdg() external view returns (uint256);
    function epochsCompleted() external view returns (uint256);
}
