// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Plain OZ ERC-4626 that just holds its asset (0% yield). A stand-in boost strategy for migration /
///      asset-mismatch tests, and the "parking" strategy an owner could point vaults at to pause yield.
contract MockStrategy is ERC4626 {
    constructor(IERC20 asset_) ERC20("Holding Vault", "hUSDG") ERC4626(asset_) {}
}
