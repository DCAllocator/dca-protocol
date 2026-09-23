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
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {BoostLib} from "../libraries/BoostLib.sol";
import {VaultAdminLib} from "../libraries/VaultAdminLib.sol";
import {PriceGuardLib} from "../libraries/PriceGuardLib.sol";
import {PlanExitLib} from "../libraries/PlanExitLib.sol";

import {IPlanVault} from "../interfaces/IPlanVault.sol";
import {IStockRegistry} from "../interfaces/IStockRegistry.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {IDCA} from "../token/IDCA.sol";
import {IAggregatorRouter, Route} from "../router/IAggregatorRouter.sol";
import {FeeMath} from "../libraries/FeeMath.sol";
import {EpochLib} from "../libraries/EpochLib.sol";
import {Plan, FeeConfig, VaultParams, DustState, PriceGuard, PriceFeed} from "./VaultTypes.sol";

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
///      - Boost: a plan may opt in (`boosted`) to have its idle USDG lent out through `boostStrategy`, an
///        owner-set ERC-4626 vault (MorphoBlueStrategy = one Morpho Blue market). The vault keeps ONE strategy
///        position and splits it between boosted plans with internal shares (`boostShares`, `totalBoostShares`;
///        see BoostLib, a linked external library that holds the pool mutations; VaultAdminLib holds the rarely
///        used skim / rescue paths and PlanExitLib the exit paths — withdraw, claim, prune, close — for the same
///        size reason). A boosted plan's spendable
///        balance is `usdgIdle + boostValueOf(plan)`; spends and withdrawals take `usdgIdle` first, then pull
///        from the strategy. `boostPrincipal` (cost basis) and `boostEarned` (realised yield) track earnings
///        per plan. Epoch pages pull the page's boosted spend in one strategy withdrawal; if the strategy
///        cannot pay (illiquid market) the boosted plans of that page are dropped and everyone else fills.
///      - Invariants (see test/invariant):
///          stock.balanceOf(vault) == totalStockAccrued[stock] + dustPot[stock]
///          usdg.balanceOf(vault)  == totalUsdgIdle + usdgDust
///          weth.balanceOf(vault)  == wethDust
///          sum(plan.boostShares)  == totalBoostShares;  !plan.boosted => plan.boostShares == 0
///
///      Epoch execution is paginated: `advanceEpoch(stock, limit, ...)` processes plans
///      [nextPlanIndex, nextPlanIndex + limit) of `stockPlans[stock]` with ONE aggregate USDG->stock swap per
///      page. If that swap cannot be quoted or executed (no route within the impact cap for this page size, a
///      price-guard deviation, a partial fill) the call REVERTS and the cursor does not move: the operator retries
///      later or with a smaller `limit`. No single plan's state can make a page unfillable (minimums, full-fill
///      routing); only page size and market conditions can, and both are the operator's to change.
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
    /// @notice Largest USDG notional one page may buy (vault default; 0 = unlimited). A page stops before it would
    ///         exceed the cap, so `limit` is a maximum plan count and the cap sizes pages to what the pools absorb
    ///         (on-chain TWAP sizing). Default 100,000 USDG.
    uint256 public maxPageNotional;
    /// @notice Per-stock override of `maxPageNotional` (0 = use the default). Set from the pools' depth.
    mapping(address => uint256) public maxPageNotionalOf;
    mapping(address => bool) public isKeeper;

    /// @dev The boost pool: strategy + internal share supply (see BoostLib).
    BoostLib.Pool internal _boost;
    /// @notice The epoch-purchase price guard (see PriceGuardLib): max deviation from the Chainlink reference,
    ///         whether stocks without a feed may be bought, optional L2 sequencer uptime feed + grace.
    PriceGuard public priceGuard;
    /// @notice Chainlink reference feed per stock (USD per raw token), with its staleness window and decimals.
    mapping(address => PriceFeed) public priceFeed;

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
    DustState internal _dust;
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
        uint128 fromBoost; // part of `spend` that comes out of the plan's boosted balance
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
        uint256 boostOut; // boosted USDG this page pulls from the strategy (sum of Fill.fromBoost)
        uint256 poolAssets; // boost pool snapshot taken while collecting: value ...
        uint256 poolShares; // ... and shares, so boosted spends are priced consistently across the page
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

        // Both perks unlock at the same balance by default; `setThresholds` keeps them independently settable.
        uint8 dcaDec = p.dca == address(0) ? 18 : IDCA(p.dca).decimals();
        autoDistributeThreshold = 100_000 * 10 ** dcaDec;
        feeHalveThreshold = 100_000 * 10 ** dcaDec;
        emit ThresholdsSet(autoDistributeThreshold, feeHalveThreshold);

        uint256 unit = 10 ** usdgDecimals;
        minAmountPerEpoch = 10 * unit;
        minDeposit = 10 * unit;
        dustSweepMinUsdg = unit;
        maxPageNotional = 100_000 * unit;
        emit MinimumsSet(minAmountPerEpoch, minDeposit);
        emit DustSweepMinSet(dustSweepMinUsdg);
        emit MaxPageNotionalSet(address(0), maxPageNotional);
        emit KeeperOnlySet(true);
        // Fail closed: until the owner sets a feed for a stock (or turns `requireFeed` off) no epoch buys it.
        priceGuard.maxDeviationBps = 300;
        priceGuard.requireFeed = true;
        emit PriceGuardSet(300, true, address(0), 0);

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
    /// @param boost            Lend the plan's idle USDG through `boostStrategy` from the first deposit on
    ///                         (the deposit reverts `BoostUnavailable` if no strategy is set). Toggle later with
    ///                         `setPlanBoost`.
    function createPlan(
        address stock,
        uint96 amountPerEpoch,
        address recipient,
        uint256 usdgAmount,
        uint256 wethAmount,
        uint256 minUsdgOut,
        bool boost
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
        p.boosted = boost;
        _userPlans[msg.sender].push(planId);
        emit PlanCreated(planId, msg.sender, stock, amountPerEpoch, recipient);
        if (boost) emit PlanBoostSet(planId, true);

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
    /// @notice Withdraw idle USDG — for a boosted plan that includes its boosted balance, yield included, pulled
    ///         back from the strategy (subject to the market's liquidity). `type(uint256).max` = all. Withdraw
    ///         fee applies. Works while paused.
    function withdrawIdle(uint256 planId, uint256 usdgAmount) external nonReentrant onlyPlanOwner(planId) {
        // usdgIdle first, then (for boosted plans) the strategy; the library does the checks, debits the plan and
        // pays msg.sender, and returns the part that came out of usdgIdle.
        totalUsdgIdle -= PlanExitLib.withdrawIdle(
            _boost, _plans[planId], planId, usdgAmount, _usdg, feeRecipient, _fees.withdrawFeeBps
        );
    }

    /// @inheritdoc IPlanVault
    /// @notice Claim accrued stock to the plan's recipient. `type(uint256).max` = all. Claim fee is 0 for
    ///         auto-distribute tier holders (>= autoDistributeThreshold $DCA at claim time). Works while paused.
    function claim(uint256 planId, uint256 amount) external nonReentrant onlyPlanOwner(planId) {
        _claim(planId, amount);
    }

    /// @inheritdoc IPlanVault
    /// @notice Withdraw everything and remove the plan in ONE transaction: unboost (if boosted), pay out all idle
    ///         USDG to the caller (withdraw fee), claim all accrued stock to the recipient (claim fee unless the
    ///         owner holds the auto-distribute perk), then drop the plan from epoch iteration. Works while paused
    ///         and after the stock is delisted. An empty or already pruned plan closes without reverting, so the
    ///         call is idempotent. While an epoch page is pending for the stock the unindex of a still-indexed
    ///         plan is deferred: the plan is paused and stays indexed (`PlanClosed(..., false)`), and `prunePlan`
    ///         — or a second `closePlan` — drops it once the epoch is over (a plan already out of the list is
    ///         never parked). The record persists; a later deposit re-indexes it as a plain
    ///         (unboosted) plan. Atomic: a strategy that cannot pay the boosted balance back, or a token that
    ///         refuses `feeRecipient`, reverts the whole close (fall back to the single legs).
    function closePlan(uint256 planId) external nonReentrant onlyPlanOwner(planId) {
        Plan storage p = _plans[planId];
        uint256 fromPool;
        // pull the boosted balance back into usdgIdle first, yield included (keeps the unboost leg next to
        // setPlanBoost: the exit library never burns shares)
        if (p.boosted) (, fromPool) = BoostLib.setPlanBoost(_boost, p, planId, false);
        uint256 out = PlanExitLib.close(
            p,
            planId,
            totalStockAccrued,
            userStockAccrued,
            _stockPlans,
            _stockPlanIndex,
            _usdg,
            feeRecipient,
            _fees.withdrawFeeBps,
            _claimFeeBps(p.owner),
            _isEpochPending(p.stock)
        );
        totalUsdgIdle = totalUsdgIdle + fromPool - out;
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
    /// @notice Boost (lend the plan's idle USDG through the strategy, future deposits included) or unboost (pull
    ///         everything back into `usdgIdle`, realising the yield). Boosting an already boosted plan sweeps any
    ///         unboosted residual into the pool. Boosting needs an unpaused vault; unboosting always works.
    function setPlanBoost(uint256 planId, bool enabled) external nonReentrant onlyPlanOwner(planId) {
        if (enabled) _requireNotPaused();
        (uint256 toPool, uint256 fromPool) = BoostLib.setPlanBoost(_boost, _plans[planId], planId, enabled);
        totalUsdgIdle = totalUsdgIdle + fromPool - toPool;
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
        PlanExitLib.prune(p, planId, _isEpochPending(p.stock), _stockPlans, _stockPlanIndex);
    }

    // ==================================================================
    // Epochs
    // ==================================================================

    /// @inheritdoc IPlanVault
    /// @notice Execute (a page of) the current epoch for `stock`. Owner / keepers only while `keeperOnly`.
    /// @param stock         Registry-approved Stock Token.
    /// @param limit         Max plans to process this call (0 or > maxPlansPerTx => maxPlansPerTx).
    /// @param routeOverride Empty for auto-routing. Owner/keepers may pass abi.encode(Route[] path, uint256 minOut)
    ///                      to force the path. Every hop must be approved on the router, the path must be within
    ///                      the router's price-impact cap (`quotePath` enforces it), and `minOut` may not be below
    ///                      the auto-route's floor (quote * (1 - swapSlippageBps)) nor below the same floor computed
    ///                      on the override path's own quote: an override picks a path, never a worse price or a
    ///                      larger impact. Every failure to quote or execute reverts and leaves the page unconsumed
    ///                      (retry later or with a smaller `limit`). Both paths are floored at the stock's Chainlink
    ///                      reference price (PriceGuardLib).
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
        // Boosted spend is pulled from the strategy before the swap; if the strategy cannot pay, boosted plans
        // sit this page out (their fills are dropped) and the unboosted ones are still filled.
        if (ctx.boostOut > 0 && !BoostLib.withdrawPage(_boost, stock, ctx.epochId, ctx.boostOut)) {
            _dropBoostedFills(ctx, fills);
        }
        if (ctx.totalNet > 0) {
            _buyStock(ctx, routeOverride); // reverts if the page cannot be bought: nothing is consumed
            _commitSpend(ctx, fills);
            _payFees(ctx);
            uint256 pot = ctx.bought + dustPot[stock];
            uint256 distributed = _distribute(ctx, fills, pot, ctx.totalNet - ctx.spent);
            dustPot[stock] = pot - distributed;
        }
        _sweepDust(false);
        completed = _finalizePage(ctx, len);
    }

    /// @inheritdoc IPlanVault
    /// @notice Forward accumulated dust to `feeRecipient` regardless of the threshold. Owner or feeManager.
    function sweepDust() external onlyFeeManager nonReentrant {
        _sweepDust(true);
    }

    /// @inheritdoc IPlanVault
    /// @notice Reconcile a balance the vault did not book (a transfer made directly to it, an issuer
    ///         distribution): the excess of a listed stock goes to that stock's `dustPot` (distributed to its
    ///         plans at the next epoch), excess USDG / WETH to the dust sinks swept to `feeRecipient`. The
    ///         invariants `balance == accounted + dust` hold again afterwards. Owner or feeManager.
    ///         (audit v0.3 M-04: without this, such balances were unreachable — `rescueERC20` rightly refuses
    ///         every token that can carry user accounting.)
    function skim(address token) external onlyFeeManager nonReentrant {
        VaultAdminLib.skim(token, _usdg, _weth, _registry, totalUsdgIdle, _dust, totalStockAccrued, dustPot);
    }

    // ------------------------------------------------------------------
    // Epoch phases
    // ------------------------------------------------------------------

    /// @dev Phase 1: pick eligible plans on this page and tally spend / fee / net in memory. No storage writes.
    ///      Boosted balances are valued against one pool snapshot for the whole page; a spend takes `usdgIdle`
    ///      first and the boosted balance for the rest. The page stops (ctx.end shrinks) before its notional
    ///      would exceed the stock's page cap, so a page is never larger than the pools absorb; a single plan
    ///      above the cap sits the epoch out (`PlanTooLarge`) instead of blocking everyone behind it.
    function _collect(Ctx memory ctx, Fill[] memory fills) internal {
        uint256[] storage ids = _stockPlans[ctx.stock];
        uint16 baseBps = _fees.purchaseFeeBps;
        ctx.poolShares = _boost.totalShares;
        if (ctx.poolShares > 0) ctx.poolAssets = BoostLib.poolAssets(_boost);
        uint256 cap = maxPageNotionalOf[ctx.stock];
        if (cap == 0) cap = maxPageNotional;
        uint256 n;
        for (uint256 i = ctx.start; i < ctx.end; ++i) {
            uint256 planId = ids[i];
            Plan storage p = _plans[planId];
            if (p.paused || p.lastEpochId == ctx.epochId) continue;
            uint256 idle = p.usdgIdle;
            uint256 avail = idle;
            if (p.boosted) avail += BoostLib.valueOf(p.boostShares, ctx.poolAssets, ctx.poolShares);
            if (avail == 0) continue;
            uint256 spend = avail < p.amountPerEpoch ? avail : p.amountPerEpoch;
            if (cap != 0) {
                if (spend > cap) {
                    emit PlanTooLarge(planId, spend, cap);
                    continue;
                }
                if (ctx.totalSpend + spend > cap) {
                    ctx.end = i; // this page ends here; the next one starts at plan i
                    break;
                }
            }
            (bool halve, bool autoDist) = _perks(p.owner);
            (uint256 net, uint256 fee) = FeeMath.split(spend, halve ? FeeMath.halve(baseBps) : baseBps);
            Fill memory f = fills[n];
            f.planId = planId;
            f.spend = spend.toUint128();
            f.net = net.toUint128();
            f.fee = fee.toUint128();
            if (spend > idle) {
                f.fromBoost = (spend - idle).toUint128();
                ctx.boostOut += spend - idle;
            }
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

    /// @dev Phase 2: single USDG->stock swap. Any failure to quote or execute REVERTS — the router's own error
    ///      (`NoRoute`, `PriceImpactTooHigh`, `PartialFill`, `InsufficientOutput`) or the vault's (`PriceDeviates`,
    ///      `QuoteTooSmall`) bubbles up so the operator can react (retry later, smaller `limit`). Measures real
    ///      balance deltas: `ctx.bought`, `ctx.spent`, and any WETH that reached the vault (booked as dust).
    function _buyStock(Ctx memory ctx, bytes calldata routeOverride) internal {
        address stock = ctx.stock;
        uint256 amountIn = ctx.totalNet;
        uint256 minOut;
        Route[] memory path;
        if (routeOverride.length != 0) {
            uint256 overrideMinOut;
            (path, overrideMinOut) = abi.decode(routeOverride, (Route[], uint256));
            if (overrideMinOut == 0) revert ZeroAmount();
            // floor = max(auto floor if the auto-route has a quote, the override path's own floor); quotePath
            // reverts if the path is unapproved, cannot fill in full or exceeds the impact cap
            try _router.quote(address(_usdg), stock, amountIn) returns (uint256 quoted, Route[] memory) {
                minOut = FeeMath.applySlippage(quoted, _fees.swapSlippageBps);
            } catch {}
            uint256 pathFloor = FeeMath.applySlippage(_router.quotePath(path, amountIn), _fees.swapSlippageBps);
            if (pathFloor > minOut) minOut = pathFloor;
            if (overrideMinOut < minOut) revert OverrideMinOutTooLow(overrideMinOut, minOut);
            minOut = overrideMinOut;
        } else {
            uint256 quoted;
            (quoted, path) = _router.quote(address(_usdg), stock, amountIn); // reverts NoRoute for this page size
            minOut = FeeMath.applySlippage(quoted, _fees.swapSlippageBps);
            if (minOut == 0) revert QuoteTooSmall();
        }
        // External price floor (audit v0.3 H-01): whatever the pool says, the swap may not deliver less than the
        // Chainlink reference less `maxDeviationBps`.
        PriceGuardLib.check(priceGuard, priceFeed, stock, amountIn, minOut, usdgDecimals);

        uint256 usdgBefore = _usdg.balanceOf(address(this));
        uint256 stockBefore = IERC20(stock).balanceOf(address(this));
        uint256 wethBefore = _weth.balanceOf(address(this));
        // Exact, per-call approval: the router can only ever pull this page's input (audit v0.3 M-03).
        _usdg.forceApprove(address(_router), amountIn);
        _router.swapWithRoute(address(_usdg), stock, amountIn, minOut, address(this), path);
        _usdg.forceApprove(address(_router), 0);

        ctx.bought = IERC20(stock).balanceOf(address(this)) - stockBefore;
        if (ctx.bought == 0) revert SwapReturnedZero();
        ctx.spent = usdgBefore - _usdg.balanceOf(address(this));
        if (ctx.spent > amountIn) revert Overspent(amountIn, ctx.spent);
        uint256 wethIn = _weth.balanceOf(address(this)) - wethBefore;
        if (wethIn > 0) _dust.weth += wethIn;
    }

    /// @dev Phase 3: debit idle USDG (and burn the boost shares behind any boosted spend, priced at the page's
    ///      pool snapshot) and mark plans filled. Only runs after a successful purchase.
    function _commitSpend(Ctx memory ctx, Fill[] memory fills) internal {
        for (uint256 j; j < ctx.n; ++j) {
            Fill memory f = fills[j];
            if (f.spend == 0) continue; // dropped boosted fill
            Plan storage p = _plans[f.planId];
            p.usdgIdle -= f.spend - f.fromBoost;
            if (f.fromBoost > 0) BoostLib.burn(_boost, p, f.planId, f.fromBoost, ctx.poolAssets, ctx.poolShares);
            p.lastEpochId = ctx.epochId;
        }
        totalUsdgIdle -= ctx.totalSpend - ctx.boostOut;
    }

    /// @dev Remove every fill that needed boosted funds from the page tallies (the plans keep their balances
    ///      and are not marked filled, so they simply try again next epoch).
    function _dropBoostedFills(Ctx memory ctx, Fill[] memory fills) internal pure {
        for (uint256 j; j < ctx.n; ++j) {
            Fill memory f = fills[j];
            if (f.fromBoost == 0) continue;
            ctx.totalSpend -= f.spend;
            ctx.totalNet -= f.net;
            ctx.totalFee -= f.fee;
            --ctx.filled;
            f.spend = 0;
            f.net = 0;
            f.fee = 0;
            f.fromBoost = 0;
        }
        ctx.boostOut = 0;
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
        if (residual > backTotal) _dust.usdg += residual - backTotal;
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
        VaultAdminLib.sweepDust(_dust, _usdg, _weth, feeRecipient, force ? 0 : dustSweepMinUsdg);
    }

    // ==================================================================
    // Admin
    // ==================================================================

    /// @notice Replace the whole fee configuration. Every fee is capped at 90 bps; tolerances have their own caps
    ///         (swap slippage <= 100 bps, keeper tip <= 10%) and may only be changed by the owner: the feeManager
    ///         can move the fees, not the price tolerance of every epoch buy (audit v0.3 L-04).
    /// @dev Owner or feeManager. Emits the full config so indexers never need to diff.
    function setFees(FeeConfig calldata f) external onlyFeeManager {
        VaultAdminLib.setFees(_fees, f, msg.sender == owner());
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

    /// @inheritdoc IPlanVault
    /// @notice Page notional cap in USDG: `stock == address(0)` sets the vault default (0 = unlimited), otherwise a
    ///         per-stock override (0 = use the default). Size it to what the stock's approved pools absorb inside
    ///         the router's impact cap (see script/RouteBench.s.sol).
    function setMaxPageNotional(address stock, uint256 amount) external onlyOwner {
        if (stock == address(0)) maxPageNotional = amount;
        else maxPageNotionalOf[stock] = amount;
        emit MaxPageNotionalSet(stock, amount);
    }

    /// @notice Swap the router. The vault holds no standing approvals (it approves exactly one swap's input per
    ///         call), so there is nothing to revoke; the new router must share the vault's WETH.
    function setRouter(address newRouter) external onlyOwner {
        _setRouter(newRouter);
    }

    /// @notice Set (or migrate) the ERC-4626 strategy boosted plans lend through. Its asset must be USDG. With
    ///         boosted positions open the whole pool is redeemed from the old strategy and deposited into the new
    ///         one in this call (internal shares are untouched); clearing the strategy then reverts `BoostInUse`.
    function setBoostStrategy(address strategy) external onlyOwner nonReentrant {
        BoostLib.setStrategy(_boost, _usdg, strategy);
    }

    /// @inheritdoc IPlanVault
    /// @notice Set (or clear with `feed == address(0)`) the Chainlink reference feed of `stock` (USD per raw token).
    function setPriceFeed(address stock, address feed, uint32 maxStaleness) external onlyOwner {
        PriceGuardLib.setFeed(priceFeed, stock, feed, maxStaleness);
    }

    /// @inheritdoc IPlanVault
    /// @notice Tune the price guard: max deviation (bps, <= 1000), whether stocks without a feed may be bought,
    ///         and an optional L2 sequencer uptime feed with its grace period.
    function setPriceGuard(uint16 maxDeviationBps, bool requireFeed, address sequencerFeed, uint32 sequencerGrace)
        external
        onlyOwner
    {
        PriceGuardLib.setConfig(priceGuard, maxDeviationBps, requireFeed, sequencerFeed, sequencerGrace);
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

    /// @notice Recover tokens that can never be user accounting: not USDG, not WETH, not the boost strategy's
    ///         shares, never listed as a stock (those are reconciled with `skim`).
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        VaultAdminLib.rescue(token, to, amount, _usdg, _weth, address(_boost.strategy), _registry);
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
    /// @notice USDG value of the vault's whole boost position (yield accrued to this block), i.e. what the
    ///         internal boost pool is worth. A plan's share of it is `boostShares / (totalBoostShares + 1)`
    ///         (see BoostLib.valueOf; ClaimHelper.boostValueOf does the maths).
    function boostAssets() external view returns (uint256) {
        return BoostLib.poolAssets(_boost);
    }

    /// @inheritdoc IPlanVault
    /// @notice Internal boost-pool shares held by all boosted plans; the pool is worth `boostAssets()`.
    function totalBoostShares() external view returns (uint256) {
        return _boost.totalShares;
    }

    /// @inheritdoc IPlanVault
    function fees() external view returns (FeeConfig memory) {
        return _fees;
    }

    /// @inheritdoc IPlanVault
    function usdgDust() external view returns (uint256) {
        return _dust.usdg;
    }

    /// @inheritdoc IPlanVault
    function wethDust() external view returns (uint256) {
        return _dust.weth;
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

    /// @inheritdoc IPlanVault
    /// @notice The ERC-4626 strategy boosted plans lend through (address(0) = boost unavailable).
    function boostStrategy() external view returns (address) {
        return address(_boost.strategy);
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
        _weth.forceApprove(address(_router), net); // exact, per-call (audit v0.3 M-03)
        _router.swap(address(_weth), address(_usdg), net, minUsdgOut, address(this));
        _weth.forceApprove(address(_router), 0);
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
        Plan storage p = _plans[planId];
        if (p.boosted) {
            BoostLib.deposit(_boost, p, planId, amount);
            return;
        }
        p.usdgIdle += amount.toUint128();
        totalUsdgIdle += amount;
    }

    function _takeDepositFee(IERC20 token, uint256 amount) internal returns (uint256 net, uint256 fee) {
        (net, fee) = FeeMath.split(amount, _fees.depositFeeBps);
        if (fee > 0) token.safeTransfer(feeRecipient, fee);
    }

    /// @dev Claim `amount` (`type(uint256).max` = all) of `planId`'s accrued stock through the exit library.
    function _claim(uint256 planId, uint256 amount) internal {
        Plan storage p = _plans[planId];
        PlanExitLib.claim(p, planId, amount, totalStockAccrued, userStockAccrued, feeRecipient, _claimFeeBps(p.owner));
    }

    /// @dev Claim fee for `user`: 0 for auto-distribute tier holders, read as a spot $DCA balance at claim time by
    ///      decision (audit v0.3 L-01 accepted: the perk is meant to be live).
    function _claimFeeBps(address user) internal view returns (uint16) {
        return isAutoDistribute(user) ? 0 : _fees.claimFeeBps;
    }

    function _index(uint256 planId, address stock) internal {
        if (_stockPlanIndex[planId] != 0) return;
        _stockPlans[stock].push(planId);
        _stockPlanIndex[planId] = _stockPlans[stock].length;
        emit PlanIndexed(planId, stock, true);
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

    /// @dev Non-reverting ERC-20 transfer. Returns false on revert / false return so a blocked recipient
    ///      (e.g. a stock token with an allowlist) degrades to accrual instead of bricking the epoch.
    function _tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return token.code.length > 0;
        if (ret.length != 32) return false;
        return abi.decode(ret, (bool));
    }

    /// @dev No standing approvals are granted (audit v0.3 M-03: a max approval made `setRouter` a one-transaction
    ///      custody transfer). `_buyStock` / `_zapWethDeposit` approve exactly one swap's input and reset it.
    function _setRouter(address newRouter) internal {
        if (newRouter == address(0)) revert ZeroAddress();
        if (IAggregatorRouter(newRouter).weth() != address(_weth)) revert RouterMismatch(newRouter);
        _router = IAggregatorRouter(newRouter);
        emit RouterSet(newRouter);
    }
}
