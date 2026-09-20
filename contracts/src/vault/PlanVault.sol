// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IPlanVault} from "../interfaces/IPlanVault.sol";
import {IStockRegistry} from "../interfaces/IStockRegistry.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {IDCA} from "../token/IDCA.sol";
import {IAggregatorRouter, Route} from "../router/IAggregatorRouter.sol";
import {FeeMath} from "../libraries/FeeMath.sol";
import {EpochLib} from "../libraries/EpochLib.sol";
import {Plan, FeeConfig, VaultParams} from "./VaultTypes.sol";

/// @title PlanVault
/// @notice Shared implementation of a DCA frequency vault. Daily / Weekly / Monthly are thin subclasses
///         that fix `epochLength` and the default purchase fee.
///
/// @dev Accounting model
///      - Every user balance lives on a Plan: usdgIdle, wethIdle, stockAccrued.
///      - Fees leave the vault the moment they are taken; the vault never holds protocol USDG/WETH.
///      - Rounding dust from pro-rata stock distribution stays in `dustPot[stock]` and is folded into the
///        next epoch's distribution for that stock (user-favourable; never sent to the treasury).
///      - Invariants (see test/invariant):
///          stock.balanceOf(vault) >= totalStockAccrued[stock] + dustPot[stock]
///          usdg.balanceOf(vault)  >= totalUsdgIdle
///          weth.balanceOf(vault)  >= totalWethIdle
///
///      Epoch execution is paginated: `advanceEpoch(stock, limit, ...)` processes plans
///      [nextPlanIndex, nextPlanIndex + limit) of `stockPlans[stock]`, performing at most two swaps
///      (aggregate WETH->USDG zap, aggregate USDG->stock buy) per page. The epoch is "pending" until the
///      cursor reaches the end of the plan list, at which point it is marked executed. Only the CURRENT
///      epoch is ever executed: if the keeper misses an epoch it is skipped, never caught up (users are
///      charged at most one spend per epoch, never several at once).
///
///      $DCA perks are read as spot balances at execution / claim time (never at plan creation).
abstract contract PlanVault is IPlanVault, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeERC20 for IWETH;
    using FeeMath for uint256;
    using SafeCast for uint256;

    // ------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------
    IERC20 internal immutable _usdg;
    IWETH internal immutable _weth;
    IDCA internal immutable _dca;
    IStockRegistry internal immutable _registry;
    uint32 public immutable epochLength;
    uint64 public immutable origin;
    uint8 public immutable usdgDecimals;

    // ------------------------------------------------------------------
    // Config
    // ------------------------------------------------------------------
    IAggregatorRouter internal _router;
    address public feeRecipient;
    address public feeManager;
    bool public keeperOnly;
    uint16 public maxPlansPerTx = 150;
    FeeConfig internal _fees;
    uint256 public autoDistributeThreshold;
    uint256 public feeHalveThreshold;
    mapping(address => bool) public isKeeper;

    uint16 internal constant MAX_KEEPER_TIP_BPS = 5_000;
    uint16 internal constant MAX_SWAP_SLIPPAGE_BPS = 500;
    uint16 internal constant MAX_WETH_SLIPPAGE_BPS = 1_000;
    uint16 internal constant MAX_PLANS_PER_TX_CAP = 1_000;

    // ------------------------------------------------------------------
    // Plans
    // ------------------------------------------------------------------
    uint256 public nextPlanId = 1;
    mapping(uint256 => Plan) internal _plans;
    mapping(address => uint256[]) internal _userPlans;
    mapping(address => uint256[]) internal _stockPlans;
    /// @dev planId => index in _stockPlans[plan.stock] + 1 (0 = not indexed)
    mapping(uint256 => uint256) internal _stockPlanIndex;

    // ------------------------------------------------------------------
    // Aggregates
    // ------------------------------------------------------------------
    uint256 public totalUsdgIdle;
    uint256 public totalWethIdle;
    mapping(address => uint256) public totalStockAccrued;
    mapping(address => mapping(address => uint256)) public userStockAccrued;
    mapping(address => uint256) public dustPot;
    uint256 public totalNotionalUsdg;
    uint256 public epochsCompleted;

    // ------------------------------------------------------------------
    // Epochs
    // ------------------------------------------------------------------
    mapping(address => uint32) public lastExecutedEpoch;
    mapping(address => mapping(uint32 => uint32)) public nextPlanIndex;

    // ------------------------------------------------------------------
    // Transient execution structs (memory only)
    // ------------------------------------------------------------------
    struct Fill {
        uint256 planId;
        uint128 wethToZap;
        uint128 spend;
        uint128 net;
        uint128 fee;
        bool wethNeeded;
        bool skipped;
        bool autoDist;
    }

    struct Ctx {
        address stock;
        uint32 epochId;
        uint256 start; // page bounds in _stockPlans[stock]
        uint256 end;
        uint256 n; // number of fills
        uint256 wethCandidates;
        uint256 totalNet;
        uint256 totalFee;
        uint256 bought; // stock received from the swap this page
        uint32 filled;
    }

    // ------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------
    constructor(VaultParams memory p) Ownable(p.owner) {
        if (
            p.usdg == address(0) || p.weth == address(0) || p.registry == address(0) || p.router == address(0)
                || p.feeRecipient == address(0)
        ) revert ZeroAddress();
        if (p.epochLength == 0) revert ZeroAmount();
        // Epoch 0 must contain the deployment timestamp: guarantees epoch ids start at 0 and the first
        // executable epoch is 1 (see EpochLib alignment policy).
        // forge-lint: disable-next-line(block-timestamp)
        if (p.origin == 0 || p.origin > block.timestamp || block.timestamp - p.origin >= p.epochLength) {
            revert BadOrigin();
        }
        FeeMath.validate(p.purchaseFeeBps);

        _usdg = IERC20(p.usdg);
        _weth = IWETH(p.weth);
        _dca = IDCA(p.dca);
        _registry = IStockRegistry(p.registry);
        epochLength = p.epochLength;
        origin = p.origin;
        usdgDecimals = IERC20Metadata(p.usdg).decimals();
        feeRecipient = p.feeRecipient;

        _fees = FeeConfig({
            purchaseFeeBps: p.purchaseFeeBps,
            depositFeeBps: 0,
            withdrawFeeBps: 25,
            claimFeeBps: 25,
            keeperTipBps: 0,
            swapSlippageBps: 50,
            maxWethSlippageBps: 100
        });
        emit FeeConfigSet(_fees);

        uint8 dcaDec = p.dca == address(0) ? 18 : IDCA(p.dca).decimals();
        autoDistributeThreshold = 10_000 * 10 ** dcaDec;
        feeHalveThreshold = 50_000 * 10 ** dcaDec;
        emit ThresholdsSet(autoDistributeThreshold, feeHalveThreshold);

        _setRouter(p.router);
    }

    /// @dev Only WETH may push ETH here (on `withdraw`). Everything else is rejected so no stray ETH accrues.
    receive() external payable {
        if (msg.sender != address(_weth)) revert OnlyWeth();
    }

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------
    modifier onlyPlanOwner(uint256 planId) {
        if (_plans[planId].owner != msg.sender) revert NotPlanOwner(planId);
        _;
    }

    modifier onlyFeeManager() {
        if (msg.sender != owner() && msg.sender != feeManager) revert OwnableUnauthorizedAccount(msg.sender);
        _;
    }

    // ==================================================================
    // Plans
    // ==================================================================

    /// @inheritdoc IPlanVault
    /// @notice Open a plan and optionally fund it in the same transaction.
    /// @param stock            Registry-approved Stock Token.
    /// @param amountPerEpoch   USDG to spend each epoch (in USDG decimals). Must be > 0.
    /// @param zapWethEachEpoch true = hold WETH and zap at epoch (subject to slippage skip); false = zap on deposit.
    /// @param recipient        Receives stock. address(0) = msg.sender.
    /// @param usdgAmount       Initial USDG deposit (0 to skip).
    /// @param wethAmount       Initial WETH deposit (0 to skip). msg.value is additionally wrapped and deposited.
    /// @param minUsdgOut       Min USDG when zapping WETH/ETH on deposit (ignored for zap-at-epoch plans; 0 = quote-based).
    ///                         Applies to EACH leg separately if both `wethAmount` and `msg.value` are supplied.
    function createPlan(
        address stock,
        uint96 amountPerEpoch,
        bool zapWethEachEpoch,
        address recipient,
        uint256 usdgAmount,
        uint256 wethAmount,
        uint256 minUsdgOut
    ) external payable whenNotPaused nonReentrant returns (uint256 planId) {
        if (!_registry.isPurchasable(stock)) revert StockNotPurchasable(stock);
        if (amountPerEpoch == 0) revert ZeroAmount();
        if (recipient == address(0)) recipient = msg.sender;

        planId = nextPlanId++;
        Plan storage p = _plans[planId];
        p.owner = msg.sender;
        p.recipient = recipient;
        p.stock = stock;
        p.amountPerEpoch = amountPerEpoch;
        p.zapWethEachEpoch = zapWethEachEpoch;
        _userPlans[msg.sender].push(planId);
        _index(planId, stock);
        emit PlanCreated(planId, msg.sender, stock, amountPerEpoch, zapWethEachEpoch, recipient);

        if (usdgAmount > 0) _depositUSDG(planId, usdgAmount);
        if (wethAmount > 0) {
            _weth.safeTransferFrom(msg.sender, address(this), wethAmount);
            _creditWeth(planId, wethAmount, minUsdgOut);
        }
        if (msg.value > 0) {
            _weth.deposit{value: msg.value}();
            _creditWeth(planId, msg.value, minUsdgOut);
        }
    }

    /// @inheritdoc IPlanVault
    /// @notice Top up a plan with USDG. Anyone may fund any plan (it can only add value to it).
    function depositUSDG(uint256 planId, uint256 amount) external whenNotPaused nonReentrant {
        _requireFundable(planId);
        if (amount == 0) revert ZeroAmount();
        _depositUSDG(planId, amount);
    }

    /// @inheritdoc IPlanVault
    /// @notice Top up with WETH. Zapped to USDG immediately unless the plan is zap-at-epoch.
    function depositWETH(uint256 planId, uint256 amount, uint256 minUsdgOut) external whenNotPaused nonReentrant {
        _requireFundable(planId);
        if (amount == 0) revert ZeroAmount();
        _weth.safeTransferFrom(msg.sender, address(this), amount);
        _creditWeth(planId, amount, minUsdgOut);
    }

    /// @inheritdoc IPlanVault
    /// @notice Top up with ETH; wrapped to WETH immediately, then handled like `depositWETH`.
    function depositETH(uint256 planId, uint256 minUsdgOut) external payable whenNotPaused nonReentrant {
        _requireFundable(planId);
        if (msg.value == 0) revert ZeroAmount();
        _weth.deposit{value: msg.value}();
        _creditWeth(planId, msg.value, minUsdgOut);
    }

    /// @inheritdoc IPlanVault
    /// @notice Withdraw idle USDG / WETH. `type(uint256).max` = all. Withdraw fee applies. Works while paused.
    /// @param unwrap true = receive ETH instead of WETH.
    function withdrawIdle(uint256 planId, uint256 usdgAmount, uint256 wethAmount, bool unwrap)
        external
        nonReentrant
        onlyPlanOwner(planId)
    {
        _withdrawIdle(planId, usdgAmount, wethAmount, unwrap);
    }

    /// @inheritdoc IPlanVault
    /// @notice Claim accrued stock to the plan's recipient. `type(uint256).max` = all. Claim fee is 0 for
    ///         auto-distribute tier holders (>= autoDistributeThreshold $DCA at claim time). Works while paused.
    function claim(uint256 planId, uint256 amount) external nonReentrant onlyPlanOwner(planId) {
        _claim(planId, amount);
    }

    /// @inheritdoc IPlanVault
    /// @notice Claim every plan of msg.sender for `stock`.
    function claimAll(address stock) external nonReentrant {
        uint256[] storage ids = _userPlans[msg.sender];
        for (uint256 i; i < ids.length; ++i) {
            Plan storage p = _plans[ids[i]];
            if (p.stock == stock && p.stockAccrued > 0) _claim(ids[i], type(uint256).max);
        }
    }

    /// @inheritdoc IPlanVault
    function setPlanPaused(uint256 planId, bool paused) external onlyPlanOwner(planId) {
        _plans[planId].paused = paused;
        emit PlanPausedSet(planId, paused);
    }

    /// @inheritdoc IPlanVault
    function setPlanAmount(uint256 planId, uint96 amountPerEpoch) external onlyPlanOwner(planId) {
        if (amountPerEpoch == 0) revert ZeroAmount();
        _plans[planId].amountPerEpoch = amountPerEpoch;
        emit PlanAmountSet(planId, amountPerEpoch);
    }

    /// @inheritdoc IPlanVault
    function setPlanRecipient(uint256 planId, address recipient) external onlyPlanOwner(planId) {
        if (recipient == address(0)) revert ZeroAddress();
        _plans[planId].recipient = recipient;
        emit PlanRecipientSet(planId, recipient);
    }

    /// @inheritdoc IPlanVault
    /// @notice Per-plan WETH zap impact cap. 0 = vault default.
    function setPlanSlippage(uint256 planId, uint16 maxWethSlippageBps) external onlyPlanOwner(planId) {
        if (maxWethSlippageBps > MAX_WETH_SLIPPAGE_BPS) {
            revert ValueOutOfRange(maxWethSlippageBps, MAX_WETH_SLIPPAGE_BPS);
        }
        _plans[planId].maxWethSlippageBps = maxWethSlippageBps;
        emit PlanSlippageSet(planId, maxWethSlippageBps);
    }

    /// @inheritdoc IPlanVault
    /// @notice Permissionless: drop an empty plan from epoch iteration so it stops costing keeper gas.
    ///         A later deposit re-indexes it automatically.
    function prunePlan(uint256 planId) external {
        Plan storage p = _plans[planId];
        if (p.owner == address(0)) revert PlanNotFound(planId);
        if (p.usdgIdle > 0 || p.wethIdle > 0 || p.stockAccrued > 0) revert PlanNotEmpty(planId);
        if (_isEpochPending(p.stock)) revert EpochInProgress(p.stock);
        _unindex(planId);
    }

    // ==================================================================
    // Epochs
    // ==================================================================

    /// @inheritdoc IPlanVault
    /// @notice Execute (a page of) the current epoch for `stock`. Permissionless unless `keeperOnly`.
    /// @param stock         Registry-approved Stock Token.
    /// @param limit         Max plans to process this call (0 or > maxPlansPerTx => maxPlansPerTx).
    /// @param routeOverride Empty for auto-routing. Owner/keepers may pass abi.encode(Route[] path, uint256 minOut)
    ///                      to force the USDG->stock route (WETH zaps always auto-route).
    /// @return completed True once the cursor reached the end of the plan list (epoch marked executed).
    function advanceEpoch(address stock, uint256 limit, bytes calldata routeOverride)
        external
        whenNotPaused
        nonReentrant
        returns (bool completed)
    {
        return _advanceEpoch(stock, limit, routeOverride);
    }

    function _advanceEpoch(address stock, uint256 limit, bytes memory routeOverride) internal returns (bool completed) {
        bool privileged = msg.sender == owner() || isKeeper[msg.sender];
        if (keeperOnly && !privileged) revert NotKeeper();
        if (routeOverride.length != 0 && !privileged) revert NotKeeper();
        if (!_registry.isPurchasable(stock)) revert StockNotPurchasable(stock);

        Ctx memory ctx;
        ctx.stock = stock;
        ctx.epochId = currentEpochId();
        if (ctx.epochId <= lastExecutedEpoch[stock]) revert EpochNotDue(stock, ctx.epochId);
        if (limit == 0 || limit > maxPlansPerTx) limit = maxPlansPerTx;

        uint256 len = _stockPlans[stock].length;
        ctx.start = nextPlanIndex[stock][ctx.epochId];
        ctx.end = ctx.start + limit;
        if (ctx.end > len) ctx.end = len;

        Fill[] memory fills = new Fill[](ctx.end - ctx.start);
        _collect(ctx, fills);
        if (ctx.wethCandidates > 0) _zapWeth(ctx, fills);
        _spend(ctx, fills);
        _payFees(ctx);
        if (ctx.totalNet > 0) _buyAndDistribute(ctx, fills, routeOverride);
        completed = _finalizePage(ctx, len);
    }

    /// @dev Phase 5+6 wrapper: buy stock for the page, fold in the dust pot, distribute, keep new dust.
    function _buyAndDistribute(Ctx memory ctx, Fill[] memory fills, bytes memory routeOverride) internal {
        (uint256 bought, uint256 residual) = _buyStock(ctx.stock, ctx.totalNet, routeOverride);
        ctx.bought = bought;
        uint256 pot = bought + dustPot[ctx.stock];
        uint256 distributed = _distribute(ctx, fills, pot, residual);
        dustPot[ctx.stock] = pot - distributed;
    }

    /// @dev Phase 7: cursor, stats and completion.
    function _finalizePage(Ctx memory ctx, uint256 len) internal returns (bool completed) {
        nextPlanIndex[ctx.stock][ctx.epochId] = ctx.end.toUint32();
        totalNotionalUsdg += ctx.totalNet;
        emit EpochPageExecuted(ctx.stock, ctx.epochId, ctx.start, ctx.end, ctx.totalNet, ctx.bought, ctx.filled);

        if (ctx.end == len) {
            lastExecutedEpoch[ctx.stock] = ctx.epochId;
            epochsCompleted += 1;
            emit EpochExecuted(ctx.stock, ctx.epochId);
            completed = true;
        }
    }

    // ------------------------------------------------------------------
    // Epoch phases
    // ------------------------------------------------------------------

    /// @dev Phase 1: pick eligible plans on this page and tally WETH that may need zapping.
    function _collect(Ctx memory ctx, Fill[] memory fills) internal view {
        uint256[] storage ids = _stockPlans[ctx.stock];
        uint256 n;
        for (uint256 i = ctx.start; i < ctx.end; ++i) {
            uint256 planId = ids[i];
            Plan storage p = _plans[planId];
            if (p.paused || p.lastEpochId == ctx.epochId || p.amountPerEpoch == 0) continue;
            if (p.usdgIdle == 0 && (p.wethIdle == 0 || !p.zapWethEachEpoch)) continue;
            Fill memory f = fills[n];
            f.planId = planId;
            if (p.zapWethEachEpoch && p.wethIdle > 0 && p.usdgIdle < p.amountPerEpoch) {
                f.wethNeeded = true;
                ctx.wethCandidates += p.wethIdle;
            }
            ++n;
        }
        ctx.n = n;
    }

    /// @dev Phase 2: size, cap and execute one aggregate WETH->USDG zap for plans that need it.
    function _zapWeth(Ctx memory ctx, Fill[] memory fills) internal {
        uint256 sumZap = _sizeZap(ctx, fills);
        if (sumZap == 0) {
            _skipAllWeth(ctx, fills);
            return;
        }
        // Real quote for what we will zap: gives the impact for the per-plan cap check and the minOut basis.
        (uint256 outZap, Route[] memory path, uint256 impactBps) =
            _router.quoteWithImpact(address(_weth), address(_usdg), sumZap);
        uint256 finalSum = _applyZapCaps(ctx, fills, impactBps);
        if (finalSum == 0) return;

        // Smaller amount than quoted => realised rate is at least as good; scale minOut linearly.
        uint256 minOut = FeeMath.applySlippage(Math.mulDiv(outZap, finalSum, sumZap), _fees.swapSlippageBps);
        (uint256 received, uint256 wethSpent) = _executeZap(finalSum, minOut, path);
        _creditZap(ctx, fills, received, wethSpent, finalSum);
    }

    /// @dev Sizing quote over every candidate WETH; the rate is conservative for the smaller amount actually zapped.
    ///      Returns the total WETH sized for zapping (0 if no route).
    function _sizeZap(Ctx memory ctx, Fill[] memory fills) internal returns (uint256 sumZap) {
        (bool ok, uint256 outAll) = _tryQuote(address(_weth), address(_usdg), ctx.wethCandidates);
        if (!ok || outAll == 0) return 0;
        for (uint256 j; j < ctx.n; ++j) {
            Fill memory f = fills[j];
            if (!f.wethNeeded) continue;
            Plan storage p = _plans[f.planId];
            uint256 deficit = uint256(p.amountPerEpoch) - p.usdgIdle;
            uint256 toZap = Math.mulDiv(deficit, ctx.wethCandidates, outAll, Math.Rounding.Ceil);
            if (toZap > p.wethIdle) toZap = p.wethIdle;
            f.wethToZap = toZap.toUint128();
            sumZap += toZap;
        }
    }

    /// @dev Skip plans whose cap is below the quoted impact. Returns the WETH sum that survives.
    function _applyZapCaps(Ctx memory ctx, Fill[] memory fills, uint256 impactBps) internal returns (uint256 finalSum) {
        for (uint256 j; j < ctx.n; ++j) {
            Fill memory f = fills[j];
            if (f.wethToZap == 0) continue;
            uint16 planCap = _plans[f.planId].maxWethSlippageBps;
            uint256 cap = planCap == 0 ? _fees.maxWethSlippageBps : planCap;
            if (impactBps > cap) {
                f.skipped = true;
                f.wethToZap = 0;
                emit PlanSkippedSlippage(f.planId, ctx.epochId, impactBps, cap);
            } else {
                finalSum += f.wethToZap;
            }
        }
    }

    function _executeZap(uint256 amountIn, uint256 minOut, Route[] memory path)
        internal
        returns (uint256 received, uint256 wethSpent)
    {
        uint256 usdgBefore = _usdg.balanceOf(address(this));
        uint256 wethBefore = _weth.balanceOf(address(this));
        _router.swapWithRoute(address(_weth), address(_usdg), amountIn, minOut, address(this), path);
        received = _usdg.balanceOf(address(this)) - usdgBefore;
        wethSpent = wethBefore - _weth.balanceOf(address(this));
        if (wethSpent > amountIn) revert Overspent(amountIn, wethSpent);
    }

    /// @dev Credit zap output pro-rata by WETH contributed; debit WETH actually spent.
    function _creditZap(Ctx memory ctx, Fill[] memory fills, uint256 received, uint256 wethSpent, uint256 finalSum)
        internal
    {
        for (uint256 j; j < ctx.n; ++j) {
            Fill memory f = fills[j];
            if (f.wethToZap == 0) continue;
            Plan storage p = _plans[f.planId];
            uint256 usdgShare = Math.mulDiv(received, f.wethToZap, finalSum);
            uint256 wethDeduct = Math.mulDiv(wethSpent, f.wethToZap, finalSum);
            p.wethIdle -= wethDeduct.toUint128();
            p.usdgIdle += usdgShare.toUint128();
            totalWethIdle -= wethDeduct;
            totalUsdgIdle += usdgShare;
            emit WethZapped(f.planId, ctx.epochId, wethDeduct, usdgShare);
        }
    }

    function _skipAllWeth(Ctx memory ctx, Fill[] memory fills) internal {
        for (uint256 j; j < ctx.n; ++j) {
            Fill memory f = fills[j];
            if (!f.wethNeeded) continue;
            f.skipped = true;
            f.wethToZap = 0;
            emit PlanSkippedNoRoute(f.planId, ctx.epochId);
        }
    }

    /// @dev Phase 3: compute spend / fee / net per plan, snapshot $DCA perks, debit idle USDG.
    function _spend(Ctx memory ctx, Fill[] memory fills) internal {
        for (uint256 j; j < ctx.n; ++j) {
            Fill memory f = fills[j];
            if (f.skipped) continue;
            Plan storage p = _plans[f.planId];
            uint256 spend = p.usdgIdle < p.amountPerEpoch ? p.usdgIdle : p.amountPerEpoch;
            if (spend == 0) {
                f.skipped = true;
                continue;
            }
            uint256 dcaBal = _dcaBalance(p.owner);
            uint16 bps = _fees.purchaseFeeBps;
            if (dcaBal >= feeHalveThreshold) bps = FeeMath.halve(bps);
            (uint256 net, uint256 fee) = FeeMath.split(spend, bps);

            p.usdgIdle -= spend.toUint128();
            p.lastEpochId = ctx.epochId;
            totalUsdgIdle -= spend;

            f.spend = spend.toUint128();
            f.net = net.toUint128();
            f.fee = fee.toUint128();
            f.autoDist = dcaBal >= autoDistributeThreshold;
            ctx.totalNet += net;
            ctx.totalFee += fee;
            ctx.filled += 1;
        }
    }

    /// @dev Phase 4: purchase fees leave the vault immediately (keeper tip carved out first).
    function _payFees(Ctx memory ctx) internal {
        if (ctx.totalFee == 0) return;
        uint256 tip = FeeMath.feeOf(ctx.totalFee, _fees.keeperTipBps);
        if (tip > 0) _usdg.safeTransfer(msg.sender, tip);
        _usdg.safeTransfer(feeRecipient, ctx.totalFee - tip);
    }

    /// @dev Phase 5: single USDG->stock swap. Measures real balance deltas; returns unspent USDG as `residual`.
    function _buyStock(address stock, uint256 amountIn, bytes memory routeOverride)
        internal
        returns (uint256 amountOut, uint256 residual)
    {
        uint256 usdgBefore = _usdg.balanceOf(address(this));
        uint256 stockBefore = IERC20(stock).balanceOf(address(this));

        Route[] memory path;
        uint256 minOut;
        if (routeOverride.length != 0) {
            (path, minOut) = abi.decode(routeOverride, (Route[], uint256));
            if (minOut == 0) revert ZeroAmount();
        } else {
            uint256 quoted;
            (quoted, path) = _router.quote(address(_usdg), stock, amountIn);
            minOut = FeeMath.applySlippage(quoted, _fees.swapSlippageBps);
        }
        _router.swapWithRoute(address(_usdg), stock, amountIn, minOut, address(this), path);

        amountOut = IERC20(stock).balanceOf(address(this)) - stockBefore;
        if (amountOut == 0) revert SwapReturnedZero();
        uint256 spent = usdgBefore - _usdg.balanceOf(address(this));
        if (spent > amountIn) revert Overspent(amountIn, spent);
        residual = amountIn - spent;
    }

    /// @dev Phase 6: pro-rata stock by net weight (floor). Auto-distribute or accrue. Returns stock handed out.
    function _distribute(Ctx memory ctx, Fill[] memory fills, uint256 amountOut, uint256 residual)
        internal
        returns (uint256 distributed)
    {
        for (uint256 j; j < ctx.n; ++j) {
            Fill memory f = fills[j];
            if (f.skipped || f.net == 0) continue;
            Plan storage p = _plans[f.planId];
            uint256 share = Math.mulDiv(amountOut, f.net, ctx.totalNet);
            if (residual > 0) {
                uint256 back = Math.mulDiv(residual, f.net, ctx.totalNet);
                p.usdgIdle += back.toUint128();
                totalUsdgIdle += back;
            }
            distributed += share;
            bool sent;
            if (f.autoDist && share > 0) sent = _tryTransfer(ctx.stock, p.recipient, share);
            if (!sent && share > 0) {
                p.stockAccrued += share.toUint128();
                totalStockAccrued[ctx.stock] += share;
                userStockAccrued[p.owner][ctx.stock] += share;
            }
            emit PlanFilled(f.planId, ctx.epochId, f.spend, f.fee, share, sent);
        }
    }

    // ==================================================================
    // Admin
    // ==================================================================

    /// @notice Replace the whole fee configuration. Every fee is capped at 90 bps; tolerances have their own caps.
    /// @dev Owner or feeManager. Emits the full config so indexers never need to diff.
    function setFees(FeeConfig calldata f) external onlyFeeManager {
        FeeMath.validate(f.purchaseFeeBps);
        FeeMath.validate(f.depositFeeBps);
        FeeMath.validate(f.withdrawFeeBps);
        FeeMath.validate(f.claimFeeBps);
        if (f.keeperTipBps > MAX_KEEPER_TIP_BPS) revert ValueOutOfRange(f.keeperTipBps, MAX_KEEPER_TIP_BPS);
        if (f.swapSlippageBps > MAX_SWAP_SLIPPAGE_BPS) {
            revert ValueOutOfRange(f.swapSlippageBps, MAX_SWAP_SLIPPAGE_BPS);
        }
        if (f.maxWethSlippageBps > MAX_WETH_SLIPPAGE_BPS) {
            revert ValueOutOfRange(f.maxWethSlippageBps, MAX_WETH_SLIPPAGE_BPS);
        }
        _fees = f;
        emit FeeConfigSet(f);
    }

    /// @notice Set both $DCA thresholds (raw token units).
    function setThresholds(uint256 autoDistribute, uint256 feeHalve) external onlyOwner {
        autoDistributeThreshold = autoDistribute;
        feeHalveThreshold = feeHalve;
        emit ThresholdsSet(autoDistribute, feeHalve);
    }

    /// @notice Cap on plans processed per advanceEpoch call (1..1000).
    function setMaxPlansPerTx(uint16 n) external onlyOwner {
        if (n == 0 || n > MAX_PLANS_PER_TX_CAP) revert ValueOutOfRange(n, MAX_PLANS_PER_TX_CAP);
        maxPlansPerTx = n;
        emit MaxPlansPerTxSet(n);
    }

    /// @notice Swap the router. Approvals to the old router are revoked.
    function setRouter(address newRouter) external onlyOwner {
        _setRouter(newRouter);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    function setFeeManager(address manager) external onlyOwner {
        feeManager = manager;
        emit FeeManagerSet(manager);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /// @notice When true only owner / keepers may call advanceEpoch.
    function setKeeperOnly(bool enabled) external onlyOwner {
        keeperOnly = enabled;
        emit KeeperOnlySet(enabled);
    }

    /// @notice Stops plan creation, deposits and epochs. Claims and idle withdrawals stay open.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover tokens that can never be user accounting: not USDG, not WETH, never listed as a stock.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(_usdg) || token == address(_weth) || _registry.isKnown(token)) {
            revert TokenNotRescuable(token);
        }
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    // ==================================================================
    // Views
    // ==================================================================

    /// @inheritdoc IPlanVault
    function currentEpochId() public view returns (uint32) {
        return EpochLib.epochAt(origin, epochLength, block.timestamp);
    }

    /// @inheritdoc IPlanVault
    function nextEpochStart() external view returns (uint256) {
        return EpochLib.nextBoundary(origin, epochLength, block.timestamp);
    }

    /// @inheritdoc IPlanVault
    function isEpochDue(address stock) external view returns (bool) {
        return !paused() && _registry.isPurchasable(stock) && currentEpochId() > lastExecutedEpoch[stock]
            && _stockPlans[stock].length > 0;
    }

    /// @inheritdoc IPlanVault
    function isEpochPending(address stock) external view returns (bool) {
        return _isEpochPending(stock);
    }

    /// @inheritdoc IPlanVault
    function getPlan(uint256 planId) external view returns (Plan memory) {
        return _plans[planId];
    }

    /// @inheritdoc IPlanVault
    function userPlans(address user) external view returns (uint256[] memory) {
        return _userPlans[user];
    }

    /// @inheritdoc IPlanVault
    function stockPlanCount(address stock) external view returns (uint256) {
        return _stockPlans[stock].length;
    }

    /// @inheritdoc IPlanVault
    function fees() external view returns (FeeConfig memory) {
        return _fees;
    }

    /// @inheritdoc IPlanVault
    function effectivePurchaseFeeBps(address user) public view returns (uint16) {
        uint16 bps = _fees.purchaseFeeBps;
        return _dcaBalance(user) >= feeHalveThreshold ? FeeMath.halve(bps) : bps;
    }

    /// @inheritdoc IPlanVault
    function isAutoDistribute(address user) public view returns (bool) {
        return _dcaBalance(user) >= autoDistributeThreshold;
    }

    /// @inheritdoc IPlanVault
    function usdg() external view returns (address) {
        return address(_usdg);
    }

    /// @inheritdoc IPlanVault
    function weth() external view returns (address) {
        return address(_weth);
    }

    /// @inheritdoc IPlanVault
    function dca() external view returns (address) {
        return address(_dca);
    }

    /// @inheritdoc IPlanVault
    function registry() external view returns (address) {
        return address(_registry);
    }

    /// @inheritdoc IPlanVault
    function router() external view returns (address) {
        return address(_router);
    }

    // ==================================================================
    // Internals
    // ==================================================================

    function _requireFundable(uint256 planId) internal view {
        Plan storage p = _plans[planId];
        if (p.owner == address(0)) revert PlanNotFound(planId);
        if (!_registry.isPurchasable(p.stock)) revert StockNotPurchasable(p.stock);
    }

    function _depositUSDG(uint256 planId, uint256 amount) internal {
        _usdg.safeTransferFrom(msg.sender, address(this), amount);
        (uint256 net, uint256 fee) = _takeDepositFee(_usdg, amount);
        Plan storage p = _plans[planId];
        p.usdgIdle += net.toUint128();
        totalUsdgIdle += net;
        _index(planId, p.stock);
        emit Deposited(planId, address(_usdg), msg.sender, amount, fee);
    }

    /// @dev WETH already sits in the vault. Credit as WETH (zap-at-epoch) or zap to USDG now.
    function _creditWeth(uint256 planId, uint256 amount, uint256 minUsdgOut) internal {
        (uint256 net, uint256 fee) = _takeDepositFee(_weth, amount);
        Plan storage p = _plans[planId];
        if (p.zapWethEachEpoch) {
            p.wethIdle += net.toUint128();
            totalWethIdle += net;
        } else {
            if (minUsdgOut == 0) {
                (uint256 quoted,) = _router.quote(address(_weth), address(_usdg), net);
                minUsdgOut = FeeMath.applySlippage(quoted, _fees.swapSlippageBps);
            }
            uint256 usdgBefore = _usdg.balanceOf(address(this));
            uint256 wethBefore = _weth.balanceOf(address(this));
            _router.swap(address(_weth), address(_usdg), net, minUsdgOut, address(this));
            uint256 out = _usdg.balanceOf(address(this)) - usdgBefore;
            uint256 spent = wethBefore - _weth.balanceOf(address(this));
            if (spent > net) revert Overspent(net, spent);
            p.usdgIdle += out.toUint128();
            totalUsdgIdle += out;
            uint256 leftover = net - spent;
            if (leftover > 0) {
                p.wethIdle += leftover.toUint128();
                totalWethIdle += leftover;
            }
            emit WethZapped(planId, currentEpochId(), spent, out);
        }
        _index(planId, p.stock);
        emit Deposited(planId, address(_weth), msg.sender, amount, fee);
    }

    function _takeDepositFee(IERC20 token, uint256 amount) internal returns (uint256 net, uint256 fee) {
        (net, fee) = FeeMath.split(amount, _fees.depositFeeBps);
        if (fee > 0) token.safeTransfer(feeRecipient, fee);
    }

    function _withdrawIdle(uint256 planId, uint256 usdgAmount, uint256 wethAmount, bool unwrap) internal {
        Plan storage p = _plans[planId];
        if (usdgAmount == type(uint256).max) usdgAmount = p.usdgIdle;
        if (wethAmount == type(uint256).max) wethAmount = p.wethIdle;
        if (usdgAmount > p.usdgIdle) revert InsufficientIdle(usdgAmount, p.usdgIdle);
        if (wethAmount > p.wethIdle) revert InsufficientIdle(wethAmount, p.wethIdle);
        if (usdgAmount == 0 && wethAmount == 0) revert ZeroAmount();

        uint256 usdgFee;
        uint256 wethFee;
        if (usdgAmount > 0) {
            uint256 net;
            (net, usdgFee) = FeeMath.split(usdgAmount, _fees.withdrawFeeBps);
            p.usdgIdle -= usdgAmount.toUint128();
            totalUsdgIdle -= usdgAmount;
            if (usdgFee > 0) _usdg.safeTransfer(feeRecipient, usdgFee);
            _usdg.safeTransfer(msg.sender, net);
        }
        if (wethAmount > 0) {
            uint256 net;
            (net, wethFee) = FeeMath.split(wethAmount, _fees.withdrawFeeBps);
            p.wethIdle -= wethAmount.toUint128();
            totalWethIdle -= wethAmount;
            if (wethFee > 0) _weth.safeTransfer(feeRecipient, wethFee);
            if (unwrap) {
                _weth.withdraw(net);
                (bool ok,) = msg.sender.call{value: net}("");
                if (!ok) revert EthTransferFailed();
            } else {
                _weth.safeTransfer(msg.sender, net);
            }
        }
        emit IdleWithdrawn(planId, usdgAmount, usdgFee, wethAmount, wethFee, unwrap);
    }

    function _claim(uint256 planId, uint256 amount) internal {
        Plan storage p = _plans[planId];
        if (amount == type(uint256).max) amount = p.stockAccrued;
        if (amount == 0) revert ZeroAmount();
        if (amount > p.stockAccrued) revert InsufficientAccrued(amount, p.stockAccrued);

        uint16 bps = isAutoDistribute(p.owner) ? 0 : _fees.claimFeeBps;
        (uint256 net, uint256 fee) = FeeMath.split(amount, bps);

        address stock = p.stock;
        p.stockAccrued -= amount.toUint128();
        totalStockAccrued[stock] -= amount;
        userStockAccrued[p.owner][stock] -= amount;

        if (fee > 0) IERC20(stock).safeTransfer(feeRecipient, fee);
        IERC20(stock).safeTransfer(p.recipient, net);
        emit Claimed(planId, stock, p.recipient, amount, fee);
    }

    function _index(uint256 planId, address stock) internal {
        if (_stockPlanIndex[planId] != 0) return;
        _stockPlans[stock].push(planId);
        _stockPlanIndex[planId] = _stockPlans[stock].length;
        emit PlanIndexed(planId, stock, true);
    }

    function _unindex(uint256 planId) internal {
        uint256 idx = _stockPlanIndex[planId];
        if (idx == 0) return;
        address stock = _plans[planId].stock;
        uint256[] storage arr = _stockPlans[stock];
        uint256 last = arr[arr.length - 1];
        arr[idx - 1] = last;
        _stockPlanIndex[last] = idx;
        arr.pop();
        _stockPlanIndex[planId] = 0;
        emit PlanIndexed(planId, stock, false);
    }

    function _isEpochPending(address stock) internal view returns (bool) {
        uint32 id = currentEpochId();
        return lastExecutedEpoch[stock] < id && nextPlanIndex[stock][id] > 0;
    }

    function _dcaBalance(address user) internal view returns (uint256) {
        if (address(_dca) == address(0)) return 0;
        return _dca.balanceOf(user);
    }

    function _tryQuote(address tokenIn, address tokenOut, uint256 amountIn) internal returns (bool ok, uint256 out) {
        try _router.quote(tokenIn, tokenOut, amountIn) returns (uint256 amountOut, Route[] memory) {
            return (true, amountOut);
        } catch {
            return (false, 0);
        }
    }

    /// @dev Non-reverting ERC-20 transfer. Returns false on revert / false return so a blocked recipient
    ///      (e.g. a stock token with an allowlist) degrades to accrual instead of bricking the epoch.
    function _tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return token.code.length > 0;
        if (ret.length != 32) return false;
        return abi.decode(ret, (bool));
    }

    function _setRouter(address newRouter) internal {
        if (newRouter == address(0)) revert ZeroAddress();
        address old = address(_router);
        if (old != address(0)) {
            _usdg.forceApprove(old, 0);
            _weth.forceApprove(old, 0);
        }
        _router = IAggregatorRouter(newRouter);
        _usdg.forceApprove(newRouter, type(uint256).max);
        _weth.forceApprove(newRouter, type(uint256).max);
        emit RouterSet(newRouter);
    }
}
