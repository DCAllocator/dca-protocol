// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockWETH} from "../test/mocks/MockWETH.sol";
import {MockV3Factory} from "../test/mocks/MockV3.sol";
import {MockDCA} from "../test/mocks/MockDCA.sol";
import {MockMorpho, MockIrm} from "../test/mocks/MockMorpho.sol";
import {MorphoBlueStrategy} from "../src/boost/MorphoBlueStrategy.sol";
import {Id, MarketParams} from "../src/interfaces/IMorpho.sol";
import {StockRegistry} from "../src/registries/StockRegistry.sol";
import {AggregatorRouter} from "../src/router/AggregatorRouter.sol";
import {UniV3Adapter} from "../src/router/adapters/UniV3Adapter.sol";
import {DailyVault} from "../src/vault/DailyVault.sol";
import {WeeklyVault} from "../src/vault/WeeklyVault.sol";
import {MonthlyVault} from "../src/vault/MonthlyVault.sol";
import {TestVault} from "../test/mocks/TestVault.sol";
import {PlanVault} from "../src/vault/PlanVault.sol";
import {VaultDirectory} from "../src/vault/VaultDirectory.sol";
import {VaultParams} from "../src/vault/VaultTypes.sol";
import {EpochKeeper} from "../src/keeper/EpochKeeper.sol";
import {Zap} from "../src/periphery/Zap.sol";
import {ClaimHelper} from "../src/periphery/ClaimHelper.sol";
import {EpochLib} from "../src/libraries/EpochLib.sol";
import {Route} from "../src/router/IAggregatorRouter.sol";

