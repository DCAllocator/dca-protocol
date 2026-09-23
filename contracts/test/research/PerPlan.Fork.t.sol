// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// forge-lint: disable-start(unsafe-typecast)

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AggregatorRouter} from "../../src/router/AggregatorRouter.sol";
import {UniV3Adapter} from "../../src/router/adapters/UniV3Adapter.sol";
import {Route} from "../../src/router/IAggregatorRouter.sol";
import {StockRegistry} from "../../src/registries/StockRegistry.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback} from "../../src/interfaces/IUniswapV3.sol";
import {VaultParams} from "../../src/vault/VaultTypes.sol";
import {TestVault} from "../mocks/TestVault.sol";
import {MockDCA} from "../mocks/MockDCA.sol";
import {MockAggregatorV3} from "../mocks/MockChainlink.sol";
import {PlanAccount, PlanAccountFactory} from "./PlanAccount.sol";

/// @dev Plain V3 trader (an attacker / arbitrageur): swaps on the pool directly and pays in the callback.
contract V3Trader is IUniswapV3SwapCallback {
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    function trade(IUniswapV3Pool pool, bool zeroForOne, uint256 amountIn) external returns (uint256 out) {
        (int256 a0, int256 a1) = pool.swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(zeroForOne ? pool.token0() : pool.token1())
        );
        out = uint256(-(zeroForOne ? a1 : a0));
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        address tIn = abi.decode(data, (address));
        IERC20(tIn).transfer(msg.sender, uint256(a0 > 0 ? a0 : a1));
    }
}

/// @title Per-plan contracts vs the pooled vault — Robinhood Chain fork study
/// @notice Real NVDA/USDG Uniswap V3 pool (0.05%), real Stock Token and USDG code, the protocol's real router +
///         UniV3Adapter + PlanVault (TestVault, 1-day epochs) next to the PlanAccount prototype. Skipped unless
///         RH_RPC is set. Gas numbers need `--isolate` (every top-level call becomes its own transaction: cold
///         storage, 21k intrinsic), exactly what an operator pays per submitted transaction:
///
///   RH_RPC=https://rpc.mainnet.chain.robinhood.com FORK_BLOCK=<recent> \
///     forge test --isolate --match-path test/research/PerPlan.Fork.t.sol -vv
///
///      The public RPC serves recent state only: pin FORK_BLOCK to a block from the last few minutes on the first
///      run; forge caches everything it fetched under ~/.foundry/cache/rpc, so later runs replay offline.
///      Lines starting `CSV,` are machine-readable results.
abstract contract ResearchForkBase is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant POOL = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3; // USDG (token0) / NVDA, 500

    address internal admin = makeAddr("admin");
    address internal bot = makeAddr("bot");
    address internal treasury = makeAddr("treasury");

    bool internal enabled;
    StockRegistry internal registry;
    AggregatorRouter internal router;
    UniV3Adapter internal adapter;
    MockDCA internal dca;
    MockAggregatorV3 internal feed;
    TestVault internal vault;
    PlanAccountFactory internal factory;
    V3Trader internal trader;
    Route internal hop;

    function setUp() public virtual {
        string memory rpc = vm.envOr("RH_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        if (block.chainid != 4663) return;
        enabled = true;

        vm.startPrank(admin);
        registry = new StockRegistry(admin);
        registry.listStock(NVDA, "NVDA", false, true);
        router = new AggregatorRouter(WETH, admin);
        adapter = new UniV3Adapter(1, address(router), V3_FACTORY, admin);
        router.setAdapter(1, address(adapter));
        hop = Route({protocol: 1, tokenIn: USDG, tokenOut: NVDA, fee: 500, extra: abi.encode(POOL)});
        router.approveHop(hop);
        dca = new MockDCA(admin);
        // Reference feed pinned at the pool's mid price at the fork block (USD per whole NVDA, 8 decimals).
        feed = new MockAggregatorV3(8, int256(_midUsdPerNvda8()));

        vault = _newVault();

        factory = new PlanAccountFactory(USDG, address(dca), address(registry), address(router), treasury, admin);
        factory.setKeeper(bot, true);
        factory.setPriceFeed(NVDA, address(feed), 365 days);
        Route[] memory path = new Route[](1);
        path[0] = hop;
        factory.setLeanPath(NVDA, path);
        vm.stopPrank();

        trader = new V3Trader();
    }

    modifier onlyFork() {
        if (!enabled) {
            console2.log("skipped: set RH_RPC (and FORK_BLOCK) to run the Robinhood Chain research fork");
            return;
        }
        _;
    }

    // ------------------------------------------------------------------ helpers

    /// @dev A fresh 1-day TestVault on the real router with the pinned reference feed (called as admin).
    function _newVault() internal returns (TestVault v) {
        v = new TestVault(
            VaultParams({
                owner: admin,
                usdg: USDG,
                weth: WETH,
                dca: address(dca),
                registry: address(registry),
                router: address(router),
                feeRecipient: treasury,
                epochLength: 0,
                origin: uint64(block.timestamp - (block.timestamp % 1 days)),
                purchaseFeeBps: 0
            }),
            1 days
        );
        v.setKeeper(bot, true);
        v.setPriceFeed(NVDA, address(feed), 365 days);
    }

    function _user(uint256 i) internal pure returns (address) {
        return address(uint160(0x5EED0000 + i));
    }

    /// @dev USD per whole NVDA × 1e8 from slot0: price(raw NVDA per raw USDG) = sqrtP² / 2^192.
    function _midUsdPerNvda8() internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(POOL).slot0();
        return Math.mulDiv(1e20, 2 ** 192, uint256(sqrtP) * uint256(sqrtP));
    }

    /// @dev NVDA (raw) that `usdgIn` buys at the current mid price, before fee and impact.
    function _midOut(uint256 usdgIn) internal view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(POOL).slot0();
        return Math.mulDiv(Math.mulDiv(usdgIn, sqrtP, 2 ** 96), sqrtP, 2 ** 96);
    }

    function _buy(uint256 usdgIn) internal returns (uint256) {
        deal(USDG, address(trader), usdgIn);
        return trader.trade(IUniswapV3Pool(POOL), true, usdgIn);
    }

    function _sell(uint256 nvdaIn) internal returns (uint256) {
        return trader.trade(IUniswapV3Pool(POOL), false, nvdaIn);
    }

    function _bps(uint256 got, uint256 ideal) internal pure returns (uint256) {
        return got >= ideal ? 0 : ((ideal - got) * 1_000_000) / ideal; // hundredths of a bp
    }

    function _fmtBps(uint256 centiBps) internal pure returns (string memory) {
        uint256 frac = centiBps % 100;
        return string.concat(vm.toString(centiBps / 100), ".", frac < 10 ? "0" : "", vm.toString(frac));
    }
}

