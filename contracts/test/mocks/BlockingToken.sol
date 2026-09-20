// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Stock token with a transfer blocklist (models a permissioned Stock Token).
contract BlockingToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blocking Stock", "BLK") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function setBlocked(address who, bool isBlocked) external {
        blocked[who] = isBlocked;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "BLK: recipient blocked");
        super._update(from, to, value);
    }
}
