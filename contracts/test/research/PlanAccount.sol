// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAggregatorRouter, Route} from "../../src/router/IAggregatorRouter.sol";
import {IStockRegistry} from "../../src/interfaces/IStockRegistry.sol";
import {IDCA} from "../../src/token/IDCA.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {PriceGuardLib} from "../../src/libraries/PriceGuardLib.sol";
import {PriceGuard, PriceFeed} from "../../src/vault/VaultTypes.sol";

/// @title PlanAccount (RESEARCH PROTOTYPE — not audited, never deploy)
/// @notice One DCA plan = one contract (an EIP-1167 clone). The plan's USDG sits in the account; each buy is its
///         own swap straight to `recipient`. Built only to measure what the per-plan-contract design costs next to
///         the pooled PlanVault; see test/research/PerPlan.Fork.t.sol.
/// @dev Safety parity with PlanVault._buyStock where it matters for the comparison: exact per-call approval, the
///      same Chainlink floor (PriceGuardLib), router quote + slippage floor, fee skimmed before the swap, $DCA fee
///      halving read at execution, no catch-up of missed buys. Deliberately left out (not needed to measure gas or
///      execution): boost, WETH deposits, claim path, withdraw fee, pause-by-owner of the factory.
contract PlanAccount {
    using SafeERC20 for IERC20;

    // slot 0
    PlanAccountFactory public factory;
    uint32 public interval; // seconds between buys (any cadence: no Daily/Weekly/Monthly vaults needed)
    uint64 public nextAt; // earliest timestamp of the next buy; its phase is the plan's own (natural staggering)
    // slot 1
    address public owner;
    uint96 public amountPerBuy;
    // slot 2
    address public recipient;
    bool public paused;
    // slot 3
    address public stock;

    error AlreadyInitialized();
    error OnlyFactory();
    error OnlyOwner();
    error NotDue(uint64 nextAt);
    error Paused();
    error Empty();
    error SwapReturnedZero();

    event Bought(uint256 spend, uint256 fee, uint256 bought, uint64 nextAt);
    event Withdrawn(uint256 amount);

    function initialize(
        address owner_,
        address recipient_,
        address stock_,
        uint96 amountPerBuy_,
        uint32 interval_,
        uint64 firstAt
    ) external {
        if (address(factory) != address(0)) revert AlreadyInitialized();
        factory = PlanAccountFactory(msg.sender);
        owner = owner_;
        recipient = recipient_;
        stock = stock_;
        amountPerBuy = amountPerBuy_;
        interval = interval_;
        nextAt = firstAt;
    }

    /// @notice One buy. `lean` skips the in-tx router quote: the factory's cached path is executed with the
    ///         Chainlink floor as minOut (the only price protection that survives a sandwich anyway).
    function execute(bool lean) external returns (uint256 bought) {
        PlanAccountFactory f = factory;
        if (msg.sender != address(f)) revert OnlyFactory();
        if (paused) revert Paused();
        uint64 due = nextAt;
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < due) revert NotDue(due);
        // Missed buys are skipped, never caught up: move to the first future slot on the plan's own phase.
        uint64 next = due + interval;
        // forge-lint: disable-next-line(block-timestamp)
        if (next <= block.timestamp) next += uint64(((block.timestamp - next) / interval + 1) * interval);
        nextAt = next;

        (IERC20 usdg, IAggregatorRouter router, address feeRecipient, uint16 feeBps, uint16 slipBps) = f.config();
        address stock_ = stock;
        uint256 spend = usdg.balanceOf(address(this));
        if (spend > amountPerBuy) spend = amountPerBuy;
        if (spend == 0) revert Empty();
        if (f.halvesFee(owner)) feeBps = FeeMath.halve(feeBps);
        (uint256 net, uint256 fee) = FeeMath.split(spend, feeBps);

        Route[] memory path;
        uint256 minOut;
        if (lean) {
            path = f.leanPath(stock_);
            minOut = f.referenceFloor(stock_, net);
        } else {
            uint256 quoted;
            (quoted, path) = router.quote(address(usdg), stock_, net);
            minOut = FeeMath.applySlippage(quoted, slipBps);
            f.checkPrice(stock_, net, minOut);
        }

        if (fee > 0) usdg.safeTransfer(feeRecipient, fee);
        address to = recipient;
        uint256 before = IERC20(stock_).balanceOf(to);
        usdg.forceApprove(address(router), net);
        router.swapWithRoute(address(usdg), stock_, net, minOut, to, path);
        usdg.forceApprove(address(router), 0);
        bought = IERC20(stock_).balanceOf(to) - before;
        if (bought == 0) revert SwapReturnedZero();
        emit Bought(spend, fee, bought, next);
    }

    function withdraw(uint256 amount) external {
        if (msg.sender != owner) revert OnlyOwner();
        (IERC20 usdg,,,,) = factory.config();
        if (amount == type(uint256).max) amount = usdg.balanceOf(address(this));
        usdg.safeTransfer(msg.sender, amount);
        emit Withdrawn(amount);
    }

    function setPaused(bool p) external {
        if (msg.sender != owner) revert OnlyOwner();
        paused = p;
    }
}