/// @notice Gas per buy. Run with --isolate.
contract PerPlanForkGasTest is ResearchForkBase {
    uint96 internal constant PER_BUY = 100e6; // 100 USDG per plan per epoch
    uint256 internal constant FUNDING = 10_000e6;

    /// @dev Pooled vault, steady state (every plan filled once before), accrue path and auto-distribute path.
    function test_gas_pooledVault() public onlyFork {
        _pooled(false);
        _pooled(true);
    }

    function _pooled(bool autoDist) internal {
        vm.startPrank(admin);
        vault = _newVault();
        vm.stopPrank();
        uint256 n = 150;
        uint256 base = autoDist ? 1_000 : 0;
        for (uint256 i; i < n; ++i) {
            address u = _user(base + i);
            deal(USDG, u, FUNDING);
            if (autoDist) {
                vm.prank(admin);
                dca.mint(u, 100_000e18);
            }
            vm.startPrank(u);
            IERC20(USDG).approve(address(vault), FUNDING);
            vault.createPlan(NVDA, PER_BUY, address(0), FUNDING, 0, 0, false);
            vm.stopPrank();
        }
        // warm-up epoch: every plan filled once (fresh-slot costs are one-offs, not steady state)
        vm.warp(vault.nextEpochStart());
        vm.prank(bot);
        vault.advanceEpoch(NVDA, 150, "");

        uint16[6] memory sizes = [uint16(1), 10, 25, 50, 100, 150];
        for (uint256 s; s < sizes.length; ++s) {
            vm.warp(vault.nextEpochStart());
            vm.prank(bot);
            vault.advanceEpoch(NVDA, sizes[s], "");
            uint256 g = vm.lastCallGas().gasTotalUsed;
            console2.log(
                string.concat(
                    "CSV,pooled_",
                    autoDist ? "autodist" : "accrue",
                    ",plans=",
                    vm.toString(sizes[s]),
                    ",txGas=",
                    vm.toString(g),
                    ",gasPerPlan=",
                    vm.toString(g / sizes[s])
                )
            );
        }
    }

    /// @dev Per-plan accounts: one isolated transaction per buy, and batched `fireBatch`, parity and lean.
    function test_gas_perPlan() public onlyFork {
        uint256 n = 150;
        address[] memory plans = new address[](n);
        for (uint256 i; i < n; ++i) {
            address u = _user(5_000 + i);
            deal(USDG, u, FUNDING);
            vm.startPrank(u);
            IERC20(USDG).approve(address(factory), FUNDING);
            plans[i] = factory.createPlan(NVDA, PER_BUY, 1 days, address(0), FUNDING);
            vm.stopPrank();
        }
        // warm-up: every plan bought once (recipient balance slot non-zero, nextAt set) = steady state
        vm.warp(block.timestamp + 1 days);
        for (uint256 i; i < n; ++i) {
            vm.prank(bot);
            factory.fire(plans[i], false);
        }

        // Round 1: one transaction per plan (what "the scheduler fires them individually" costs)
        vm.warp(block.timestamp + 1 days);
        _single(plans, 0, 20, false, "perplan_single_quote");
        _single(plans, 20, 40, true, "perplan_single_lean");

        // Rounds 2..: batches (every buy of the batch lands in the same block — see the execution study)
        uint16[3] memory sizes = [uint16(10), 50, 150];
        for (uint256 lean; lean < 2; ++lean) {
            for (uint256 s; s < sizes.length; ++s) {
                vm.warp(block.timestamp + 1 days);
                address[] memory batch = new address[](sizes[s]);
                for (uint256 i; i < sizes[s]; ++i) {
                    batch[i] = plans[i];
                }
                vm.prank(bot);
                uint256 ok = factory.fireBatch(batch, lean == 1);
                uint256 g = vm.lastCallGas().gasTotalUsed;
                assertEq(ok, sizes[s], "batch filled");
                console2.log(
                    string.concat(
                        "CSV,perplan_batch_",
                        lean == 1 ? "lean" : "quote",
                        ",plans=",
                        vm.toString(sizes[s]),
                        ",txGas=",
                        vm.toString(g),
                        ",gasPerPlan=",
                        vm.toString(g / sizes[s])
                    )
                );
            }
        }
    }

    function _single(address[] memory plans, uint256 from, uint256 to, bool lean, string memory label) internal {
        uint256 total;
        uint256 lo = type(uint256).max;
        uint256 hi;
        for (uint256 i = from; i < to; ++i) {
            vm.prank(bot);
            factory.fire(plans[i], lean);
            uint256 g = vm.lastCallGas().gasTotalUsed;
            total += g;
            if (g < lo) lo = g;
            if (g > hi) hi = g;
        }
        console2.log(
            string.concat(
                "CSV,",
                label,
                ",plans=1,txGas=",
                vm.toString(total / (to - from)),
                ",min=",
                vm.toString(lo),
                ",max=",
                vm.toString(hi)
            )
        );
    }

    /// @dev What opening a plan costs the user: a storage record in the vault vs a fresh clone.
    function test_gas_create() public onlyFork {
        for (uint256 i; i < 5; ++i) {
            address u = _user(9_000 + i);
            deal(USDG, u, 2 * FUNDING);
            vm.startPrank(u);
            IERC20(USDG).approve(address(vault), FUNDING);
            IERC20(USDG).approve(address(factory), FUNDING);
            vault.createPlan(NVDA, PER_BUY, address(0), FUNDING, 0, 0, false);
            uint256 gv = vm.lastCallGas().gasTotalUsed;
            factory.createPlan(NVDA, PER_BUY, 1 days, address(0), FUNDING);
            uint256 gf = vm.lastCallGas().gasTotalUsed;
            vm.stopPrank();
            console2.log(string.concat("CSV,create,vault=", vm.toString(gv), ",clone=", vm.toString(gf)));
        }
    }
}

