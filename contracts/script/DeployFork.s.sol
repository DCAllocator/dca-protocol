// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PlanVault} from "../src/vault/PlanVault.sol";
import {VaultParams} from "../src/vault/VaultTypes.sol";
import {EpochKeeper} from "../src/keeper/EpochKeeper.sol";
import {StockRegistry} from "../src/registries/StockRegistry.sol";
import {MorphoBlueStrategy} from "../src/boost/MorphoBlueStrategy.sol";
import {TestVault} from "../test/mocks/TestVault.sol";
import {MockDCA} from "../test/mocks/MockDCA.sol";

interface IV3Factory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

interface IV3PoolAdmin {
    function initialize(uint160 sqrtPriceX96) external;
    function increaseObservationCardinalityNext(uint16 next) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
}

/// @notice Pays a V3 `mint` from the address in `data`. Fork-only: it trusts whichever pool calls back, so it must
///         never hold an allowance on a real chain.
contract ForkLiquidity {
    using SafeERC20 for IERC20;

    function mint(IV3PoolAdmin pool, int24 lo, int24 hi, uint128 liquidity) external {
        pool.mint(msg.sender, lo, hi, liquidity, abi.encode(msg.sender));
    }

    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata data) external {
        address payer = abi.decode(data, (address));
        if (owed0 > 0) IERC20(IV3PoolAdmin(msg.sender).token0()).safeTransferFrom(payer, msg.sender, owed0);
        if (owed1 > 0) IERC20(IV3PoolAdmin(msg.sender).token1()).safeTransferFrom(payer, msg.sender, owed1);
    }
}