/// @title PlanAccountFactory (RESEARCH PROTOTYPE)
/// @notice Deploys PlanAccount clones, holds the shared configuration (router, fees, price guard, keepers) and is
///         the only caller of `PlanAccount.execute` (`fire` / `fireBatch`, keeper-only).
contract PlanAccountFactory is Ownable {
    using SafeERC20 for IERC20;

    address public immutable implementation;
    IERC20 public immutable usdg;
    IDCA public immutable dca;
    IStockRegistry public immutable registry;
    uint8 public immutable usdgDecimals;

    IAggregatorRouter public router;
    address public feeRecipient;
    uint16 public purchaseFeeBps = 75;
    uint16 public swapSlippageBps = 50;
    uint256 public feeHalveThreshold;
    uint256 public minAmountPerBuy;
    PriceGuard public priceGuard;
    mapping(address => PriceFeed) public priceFeed;
    mapping(address => Route[]) internal _leanPath;
    mapping(address => bool) public isKeeper;
    mapping(address => bool) public isPlan;

    error NotKeeper();
    error NotPlan(address plan);
    error StockNotPurchasable(address stock);
    error BelowMinimum(uint256 value, uint256 min);

    event PlanCreated(address indexed plan, address indexed owner, address indexed stock, uint96 amountPerBuy, uint32 interval);
    event FireFailed(address indexed plan, bytes reason);

    constructor(address usdg_, address dca_, address registry_, address router_, address feeRecipient_, address owner_)
        Ownable(owner_)
    {
        implementation = address(new PlanAccount());
        usdg = IERC20(usdg_);
        dca = IDCA(dca_);
        registry = IStockRegistry(registry_);
        router = IAggregatorRouter(router_);
        feeRecipient = feeRecipient_;
        usdgDecimals = IERC20Metadata(usdg_).decimals();
        minAmountPerBuy = 10 * 10 ** usdgDecimals;
        feeHalveThreshold = 100_000e18;
        priceGuard.maxDeviationBps = 300;
        priceGuard.requireFeed = true;
    }

    // ------------------------------------------------------------------ user

    /// @notice Deploy a plan and fund it. The first buy is `interval` from now: every plan runs on its own phase.
    function createPlan(address stock, uint96 amountPerBuy, uint32 interval, address recipient, uint256 usdgAmount)
        external
        returns (address plan)
    {
        if (!registry.isPurchasable(stock)) revert StockNotPurchasable(stock);
        if (amountPerBuy < minAmountPerBuy) revert BelowMinimum(amountPerBuy, minAmountPerBuy);
        if (recipient == address(0)) recipient = msg.sender;
        plan = Clones.clone(implementation);
        // forge-lint: disable-next-line(unsafe-typecast)
        PlanAccount(plan).initialize(msg.sender, recipient, stock, amountPerBuy, interval, uint64(block.timestamp) + interval);
        isPlan[plan] = true;
        if (usdgAmount > 0) usdg.safeTransferFrom(msg.sender, plan, usdgAmount);
        emit PlanCreated(plan, msg.sender, stock, amountPerBuy, interval);
    }

    // ------------------------------------------------------------------ keeper

    function fire(address plan, bool lean) external returns (uint256) {
        if (!isKeeper[msg.sender] && msg.sender != owner()) revert NotKeeper();
        if (!isPlan[plan]) revert NotPlan(plan);
        return PlanAccount(plan).execute(lean);
    }

    /// @notice Many plans in one transaction. One failing plan never blocks the others.
    function fireBatch(address[] calldata plans, bool lean) external returns (uint256 ok) {
        if (!isKeeper[msg.sender] && msg.sender != owner()) revert NotKeeper();
        for (uint256 i; i < plans.length; ++i) {
            if (!isPlan[plans[i]]) continue;
            try PlanAccount(plans[i]).execute(lean) returns (uint256) {
                ++ok;
            } catch (bytes memory reason) {
                emit FireFailed(plans[i], reason);
            }
        }
    }

    // ------------------------------------------------------------------ views used by the accounts

    function config() external view returns (IERC20, IAggregatorRouter, address, uint16, uint16) {
        return (usdg, router, feeRecipient, purchaseFeeBps, swapSlippageBps);
    }

    function halvesFee(address user) external view returns (bool) {
        return address(dca) != address(0) && dca.balanceOf(user) >= feeHalveThreshold;
    }

    function checkPrice(address stock, uint256 amountIn, uint256 minOut) external view {
        PriceGuardLib.check(priceGuard, priceFeed, stock, amountIn, minOut, usdgDecimals);
    }

    /// @notice Chainlink reference output less `maxDeviationBps`: the lean path's minOut.
    function referenceFloor(address stock, uint256 amountIn) external view returns (uint256) {
        (uint256 expected, bool hasFeed) = PriceGuardLib.referenceOut(priceGuard, priceFeed, stock, amountIn, usdgDecimals);
        if (!hasFeed) revert StockNotPurchasable(stock);
        return (expected * (FeeMath.BPS - priceGuard.maxDeviationBps)) / FeeMath.BPS;
    }

    function leanPath(address stock) external view returns (Route[] memory) {
        return _leanPath[stock];
    }

    // ------------------------------------------------------------------ admin

    function setKeeper(address k, bool allowed) external onlyOwner {
        isKeeper[k] = allowed;
    }

    function setPriceFeed(address stock, address feed, uint32 maxStaleness) external onlyOwner {
        PriceGuardLib.setFeed(priceFeed, stock, feed, maxStaleness);
    }

    function setLeanPath(address stock, Route[] calldata path) external onlyOwner {
        delete _leanPath[stock];
        for (uint256 i; i < path.length; ++i) {
            _leanPath[stock].push(path[i]);
        }
    }

    function setMaxDeviationBps(uint16 bps) external onlyOwner {
        priceGuard.maxDeviationBps = bps;
    }

    function setPurchaseFeeBps(uint16 bps) external onlyOwner {
        FeeMath.validate(bps);
        purchaseFeeBps = bps;
    }
}
