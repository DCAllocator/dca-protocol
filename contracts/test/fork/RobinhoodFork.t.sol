// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {AggregatorRouter} from "../../src/router/AggregatorRouter.sol";
import {UniV3Adapter} from "../../src/router/adapters/UniV3Adapter.sol";
import {RamsesV3Adapter} from "../../src/router/adapters/RamsesV3Adapter.sol";
import {UniV4Adapter} from "../../src/router/adapters/UniV4Adapter.sol";
import {Route} from "../../src/router/IAggregatorRouter.sol";
import {IUniswapV3Factory} from "../../src/interfaces/IUniswapV3.sol";

/// @dev Robinhood Chain (4663) fork smoke test. Runs only when RH_RPC is set AND config/addresses.rh.json has
///      real (non-zero) USDG + at least one stock + one DEX factory. Otherwise every test is skipped.
///
///   RH_RPC=https://... forge test --match-path test/fork/RobinhoodFork.t.sol -vvv
contract RobinhoodForkTest is Test {
    using stdJson for string;

    string internal cfg;
    address internal usdg;
    address internal weth;
    address internal nvda;
    address internal uniV3Factory;
    address internal uniV4Pm;
    address internal ramsesFactory;
    bool internal enabled;

    function setUp() public {
        string memory rpc = vm.envOr("RH_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        cfg = vm.readFile("config/addresses.rh.json");
        usdg = cfg.readAddress(".tokens.USDG");
        weth = cfg.readAddress(".tokens.WETH");
        nvda = cfg.readAddress(".stocks.NVDA.address");
        uniV3Factory = cfg.readAddress(".dex.uniswapV3.factory");
        uniV4Pm = cfg.readAddress(".dex.uniswapV4.poolManager");
        ramsesFactory = cfg.readAddress(".dex.ramsesV3.factory");
        if (usdg == address(0) || weth == address(0) || nvda == address(0)) return;
        if (uniV3Factory == address(0) && ramsesFactory == address(0)) return;
        vm.createSelectFork(rpc);
        if (block.chainid != 4663) return;
        enabled = true;
    }

    modifier onlyFork() {
        if (!enabled) {
            console2.log("skipped: RH_RPC unset or config/addresses.rh.json incomplete");
            return;
        }
        _;
    }

    function test_fork_tokenMetadata() public onlyFork {
        assertGt(usdg.code.length, 0, "USDG is a contract");
        assertGt(nvda.code.length, 0, "NVDA is a contract");
        console2.log("USDG decimals", IERC20Metadata(usdg).decimals());
        console2.log("NVDA symbol  ", IERC20Metadata(nvda).symbol());
    }

    function test_fork_quoteUsdgToNvda() public onlyFork {
        AggregatorRouter router = new AggregatorRouter(weth, address(this));
        UniV3Adapter uni;
        if (uniV3Factory != address(0)) {
            uni = new UniV3Adapter(1, address(router), uniV3Factory, address(this));
            router.setAdapter(1, address(uni));
        }
        if (ramsesFactory != address(0)) {
            router.setAdapter(3, address(new RamsesV3Adapter(address(router), ramsesFactory, address(this))));
        }
        if (uniV4Pm != address(0)) {
            router.setAdapter(2, address(new UniV4Adapter(address(router), uniV4Pm, address(this))));
        }
        // The router only trades approved hops: approve every Uniswap V3 USDG/NVDA tier the factory knows.
        uint24[4] memory tiers = [uint24(100), 500, 3000, 10000];
        for (uint256 i; i < 4 && address(uni) != address(0); ++i) {
            address pool = IUniswapV3Factory(uniV3Factory).getPool(usdg, nvda, tiers[i]);
            if (pool == address(0)) continue;
            router.approveHop(
                Route({protocol: 1, tokenIn: usdg, tokenOut: nvda, fee: tiers[i], extra: abi.encode(pool)})
            );
        }
        uint256 amountIn = 1_000 * 10 ** IERC20Metadata(usdg).decimals();
        (uint256 out, Route[] memory path, uint256 impact) = router.quoteWithImpact(usdg, nvda, amountIn);
        console2.log("1000 USDG -> NVDA out", out);
        console2.log("impact bps", impact);
        console2.log("hops", path.length);
        for (uint256 i; i < path.length; ++i) {
            console2.log("  protocol", uint256(path[i].protocol), "fee", uint256(path[i].fee));
        }
        assertGt(out, 0);
        assertLe(impact, router.maxPriceImpactBps());
    }
}
