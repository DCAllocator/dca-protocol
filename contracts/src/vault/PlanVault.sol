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
///      - Vaults hold USDG (idle) and Stock Tokens (accrued) only. ETH / WETH deposits are converted to USDG
///        at deposit time; any unfilled WETH remainder goes straight back to the depositor.
///      - Fees leave the vault the moment they are taken; the vault never holds protocol USDG/WETH.
///      - Rounding dust from pro-rata stock distribution stays in `dustPot[stock]` and is folded into the
///        next epoch's distribution for that stock (user-favourable; never sent to the treasury).
///      - Rounding dust on the USDG side (unspent purchase notional that cannot be split exactly) and any WETH
///        the router forwards back from a partially filled second hop accrue in `usdgDust` / `wethDust` and
///        are swept to `feeRecipient` once `usdgDust >= dustSweepMinUsdg` (WETH: whenever non-zero).
///      - Invariants (see test/invariant):
///          stock.balanceOf(vault) == totalStockAccrued[stock] + dustPot[stock]
///          usdg.balanceOf(vault)  == totalUsdgIdle + usdgDust
///          weth.balanceOf(vault)  == wethDust
///
///      Epoch execution is paginated: `advanceEpoch(stock, limit, ...)` processes plans
///      [nextPlanIndex, nextPlanIndex + limit) of `stockPlans[stock]` with ONE aggregate USDG->stock swap per
///      page. If that swap cannot be quoted or executed the page is SKIPPED (no plan is charged, the cursor
///      still advances, `EpochPageSkipped` is emitted) — a single plan's state can never revert an epoch.
///      The epoch is "pending" until the cursor reaches the end of the plan list, at which point it is marked
///      executed. Only the CURRENT epoch is ever executed: if the keeper misses an epoch it is skipped, never
///      caught up (users are charged at most one spend per epoch, never several at once).
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
    /// @notice When true (default) only owner / keepers may call advanceEpoch.
    bool public keeperOnly = true;
    uint16 public maxPlansPerTx = 150;
    FeeConfig internal _fees;
    uint256 public autoDistributeThreshold;
    uint256 public feeHalveThreshold;
    /// @notice Smallest `amountPerEpoch` a plan may have (USDG units). Default 10 USDG.
    uint256 public minAmountPerEpoch;
    /// @notice Smallest USDG credit a deposit (or plan creation) must produce. Default 10 USDG.
    uint256 public minDeposit;
    /// @notice `usdgDust` is forwarded to `feeRecipient` during advanceEpoch once it reaches this. Default 1 USDG.
    uint256 public dustSweepMinUsdg;
    mapping(address => bool) public isKeeper;

    uint16 internal constant MAX_KEEPER_TIP_BPS = 5_000;
    uint16 internal constant MAX_SWAP_SLIPPAGE_BPS = 500;
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
    mapping(address => uint256) public totalStockAccrued;
    mapping(address => mapping(address => uint256)) public userStockAccrued;
    mapping(address => uint256) public dustPot;
    uint256 public usdgDust;
    uint256 public wethDust;
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
        uint128 spend;
        uint128 net;
        uint128 fee;
        bool autoDist;
    }

    struct Ctx {
        address stock;
        uint32 epochId;
        uint256 start; // page bounds in _stockPlans[stock]
        uint256 end;
        uint256 n; // number of fills
        uint256 totalSpend;
        uint256 totalNet;
        uint256 totalFee;
        uint256 bought; // stock received from the swap this page
        uint256 spent; // USDG the swap actually consumed
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
            swapSlippageBps: 50
        });
        emit FeeConfigSet(_fees);

        uint8 dcaDec = p.dca == address(0) ? 18 : IDCA(p.dca).decimals();
        autoDistributeThreshold = 10_000 * 10 ** dcaDec;
        feeHalveThreshold = 50_000 * 10 ** dcaDec;
        emit ThresholdsSet(autoDistributeThreshold, feeHalveThreshold);

        uint256 unit = 10 ** usdgDecimals;
        minAmountPerEpoch = 10 * unit;
        minDeposit = 10 * unit;
        dustSweepMinUsdg = unit;
        emit MinimumsSet(minAmountPerEpoch, minDeposit);
        emit DustSweepMinSet(dustSweepMinUsdg);
        emit KeeperOnlySet(true);

        _setRouter(p.router);
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
    /// @notice Open a plan and fund it in the same transaction. The plan must be funded with at least
    ///         `minDeposit` USDG (after conversion) so that only funded plans ever enter epoch iteration.
    /// @param stock            Registry-approved Stock Token.
    /// @param amountPerEpoch   USDG to spend each epoch (in USDG decimals). Must be >= minAmountPerEpoch.
    /// @param recipient        Receives stock. address(0) = msg.sender.
    /// @param usdgAmount       Initial USDG deposit (0 to skip).
    /// @param wethAmount       Initial WETH deposit, converted to USDG now (0 to skip). msg.value is additionally
    ///                         wrapped and converted.
    /// @param minUsdgOut       Min USDG when converting WETH/ETH (0 = quote-based). Applies to EACH leg separately
    ///                         if both `wethAmount` and `msg.value` are supplied.
    function createPlan(
        address stock,
        uint96 amountPerEpoch,
        address recipient,
        uint256 usdgAmount,
        uint256 wethAmount,
        uint256 minUsdgOut
    ) external payable whenNotPaused nonReentrant returns (uint256 planId) {
        if (!_registry.isPurchasable(stock)) revert StockNotPurchasable(stock);
        if (amountPerEpoch < minAmountPerEpoch) revert BelowMinimum(amountPerEpoch, minAmountPerEpoch);
        if (recipient == address(0)) recipient = msg.sender;

        planId = nextPlanId++;
        Plan storage p = _plans[planId];
        p.owner = msg.sender;
        p.recipient = recipient;
        p.stock = stock;
        p.amountPerEpoch = amountPerEpoch;
        _userPlans[msg.sender].push(planId);
        emit PlanCreated(planId, msg.sender, stock, amountPerEpoch, recipient);

        uint256 credited;
        if (usdgAmount > 0) credited += _depositUSDG(planId, usdgAmount);
        if (wethAmount > 0) {
            _weth.safeTransferFrom(msg.sender, address(this), wethAmount);
            credited += _zapWethDeposit(planId, wethAmount, minUsdgOut);
        }
        if (msg.value > 0) {
            _weth.deposit{value: msg.value}();
            credited += _zapWethDeposit(planId, msg.value, minUsdgOut);
        }
        if (credited < minDeposit) revert BelowMinimum(credited, minDeposit);
        _index(planId, stock);
    }

    /// @inheritdoc IPlanVault
    /// @notice Top up a plan with USDG. Anyone may fund any plan (it can only add value to it).
    function depositUSDG(uint256 planId, uint256 amount) external whenNotPaused nonReentrant {
        _requireFundable(planId);
        if (amount == 0) revert ZeroAmount();
        uint256 net = _depositUSDG(planId, amount);
        if (net < minDeposit) revert BelowMinimum(net, minDeposit);
        _index(planId, _plans[planId].stock);
    }

    /// @inheritdoc IPlanVault
    /// @notice Top up with WETH, converted to USDG immediately. Unfilled WETH is returned to msg.sender.
    function depositWETH(uint256 planId, uint256 amount, uint256 minUsdgOut) external whenNotPaused nonReentrant {
        _requireFundable(planId);
        if (amount == 0) revert ZeroAmount();
        _weth.safeTransferFrom(msg.sender, address(this), amount);
        uint256 out = _zapWethDeposit(planId, amount, minUsdgOut);
        if (out < minDeposit) revert BelowMinimum(out, minDeposit);
        _index(planId, _plans[planId].stock);
    }

    /// @inheritdoc IPlanVault
    /// @notice Top up with ETH; wrapped to WETH then handled like `depositWETH`.
    function depositETH(uint256 planId, uint256 minUsdgOut) external payable whenNotPaused nonReentrant {
        _requireFundable(planId);
        if (msg.value == 0) revert ZeroAmount();
        _weth.deposit{value: msg.value}();
        uint256 out = _zapWethDeposit(planId, msg.value, minUsdgOut);
        if (out < minDeposit) revert BelowMinimum(out, minDeposit);
        _index(planId, _plans[planId].stock);
    }

    /// @inheritdoc IPlanVault
    /// @notice Withdraw idle USDG. `type(uint256).max` = all. Withdraw fee applies. Works while paused.
    function withdrawIdle(uint256 planId, uint256 usdgAmount) external nonReentrant onlyPlanOwner(planId) {
        Plan storage p = _plans[planId];
        if (usdgAmount == type(uint256).max) usdgAmount = p.usdgIdle;
        if (usdgAmount == 0) revert ZeroAmount();
        if (usdgAmount > p.usdgIdle) revert InsufficientIdle(usdgAmount, p.usdgIdle);

        (uint256 net, uint256 fee) = FeeMath.split(usdgAmount, _fees.withdrawFeeBps);
        p.usdgIdle -= usdgAmount.toUint128();
        totalUsdgIdle -= usdgAmount;
        if (fee > 0) _usdg.safeTransfer(feeRecipient, fee);
        _usdg.safeTransfer(msg.sender, net);
        emit IdleWithdrawn(planId, usdgAmount, fee);
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
        if (amountPerEpoch < minAmountPerEpoch) revert BelowMinimum(amountPerEpoch, minAmountPerEpoch);
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
    /// @notice Permissionless: drop an empty plan from epoch iteration so it stops costing keeper gas.
    ///         A later deposit re-indexes it automatically.
    function prunePlan(uint256 planId) external nonReentrant {
        Plan storage p = _plans[planId];
        if (p.owner == address(0)) revert PlanNotFound(planId);
        if (p.usdgIdle > 0 || p.stockAccrued > 0) revert PlanNotEmpty(planId);
        if (_isEpochPending(p.stock)) revert EpochInProgress(p.stock);
        _unindex(planId);
    }

    // ==================================================================
    // Epochs
    // ==================================================================

    /// @inheritdoc IPlanVault
    /// @notice Execute (a page of) the current epoch for `stock`. Owner / keepers only while `keeperOnly`.
    /// @param stock         Registry-approved Stock Token.
    /// @param limit         Max plans to process this call (0 or > maxPlansPerTx => maxPlansPerTx).
    /// @param routeOverride Empty for auto-routing. Owner/keepers may pass abi.encode(Route[] path, uint256 minOut)
    ///                      to force the path. Every hop must be approved on the router, and `minOut` may not be
    ///                      below the auto-route's floor (quote * (1 - swapSlippageBps)) nor below the same floor
    ///                      computed on the override path's own quote: an override picks a path, never a worse price.
    ///                      Override failures revert (the page is not consumed); auto-route failures skip the page.
    /// @return completed True once the cursor reached the end of the plan list (epoch marked executed).
    function advanceEpoch(address stock, uint256 limit, bytes calldata routeOverride)
        external
        whenNotPaused
        nonReentrant
        returns (bool completed)
    {
        bool privileged = msg.sender == owner() || isKeeper[msg.sender];
        if (keeperOnly && !privileged) revert NotKeeper();
        if (routeOverride.length != 0 && !privileged) revert NotKeeper();
        if (!_registry.isPurchasable(stock)) revert StockNotPurchasable(stock);

        Ctx memory ctx;
        ctx.stock = stock;
        ctx.epochId = currentEpochId();
        if (ctx.epochId <= lastExecutedEpoch[stock]) revert EpochNotDue(stock, ctx.epochId);
        uint256 len = _stockPlans[stock].length;
        if (len == 0) revert EpochNotDue(stock, ctx.epochId);
        if (limit == 0 || limit > maxPlansPerTx) limit = maxPlansPerTx;

        ctx.start = nextPlanIndex[stock][ctx.epochId];
        ctx.end = ctx.start + limit;
        if (ctx.end > len) ctx.end = len;

        Fill[] memory fills = new Fill[](ctx.end - ctx.start);
        _collect(ctx, fills);
        if (ctx.totalNet > 0) {
            (bool ok, bytes memory reason) = _buyStock(ctx, routeOverride);
            if (ok) {
                _commitSpend(ctx, fills);
                _payFees(ctx);
                uint256 pot = ctx.bought + dustPot[stock];
                uint256 distributed = _distribute(ctx, fills, pot, ctx.totalNet - ctx.spent);
                dustPot[stock] = pot - distributed;
            } else {
                emit EpochPageSkipped(stock, ctx.epochId, ctx.start, ctx.end, reason);
                ctx.totalNet = 0;
                ctx.totalFee = 0;
                ctx.filled = 0;
            }
        }
        _sweepDust(false);
        completed = _finalizePage(ctx, len);
    }

    /// @inheritdoc IPlanVault
    /// @notice Forward accumulated dust to `feeRecipient` regardless of the threshold. Owner or feeManager.
    function sweepDust() external onlyFeeManager nonReentrant {
        _sweepDust(true);
    }

    // ------------------------------------------------------------------
    // Epoch phases
    // ------------------------------------------------------------------

    /// @dev Phase 1: pick eligible plans on this page and tally spend / fee / net in memory. No storage writes.
    function _collect(Ctx memory ctx, Fill[] memory fills) internal view {
        uint256[] storage ids = _stockPlans[ctx.stock];
        uint16 baseBps = _fees.purchaseFeeBps;
        uint256 n;
        for (uint256 i = ctx.start; i < ctx.end; ++i) {
            uint256 planId = ids[i];
            Plan storage p = _plans[planId];
            if (p.paused || p.lastEpochId == ctx.epochId || p.usdgIdle == 0) continue;
            uint256 spend = p.usdgIdle < p.amountPerEpoch ? p.usdgIdle : p.amountPerEpoch;
            (bool halve, bool autoDist) = _perks(p.owner);
            (uint256 net, uint256 fee) = FeeMath.split(spend, halve ? FeeMath.halve(baseBps) : baseBps);
            Fill memory f = fills[n];
            f.planId = planId;
            f.spend = spend.toUint128();
            f.net = net.toUint128();
            f.fee = fee.toUint128();
            f.autoDist = autoDist;
            ctx.totalSpend += spend;
            ctx.totalNet += net;
            ctx.totalFee += fee;
            ++n;
        }
        ctx.n = n;
        // casting to 'uint32' is safe: n <= maxPlansPerTx <= 1000
        // forge-lint: disable-next-line(unsafe-typecast)
        ctx.filled = uint32(n);
    }

    /// @dev Phase 2: single USDG->stock swap. Auto-route failures are reported (page skipped); override failures
    ///      revert. Measures real balance deltas: `ctx.bought`, `ctx.spent`, and any WETH the router forwarded
    ///      back from a partial second hop (booked as `wethDust`).
    function _buyStock(Ctx memory ctx, bytes calldata routeOverride) internal returns (bool ok, bytes memory reason) {
        address stock = ctx.stock;
        uint256 amountIn = ctx.totalNet;
        (bool haveQuote, uint256 quoted, Route[] memory path, bytes memory quoteErr) =
            _tryQuote(address(_usdg), stock, amountIn);
        uint256 minOut = FeeMath.applySlippage(quoted, _fees.swapSlippageBps);

        bool isOverride = routeOverride.length != 0;
        if (isOverride) {
            uint256 overrideMinOut;
            (path, overrideMinOut) = abi.decode(routeOverride, (Route[], uint256));
            if (overrideMinOut == 0) revert ZeroAmount();
            // floor = max(auto floor, the override path's own floor); reverts if the path is unapproved / dead
            uint256 pathFloor = FeeMath.applySlippage(_router.quotePath(path, amountIn), _fees.swapSlippageBps);
            if (pathFloor > minOut) minOut = pathFloor;
            if (overrideMinOut < minOut) revert OverrideMinOutTooLow(overrideMinOut, minOut);
            minOut = overrideMinOut;
        } else {
            if (!haveQuote) return (false, quoteErr);
            if (minOut == 0) return (false, bytes("quote too small"));
        }

        uint256 usdgBefore = _usdg.balanceOf(address(this));
        uint256 stockBefore = IERC20(stock).balanceOf(address(this));
        uint256 wethBefore = _weth.balanceOf(address(this));
        if (isOverride) {
            _router.swapWithRoute(address(_usdg), stock, amountIn, minOut, address(this), path);
        } else {
            try _router.swapWithRoute(address(_usdg), stock, amountIn, minOut, address(this), path) {}
            catch (bytes memory err) {
                return (false, err);
            }
        }

        ctx.bought = IERC20(stock).balanceOf(address(this)) - stockBefore;
        if (ctx.bought == 0) revert SwapReturnedZero();
        ctx.spent = usdgBefore - _usdg.balanceOf(address(this));
        if (ctx.spent > amountIn) revert Overspent(amountIn, ctx.spent);
        uint256 wethIn = _weth.balanceOf(address(this)) - wethBefore;
        if (wethIn > 0) wethDust += wethIn;
        ok = true;
    }

    /// @dev Phase 3: debit idle USDG and mark plans filled. Only runs after a successful purchase.
    function _commitSpend(Ctx memory ctx, Fill[] memory fills) internal {
        for (uint256 j; j < ctx.n; ++j) {
            Fill memory f = fills[j];
            Plan storage p = _plans[f.planId];
            p.usdgIdle -= f.spend;
            p.lastEpochId = ctx.epochId;
        }
        totalUsdgIdle -= ctx.totalSpend;
    }

    /// @dev Phase 4: purchase fees leave the vault immediately (keeper tip carved out first).
    function _payFees(Ctx memory ctx) internal {
        if (ctx.totalFee == 0) return;
        uint256 tip = FeeMath.feeOf(ctx.totalFee, _fees.keeperTipBps);
        if (tip > 0) _usdg.safeTransfer(msg.sender, tip);
        _usdg.safeTransfer(feeRecipient, ctx.totalFee - tip);
    }

    /// @dev Phase 5: pro-rata stock by net weight (floor). Auto-distribute or accrue. Unspent USDG (`residual`) is
    ///      returned pro-rata; the remainder that cannot be split exactly accrues in `usdgDust`.
    ///      Returns stock handed out.
    function _distribute(Ctx memory ctx, Fill[] memory fills, uint256 amountOut, uint256 residual)
        internal
        returns (uint256 distributed)
    {
        uint256 backTotal;
        for (uint256 j; j < ctx.n; ++j) {
            Fill memory f = fills[j];
            if (f.net == 0) continue;
            Plan storage p = _plans[f.planId];
            uint256 share = Math.mulDiv(amountOut, f.net, ctx.totalNet);
            if (residual > 0) {
                uint256 back = Math.mulDiv(residual, f.net, ctx.totalNet);
                p.usdgIdle += back.toUint128();
                backTotal += back;
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
        if (backTotal > 0) totalUsdgIdle += backTotal;
        if (residual > backTotal) usdgDust += residual - backTotal;
    }

    /// @dev Phase 6: cursor, stats and completion.
    function _finalizePage(Ctx memory ctx, uint256 len) internal returns (bool completed) {
        nextPlanIndex[ctx.stock][ctx.epochId] = ctx.end.toUint32();
        totalNotionalUsdg += ctx.spent;
        emit EpochPageExecuted(ctx.stock, ctx.epochId, ctx.start, ctx.end, ctx.totalNet, ctx.bought, ctx.filled);

        if (ctx.end == len) {
            lastExecutedEpoch[ctx.stock] = ctx.epochId;
            epochsCompleted += 1;
            emit EpochExecuted(ctx.stock, ctx.epochId);
            completed = true;
        }
    }

    /// @dev Forward dust to the treasury. USDG only once it reaches `dustSweepMinUsdg` (or `force`); WETH whenever
    ///      there is any (it only appears in the rare partial-hop case).
    function _sweepDust(bool force) internal {
        uint256 u = usdgDust;
        if (u > 0 && (force || u >= dustSweepMinUsdg)) {
            usdgDust = 0;
            _usdg.safeTransfer(feeRecipient, u);
            emit DustSwept(address(_usdg), feeRecipient, u);
        }
        uint256 w = wethDust;
        if (w > 0) {
            wethDust = 0;
            _weth.safeTransfer(feeRecipient, w);
            emit DustSwept(address(_weth), feeRecipient, w);
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
        _fees = f;
        emit FeeConfigSet(f);
    }

    /// @notice Set both $DCA thresholds (raw token units, both > 0).
    function setThresholds(uint256 autoDistribute, uint256 feeHalve) external onlyOwner {
        if (autoDistribute == 0 || feeHalve == 0) revert ZeroAmount();
        autoDistributeThreshold = autoDistribute;
        feeHalveThreshold = feeHalve;
        emit ThresholdsSet(autoDistribute, feeHalve);
    }

    /// @notice Minimum `amountPerEpoch` and minimum USDG credited per deposit (USDG units, both > 0).
    function setMinimums(uint256 minAmountPerEpoch_, uint256 minDeposit_) external onlyOwner {
        if (minAmountPerEpoch_ == 0 || minDeposit_ == 0) revert ZeroAmount();
        minAmountPerEpoch = minAmountPerEpoch_;
        minDeposit = minDeposit_;
        emit MinimumsSet(minAmountPerEpoch_, minDeposit_);
    }

    /// @notice USDG dust is swept to `feeRecipient` during advanceEpoch once it reaches this amount.
    function setDustSweepMin(uint256 minUsdg) external onlyOwner {
        dustSweepMinUsdg = minUsdg;
        emit DustSweepMinSet(minUsdg);
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
        if (keeper == address(0)) revert ZeroAddress();
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /// @notice When true only owner / keepers may call advanceEpoch. Default true.
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
        (bool halve,) = _perks(user);
        return halve ? FeeMath.halve(bps) : bps;
    }

    /// @inheritdoc IPlanVault
    function isAutoDistribute(address user) public view returns (bool) {
        (, bool autoDist) = _perks(user);
        return autoDist;
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

    /// @dev Pull USDG from msg.sender, take the deposit fee, credit the net. Returns the net credited.
    function _depositUSDG(uint256 planId, uint256 amount) internal returns (uint256 net) {
        _usdg.safeTransferFrom(msg.sender, address(this), amount);
        uint256 fee;
        (net, fee) = _takeDepositFee(_usdg, amount);
        _creditUsdg(planId, net);
        emit Deposited(planId, address(_usdg), msg.sender, amount, fee);
    }

    /// @dev WETH already sits in the vault. Take the deposit fee, convert to USDG through the router, credit the
    ///      output and return any unfilled WETH to msg.sender. Returns the USDG credited.
    function _zapWethDeposit(uint256 planId, uint256 amount, uint256 minUsdgOut) internal returns (uint256 out) {
        (uint256 net, uint256 fee) = _takeDepositFee(_weth, amount);
        if (minUsdgOut == 0) {
            (uint256 quoted,) = _router.quote(address(_weth), address(_usdg), net);
            minUsdgOut = FeeMath.applySlippage(quoted, _fees.swapSlippageBps);
        }
        uint256 usdgBefore = _usdg.balanceOf(address(this));
        uint256 wethBefore = _weth.balanceOf(address(this));
        _router.swap(address(_weth), address(_usdg), net, minUsdgOut, address(this));
        out = _usdg.balanceOf(address(this)) - usdgBefore;
        uint256 spent = wethBefore - _weth.balanceOf(address(this));
        if (spent > net) revert Overspent(net, spent);
        _creditUsdg(planId, out);
        uint256 leftover = net - spent;
        if (leftover > 0) _weth.safeTransfer(msg.sender, leftover);
        emit WethZapped(planId, spent, out, leftover);
        emit Deposited(planId, address(_weth), msg.sender, amount, fee);
    }

    function _creditUsdg(uint256 planId, uint256 amount) internal {
        _plans[planId].usdgIdle += amount.toUint128();
        totalUsdgIdle += amount;
    }

    function _takeDepositFee(IERC20 token, uint256 amount) internal returns (uint256 net, uint256 fee) {
        (net, fee) = FeeMath.split(amount, _fees.depositFeeBps);
        if (fee > 0) token.safeTransfer(feeRecipient, fee);
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

    /// @dev $DCA perks. No token => no perks, whatever the thresholds are.
    function _perks(address user) internal view returns (bool halveFee, bool autoDist) {
        if (address(_dca) == address(0)) return (false, false);
        uint256 bal = _dca.balanceOf(user);
        return (bal >= feeHalveThreshold, bal >= autoDistributeThreshold);
    }

    function _tryQuote(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (bool ok, uint256 out, Route[] memory path, bytes memory err)
    {
        try _router.quote(tokenIn, tokenOut, amountIn) returns (uint256 amountOut, Route[] memory p) {
            return (true, amountOut, p, "");
        } catch (bytes memory reason) {
            return (false, 0, path, reason);
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
