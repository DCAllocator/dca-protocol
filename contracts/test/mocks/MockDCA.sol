// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockDCA
/// @notice Test / local-only stand-in for the $DCA token. NEVER deploy this as the production token:
///         production vaults take the real token address in their constructor (see script/Deploy.s.sol).
contract MockDCA is ERC20, Ownable {
    constructor(address initialOwner) ERC20("Mock DCA", "mDCA") Ownable(initialOwner) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
