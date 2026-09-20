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
    error EthTransferFailed();
    error OnlyWeth();

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------
    event PlanCreated(
        uint256 indexed planId,
        address indexed owner,
        address indexed stock,
        uint96 amountPerEpoch,
        bool zapWethEachEpoch,
        address recipient
    );
    event PlanAmountSet(uint256 indexed planId, uint96 amountPerEpoch);
    event PlanRecipientSet(uint256 indexed planId, address recipient);
    event PlanSlippageSet(uint256 indexed planId, uint16 maxWethSlippageBps);
    event PlanPausedSet(uint256 indexed planId, bool paused);
    event PlanIndexed(uint256 indexed planId, address indexed stock, bool indexed active);
    event Deposited(uint256 indexed planId, address indexed token, address from, uint256 amount, uint256 fee);
    event IdleWithdrawn(
        uint256 indexed planId, uint256 usdgAmount, uint256 usdgFee, uint256 wethAmount, uint256 wethFee, bool unwrapped
    );
    event WethZapped(uint256 indexed planId, uint32 indexed epochId, uint256 wethIn, uint256 usdgOut);
    event PlanSkippedSlippage(uint256 indexed planId, uint32 indexed epochId, uint256 impactBps, uint256 capBps);
    event PlanSkippedNoRoute(uint256 indexed planId, uint32 indexed epochId);
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
    event FeeConfigSet(FeeConfig fees);
    event ThresholdsSet(uint256 autoDistributeThreshold, uint256 feeHalveThreshold);
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
        bool zapWethEachEpoch,
        address recipient,
        uint256 usdgAmount,
        uint256 wethAmount,
        uint256 minUsdgOut
    ) external payable returns (uint256 planId);
    function depositUSDG(uint256 planId, uint256 amount) external;
    function depositWETH(uint256 planId, uint256 amount, uint256 minUsdgOut) external;
    function depositETH(uint256 planId, uint256 minUsdgOut) external payable;
    function withdrawIdle(uint256 planId, uint256 usdgAmount, uint256 wethAmount, bool unwrap) external;
    function claim(uint256 planId, uint256 amount) external;
    function claimAll(address stock) external;
    function setPlanPaused(uint256 planId, bool paused) external;
    function setPlanAmount(uint256 planId, uint96 amountPerEpoch) external;
    function setPlanRecipient(uint256 planId, address recipient) external;
    function setPlanSlippage(uint256 planId, uint16 maxWethSlippageBps) external;
    function prunePlan(uint256 planId) external;

    // ------------------------------------------------------------------
    // Epochs
    // ------------------------------------------------------------------
    function advanceEpoch(address stock, uint256 limit, bytes calldata routeOverride) external returns (bool completed);
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
    function maxPlansPerTx() external view returns (uint16);
    function totalUsdgIdle() external view returns (uint256);
    function totalWethIdle() external view returns (uint256);
    function totalStockAccrued(address stock) external view returns (uint256);
    function userStockAccrued(address user, address stock) external view returns (uint256);
    function dustPot(address stock) external view returns (uint256);
    function totalNotionalUsdg() external view returns (uint256);
    function epochsCompleted() external view returns (uint256);
}