/// @title DeployLocal
/// @notice Full local stack on anvil: mock USDG/WETH/$DCA/stocks, a mock V3 factory with seeded pools, and the
///         real router/adapter/vaults/keeper. Separates roles across anvil's default accounts:
///         the broadcaster (account 0) owns/admins everything, `TREASURY` (account 1) is `feeRecipient`,
///         and `TEST1`/`TEST2`/`TEST3` (accounts 2-4) are funded wallets for interacting with the protocol.
///         All five get USDG (ETH is already funded by anvil's genesis); TEST1-3 also get WETH and $DCA.
///         `BOT` (account 5) is the scheduler's wallet (apps/scheduler): it only pays gas for `EpochKeeper.run`.
///
///         Besides Daily / Weekly / Monthly, a fourth `TestVault` with a `TEST_EPOCH_MINUTES`-minute epoch
///         (default 2) is deployed and given keeper jobs, plus three deployer-owned plans, so the scheduler
///         has an epoch to advance every couple of minutes instead of once a day. Local stacks only.
///
///         Boost: a mock Morpho Blue (`MockMorpho`, real share maths and interest accrual) with a USDG market
///         seeded by the deployer and 90% utilised by a phantom borrower, so the market pays ~5% supply APY,
///         behind a real `MorphoBlueStrategy` that every vault has as its `boostStrategy`. The seeded NVDA test
///         plan is boosted so the scheduler exercises the boosted fill path every couple of minutes.
///
///         Stocks mirror the full Robinhood Stock Token lineup (see apps/web/src/lib/tickers.ts). `SYMBOLS`
///         are "liquid": each gets a seeded USDG pool and keeper jobs so plans actually execute. `OTHER_SYMBOLS`
///         are listed in the registry (so the frontend's dropdown search has the full set) but with no pool —
///         same as a real thin-liquidity ticker, the router has no route and the UI simply shows no price.
///
///   anvil &
///   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
contract DeployLocal is Script {
    using stdJson for string;

    string[] internal SYMBOLS;
    uint256[] internal PRICES_USDG;
    uint256[] internal SUPPLIES;
    string[] internal OTHER_SYMBOLS;

    function _liquid(string memory symbol, uint256 priceUsdg, uint256 supply) internal {
        SYMBOLS.push(symbol);
        PRICES_USDG.push(priceUsdg);
        SUPPLIES.push(supply);
    }

    function _other(string memory symbol) internal {
        OTHER_SYMBOLS.push(symbol);
    }

    /// @dev Prices are illustrative USDG-per-share mocks for seeding a local pool, not real quotes. The
    ///      supply is the whole minted amount (it all sits in the pool) and is shaped like Robinhood Chain,
    ///      where Stock Tokens are minted on demand — these are the mainnet `totalSupply()` figures of
    ///      21 Sep 2026 ×10, so the web app's "Popular" row (ranked by supply × price, the tokenised market
    ///      cap) orders the same way locally as it does live. Even the thinnest pool holds ~$1M of stock.
    function _seedSymbols() internal {
        _liquid("NVDA", 500e6, 912_570e18);
        _liquid("AAPL", 190e6, 162_340e18);
        _liquid("TSLA", 250e6, 135_030e18);
        _liquid("SPY", 560e6, 318_810e18);
        _liquid("QQQ", 480e6, 71_780e18);
        _liquid("GOOGL", 175e6, 153_330e18);
        _liquid("META", 520e6, 76_710e18);
        _liquid("MSFT", 430e6, 60_270e18);
        _liquid("AMZN", 185e6, 139_490e18);
        _liquid("AVGO", 170e6, 5_670e18);
        _liquid("COST", 890e6, 14_990e18);
        _liquid("NFLX", 700e6, 125_110e18);
        _liquid("ORCL", 180e6, 65_560e18);
        _liquid("COIN", 230e6, 112_040e18);
        _liquid("PLTR", 70e6, 138_800e18);
        _liquid("TSM", 165e6, 35_530e18);

        _other("ADBE");
        _other("AEIS");
        _other("AMAT");
        _other("AMBA");
        _other("AMC");
        _other("AMD");
        _other("AMKR");
        _other("ANET");
        _other("APP");
        _other("ASML");
        _other("ASTS");
        _other("AVAV");
        _other("AXON");
        _other("BA");
        _other("BABA");
        _other("BB");
        _other("BE");
        _other("CBRS");
        _other("CCL");
        _other("CEG");
        _other("CELH");
        _other("COHR");
        _other("CRM");
        _other("CRWD");
        _other("CRWV");
        _other("CSCO");
        _other("CTSH");
        _other("DELL");
        _other("DJT");
        _other("DOCN");
        _other("EWT");
        _other("EWY");
        _other("F");
        _other("FICO");
        _other("FIG");
        _other("FISV");
        _other("FIX");
        _other("FTNT");
        _other("GE");
        _other("GEV");
        _other("GLD");
        _other("GLW");
        _other("GME");
        _other("HII");
        _other("HIMS");
        _other("HOOD");
        _other("HPE");
        _other("HWM");
        _other("IBM");
        _other("INDA");
        _other("INTC");
        _other("INTU");
        _other("IONQ");
        _other("IREN");
        _other("JBL");
        _other("JNJ");
        _other("KLAC");
        _other("KSS");
        _other("LHX");
        _other("LITE");
        _other("LLY");
        _other("LMT");
        _other("LRCX");
        _other("LULU");
        _other("LUNR");
        _other("MDB");
        _other("MOD");
        _other("MPWR");
        _other("MRNA");
        _other("MRVL");
        _other("MSTR");
        _other("MTSI");
        _other("MU");
        _other("MXL");
        _other("NAVN");
        _other("NET");
        _other("NOW");
        _other("NU");
        _other("ON");
        _other("ONTO");
        _other("PANW");
        _other("PATH");
        _other("PFE");
        _other("PL");
        _other("QBTS");
        _other("QCOM");
        _other("RBLX");
        _other("RDDT");
        _other("RDW");
        _other("RGTI");
        _other("RIVN");
        _other("RKLB");
        _other("RUN");
        _other("SATS");
        _other("SCHD");
        _other("SGOV");
        _other("SHOP");
        _other("SHY");
        _other("SIMO");
        _other("SKHY");
        _other("SLV");
        _other("SMCI");
        _other("SMH");
        _other("SNAP");
        _other("SNDK");
        _other("SNOW");
        _other("SOFI");
        _other("SOXX");
        _other("SPCX");
        _other("TEAM");
        _other("TEM");
        _other("TER");
        _other("TSEM");
        _other("TTD");
        _other("TTWO");
        _other("UMC");
        _other("UNH");
        _other("UPS");
        _other("VRT");
        _other("VSAT");
        _other("VST");
        _other("WDAY");
        _other("WDC");
        _other("XLK");
        _other("XOM");
        _other("ZM");
    }

    function run() external {
        _seedSymbols();
        require(block.chainid != 4663, "DeployLocal is not for Robinhood Chain mainnet");
        // Defaults are anvil's own deterministic accounts 1-4 (mnemonic "test test ... junk"); fork.sh passes
        // the real values it parsed from anvil's own startup log.
        address treasury = vm.envOr("TREASURY", address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8));
        address test1 = vm.envOr("TEST1", address(0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC));
        address test2 = vm.envOr("TEST2", address(0x90F79bf6EB2c4f870365E785982E1f101E93b906));
        address test3 = vm.envOr("TEST3", address(0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65));
        address bot = vm.envOr("BOT", address(0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc));
        address[3] memory testWallets = [test1, test2, test3];
        uint256 testEpochMinutes = vm.envOr("TEST_EPOCH_MINUTES", uint256(2));
        require(testEpochMinutes > 0 && testEpochMinutes <= 24 * 60, "TEST_EPOCH_MINUTES must be 1..1440");
        // casting to 'uint32' is safe: bounded to 1440 minutes just above
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 testEpochLength = uint32(testEpochMinutes * 60);

        vm.startBroadcast();
        address deployer = msg.sender;

        MockERC20 usdg = new MockERC20("Global Dollar", "USDG", 6);
        MockWETH weth = new MockWETH();
        MockDCA dca = new MockDCA(deployer);
        MockV3Factory factory = new MockV3Factory();
        StockRegistry registry = new StockRegistry(deployer);
        AggregatorRouter router = new AggregatorRouter(address(weth), deployer);
        UniV3Adapter adapter = new UniV3Adapter(1, address(router), address(factory), deployer);
        router.setAdapter(1, address(adapter));

        // WETH/USDG pool at 3000 USDG per ETH, approved both ways (deposits zap WETH->USDG; Zap sells USDG->WETH)
        address pool =
            factory.createPool(address(weth), address(usdg), 500, _sqrt(address(weth), 1e18, address(usdg), 3000e6));
        usdg.mint(pool, 1_000_000_000e6);
        weth.mint(pool, 1_000_000e18);
        _approveBoth(router, 1, pool, address(weth), address(usdg), 500);

        address[] memory stocks = new address[](SYMBOLS.length);
        for (uint256 i; i < SYMBOLS.length; ++i) {
            MockERC20 st = new MockERC20(string.concat(SYMBOLS[i], " Stock Token"), string.concat(SYMBOLS[i], "st"), 18);
            registry.listStock(address(st), SYMBOLS[i], false, true);
            address p = factory.createPool(
                address(st), address(usdg), 3000, _sqrt(address(st), 1e18, address(usdg), PRICES_USDG[i])
            );
            usdg.mint(p, 1_000_000_000e6);
            st.mint(p, SUPPLIES[i]);
            _approveBoth(router, 1, p, address(usdg), address(st), 3000);
            stocks[i] = address(st);
        }
        // Long-tail tickers: registry-listed for the frontend, no seeded pool (no route, no price — same as
        // real life for a thin-liquidity Stock Token), so no keeper jobs either.
        for (uint256 i; i < OTHER_SYMBOLS.length; ++i) {
            MockERC20 st = new MockERC20(
                string.concat(OTHER_SYMBOLS[i], " Stock Token"), string.concat(OTHER_SYMBOLS[i], "st"), 18
            );
            registry.listStock(address(st), OTHER_SYMBOLS[i], false, true);
        }

        VaultParams memory vp = VaultParams({
            owner: deployer,
            usdg: address(usdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: treasury,
            epochLength: 0,
            origin: 0,
            purchaseFeeBps: 0
        });
        vp.origin = EpochLib.alignToDay(block.timestamp);
        DailyVault daily = new DailyVault(vp);
        vp.origin = EpochLib.alignToMonday(block.timestamp);
        WeeklyVault weekly = new WeeklyVault(vp);
        vp.origin = EpochLib.alignToDay(block.timestamp);
        MonthlyVault monthly = new MonthlyVault(vp);

        // Vaults are keeperOnly by default: the EpochKeeper contract is their keeper, and the scheduler's `bot`
        // wallet is an EpochKeeper operator (every execution entry point on the keeper is operator-only).
        EpochKeeper keeper = new EpochKeeper(address(usdg), deployer);
        keeper.setOperator(bot, true);
        PlanVault[3] memory vaults = [PlanVault(daily), PlanVault(weekly), PlanVault(monthly)];
        for (uint256 v; v < 3; ++v) {
            vaults[v].setKeeper(address(keeper), true);
            for (uint256 s; s < stocks.length; ++s) {
                keeper.addJob(address(vaults[v]), stocks[s]);
            }
        }

        // Test vault: N-minute epochs, origin aligned to a multiple of the epoch length so boundaries land on
        // predictable wall-clock minutes (e.g. every even minute for the default 2). Same keeper, same jobs.
        vp.origin = uint64(block.timestamp - (block.timestamp % testEpochLength));
        TestVault testVault = new TestVault(vp, testEpochLength);
        testVault.setKeeper(address(keeper), true);
        for (uint256 s; s < stocks.length; ++s) {
            keeper.addJob(address(testVault), stocks[s]);
        }

        // Boost: mock Morpho market + real strategy, every vault wired to it.
        MockIrm irm = new MockIrm(uint256(0.055e18) / 365 days); // 5.5% borrow APR => ~5% supply APY at 90% util
        MockMorpho morpho = new MockMorpho(treasury);
        MarketParams memory market = MarketParams({
            loanToken: address(usdg),
            collateralToken: address(weth),
            oracle: address(0),
            irm: address(irm),
            lltv: 0.86e18
        });
        Id marketId = morpho.createMarket(market);
        usdg.mint(deployer, 10_000_000e6);
        usdg.approve(address(morpho), 10_000_000e6);
        morpho.supply(market, 10_000_000e6, 0, deployer, "");
        morpho.mockBorrow(marketId, 9_000_000e6, deployer); // phantom debt: the loan tokens come back to us
        MorphoBlueStrategy boostStrategy = new MorphoBlueStrategy(address(morpho), market, deployer);
        PlanVault[4] memory boostVaults =
            [PlanVault(daily), PlanVault(weekly), PlanVault(monthly), PlanVault(testVault)];
        for (uint256 v; v < 4; ++v) {
            boostStrategy.setDepositor(address(boostVaults[v]), true);
            boostVaults[v].setBoostStrategy(address(boostStrategy));
        }

        Zap zap = new Zap(address(weth), address(usdg), address(router));
        ClaimHelper helper = new ClaimHelper();
        VaultDirectory directory = new VaultDirectory(deployer);
        directory.set(
            VaultDirectory.Entry({
                daily: address(daily),
                weekly: address(weekly),
                monthly: address(monthly),
                registry: address(registry),
                router: address(router),
                usdg: address(usdg),
                weth: address(weth),
                dca: address(dca)
            })
        );

        usdg.mint(deployer, 1_000_000e6);
        usdg.mint(treasury, 1_000_000e6);
        for (uint256 i; i < testWallets.length; ++i) {
            usdg.mint(testWallets[i], 1_000_000e6);
            weth.mint(testWallets[i], 100e18);
            dca.mint(testWallets[i], 150_000e18); // clears both $DCA perk thresholds (100k)
        }

        // Seed the test vault with three deployer-owned plans (NVDA / AAPL / TSLA, the first three liquid
        // symbols) so `isEpochDue` is true from the very first boundary and the scheduler has real work.
        // 500k USDG each: at 100 USDG per 2-minute epoch that is ~7 days of fills before the biggest runs dry.
        // The NVDA plan is boosted (its 500k sits on the mock Morpho market and is pulled per fill).
        usdg.mint(deployer, 1_500_000e6);
        usdg.approve(address(testVault), 1_500_000e6);
        uint96[3] memory seedPerEpoch = [uint96(100e6), uint96(50e6), uint96(25e6)];
        for (uint256 i; i < 3 && i < stocks.length; ++i) {
            testVault.createPlan(stocks[i], seedPerEpoch[i], address(0), 500_000e6, 0, 0, i == 0);
        }
        vm.stopBroadcast();

        string memory j = "local";
        j.serialize("chainId", block.chainid);
        j.serialize("usdg", address(usdg));
        j.serialize("weth", address(weth));
        j.serialize("dca", address(dca));
        j.serialize("registry", address(registry));
        j.serialize("router", address(router));
        j.serialize("uniV3Adapter", address(adapter));
        j.serialize("daily", address(daily));
        j.serialize("weekly", address(weekly));
        j.serialize("monthly", address(monthly));
        j.serialize("testVault", address(testVault));
        j.serialize("testEpochLength", uint256(testEpochLength));
        j.serialize("keeper", address(keeper));
        j.serialize("directory", address(directory));
        j.serialize("zap", address(zap));
        j.serialize("morpho", address(morpho));
        j.serialize("morphoIrm", address(irm));
        j.serialize("morphoMarketId", Id.unwrap(marketId));
        j.serialize("boostStrategy", address(boostStrategy));
        j.serialize("stocks", stocks);
        j.serialize("claimHelper", address(helper));
        j.serialize("deployer", deployer);
        j.serialize("treasury", treasury);
        j.serialize("test1", test1);
        j.serialize("test2", test2);
        j.serialize("test3", test3);
        string memory out = j.serialize("bot", bot);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(out, path);
        console2.log("wrote", path);
        console2.log("directory", address(directory));
        console2.log("deployer ", deployer);
        console2.log("treasury ", treasury);
        console2.log("test1    ", test1);
        console2.log("test2    ", test2);
        console2.log("test3    ", test3);
        console2.log("bot      ", bot);
        console2.log("testVault", address(testVault));
        console2.log("testEpoch (s)", uint256(testEpochLength));
        console2.log("morpho   ", address(morpho));
        console2.log("boost    ", address(boostStrategy));
    }

    function _approveBoth(AggregatorRouter router, uint8 protocol, address pool, address a, address b, uint24 fee)
        internal
    {
        router.approveHop(Route({protocol: protocol, tokenIn: a, tokenOut: b, fee: fee, extra: abi.encode(pool)}));
        router.approveHop(Route({protocol: protocol, tokenIn: b, tokenOut: a, fee: fee, extra: abi.encode(pool)}));
    }

    function _sqrt(address base, uint256 baseAmt, address quote, uint256 quoteAmt) internal pure returns (uint160) {
        (uint256 num, uint256 den) = base < quote ? (quoteAmt, baseAmt) : (baseAmt, quoteAmt);
        return uint160(Math.sqrt(Math.mulDiv(2 ** 192, num, den)));
    }
}
