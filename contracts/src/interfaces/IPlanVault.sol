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

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event PlanCreated(
        uint256 indexed planId, address indexed owner, address indexed stock, uint96 amountPerEpoch, address recipient
    );
    event PlanAmountSet(uint256 indexed planId, uint96 amountPerEpoch);
    event PlanRecipientSet(uint256 indexed planId, address recipient);
    event PlanPausedSet(uint256 indexed planId, bool paused);
    event PlanIndexed(uint256 indexed planId, address indexed stock, bool indexed active);
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
    /// @notice The page's purchase could not be quoted / executed; no plan was charged. The cursor still advances.
    event EpochPageSkipped(
        address indexed stock, uint32 indexed epochId, uint256 fromIndex, uint256 toIndex, bytes reason
    );
    event EpochExecuted(address indexed stock, uint32 indexed epochId);
    event Claimed(
        uint256 indexed planId, address indexed stock, address indexed recipient, uint256 amount, uint256 fee
    );
    event DustSwept(address indexed token, address indexed to, uint256 amount);
    event FeeConfigSet(FeeConfig fees);
    event ThresholdsSet(uint256 autoDistributeThreshold, uint256 feeHalveThreshold);
    event MinimumsSet(uint256 minAmountPerEpoch, uint256 minDeposit);
    event DustSweepMinSet(uint256 minUsdg);
    event MaxPlansPerTxSet(uint16 maxPlansPerTx);
    event RouterSet(address router);
    event FeeRecipientSet(address feeRecipient);
    event FeeManagerSet(address feeManager);
    event KeeperSet(address indexed keeper, bool allowed);
    event KeeperOnlySet(bool keeperOnly);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // ------------------------------------------------------------------
    // Plans
    // ------------------------------------------------------------------
    function createPlan(
        address stock,
        uint96 amountPerEpoch,
        address recipient,
        uint256 usdgAmount,
        uint256 wethAmount,
        uint256 minUsdgOut
    ) external payable returns (uint256 planId);
    function depositUSDG(uint256 planId, uint256 amount) external;
    function depositWETH(uint256 planId, uint256 amount, uint256 minUsdgOut) external;
    function depositETH(uint256 planId, uint256 minUsdgOut) external payable;
    function withdrawIdle(uint256 planId, uint256 usdgAmount) external;
    function claim(uint256 planId, uint256 amount) external;
    function claimAll(address stock) external;
    function setPlanPaused(uint256 planId, bool paused) external;
    function setPlanAmount(uint256 planId, uint96 amountPerEpoch) external;
    function setPlanRecipient(uint256 planId, address recipient) external;
    function prunePlan(uint256 planId) external;

    // ------------------------------------------------------------------
    // Epochs
    // ------------------------------------------------------------------
    function advanceEpoch(address stock, uint256 limit, bytes calldata routeOverride) external returns (bool completed);
    function sweepDust() external;
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
    function totalStockAccrued(address stock) external view returns (uint256);
    function userStockAccrued(address user, address stock) external view returns (uint256);
    function dustPot(address stock) external view returns (uint256);
    function usdgDust() external view returns (uint256);
    function wethDust() external view returns (uint256);
    function totalNotionalUsdg() external view returns (uint256);
    function epochsCompleted() external view returns (uint256);
}
