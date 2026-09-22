// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// forge-lint: disable-start(unsafe-typecast)

import {Script, console2} from "forge-std/Script.sol";

import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockWETH} from "../test/mocks/MockWETH.sol";
import {MockRouter} from "../test/mocks/MockRouter.sol";
import {MockDCA} from "../test/mocks/MockDCA.sol";
import {MockMorpho, MockIrm} from "../test/mocks/MockMorpho.sol";
import {MockAggregatorV3} from "../test/mocks/MockChainlink.sol";
import {TestVault} from "../test/mocks/TestVault.sol";
import {MorphoBlueStrategy} from "../src/boost/MorphoBlueStrategy.sol";
import {Id, MarketParams} from "../src/interfaces/IMorpho.sol";
import {StockRegistry} from "../src/registries/StockRegistry.sol";
import {VaultParams} from "../src/vault/VaultTypes.sol";

/// @title GasSim
/// @notice Epoch gas simulation: how much one epoch of a stock costs the operator as the number of plans grows,
///         for several page sizes, priced in USD. Uses the real vault (+ the linked libraries) with a mock router,
///         the Chainlink guard ON (mock feed) and, optionally, every plan boosted (upper bound: adds one strategy
///         withdrawal per page).
///
///   ./script/gas-sim.sh                      # fetches the ETH price and (if RH_RPC is set) the chain gas price
///   forge script script/GasSim.s.sol -vv     # with defaults / env below
///
/// Env: ETH_PRICE_USD (3000), GAS_PRICE_WEI (1e7 = 0.01 gwei), L1_FEE_USD_CENTS per tx (2),
///      (larger plan counts are extrapolated from the measured linear model; a single script frame cannot
///      hold many thousands of plans across several page sizes),
///      SIM_PLAN_COUNTS (10,100,1000), SIM_PAGE_SIZES (25,50,100,150), SIM_STOCKS (20, for the fleet
///      extrapolation), SIM_BOOSTED (false).
contract GasSim is Script {
    uint256 internal constant TX_BASE_GAS = 21_000 + 2_000; // intrinsic + calldata of an advanceEpoch call

    MockERC20 internal usdg;
    MockERC20 internal stock;
    TestVault internal vault;
    address internal keeper = address(0xBEEF);
    address internal admin = address(0xAD31); // scripts may not rely on address(this)
    uint256 internal ethPriceUsd;
    uint256 internal gasPriceWei;
    uint256 internal l1FeeCents;
    bool internal boosted;

    function run() external {
        vm.warp(1_800_000_000); // a script's default block.timestamp is ~0; the vault needs a real epoch origin
        ethPriceUsd = vm.envOr("ETH_PRICE_USD", uint256(3_000));
        gasPriceWei = vm.envOr("GAS_PRICE_WEI", uint256(10_000_000));
        l1FeeCents = vm.envOr("L1_FEE_USD_CENTS", uint256(2));
        boosted = vm.envOr("SIM_BOOSTED", false);
        uint256[] memory counts = _csv(vm.envOr("SIM_PLAN_COUNTS", string("10,100,1000")));
        uint256[] memory pages = _csv(vm.envOr("SIM_PAGE_SIZES", string("25,50,100,150")));
        uint256 stocksInFleet = vm.envOr("SIM_STOCKS", uint256(20));

        console2.log("");
        console2.log("=== GasSim: ETH $%s, gas %s wei, L1 fee %s cents/tx ===", ethPriceUsd, gasPriceWei, l1FeeCents);
        console2.log("plans %s, price guard ON", boosted ? "BOOSTED (every plan)" : "unboosted");

        // Calibrate the linear model (fixed per page, marginal per plan) from a 150-plan stock in STEADY STATE:
        // every plan has been filled once before (a plan's first fill pays ~40k extra for its fresh storage
        // slots; that is a one-off per plan, not a recurring cost).
        _deploy();
        _createPlans(150);
        _warmUp();
        _restart();
        uint256 g1 = _page(1);
        _restart();
        uint256 g150 = _page(150);
        uint256 perPlan = (g150 - g1) / 149;
        uint256 perPage = g1 - perPlan + TX_BASE_GAS;
        console2.log("");
        console2.log("--- model (steady state): %s gas per page (fixed, incl. tx base) + %s gas per plan ---", perPage, perPlan);
        console2.log("    (a plan's FIRST fill costs ~40k gas more, once)");

        // Measured epochs.
        console2.log("");
        console2.log("--- measured: one steady-state epoch of one stock (plans x page size) ---");
        for (uint256 c; c < counts.length; ++c) {
            _deploy();
            _createPlans(counts[c]);
            _warmUp();
            for (uint256 p; p < pages.length; ++p) {
                _restart();
                uint256 total;
                uint256 nPages;
                bool done;
                while (!done) {
                    uint256 g;
                    (g, done) = _pageWithStatus(pages[p]);
                    total += g + TX_BASE_GAS;
                    nPages++;
                }
                console2.log(
                    "plans %s, page %s: %s",
                    counts[c],
                    pages[p],
                    string.concat(vm.toString(nPages), " tx, ", vm.toString(total), " gas, $", _usd(total, nPages))
                );
            }
        }

        // Extrapolation.
        console2.log("");
        console2.log("--- extrapolated with the model, page 150, per epoch ---");
        uint256[5] memory big = [uint256(1_000), 10_000, 100_000, 1_000_000, 10_000_000];
        for (uint256 i; i < 5; ++i) {
            uint256 nPages = (big[i] + 149) / 150;
            uint256 gas = nPages * perPage + big[i] * perPlan;
            console2.log(
                "%s plans: %s tx, %s",
                big[i],
                nPages,
                string.concat(vm.toString(gas), " gas, $", _usd(gas, nPages), " per stock-epoch; fleet of ", vm.toString(stocksInFleet), " stocks: $", _usd(gas * stocksInFleet, nPages * stocksInFleet))
            );
        }
        console2.log("");
        console2.log("(Daily vault: multiply by 365/yr; the 75 bps purchase fee on the same plans is the revenue side.)");
    }

    // ------------------------------------------------------------------
    // Fixture
    // ------------------------------------------------------------------

    function _deploy() internal {
        vm.startPrank(admin);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        MockWETH weth = new MockWETH();
        MockDCA dca = new MockDCA(admin);
        stock = new MockERC20("Stock", "STK", 18);
        StockRegistry registry = new StockRegistry(admin);
        registry.listStock(address(stock), "STK", false, true);
        MockRouter router = new MockRouter(address(weth));
        router.setRate(address(usdg), address(stock), 1e18, 500e6);
        uint32 epoch = 1 hours;
        VaultParams memory p = VaultParams({
            owner: admin,
            usdg: address(usdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: address(0xFEE),
            epochLength: 0,
            origin: uint64(block.timestamp - (block.timestamp % epoch)),
            purchaseFeeBps: 0
        });
        vault = new TestVault(p, epoch);
        vault.setKeeper(keeper, true);
        vault.setMaxPlansPerTx(1_000);
        MockAggregatorV3 feed = new MockAggregatorV3(8, 500e8);
        vault.setPriceFeed(address(stock), address(feed), 365 days);
        if (boosted) {
            MockIrm irm = new MockIrm(uint256(0.055e18) / 365 days);
            MockMorpho morpho = new MockMorpho(admin);
            MarketParams memory m = MarketParams({
                loanToken: address(usdg),
                collateralToken: address(weth),
                oracle: address(0),
                irm: address(irm),
                lltv: 0.86e18
            });
            Id id = morpho.createMarket(m);
            usdg.mint(admin, 100_000_000e6);
            usdg.approve(address(morpho), type(uint256).max);
            morpho.supply(m, 100_000_000e6, 0, admin, "");
            morpho.mockBorrow(id, 50_000_000e6, admin);
            MorphoBlueStrategy strategy = new MorphoBlueStrategy(address(morpho), m, admin);
            strategy.setDepositor(admin, true);
            usdg.approve(address(strategy), 100e6);
            strategy.deposit(100e6, address(0xdEaD));
            strategy.setDepositor(address(vault), true);
            vault.setBoostStrategy(address(strategy));
        }
        vm.stopPrank();
    }

    function _createPlans(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            address user = address(uint160(0x10000 + i));
            usdg.mint(user, 1_000_000e6);
            vm.startPrank(user);
            usdg.approve(address(vault), type(uint256).max);
            vault.createPlan(address(stock), 100e6, address(0), 1_000_000e6, 0, 0, boosted);
            vm.stopPrank();
        }
    }

    /// @dev Move to the next epoch boundary so every plan is due again.
    function _restart() internal {
        vm.warp(vault.nextEpochStart());
    }

    /// @dev Fill every plan once (largest pages) so later measurements are steady state.
    function _warmUp() internal {
        _restart();
        bool done;
        while (!done) {
            (, done) = _pageWithStatus(150);
        }
    }

    function _page(uint256 limit) internal returns (uint256 gas) {
        (gas,) = _pageWithStatus(limit);
    }

    function _pageWithStatus(uint256 limit) internal returns (uint256 gas, bool completed) {
        vm.prank(keeper);
        uint256 g0 = gasleft();
        completed = vault.advanceEpoch(address(stock), limit, "");
        gas = g0 - gasleft();
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev USD with 2 decimals: gas x gasPrice x ethPrice + L1 fee per transaction.
    function _usd(uint256 gas, uint256 txs) internal view returns (string memory) {
        uint256 cents = (gas * gasPriceWei * ethPriceUsd * 100) / 1e18 + txs * l1FeeCents;
        string memory c = vm.toString(cents % 100);
        if (bytes(c).length < 2) c = string.concat("0", c);
        return string.concat(vm.toString(cents / 100), ".", c);
    }

    function _csv(string memory s) internal pure returns (uint256[] memory out) {
        string[] memory parts = vm.split(s, ",");
        out = new uint256[](parts.length);
        for (uint256 i; i < parts.length; ++i) {
            out[i] = vm.parseUint(parts[i]);
        }
    }
}