/// @notice Execution quality and sandwich economics on the real pool (run with --isolate like the gas suite so the
///         attacker's gas is real transaction gas; prices are unaffected).
contract PerPlanForkExecutionTest is ResearchForkBase {
    /// @dev Cost of a buy vs the pool's mid price, 0.05% pool fee included, for four ways of executing the same
    ///      epoch notional:
    ///        one      — one aggregate swap (the pooled vault, one page);
    ///        sameBlk  — 100-USDG buys back to back with nothing in between (per-plan fired together/batched);
    ///        spread   — 100-USDG buys each against an undisturbed pool (per-plan spread out, arbitrage refills
    ///                   the pool between buys);
    ///        pages    — pooled pages of 15,000 USDG (150 plans x 100) each against an undisturbed pool
    ///                   (pooled vault with its pages spread out by the scheduler).
    function test_exec_impact() public onlyFork {
        console2.log("mid USD/NVDA (1e8):", _midUsdPerNvda8());
        uint256[6] memory notionals = [uint256(1_000e6), 10_000e6, 100_000e6, 250_000e6, 500_000e6, 1_000_000e6];
        uint256 small = 100e6;
        uint256 page = 15_000e6;

        uint256 idealSmall = _midOut(small);
        uint256 idealPage = _midOut(page);
        uint256 snap = vm.snapshotState();
        uint256 costSmall = _bps(_buy(small), idealSmall);
        vm.revertToState(snap);
        uint256 costPage = _bps(_buy(page), idealPage);
        vm.revertToState(snap);

        for (uint256 i; i < notionals.length; ++i) {
            uint256 t = notionals[i];
            uint256 ideal = _midOut(t);

            uint256 one = _buy(t);
            vm.revertToState(snap);

            // same block: t / 100 USDG buys back to back (chunked for runtime: >200 chunks of equal size are
            // path-identical on a V3 pool up to rounding)
            uint256 chunks = t / small;
            if (chunks > 200) chunks = 200;
            uint256 sameBlk;
            for (uint256 c; c < chunks; ++c) {
                sameBlk += _buy(t / chunks);
            }
            vm.revertToState(snap);

            uint256 pageCost = t <= page ? _bps(one, ideal) : costPage;
            console2.log(
                string.concat(
                    "CSV,impact,notionalUsd=",
                    vm.toString(t / 1e6),
                    ",one=",
                    _fmtBps(_bps(one, ideal)),
                    ",sameBlk=",
                    _fmtBps(_bps(sameBlk, ideal)),
                    ",spread=",
                    _fmtBps(costSmall),
                    ",pages=",
                    _fmtBps(pageCost)
                )
            );
        }
    }

    /// @dev Best sandwich an attacker can land around ONE buy of `v` USDG executed by a PlanAccount with the
    ///      protocol's full price protection (router quote, 0.5% slippage floor, Chainlink floor at 3%). The
    ///      attacker buys NVDA first (largest push that still lets the victim pass the Chainlink check), the
    ///      victim buys, the attacker sells everything back. Gas is priced at GAS_PRICE_WEI / ETH_PRICE_USD.
    ///      The same numbers apply to the pooled vault's page of `v` and to a same-block batch totalling `v`.
    function test_exec_sandwich() public onlyFork {
        vm.prank(admin);
        factory.setPurchaseFeeBps(0); // victim buys exactly v
        uint256 gasPrice = vm.envOr("GAS_PRICE_WEI", uint256(55_208_000));
        uint256 ethUsd = vm.envOr("ETH_PRICE_USD", uint256(2_759));
        // attacker: front-run + back-run, measured below, priced in USDG (6 decimals)
        uint16 band = uint16(vm.envOr("GUARD_BAND_BPS", uint256(300)));
        vm.prank(admin);
        factory.setMaxDeviationBps(band);
        console2.log("Chainlink band (bps):", band);
        uint256[11] memory sizes = [
            uint256(10e6), 100e6, 1_000e6, 10_000e6, 25_000e6, 30_000e6, 35_000e6, 40_000e6, 50_000e6, 100_000e6, 500_000e6
        ];

        for (uint256 i; i < sizes.length; ++i) {
            uint256 v = sizes[i];
            address victim = _user(20_000 + i);
            deal(USDG, victim, v);
            vm.startPrank(victim);
            IERC20(USDG).approve(address(factory), v);
            address plan = factory.createPlan(NVDA, uint96(v), 1 days, address(0), v);
            vm.stopPrank();
            vm.warp(block.timestamp + 1 days);

            uint256 snap = vm.snapshotState();
            uint256 clean = _victimFill(plan, 0);
            vm.revertToState(snap);

            // largest push the Chainlink floor admits (binary search on the victim's success)
            uint256 lo;
            uint256 hi = 2_000_000e6;
            for (uint256 k; k < 40 && hi - lo > 1e6; ++k) {
                uint256 mid = (lo + hi) / 2;
                bool ok = _victimFill(plan, mid) > 0;
                vm.revertToState(snap);
                if (ok) lo = mid;
                else hi = mid;
            }
            // profit over a grid of pushes up to that maximum (profit need not peak at the maximum)
            int256 best = type(int256).min;
            uint256 bestA;
            uint256 bestVictimOut;
            uint256 attackerGas;
            for (uint256 g = 1; g <= 20; ++g) {
                uint256 a = (lo * g) / 20;
                if (a == 0) continue;
                (int256 p, uint256 vOut, uint256 gUsed) = _sandwich(plan, a);
                vm.revertToState(snap);
                if (p > best) {
                    best = p;
                    bestA = a;
                    bestVictimOut = vOut;
                    attackerGas = gUsed;
                }
            }
            int256 gasUsd6 = int256((attackerGas * gasPrice * ethUsd) / 1e12); // USD, 6 decimals
            console2.log(
                string.concat(
                    string.concat("CSV,sandwich,victimUsd=", vm.toString(v / 1e6), ",maxPushUsd=", vm.toString(lo / 1e6)),
                    string.concat(",bestPushUsd=", vm.toString(bestA / 1e6), ",grossProfitUsd6=", vm.toString(best)),
                    string.concat(",netProfitUsd6=", vm.toString(best - gasUsd6), ",attackerGas=", vm.toString(attackerGas)),
                    string.concat(",victimLossBps=", _fmtBps(_bps(bestVictimOut, clean)))
                )
            );
        }
    }

    /// @dev Front-run `a` USDG (0 = none), then fire the victim plan. Returns the victim's NVDA, 0 if it reverted.
    function _victimFill(address plan, uint256 a) internal returns (uint256) {
        if (a > 0) _buy(a);
        vm.prank(bot);
        try factory.fire(plan, false) returns (uint256 got) {
            return got;
        } catch {
            return 0;
        }
    }

    /// @dev Attacker gas = the two trades' transaction gas (run under --isolate, so intrinsic gas is included).
    function _sandwich(address plan, uint256 a) internal returns (int256 profit, uint256 victimOut, uint256 gasUsed) {
        deal(USDG, address(trader), a);
        uint256 nv = trader.trade(IUniswapV3Pool(POOL), true, a);
        gasUsed = vm.lastCallGas().gasTotalUsed;
        vm.prank(bot);
        try factory.fire(plan, false) returns (uint256 got) {
            victimOut = got;
        } catch {
            return (type(int256).min, 0, 0);
        }
        uint256 back = trader.trade(IUniswapV3Pool(POOL), false, nv);
        gasUsed += vm.lastCallGas().gasTotalUsed;
        profit = int256(back) - int256(a);
    }

    /// @dev A batch of 100 x 100 USDG buys fired in one transaction is sandwiched exactly like one 10,000 USDG
    ///      buy: the attacker brackets the transaction, not the individual swaps.
    function test_exec_batchSandwich() public onlyFork {
        vm.prank(admin);
        factory.setPurchaseFeeBps(0);
        address[] memory plans = new address[](100);
        for (uint256 i; i < 100; ++i) {
            address u = _user(30_000 + i);
            deal(USDG, u, 100e6);
            vm.startPrank(u);
            IERC20(USDG).approve(address(factory), 100e6);
            plans[i] = factory.createPlan(NVDA, 100e6, 1 days, address(0), 100e6);
            vm.stopPrank();
        }
        vm.warp(block.timestamp + 1 days);
        uint256 snap = vm.snapshotState();
        vm.prank(bot);
        factory.fireBatch(plans, false);
        uint256 cleanOut = IERC20(NVDA).balanceOf(_user(30_000));
        vm.revertToState(snap);

        uint256 push = vm.envOr("BATCH_PUSH_USDG", uint256(300_000e6));
        uint256 nv = _buy(push);
        vm.prank(bot);
        uint256 ok = factory.fireBatch(plans, false);
        uint256 back = _sell(nv);
        console2.log(
            string.concat(
                "CSV,batchSandwich,filled=",
                vm.toString(ok),
                ",pushUsd=",
                vm.toString(push / 1e6),
                ",grossProfitUsd6=",
                vm.toString(int256(back) - int256(push)),
                ",victimLossBps=",
                _fmtBps(_bps(IERC20(NVDA).balanceOf(_user(30_000)), cleanOut))
            )
        );
    }
}
