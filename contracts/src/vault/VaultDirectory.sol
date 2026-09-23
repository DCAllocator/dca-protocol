// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title VaultDirectory
/// @notice Single discovery point for frontends and keepers: the four frequency vaults plus shared infra.
/// @dev The vaults themselves are deployed by `script/Deploy.s.sol`. An on-chain factory embedding four
///      ~24KB vault initcodes cannot fit under EIP-170, so the script is the factory and this is the index.
///      The vault fields are ordered fastest cadence first — [hourly, daily, weekly, monthly] — and `vaults()`
///      returns them in that same order; frontends display frequencies in this order too.
contract VaultDirectory is Ownable2Step {
    struct Entry {
        address hourly;
        address daily;
        address weekly;
        address monthly;
        address registry;
        address router;
        address usdg;
        address weth;
        address dca;
    }

    Entry private _entry;

    event DirectorySet(Entry entry);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Replace the whole entry (all-or-nothing keeps the set consistent).
    function set(Entry calldata e) external onlyOwner {
        _entry = e;
        emit DirectorySet(e);
    }

    /// @notice Everything a client needs to bootstrap.
    function get() external view returns (Entry memory) {
        return _entry;
    }

    /// @notice The four vaults in [hourly, daily, weekly, monthly] order.
    function vaults() external view returns (address[4] memory) {
        return [_entry.hourly, _entry.daily, _entry.weekly, _entry.monthly];
    }
}
