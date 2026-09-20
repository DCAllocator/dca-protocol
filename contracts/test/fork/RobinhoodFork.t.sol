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
        uint24[] memory tiers = new uint24[](4);
        tiers[0] = 100;
        tiers[1] = 500;
        tiers[2] = 3000;
        tiers[3] = 10000;
        if (uniV3Factory != address(0)) {
            router.setAdapter(1, address(new UniV3Adapter(1, address(router), uniV3Factory, tiers, address(this))));
        }
        if (ramsesFactory != address(0)) {
            router.setAdapter(3, address(new RamsesV3Adapter(address(router), ramsesFactory, tiers, address(this))));
        }
        if (uniV4Pm != address(0)) {
            router.setAdapter(2, address(new UniV4Adapter(address(router), uniV4Pm, address(this))));
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