/// @title DeployFork
/// @notice The fork-only halves around the production `Deploy.s.sol` on a Robinhood Chain fork (scripts/fork-mainnet.sh):
///
///   `prepare()` before Deploy: a mock $DCA (there is no token on mainnet yet) with a real Uniswap V3 mDCA/USDG pool on
///              the chain's own factory and full-range liquidity at `DCA_PRICE_USDG`, so Deploy can run with `DCA` /
///              `LIST_DCA` (and `DCA_PRICE_FEED` = `PriceGuardLib.UNGUARDED`, as production would). Writes
///              deployments/<chainId>-fork-setup.json.
///   `extras()` after Deploy: the short-epoch `TestVault` (same keeper, jobs, feeds, price guard, page cap and boost
///              strategy as the daily vault), three seeded deployer plans on it, $DCA for test1, and the merged
///              deployments/<chainId>.json the apps and scripts read (Deploy's output + the local stack's extra keys).
///
/// The deployer (anvil account 0) must already hold real USDG (the shell script writes its balance slot).
contract DeployFork is Script {
    using stdJson for string;

    /// @dev USDG (1e6-scaled) per mDCA: the pool's starting price, as on the local stack.
    uint256 internal constant DCA_PRICE_USDG = 0.1e6;
    uint256 internal constant DCA_POOL_USDG = 1_000_000e6;
    uint24 internal constant DCA_POOL_FEE = 3000;
    int24 internal constant FULL_RANGE_TICK = 887_220; // MAX_TICK rounded down to the 3000 pool's 60 spacing

    function prepare() external {
        string memory cfg = vm.readFile("config/fork.rh.json");
        address usdg = cfg.readAddress(".usdg");
        address factory = cfg.readAddress(".uniV3Factory");

        vm.startBroadcast();
        address deployer = msg.sender;
        MockDCA dca = new MockDCA(deployer);

        address pool = IV3Factory(factory).createPool(address(dca), usdg, DCA_POOL_FEE);
        uint160 sqrtP = _sqrt(address(dca), 1e18, usdg, DCA_PRICE_USDG);
        IV3PoolAdmin(pool).initialize(sqrtP);
        // The FeeReceiver's buyback reads a TWAP off this pool.
        IV3PoolAdmin(pool).increaseObservationCardinalityNext(64);

        uint256 dcaAmount = DCA_POOL_USDG * 1e18 / DCA_PRICE_USDG;
        dca.mint(deployer, dcaAmount);
        ForkLiquidity lp = new ForkLiquidity();
        IERC20(address(dca)).approve(address(lp), dcaAmount);
        IERC20(usdg).approve(address(lp), DCA_POOL_USDG);
        // Full range: amount0 ~ L / sqrtP and amount1 ~ L * sqrtP (Q96), so the smaller L fits both budgets.
        (uint256 amount0, uint256 amount1) =
            address(dca) < usdg ? (dcaAmount, DCA_POOL_USDG) : (DCA_POOL_USDG, dcaAmount);
        uint256 liq = Math.min(Math.mulDiv(amount0, sqrtP, 2 ** 96), Math.mulDiv(amount1, 2 ** 96, sqrtP));
        // casting to 'uint128' is safe: ~sqrt(1e25 * 1e12) = ~3e18 for these amounts
        // forge-lint: disable-next-line(unsafe-typecast)
        lp.mint(IV3PoolAdmin(pool), -FULL_RANGE_TICK, FULL_RANGE_TICK, uint128(liq * 99 / 100));
        IERC20(address(dca)).approve(address(lp), 0);
        IERC20(usdg).approve(address(lp), 0);
        vm.stopBroadcast();

        string memory j = "forkSetup";
        j.serialize("dca", address(dca));
        string memory out = j.serialize("dcaPool", pool);
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), "-fork-setup.json"));
        console2.log("mDCA     ", address(dca));
        console2.log("mDCA pool", pool);
    }

    function extras() external {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory d = vm.readFile(path);
        address test1 = vm.envAddress("TEST1");
        uint256 testEpochMinutes = vm.envOr("TEST_EPOCH_MINUTES", uint256(2));
        require(testEpochMinutes > 0 && testEpochMinutes <= 24 * 60, "TEST_EPOCH_MINUTES must be 1..1440");
        // casting to 'uint32' is safe: bounded to 1440 minutes just above
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 epochLength = uint32(testEpochMinutes * 60);

        PlanVault daily = PlanVault(d.readAddress(".daily"));
        EpochKeeper keeper = EpochKeeper(d.readAddress(".keeper"));
        StockRegistry registry = StockRegistry(d.readAddress(".registry"));
        address usdg = d.readAddress(".usdg");
        address dca = d.readAddress(".dca");
        address boost = d.readAddress(".boostStrategy");
        address[] memory approved = registry.approvedStocks();

        vm.startBroadcast();
        address deployer = msg.sender;
        VaultParams memory vp = VaultParams({
            owner: deployer,
            usdg: usdg,
            weth: d.readAddress(".weth"),
            dca: dca,
            registry: address(registry),
            router: d.readAddress(".router"),
            feeRecipient: daily.feeRecipient(),
            epochLength: 0,
            // Boundaries on predictable wall-clock minutes (every even minute for the default 2).
            origin: uint64(block.timestamp - (block.timestamp % epochLength)),
            purchaseFeeBps: 0
        });
        TestVault testVault = new TestVault(vp, epochLength);

        // Everything the daily vault was given by Deploy, so the test vault buys the same way.
        testVault.setKeeper(address(keeper), true);
        testVault.setThresholds(daily.autoDistributeThreshold(), daily.feeHalveThreshold());
        testVault.setMaxPlansPerTx(daily.maxPlansPerTx());
        testVault.setMaxPageNotional(address(0), daily.maxPageNotional());
        for (uint256 i; i < approved.length; ++i) {
            (address feed, uint32 maxStaleness,,) = daily.priceFeed(approved[i]);
            if (feed != address(0)) testVault.setPriceFeed(approved[i], feed, maxStaleness);
            uint256 cap = daily.maxPageNotionalOf(approved[i]);
            if (cap != 0) testVault.setMaxPageNotional(approved[i], cap);
            keeper.addJob(address(testVault), approved[i]);
        }
        (uint16 maxDeviationBps, bool requireFeed, address sequencerFeed, uint32 sequencerGrace) = daily.priceGuard();
        testVault.setPriceGuard(maxDeviationBps, requireFeed, sequencerFeed, sequencerGrace);
        if (boost != address(0)) {
            MorphoBlueStrategy(boost).setDepositor(address(testVault), true);
            testVault.setBoostStrategy(boost);
        }

        // Three deployer plans (the first boosted, lent on the real Morpho market) so the scheduler has work from the
        // first boundary: NVDA / SPCX / TSLA when listed, else the first liquid stocks.
        address[] memory stocks = _withoutDca(approved, dca);
        address[3] memory seeded =
            [_find(registry, stocks, "NVDA", 0), _find(registry, stocks, "SPCX", 1), _find(registry, stocks, "TSLA", 2)];
        uint96[3] memory perEpoch = [uint96(100e6), uint96(50e6), uint96(25e6)];
        IERC20(usdg).approve(address(testVault), 150_000e6);
        for (uint256 i; i < 3; ++i) {
            if (seeded[i] != address(0)) testVault.createPlan(seeded[i], perEpoch[i], address(0), 50_000e6, 0, 0, i == 0);
        }

        // test1 clears both $DCA perk thresholds; test2 / test3 hold none, so their stock accrues and Claim is testable.
        MockDCA(dca).mint(test1, 150_000e18);
        vm.stopBroadcast();

        // Deploy's own output plus the keys the local stack's tooling reads (web env, scheduler, pnpm fund / share).
        string memory j = "fork";
        j.serialize(d);
        j.serialize("fork", true);
        j.serialize("forkBlock", vm.envOr("FORK_BLOCK", uint256(0)));
        j.serialize("testVault", address(testVault));
        j.serialize("testEpochLength", uint256(epochLength));
        j.serialize("stocks", stocks);
        j.serialize("deployer", deployer);
        j.serialize("test1", test1);
        j.serialize("test2", vm.envAddress("TEST2"));
        j.serialize("test3", vm.envAddress("TEST3"));
        j.serialize("dcaPool", vm.envOr("DCA_POOL", address(0)));
        string memory out = j.serialize("bot", vm.envAddress("BOT"));
        vm.writeJson(out, path);
        console2.log("testVault", address(testVault));
        console2.log("stocks   ", stocks.length);
    }

    function _withoutDca(address[] memory list, address dca) internal pure returns (address[] memory out) {
        uint256 n;
        for (uint256 i; i < list.length; ++i) {
            if (list[i] != dca) ++n;
        }
        out = new address[](n);
        uint256 k;
        for (uint256 i; i < list.length; ++i) {
            if (list[i] != dca) out[k++] = list[i];
        }
    }

    /// @dev The stock listed under `symbol`, else the `fallbackIndex`-th stock (zero address when there are fewer).
    function _find(StockRegistry registry, address[] memory stocks, string memory symbol, uint256 fallbackIndex)
        internal
        view
        returns (address)
    {
        for (uint256 i; i < stocks.length; ++i) {
            if (keccak256(bytes(registry.info(stocks[i]).symbol)) == keccak256(bytes(symbol))) return stocks[i];
        }
        return fallbackIndex < stocks.length ? stocks[fallbackIndex] : address(0);
    }

    function _sqrt(address base, uint256 baseAmt, address quote, uint256 quoteAmt) internal pure returns (uint160) {
        (uint256 num, uint256 den) = base < quote ? (quoteAmt, baseAmt) : (baseAmt, quoteAmt);
        return uint160(Math.sqrt(Math.mulDiv(2 ** 192, num, den)));
    }
}
