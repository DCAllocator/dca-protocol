// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {StockRegistry} from "../src/registries/StockRegistry.sol";
import {AggregatorRouter} from "../src/router/AggregatorRouter.sol";
import {UniV3Adapter} from "../src/router/adapters/UniV3Adapter.sol";
import {RamsesV3Adapter} from "../src/router/adapters/RamsesV3Adapter.sol";
import {UniV4Adapter} from "../src/router/adapters/UniV4Adapter.sol";
import {DailyVault} from "../src/vault/DailyVault.sol";
import {WeeklyVault} from "../src/vault/WeeklyVault.sol";
import {MonthlyVault} from "../src/vault/MonthlyVault.sol";
import {PlanVault} from "../src/vault/PlanVault.sol";
import {VaultDirectory} from "../src/vault/VaultDirectory.sol";
import {VaultParams, FeeConfig} from "../src/vault/VaultTypes.sol";
import {Route} from "../src/router/IAggregatorRouter.sol";
import {IUniswapV3Pool} from "../src/interfaces/IUniswapV3.sol";
import {EpochKeeper} from "../src/keeper/EpochKeeper.sol";
import {Zap} from "../src/periphery/Zap.sol";
import {ClaimHelper} from "../src/periphery/ClaimHelper.sol";
import {EpochLib} from "../src/libraries/EpochLib.sol";
import {MorphoBlueStrategy} from "../src/boost/MorphoBlueStrategy.sol";
import {IMorpho, Id, MarketParams} from "../src/interfaces/IMorpho.sol";
import {IDCA} from "../src/token/IDCA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title Deploy
/// @notice Production deployment for Robinhood Chain (4663). Reads external addresses from the environment
///         (see .env.example) and fee defaults + $DCA perk thresholds from config/fees.json. Never deploys a mock $DCA.
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $RH_RPC --broadcast --verify -vvvv
///
/// Routes: the router only trades owner-approved hops. `V3_POOLS="1:0xpool,3:0xpool,..."` (protocol id : pool)
/// approves both directions of each listed V3-style pool at deploy; V4 keys and later additions go through
/// `script/ApproveRoutes.s.sol` / `router.approveHop`.
///
/// Boost: `MORPHO` (Morpho Blue singleton) + `MORPHO_MARKET_ID` (bytes32 id of a market whose loan token is USDG)
/// deploy a `MorphoBlueStrategy` over that market, allow the three vaults to deposit and set it as their
/// `boostStrategy`. Leave `MORPHO` empty to ship without boost; `setBoostStrategy` can wire it up later.
/// The strategy is seeded with `BOOST_SEED_USDG` whole USDG (default 100, paid by the deployer) whose shares are
/// sent to 0x…dEaD so the share supply is never zero (audit v0.3 M-01). `BOOST_SEED_USDG=0` skips the seed.
///
/// Price guard (audit v0.3 H-01): every epoch purchase is floored at the stock's Chainlink reference price less
/// `PRICE_GUARD_BPS` (default 300). `PRICE_FEEDS="0xstock:0xfeed,..."` (Chainlink AggregatorV3, USD per raw token)
/// with `FEED_MAX_STALENESS` seconds (default 90000 = 25 h) is set on every vault. The vaults fail closed
/// (`REQUIRE_PRICE_FEED`, default true): with it on, every approved stock must have a feed or the script aborts.
/// `SEQUENCER_FEED` / `SEQUENCER_GRACE` (default 3600) wire Chainlink's L2 sequencer uptime feed when available.
///
/// Post-deploy (multisig): call `acceptOwnership()` on registry, router, adapters, vaults, keeper, directory,
/// boost strategy.
contract Deploy is Script {
    using stdJson for string;

    struct Env {
        address owner;
        address feeRecipient;
        address usdg;
        address weth;
        address dca;
        address uniV3Factory;
        address uniV4PoolManager;
        address ramsesFactory;
        address[] keepers;
        string v3Pools;
        address morpho;
        bytes32 morphoMarketId;
        uint256 boostSeed;
        string priceFeeds;
        uint256 maxPageNotional;
        string pageCaps;
        uint32 feedMaxStaleness;
        uint16 priceGuardBps;
        bool requirePriceFeed;
        address sequencerFeed;
        uint32 sequencerGrace;
    }

    struct Out {
        StockRegistry registry;
        AggregatorRouter router;
        UniV3Adapter uniV3;
        UniV4Adapter uniV4;
        RamsesV3Adapter ramses;
        DailyVault daily;
        WeeklyVault weekly;
        MonthlyVault monthly;
        EpochKeeper keeper;
        VaultDirectory directory;
        Zap zap;
        ClaimHelper helper;
        MorphoBlueStrategy boostStrategy;
    }

    function run() external {
        Env memory e = _env();
        FeeConfig memory fees = _fees();

        vm.startBroadcast();
        address deployer = msg.sender;
        Out memory o;

        // Infra: deployer owns everything during setup, ownership is handed to `owner` at the end.
        o.registry = new StockRegistry(deployer);
        o.router = new AggregatorRouter(e.weth, deployer);
        if (e.uniV3Factory != address(0)) {
            o.uniV3 = new UniV3Adapter(1, address(o.router), e.uniV3Factory, deployer);
            o.router.setAdapter(1, address(o.uniV3));
        }
        if (e.uniV4PoolManager != address(0)) {
            o.uniV4 = new UniV4Adapter(address(o.router), e.uniV4PoolManager, deployer);
            o.router.setAdapter(2, address(o.uniV4));
        }
        if (e.ramsesFactory != address(0)) {
            o.ramses = new RamsesV3Adapter(address(o.router), e.ramsesFactory, deployer);
            o.router.setAdapter(3, address(o.ramses));
        }

        // Stocks from STOCKS="NVDA:0x..,AAPL:0x.." (optional at deploy; can be listed later).
        _listStocks(o.registry);
        // Approved hops from V3_POOLS="1:0x..,3:0x.." (both directions of each pool).
        _approvePools(o.router, e.v3Pools);

        // Vaults with aligned origins (epoch 0 contains now; first fire at the next boundary).
        VaultParams memory p = VaultParams({
            owner: deployer,
            usdg: e.usdg,
            weth: e.weth,
            dca: e.dca,
            registry: address(o.registry),
            router: address(o.router),
            feeRecipient: e.feeRecipient,
            epochLength: 0,
            origin: 0,
            purchaseFeeBps: 0
        });
        p.origin = EpochLib.alignToDay(block.timestamp);
        o.daily = new DailyVault(p);
        p.origin = EpochLib.alignToMonday(block.timestamp);
        o.weekly = new WeeklyVault(p);
        p.origin = EpochLib.alignToDay(block.timestamp);
        o.monthly = new MonthlyVault(p);

        // Fees from config (defaults already match; applied explicitly so config is the source of truth).
        fees.purchaseFeeBps = uint16(_cfgUint("dailyPurchaseFeeBps"));
        o.daily.setFees(fees);
        fees.purchaseFeeBps = uint16(_cfgUint("weeklyPurchaseFeeBps"));
        o.weekly.setFees(fees);
        fees.purchaseFeeBps = uint16(_cfgUint("monthlyPurchaseFeeBps"));
        o.monthly.setFees(fees);
        uint16 maxPlans = uint16(_cfgUint("maxPlansPerTx"));
        o.daily.setMaxPlansPerTx(maxPlans);
        o.weekly.setMaxPlansPerTx(maxPlans);
        o.monthly.setMaxPlansPerTx(maxPlans);
        // $DCA perk thresholds from config, in whole tokens (scaled by the token's decimals; 18 without a token).
        (uint256 autoDist, uint256 feeHalve) = _thresholds(e.dca);
        o.daily.setThresholds(autoDist, feeHalve);
        o.weekly.setThresholds(autoDist, feeHalve);
        o.monthly.setThresholds(autoDist, feeHalve);
        o.router.setMaxPriceImpactBps(uint16(_cfgUint("maxPriceImpactBps")));

        // Keeper + jobs for every approved stock. Vaults run keeperOnly (default); the EpochKeeper contract and
        // every KEEPERS address are vault keepers, and KEEPERS are EpochKeeper operators.
        o.keeper = new EpochKeeper(e.usdg, deployer);
        PlanVault[3] memory vaults = [PlanVault(o.daily), PlanVault(o.weekly), PlanVault(o.monthly)];
        address[] memory stocks = o.registry.approvedStocks();
        for (uint256 v; v < 3; ++v) {
            vaults[v].setKeeper(address(o.keeper), true);
            for (uint256 k; k < e.keepers.length; ++k) {
                vaults[v].setKeeper(e.keepers[k], true);
            }
            for (uint256 s; s < stocks.length; ++s) {
                o.keeper.addJob(address(vaults[v]), stocks[s]);
            }
        }
        for (uint256 k; k < e.keepers.length; ++k) {
            o.keeper.setOperator(e.keepers[k], true);
        }

        // Price guard: Chainlink reference feeds per stock, fail closed unless explicitly opted out.
        _setPriceFeeds(vaults, stocks, e);
        // Page sizing: vault-wide cap plus per-stock overrides sized to the pools (script/RouteBench.s.sol).
        _setPageCaps(vaults, e);

        // Boost (optional): one strategy over the configured Morpho Blue USDG market, shared by the vaults.
        if (e.morpho != address(0)) {
            MarketParams memory market = IMorpho(e.morpho).idToMarketParams(Id.wrap(e.morphoMarketId));
            require(market.loanToken == e.usdg, "MORPHO_MARKET_ID: loan token is not USDG");
            o.boostStrategy = new MorphoBlueStrategy(e.morpho, market, deployer);
            if (e.boostSeed > 0) {
                require(IERC20(e.usdg).balanceOf(deployer) >= e.boostSeed, "deployer lacks BOOST_SEED_USDG");
                o.boostStrategy.setDepositor(deployer, true);
                IERC20(e.usdg).approve(address(o.boostStrategy), e.boostSeed);
                o.boostStrategy.deposit(e.boostSeed, 0x000000000000000000000000000000000000dEaD);
                o.boostStrategy.setDepositor(deployer, false);
            }
            for (uint256 v; v < 3; ++v) {
                o.boostStrategy.setDepositor(address(vaults[v]), true);
                vaults[v].setBoostStrategy(address(o.boostStrategy));
            }
        }

        // Periphery + directory.
        o.zap = new Zap(e.weth, e.usdg, address(o.router));
        o.helper = new ClaimHelper();
        o.directory = new VaultDirectory(deployer);
        o.directory
            .set(
                VaultDirectory.Entry({
                    daily: address(o.daily),
                    weekly: address(o.weekly),
                    monthly: address(o.monthly),
                    registry: address(o.registry),
                    router: address(o.router),
                    usdg: e.usdg,
                    weth: e.weth,
                    dca: e.dca
                })
            );

        // Hand over (2-step: `owner` must accept on each contract).
        if (e.owner != deployer) {
            o.registry.transferOwnership(e.owner);
            o.router.transferOwnership(e.owner);
            if (address(o.uniV3) != address(0)) o.uniV3.transferOwnership(e.owner);
            if (address(o.uniV4) != address(0)) o.uniV4.transferOwnership(e.owner);
            if (address(o.ramses) != address(0)) o.ramses.transferOwnership(e.owner);
            o.daily.transferOwnership(e.owner);
            o.weekly.transferOwnership(e.owner);
            o.monthly.transferOwnership(e.owner);
            o.keeper.transferOwnership(e.owner);
            o.directory.transferOwnership(e.owner);
            if (address(o.boostStrategy) != address(0)) o.boostStrategy.transferOwnership(e.owner);
        }
        vm.stopBroadcast();

        _write(o, e);
    }

    // ------------------------------------------------------------------
    // Inputs
    // ------------------------------------------------------------------

    function _env() internal view returns (Env memory e) {
        e.owner = vm.envOr("OWNER", msg.sender);
        e.feeRecipient = vm.envOr("FEE_RECIPIENT", e.owner);
        e.usdg = vm.envAddress("USDG");
        e.weth = vm.envAddress("WETH");
        e.dca = vm.envOr("DCA", address(0));
        e.uniV3Factory = vm.envOr("UNIV3_FACTORY", address(0));
        e.uniV4PoolManager = vm.envOr("UNIV4_POOL_MANAGER", address(0));
        e.ramsesFactory = vm.envOr("RAMSES_FACTORY", address(0));
        e.keepers = vm.envOr("KEEPERS", ",", new address[](0));
        e.v3Pools = vm.envOr("V3_POOLS", string(""));
        e.morpho = vm.envOr("MORPHO", address(0));
        e.morphoMarketId = vm.envOr("MORPHO_MARKET_ID", bytes32(0));
        e.boostSeed = vm.envOr("BOOST_SEED_USDG", uint256(100)) * 10 ** IERC20Metadata(e.usdg).decimals();
        e.priceFeeds = vm.envOr("PRICE_FEEDS", string(""));
        e.maxPageNotional =
            vm.envOr("MAX_PAGE_NOTIONAL_USDG", uint256(100_000)) * 10 ** IERC20Metadata(e.usdg).decimals();
        e.pageCaps = vm.envOr("PAGE_NOTIONAL_CAPS", string(""));
        e.feedMaxStaleness = uint32(vm.envOr("FEED_MAX_STALENESS", uint256(90_000)));
        e.priceGuardBps = uint16(vm.envOr("PRICE_GUARD_BPS", uint256(300)));
        e.requirePriceFeed = vm.envOr("REQUIRE_PRICE_FEED", true);
        e.sequencerFeed = vm.envOr("SEQUENCER_FEED", address(0));
        e.sequencerGrace = uint32(vm.envOr("SEQUENCER_GRACE", uint256(3_600)));
        require(e.usdg != address(0) && e.weth != address(0), "USDG / WETH required");
        require(e.morpho == address(0) || e.morphoMarketId != bytes32(0), "MORPHO set: MORPHO_MARKET_ID required");
        require(e.feeRecipient != address(0), "FEE_RECIPIENT required");
        if (block.chainid == 4663) {
            require(e.dca != address(0) || vm.envOr("ALLOW_NO_DCA", false), "set DCA or ALLOW_NO_DCA=true");
        }
    }

    function _fees() internal view returns (FeeConfig memory f) {
        f.depositFeeBps = uint16(_cfgUint("depositFeeBps"));
        f.withdrawFeeBps = uint16(_cfgUint("withdrawFeeBps"));
        f.claimFeeBps = uint16(_cfgUint("claimFeeBps"));
        f.keeperTipBps = uint16(_cfgUint("keeperTipBps"));
        f.swapSlippageBps = uint16(_cfgUint("swapSlippageBps"));
    }

    function _cfgUint(string memory key) internal view returns (uint256) {
        string memory json = vm.readFile("config/fees.json");
        return json.readUint(string.concat(".", key));
    }

    /// @dev `autoDistributeThreshold` / `feeHalveThreshold` from config are whole $DCA; the vault wants raw units.
    function _thresholds(address dca) internal view returns (uint256 autoDist, uint256 feeHalve) {
        uint256 unit = 10 ** (dca == address(0) ? 18 : IDCA(dca).decimals());
        autoDist = _cfgUint("autoDistributeThreshold") * unit;
        feeHalve = _cfgUint("feeHalveThreshold") * unit;
    }

    /// @dev STOCKS="NVDA:0xabc...,AAPL:0xdef..." — listed as approved, not fee-on-transfer.
    function _listStocks(StockRegistry registry) internal {
        string memory raw = vm.envOr("STOCKS", string(""));
        if (bytes(raw).length == 0) return;
        string[] memory entries = vm.split(raw, ",");
        for (uint256 i; i < entries.length; ++i) {
            string[] memory kv = vm.split(entries[i], ":");
            require(kv.length == 2, "STOCKS entry must be SYMBOL:address");
            registry.listStock(vm.parseAddress(kv[1]), kv[0], false, true);
        }
    }

    /// @dev PRICE_FEEDS="0xstock:0xfeed,..." — set the same feeds on every vault, then the guard config. With
    ///      `REQUIRE_PRICE_FEED` on, every approved stock must have a feed (otherwise no epoch could buy it).
    function _setPriceFeeds(PlanVault[3] memory vaults, address[] memory stocks, Env memory e) internal {
        if (bytes(e.priceFeeds).length != 0) {
            string[] memory entries = vm.split(e.priceFeeds, ",");
            for (uint256 i; i < entries.length; ++i) {
                string[] memory kv = vm.split(entries[i], ":");
                require(kv.length == 2, "PRICE_FEEDS entry must be stock:feed");
                address stock = vm.parseAddress(kv[0]);
                address feed = vm.parseAddress(kv[1]);
                for (uint256 v; v < 3; ++v) {
                    vaults[v].setPriceFeed(stock, feed, e.feedMaxStaleness);
                }
            }
        }
        if (e.requirePriceFeed) {
            for (uint256 s; s < stocks.length; ++s) {
                (address feed,,,) = vaults[0].priceFeed(stocks[s]);
                require(feed != address(0), string.concat("PRICE_FEEDS: no feed for ", vm.toString(stocks[s])));
            }
        }
        for (uint256 v; v < 3; ++v) {
            vaults[v].setPriceGuard(e.priceGuardBps, e.requirePriceFeed, e.sequencerFeed, e.sequencerGrace);
        }
    }

    /// @dev MAX_PAGE_NOTIONAL_USDG (whole USDG, vault default) and PAGE_NOTIONAL_CAPS="0xstock:wholeUsdg,..." for
    ///      stocks whose pools are thinner (or deeper) than the default assumes.
    function _setPageCaps(PlanVault[3] memory vaults, Env memory e) internal {
        uint256 unit = 10 ** IERC20Metadata(e.usdg).decimals();
        for (uint256 v; v < 3; ++v) {
            vaults[v].setMaxPageNotional(address(0), e.maxPageNotional);
        }
        if (bytes(e.pageCaps).length == 0) return;
        string[] memory entries = vm.split(e.pageCaps, ",");
        for (uint256 i; i < entries.length; ++i) {
            string[] memory kv = vm.split(entries[i], ":");
            require(kv.length == 2, "PAGE_NOTIONAL_CAPS entry must be stock:usdg");
            address stock = vm.parseAddress(kv[0]);
            uint256 cap = vm.parseUint(kv[1]) * unit;
            for (uint256 v; v < 3; ++v) {
                vaults[v].setMaxPageNotional(stock, cap);
            }
        }
    }

    /// @dev V3_POOLS="1:0xpool,3:0xpool" — approve tokenA->tokenB and tokenB->tokenA on the given adapter.
    function _approvePools(AggregatorRouter router, string memory raw) internal {
        if (bytes(raw).length == 0) return;
        string[] memory entries = vm.split(raw, ",");
        for (uint256 i; i < entries.length; ++i) {
            string[] memory kv = vm.split(entries[i], ":");
            require(kv.length == 2, "V3_POOLS entry must be protocol:pool");
            uint8 protocol = uint8(vm.parseUint(kv[0]));
            address pool = vm.parseAddress(kv[1]);
            address t0 = IUniswapV3Pool(pool).token0();
            address t1 = IUniswapV3Pool(pool).token1();
            uint24 fee = IUniswapV3Pool(pool).fee();
            router.approveHop(Route({protocol: protocol, tokenIn: t0, tokenOut: t1, fee: fee, extra: abi.encode(pool)}));
            router.approveHop(Route({protocol: protocol, tokenIn: t1, tokenOut: t0, fee: fee, extra: abi.encode(pool)}));
        }
    }

    // ------------------------------------------------------------------
    // Output
    // ------------------------------------------------------------------

    function _write(Out memory o, Env memory e) internal {
        string memory j = "deployment";
        j.serialize("chainId", block.chainid);
        j.serialize("owner", e.owner);
        j.serialize("feeRecipient", e.feeRecipient);
        j.serialize("usdg", e.usdg);
        j.serialize("weth", e.weth);
        j.serialize("dca", e.dca);
        j.serialize("registry", address(o.registry));
        j.serialize("router", address(o.router));
        j.serialize("uniV3Adapter", address(o.uniV3));
        j.serialize("uniV4Adapter", address(o.uniV4));
        j.serialize("ramsesV3Adapter", address(o.ramses));
        j.serialize("daily", address(o.daily));
        j.serialize("weekly", address(o.weekly));
        j.serialize("monthly", address(o.monthly));
        j.serialize("keeper", address(o.keeper));
        j.serialize("directory", address(o.directory));
        j.serialize("zap", address(o.zap));
        j.serialize("morpho", e.morpho);
        j.serialize("morphoMarketId", e.morphoMarketId);
        j.serialize("boostStrategy", address(o.boostStrategy));
        string memory out = j.serialize("claimHelper", address(o.helper));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console2.log("wrote", path);
        console2.log("directory", address(o.directory));
    }
}
