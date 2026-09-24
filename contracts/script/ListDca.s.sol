// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {StockRegistry} from "../src/registries/StockRegistry.sol";
import {IStockRegistry} from "../src/interfaces/IStockRegistry.sol";
import {AggregatorRouter} from "../src/router/AggregatorRouter.sol";
import {PlanVault} from "../src/vault/PlanVault.sol";
import {PriceGuardLib} from "../src/libraries/PriceGuardLib.sol";
import {EpochKeeper} from "../src/keeper/EpochKeeper.sol";

/// @title ListDca
/// @notice Makes $DCA a plan asset on a running local stack that `DeployLocal` deployed before it listed $DCA
///         itself, without redeploying: lists the local mDCA in the registry as "DCA" (approved, not
///         fee-on-transfer), marks it `PriceGuardLib.UNGUARDED` on every vault (bought without a price floor, as
///         production lists it: no Chainlink feed exists for $DCA and its trading tax is the sandwich defence; this
///         also replaces the mock feed an earlier version of this script set, which pinned the price and made every
///         page revert `PriceDeviates` once the pool moved ~2%) and adds an EpochKeeper job for it on every vault —
///         hourly, daily, weekly, monthly and the TestVault — so the scheduler buys it like any liquid stock.
///         Idempotent: a step that is already done is skipped (listed / approved, marked unguarded, job present and
///         active), so a second run broadcasts nothing. Reads contracts/deployments/<chainId>.json and must broadcast as that deployment's
///         `deployer` (anvil account 0), which owns the registry, the vaults and the keeper. Local stacks only; on
///         Robinhood Chain see `LIST_DCA` in script/Deploy.s.sol.
///
///   cd contracts
///   forge script script/ListDca.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
///
///   or, from the repo root: pnpm dca:list   (RPC=... to target another anvil)
contract ListDca is Script {
    using stdJson for string;

    function run() external {
        require(block.chainid != 4663, "ListDca is not for Robinhood Chain mainnet");
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        address usdg = json.readAddress(".usdg");
        address dca = json.readAddress(".dca");
        StockRegistry registry = StockRegistry(json.readAddress(".registry"));
        AggregatorRouter router = AggregatorRouter(json.readAddress(".router"));
        EpochKeeper keeper = EpochKeeper(json.readAddress(".keeper"));
        PlanVault[] memory vaults = _vaults(json);
        require(address(registry).code.length > 0, string.concat(path, " does not match this chain: redeploy"));

        // Checks first, so a stack this cannot fix aborts before anything is broadcast.
        IStockRegistry.StockInfo memory info = registry.info(dca);
        require(!info.feeOnTransfer, "DCA is flagged fee-on-transfer in the registry; vaults refuse it");
        require(
            router.approvedHops(usdg, dca).length > 0, "no approved USDG->DCA pool on the router: redeploy"
        );

        vm.startBroadcast();
        address sender = msg.sender;
        require(registry.owner() == sender, "broadcast as the deployment's deployer (anvil account 0)");

        if (!info.known) {
            registry.listStock(dca, "DCA", false, true);
            console2.log("listed DCA in the registry", dca);
        } else if (!info.approved) {
            registry.setApproved(dca, true);
            console2.log("approved DCA in the registry", dca);
        }

        EpochKeeper.Job[] memory jobs = keeper.jobs();
        for (uint256 v; v < vaults.length; ++v) {
            PlanVault vault = vaults[v];
            (address current,,,) = vault.priceFeed(dca);
            if (current != PriceGuardLib.UNGUARDED) {
                vault.setPriceFeed(dca, PriceGuardLib.UNGUARDED, 0);
                console2.log("marked DCA unguarded on", address(vault));
            }
            (bool found, uint256 index, bool active) = _findJob(jobs, address(vault), dca);
            if (!found) {
                keeper.addJob(address(vault), dca);
                console2.log("added DCA keeper job for", address(vault));
            } else if (!active) {
                keeper.setJobActive(index, true);
                console2.log("re-activated DCA keeper job", index);
            }
        }
        vm.stopBroadcast();

        require(registry.isPurchasable(dca), "DCA is not purchasable");
        console2.log("DCA is a plan asset on vaults:", vaults.length);
    }

    /// @dev Every vault the deployment file names: hourly (older stacks have none), daily, weekly, monthly, TestVault.
    function _vaults(string memory json) internal view returns (PlanVault[] memory vaults) {
        string[5] memory keys = [".hourly", ".daily", ".weekly", ".monthly", ".testVault"];
        PlanVault[5] memory found;
        uint256 n;
        for (uint256 i; i < keys.length; ++i) {
            if (vm.keyExistsJson(json, keys[i])) found[n++] = PlanVault(json.readAddress(keys[i]));
        }
        vaults = new PlanVault[](n);
        for (uint256 i; i < n; ++i) {
            vaults[i] = found[i];
        }
    }

    function _findJob(EpochKeeper.Job[] memory jobs, address vault, address stock)
        internal
        pure
        returns (bool found, uint256 index, bool active)
    {
        for (uint256 i; i < jobs.length; ++i) {
            if (jobs[i].vault == vault && jobs[i].stock == stock) return (true, i, jobs[i].active);
        }
    }
}
