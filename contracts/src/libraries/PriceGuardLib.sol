// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPlanVault} from "../interfaces/IPlanVault.sol";
import {AggregatorV3Interface} from "../interfaces/IChainlink.sol";
import {PriceGuard, PriceFeed} from "../vault/VaultTypes.sol";

/// @title PriceGuardLib
/// @notice The external price reference for epoch purchases (audit v0.3 H-01). Every number the vault used to
///         check before spending user money — the router quote, minOut, the impact cap — was read from the pool
///         in the executing block, so a pool pushed in an earlier block passed every check. This library floors
///         a page's `minOut` at the Chainlink reference price of the stock less `maxDeviationBps`; a fill that the
///         pool cannot deliver at that price reverts (`PriceDeviates`) and the page is retried later instead of
///         being filled at the pushed price. Linked as an EXTERNAL library and delegatecalled on the vault's
///         storage (same pattern as BoostLib / VaultAdminLib); events and errors are the vault's (IPlanVault).
///
/// @dev Feeds are Chainlink AggregatorV3 "USD per Stock Token" feeds. On Robinhood Chain the feeds already apply
///      the ERC-8056 `uiMultiplier`, i.e. they price one RAW token, which is what the pools trade. USDG is
///      treated as 1 USD. Robinhood Chain is an Arbitrum Orbit chain: an optional L2 sequencer uptime feed with
///      a grace period is supported (Chainlink's recommendation for L2s). A stale, zero or missing feed is a
///      refusal, never a silent pass, when `requireFeed` is on. The one deliberate pass is a stock the owner has
///      marked `UNGUARDED`.
library PriceGuardLib {
    uint16 internal constant MAX_DEVIATION_BPS = 1_000;
    uint256 internal constant BPS = 10_000;

    /// @notice Feed value that marks a stock as deliberately bought without an external price floor:
    ///         `setPriceFeed(stock, UNGUARDED, 0)`. Meant for $DCA, which has no Chainlink feed and whose own
    ///         trading tax is what defends it: a sandwich pays that tax on both legs, while the router's impact cap
    ///         keeps a page's own price move (all an attacker can capture) below it. The router quote, slippage,
    ///         impact cap and page cap still apply; `requireFeed` counts the stock as configured. Do not use it for a
    ///         token that trades anywhere the vault can route without that tax.
    address internal constant UNGUARDED = address(type(uint160).max);

    /// @notice Set (or clear with `feed == address(0)`) the reference feed of `stock`; `UNGUARDED` (any
    ///         `maxStaleness`, stored as 0) opts the stock out of the floor.
    function setFeed(mapping(address => PriceFeed) storage feeds, address stock, address feed, uint32 maxStaleness)
        external
    {
        if (feed == UNGUARDED) {
            feeds[stock] = PriceFeed({feed: UNGUARDED, maxStaleness: 0, feedDecimals: 0, stockDecimals: 0});
            emit IPlanVault.PriceFeedSet(stock, UNGUARDED, 0);
            return;
        }
        if (feed == address(0)) {
            delete feeds[stock];
            emit IPlanVault.PriceFeedSet(stock, address(0), 0);
            return;
        }
        if (maxStaleness == 0) revert IPlanVault.InvalidFeed(feed);
        uint8 feedDecimals = AggregatorV3Interface(feed).decimals();
        (, int256 answer,, uint256 updatedAt,) = AggregatorV3Interface(feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0) revert IPlanVault.InvalidFeed(feed);
        feeds[stock] = PriceFeed({
            feed: feed,
            maxStaleness: maxStaleness,
            feedDecimals: feedDecimals,
            stockDecimals: IERC20Metadata(stock).decimals()
        });
        emit IPlanVault.PriceFeedSet(stock, feed, maxStaleness);
    }

    /// @notice Tune the guard. `maxDeviationBps` in (0, 1000]; `requireFeed` refuses purchases of stocks without
    ///         a feed; `sequencerFeed` (optional) + `sequencerGrace` gate every check on L2 sequencer uptime.
    function setConfig(
        PriceGuard storage g,
        uint16 maxDeviationBps,
        bool requireFeed,
        address sequencerFeed,
        uint32 sequencerGrace
    ) external {
        if (maxDeviationBps == 0 || maxDeviationBps > MAX_DEVIATION_BPS) {
            revert IPlanVault.ValueOutOfRange(maxDeviationBps, MAX_DEVIATION_BPS);
        }
        g.maxDeviationBps = maxDeviationBps;
        g.requireFeed = requireFeed;
        g.sequencerFeed = sequencerFeed;
        g.sequencerGrace = sequencerGrace;
        emit IPlanVault.PriceGuardSet(maxDeviationBps, requireFeed, sequencerFeed, sequencerGrace);
    }

    /// @notice Revert unless `minOut` — the least the swap is allowed to deliver for `amountIn` USDG — is within
    ///         `maxDeviationBps` of the reference output. Stocks without a feed pass only when `requireFeed` is off;
    ///         an `UNGUARDED` stock always passes.
    function check(
        PriceGuard storage g,
        mapping(address => PriceFeed) storage feeds,
        address stock,
        uint256 amountIn,
        uint256 minOut,
        uint8 usdgDecimals
    ) external view {
        if (feeds[stock].feed == UNGUARDED) return;
        (uint256 expected, bool hasFeed) = referenceOut(g, feeds, stock, amountIn, usdgDecimals);
        if (!hasFeed) {
            if (g.requireFeed) revert IPlanVault.PriceFeedMissing(stock);
            return;
        }
        uint256 floor = (expected * (BPS - g.maxDeviationBps)) / BPS;
        if (minOut < floor) revert IPlanVault.PriceDeviates(stock, minOut, floor);
    }

    /// @notice Stock (raw units) that `amountIn` USDG buys at the feed price, or (0, false) if `stock` has no feed
    ///         (or is `UNGUARDED`).
    ///         Reverts `PriceFeedStale` / `SequencerDown` instead of returning an unusable reference.
    function referenceOut(
        PriceGuard storage g,
        mapping(address => PriceFeed) storage feeds,
        address stock,
        uint256 amountIn,
        uint8 usdgDecimals
    ) public view returns (uint256 expected, bool hasFeed) {
        PriceFeed storage f = feeds[stock];
        address feed = f.feed;
        if (feed == address(0) || feed == UNGUARDED) return (0, false);
        _checkSequencer(g);
        (, int256 answer,, uint256 updatedAt,) = AggregatorV3Interface(feed).latestRoundData();
        // forge-lint: disable-next-line(block-timestamp)
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > f.maxStaleness)
        {
            revert IPlanVault.PriceFeedStale(stock);
        }
        // expected = amountIn / 10^usdgDec (USD) × 10^feedDec / answer (tokens) × 10^stockDec (raw units)
        // casting to 'uint256' is safe: `answer > 0` was checked just above
        // forge-lint: disable-next-item(unsafe-typecast)
        expected = Math.mulDiv(
            amountIn, 10 ** (uint256(f.stockDecimals) + f.feedDecimals), uint256(answer) * 10 ** usdgDecimals
        );
        hasFeed = true;
    }

    /// @dev Chainlink L2 sequencer uptime feeds report answer 0 = up, 1 = down, and `startedAt` = when the current
    ///      status began. Feeds are not trusted until the sequencer has been up for `sequencerGrace` seconds.
    function _checkSequencer(PriceGuard storage g) private view {
        address sf = g.sequencerFeed;
        if (sf == address(0)) return;
        (, int256 answer, uint256 startedAt,,) = AggregatorV3Interface(sf).latestRoundData();
        // forge-lint: disable-next-line(block-timestamp)
        if (answer != 0 || block.timestamp - startedAt < g.sequencerGrace) revert IPlanVault.SequencerDown();
    }
}
