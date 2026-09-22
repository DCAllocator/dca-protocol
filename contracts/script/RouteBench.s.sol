// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// forge-lint: disable-start(unsafe-typecast)

import {Script, console2} from "forge-std/Script.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockWETH} from "../test/mocks/MockWETH.sol";
import {MockV3Factory} from "../test/mocks/MockV3.sol";
import {CPMMPool} from "../test/audit/mocks/CPMMPool.sol";
import {AggregatorRouter} from "../src/router/AggregatorRouter.sol";
import {UniV3Adapter} from "../src/router/adapters/UniV3Adapter.sol";
import {IAggregatorRouter, Route} from "../src/router/IAggregatorRouter.sol";
import {IUniswapV3Pool} from "../src/interfaces/IUniswapV3.sol";
import {FeeMath} from "../src/libraries/FeeMath.sol";

/// @title RouteBench
/// @notice Price-impact and route-splitting study over a set of USDG -> stock pools, using the REAL router and
///         V3 adapter for every quote. Two tables:
///           1. impact: for every page size x pool, output / impact bps / whether the router's 1.5% cap admits it,
///              and what the router picks;
///           2. split: for every page size, the best single pool vs the best 2- and 3-way split (5% grid search),
///              net of the extra swap gas priced in USD — i.e. whether split routing would earn its keep.
///
/// Mock mode (default): constant-product pools at one price (the conservative model — concentrated V3 liquidity
/// has LESS impact for the same TVL). Fork mode: set BENCH_POOLS (comma-separated V3-style pool addresses),
/// BENCH_USDG, BENCH_STOCK, BENCH_WETH and run with --rpc-url; the script deploys a router + factory-less adapter
/// in the simulation, registers the pools and quotes the live state.
///
///   forge script script/RouteBench.s.sol -vv
///   BENCH_POOL_USDG=5000000,1000000,250000 BENCH_POOL_FEES=500,3000,10000 forge script script/RouteBench.s.sol -vv
///   BENCH_POOLS=0x..,0x.. BENCH_USDG=0x.. BENCH_STOCK=0x.. BENCH_WETH=0x.. forge script script/RouteBench.s.sol --rpc-url $RH_RPC -vv
///
/// Env (all optional): BENCH_SIZES (USDG, default 20,200,2000,20000,200000,2000000,20000000), BENCH_PRICE_USDG
/// (mock price, default 500), ETH_PRICE_USD (default 3000), GAS_PRICE_WEI (default 1e7 = 0.01 gwei),
/// L1_FEE_USD_CENTS per transaction (default 2), SWAP_GAS (per extra pool, default 81000 as measured by GasBench).
contract RouteBench is Script {
    struct PoolInfo {
        address pool;
        uint24 fee;
        string label;
        Route route;
    }

    address internal usdg;
    address internal stock;
    address internal weth;
    uint8 internal usdgDec;
    uint8 internal stockDec;
    AggregatorRouter internal router;
    UniV3Adapter internal adapter;
    PoolInfo[] internal pools;

    address internal admin = address(0xAD31); // scripts may not rely on address(this)
    uint256 internal ethPriceUsd;
    uint256 internal gasPriceWei;
    uint256 internal l1FeeCents;
    uint256 internal swapGas;

    function run() external {
        ethPriceUsd = vm.envOr("ETH_PRICE_USD", uint256(3_000));
        gasPriceWei = vm.envOr("GAS_PRICE_WEI", uint256(10_000_000));
        l1FeeCents = vm.envOr("L1_FEE_USD_CENTS", uint256(2));
        swapGas = vm.envOr("SWAP_GAS", uint256(81_000));

        string memory forkPools = vm.envOr("BENCH_POOLS", string(""));
        vm.startPrank(admin);
        if (bytes(forkPools).length == 0) _setupMock();
        else _setupFork(forkPools);
        vm.stopPrank();

        uint256[] memory sizes = _sizes();
        console2.log("");
        console2.log("=== RouteBench: %s pools, ETH $%s, gas %s wei ===", pools.length, ethPriceUsd, gasPriceWei);
        console2.log("impact cap %s bps; L1 fee per tx %s cents; extra swap gas %s", router.maxPriceImpactBps(), l1FeeCents, swapGas);
        _impactTable(sizes);
        _splitTable(sizes);
    }

    // ------------------------------------------------------------------
    // Table 1: impact per pool
    // ------------------------------------------------------------------

    function _impactTable(uint256[] memory sizes) internal {
        console2.log("");
        console2.log("--- 0. largest page each pool fills inside the impact cap (use for setMaxPageNotional) ---");
        for (uint256 p; p < pools.length; ++p) {
            console2.log("  %s: up to %s USDG per page", pools[p].label, _maxPageWithinCap(p) / 10 ** usdgDec);
        }
        console2.log("");
        console2.log("--- 1. price impact per pool (output in stock units, impact in bps; cap = router refuses) ---");
        for (uint256 i; i < sizes.length; ++i) {
            uint256 amountIn = sizes[i] * 10 ** usdgDec;
            console2.log("");
            console2.log("page %s USDG", sizes[i]);
            for (uint256 p; p < pools.length; ++p) {
                (uint256 out, uint256 mid) = adapter.quoteRoute(pools[p].route, amountIn);
                if (out == 0) {
                    console2.log("  %s: no full fill (liquidity exhausted)", pools[p].label);
                    continue;
                }
                uint256 impact = FeeMath.impactBps(out, mid);
                console2.log(
                    "  %s: out %s, impact %s",
                    pools[p].label,
                    _fmt(out, stockDec),
                    string.concat(vm.toString(impact), " bps", impact > router.maxPriceImpactBps() ? " (over cap)" : "")
                );
            }
            try router.quoteWithImpact(usdg, stock, amountIn) returns (uint256 out, Route[] memory path, uint256 impact) {
                console2.log("  router picks %s: out %s, impact %s bps", _labelOf(path[0]), _fmt(out, stockDec), impact);
            } catch {
                console2.log("  router: NoRoute (every pool over the cap or unable to fill) -> use a smaller page");
            }
        }
    }

    // ------------------------------------------------------------------
    // Table 2: single vs split
    // ------------------------------------------------------------------

    function _splitTable(uint256[] memory sizes) internal {
        console2.log("");
        console2.log("--- 2. best single pool vs best split, every leg inside the impact cap (net of extra swap gas) ---");
        uint256 stockUnit = 10 ** stockDec;
        for (uint256 i; i < sizes.length; ++i) {
            uint256 amountIn = sizes[i] * 10 ** usdgDec;
            (uint256 single, uint256 singleIdx) = _bestSingle(amountIn);
            console2.log("");
            console2.log("page %s USDG", sizes[i]);
            if (single == 0) {
                console2.log("  no single pool fills this page inside the cap");
            } else {
                console2.log("  single %s: out %s", pools[singleIdx].label, _fmt(single, stockDec));
            }
            if (pools.length < 2) continue;
            (uint256 out2, uint256[3] memory w2) = _bestSplit(amountIn, 2);
            _report("2-way", amountIn, single, out2, w2, stockUnit, 1);
            if (pools.length >= 3) {
                (uint256 out3, uint256[3] memory w3) = _bestSplit(amountIn, 3);
                _report("3-way", amountIn, single, out3, w3, stockUnit, 2);
            }
        }
    }

    function _report(
        string memory label,
        uint256 amountIn,
        uint256 single,
        uint256 out,
        uint256[3] memory w,
        uint256 stockUnit,
        uint256 extraSwaps
    ) internal view {
        if (out == 0) {
            console2.log("  %s: no split keeps every leg inside the cap", label);
            return;
        }
        // value of the extra stock in USDG = extra stock x (USDG per stock implied by this very fill)
        uint256 gainStock = out > single ? out - single : 0;
        uint256 usdgPerStock = Math.mulDiv(amountIn, stockUnit, out); // USDG units per stock unit
        uint256 gainUsdg = Math.mulDiv(gainStock, usdgPerStock, stockUnit);
        uint256 extraGasUsdCents = (extraSwaps * swapGas * gasPriceWei * ethPriceUsd * 100) / 1e18 + extraSwaps * l1FeeCents;
        uint256 gainCents = (gainUsdg * 100) / 10 ** usdgDec;
        console2.log(
            "  %s (%s): out %s",
            label,
            string.concat(vm.toString(w[0]), "/", vm.toString(w[1]), "/", vm.toString(w[2]), " %"),
            _fmt(out, stockDec)
        );
        console2.log(
            "    gain vs single %s cents, extra gas %s cents -> %s",
            gainCents,
            extraGasUsdCents,
            gainCents > extraGasUsdCents ? "SPLIT WINS" : "single wins"
        );
    }

    /// @dev Binary search of the largest input whose impact stays within the router's cap (full fill required).
    function _maxPageWithinCap(uint256 p) internal returns (uint256 lo) {
        uint256 cap = router.maxPriceImpactBps();
        uint256 hi = 1_000_000_000 * 10 ** usdgDec; // $1bn upper bound
        for (uint256 it; it < 40; ++it) {
            uint256 mid = (lo + hi) / 2;
            if (mid == lo) break;
            (uint256 out, uint256 midOut) = adapter.quoteRoute(pools[p].route, mid);
            if (out != 0 && FeeMath.impactBps(out, midOut) <= cap) lo = mid;
            else hi = mid;
        }
    }

    function _bestSingle(uint256 amountIn) internal returns (uint256 best, uint256 idx) {
        uint256 cap = router.maxPriceImpactBps();
        for (uint256 p; p < pools.length; ++p) {
            (uint256 out, uint256 mid) = adapter.quoteRoute(pools[p].route, amountIn);
            if (out == 0 || FeeMath.impactBps(out, mid) > cap) continue;
            if (out > best) {
                best = out;
                idx = p;
            }
        }
    }

    /// @dev Grid search in 5% steps over `ways` pools (the first `ways` pools by index, all combinations of
    ///      which pools receive weight are covered because zero weights are allowed).
    function _bestSplit(uint256 amountIn, uint256 ways) internal returns (uint256 best, uint256[3] memory weights) {
        uint256 n = pools.length < ways ? pools.length : ways;
        for (uint256 a; a <= 100; a += 5) {
            for (uint256 b; a + b <= 100; b += 5) {
                uint256 c = 100 - a - b;
                if (n == 2 && c != 0) continue;
                if (n == 3 && ways == 3 && (a == 100 || b == 100 || c == 100)) continue; // pure singles are table 1
                uint256[3] memory w = [a, b, c];
                uint256 total;
                bool ok = true;
                uint256 cap = router.maxPriceImpactBps();
                for (uint256 p; p < n; ++p) {
                    if (w[p] == 0) continue;
                    (uint256 out, uint256 mid) = adapter.quoteRoute(pools[p].route, (amountIn * w[p]) / 100);
                    // a leg the router would refuse (no full fill, or over the cap) disqualifies the split
                    if (out == 0 || FeeMath.impactBps(out, mid) > cap) {
                        ok = false;
                        break;
                    }
                    total += out;
                }
                if (ok && total > best) {
                    best = total;
                    weights = w;
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------

    function _setupMock() internal {
        MockERC20 u = new MockERC20("Global Dollar", "USDG", 6);
        MockERC20 s = new MockERC20("Stock", "STK", 18);
        MockWETH w = new MockWETH();
        usdg = address(u);
        stock = address(s);
        weth = address(w);
        usdgDec = 6;
        stockDec = 18;
        router = new AggregatorRouter(weth, admin);
        MockV3Factory factory = new MockV3Factory();
        adapter = new UniV3Adapter(1, address(router), address(factory), admin);
        router.setAdapter(1, address(adapter));

        uint256 price = vm.envOr("BENCH_PRICE_USDG", uint256(500));
        uint256[] memory tvl = _csv(vm.envOr("BENCH_POOL_USDG", string("5000000,1000000,250000")));
        uint256[] memory fees = _csv(vm.envOr("BENCH_POOL_FEES", string("500,3000,10000")));
        require(tvl.length == fees.length, "BENCH_POOL_USDG / BENCH_POOL_FEES length mismatch");
        for (uint256 i; i < tvl.length; ++i) {
            CPMMPool pool = new CPMMPool(usdg, stock, uint24(fees[i]));
            factory.forceRegister(usdg, stock, uint24(fees[i]), address(pool));
            u.mint(address(pool), tvl[i] * 1e6);
            s.mint(address(pool), (tvl[i] * 1e18) / price);
            _addPool(address(pool), uint24(fees[i]), string.concat("$", vm.toString(tvl[i]), " @", vm.toString(fees[i] / 100), "bps"));
        }
    }

    function _setupFork(string memory csv) internal {
        usdg = vm.envAddress("BENCH_USDG");
        stock = vm.envAddress("BENCH_STOCK");
        weth = vm.envAddress("BENCH_WETH");
        usdgDec = MockERC20(usdg).decimals();
        stockDec = MockERC20(stock).decimals();
        router = new AggregatorRouter(weth, admin);
        adapter = new UniV3Adapter(1, address(router), address(0), admin);
        router.setAdapter(1, address(adapter));
        string[] memory entries = vm.split(csv, ",");
        for (uint256 i; i < entries.length; ++i) {
            address pool = vm.parseAddress(entries[i]);
            adapter.registerPool(pool);
            _addPool(pool, IUniswapV3Pool(pool).fee(), vm.toString(pool));
        }
    }

    function _addPool(address pool, uint24 fee, string memory label) internal {
        Route memory r = Route({protocol: 1, tokenIn: usdg, tokenOut: stock, fee: fee, extra: abi.encode(pool)});
        router.approveHop(r);
        pools.push(PoolInfo({pool: pool, fee: fee, label: label, route: r}));
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _sizes() internal view returns (uint256[] memory) {
        return _csv(vm.envOr("BENCH_SIZES", string("20,200,2000,20000,200000,2000000,20000000")));
    }

    function _csv(string memory s) internal pure returns (uint256[] memory out) {
        string[] memory parts = vm.split(s, ",");
        out = new uint256[](parts.length);
        for (uint256 i; i < parts.length; ++i) {
            out[i] = vm.parseUint(parts[i]);
        }
    }

    function _labelOf(Route memory r) internal view returns (string memory) {
        address pool = abi.decode(r.extra, (address));
        for (uint256 p; p < pools.length; ++p) {
            if (pools[p].pool == pool) return pools[p].label;
        }
        return vm.toString(pool);
    }

    /// @dev Fixed-point to "int.frac" with 4 decimals.
    function _fmt(uint256 x, uint8 dec) internal pure returns (string memory) {
        uint256 unit = 10 ** dec;
        uint256 whole = x / unit;
        uint256 frac = ((x % unit) * 10_000) / unit;
        string memory f = vm.toString(frac);
        while (bytes(f).length < 4) f = string.concat("0", f);
        return string.concat(vm.toString(whole), ".", f);
    }
}
