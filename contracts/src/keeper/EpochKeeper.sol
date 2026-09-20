// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPlanVault} from "../interfaces/IPlanVault.sol";

/// @title EpochKeeper
/// @notice Job list of (vault, stock) pairs with an operator-only `runDue()` and a Chainlink-Automation /
///         Gelato compatible `checkUpkeep` / `performUpkeep` pair. One failing job never blocks the others.
///
/// @dev Every execution entry point (`runDue`, `performUpkeep`, `run`) is restricted to the owner and
///      `isOperator` addresses: this contract is registered as a keeper on the vaults (which run with
///      `keeperOnly = true`), so an open entry point here would hand that privilege to anyone. Register your
///      bot EOAs and the Chainlink Automation forwarder / Gelato dedicated sender as operators.
///      Cron guidance (UTC): Daily vault fires at 00:00 every day, Weekly at Monday 00:00, Monthly every
///      30 days from its origin. Poll `checkUpkeep` a few minutes after each boundary; a large stock may
///      need several `performUpkeep` calls (pagination) — keep polling until `isEpochDue` is false.
///      Vault keeper tips (if enabled) land here and are forwarded to the operator who called.
///
///      V2 hook point: a Uniswap V4 afterSwap hook could call `vault.advanceEpoch(stock, ...)` directly
///      (see IEpochAdvanceable). Nothing here depends on it.
contract EpochKeeper is Ownable2Step {
    using SafeERC20 for IERC20;

    struct Job {
        address vault;
        address stock;
        bool active;
    }

    Job[] private _jobs;
    mapping(bytes32 => uint256) private _jobIndex; // key => index + 1
    mapping(address => bool) public isOperator;
    IERC20 public immutable usdg;
    uint256 public maxJobsPerUpkeep = 5;

    error JobExists(address vault, address stock);
    error JobMissing(uint256 index);
    error NotOperator();
    error ZeroAddress();
    error NotAContract(address vault);

    event JobAdded(uint256 indexed index, address indexed vault, address indexed stock);
    event JobRemoved(uint256 indexed index, address indexed vault, address indexed stock);
    event JobActiveSet(uint256 indexed index, bool active);
    event JobRun(address indexed vault, address indexed stock, bool completed);
    event JobFailed(address indexed vault, address indexed stock, bytes reason);
    event OperatorSet(address indexed operator, bool allowed);
    event MaxJobsPerUpkeepSet(uint256 n);
    event TipsForwarded(address indexed to, uint256 amount);

    constructor(address usdg_, address owner_) Ownable(owner_) {
        if (usdg_ == address(0)) revert ZeroAddress();
        usdg = IERC20(usdg_);
    }

    modifier onlyOperator() {
        if (msg.sender != owner() && !isOperator[msg.sender]) revert NotOperator();
        _;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function addJob(address vault, address stock) external onlyOwner returns (uint256 index) {
        if (vault == address(0) || stock == address(0)) revert ZeroAddress();
        if (vault.code.length == 0) revert NotAContract(vault);
        bytes32 k = _key(vault, stock);
        if (_jobIndex[k] != 0) revert JobExists(vault, stock);
        _jobs.push(Job({vault: vault, stock: stock, active: true}));
        index = _jobs.length - 1;
        _jobIndex[k] = index + 1;
        emit JobAdded(index, vault, stock);
    }

    function removeJob(uint256 index) external onlyOwner {
        if (index >= _jobs.length) revert JobMissing(index);
        Job memory j = _jobs[index];
        uint256 last = _jobs.length - 1;
        if (index != last) {
            _jobs[index] = _jobs[last];
            _jobIndex[_key(_jobs[index].vault, _jobs[index].stock)] = index + 1;
        }
        _jobs.pop();
        _jobIndex[_key(j.vault, j.stock)] = 0;
        emit JobRemoved(index, j.vault, j.stock);
    }

    function setJobActive(uint256 index, bool active) external onlyOwner {
        if (index >= _jobs.length) revert JobMissing(index);
        _jobs[index].active = active;
        emit JobActiveSet(index, active);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        isOperator[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setMaxJobsPerUpkeep(uint256 n) external onlyOwner {
        maxJobsPerUpkeep = n == 0 ? 1 : n;
        emit MaxJobsPerUpkeepSet(maxJobsPerUpkeep);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function jobCount() external view returns (uint256) {
        return _jobs.length;
    }

    function job(uint256 index) external view returns (Job memory) {
        return _jobs[index];
    }

    function jobs() external view returns (Job[] memory) {
        return _jobs;
    }

    /// @notice Indices of active jobs whose vault reports the epoch as due.
    function dueJobs() public view returns (uint256[] memory due) {
        uint256 n;
        for (uint256 i; i < _jobs.length; ++i) {
            if (_isDue(_jobs[i])) ++n;
        }
        due = new uint256[](n);
        uint256 j;
        for (uint256 i; i < _jobs.length; ++i) {
            if (_isDue(_jobs[i])) due[j++] = i;
        }
    }

    // ------------------------------------------------------------------
    // Chainlink Automation / Gelato compatible
    // ------------------------------------------------------------------

    /// @notice Automation check. performData = abi.encode(uint256[] jobIndices) (at most maxJobsPerUpkeep).
    function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData) {
        uint256[] memory due = dueJobs();
        if (due.length == 0) return (false, "");
        uint256 n = due.length > maxJobsPerUpkeep ? maxJobsPerUpkeep : due.length;
        uint256[] memory batch = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            batch[i] = due[i];
        }
        return (true, abi.encode(batch));
    }

    /// @notice Automation perform. Operators only (register the Automation forwarder); re-checks due-ness on chain.
    function performUpkeep(bytes calldata performData) external onlyOperator {
        uint256[] memory idx = abi.decode(performData, (uint256[]));
        for (uint256 i; i < idx.length; ++i) {
            if (idx[i] >= _jobs.length) continue;
            Job memory j = _jobs[idx[i]];
            if (!_isDue(j)) continue;
            _run(j, 0, "");
        }
        _forwardTips(msg.sender);
    }

    // ------------------------------------------------------------------
    // EOA bots
    // ------------------------------------------------------------------

    /// @notice Run every due job once (one page each). Call repeatedly until nothing is due. Operators only.
    function runDue() external onlyOperator returns (uint256 ran) {
        for (uint256 i; i < _jobs.length; ++i) {
            Job memory j = _jobs[i];
            if (!_isDue(j)) continue;
            if (_run(j, 0, "")) ++ran;
        }
        _forwardTips(msg.sender);
    }

    /// @notice Run one job with an explicit page size and optional route override. Operators only.
    /// @dev The vault validates the override: every hop must be approved on the router and `minOut` may not be
    ///      below the auto-route's own minOut. Override failures revert here (the page is not consumed).
    function run(uint256 index, uint256 limit, bytes calldata routeOverride)
        external
        onlyOperator
        returns (bool completed)
    {
        if (index >= _jobs.length) revert JobMissing(index);
        Job memory j = _jobs[index];
        completed = IPlanVault(j.vault).advanceEpoch(j.stock, limit, routeOverride);
        emit JobRun(j.vault, j.stock, completed);
        _forwardTips(msg.sender);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _isDue(Job memory j) internal view returns (bool) {
        if (!j.active || j.vault.code.length == 0) return false;
        try IPlanVault(j.vault).isEpochDue(j.stock) returns (bool due) {
            return due;
        } catch {
            return false;
        }
    }

    function _run(Job memory j, uint256 limit, bytes memory routeOverride) internal returns (bool ok) {
        try IPlanVault(j.vault).advanceEpoch(j.stock, limit, routeOverride) returns (bool completed) {
            emit JobRun(j.vault, j.stock, completed);
            ok = true;
        } catch (bytes memory reason) {
            emit JobFailed(j.vault, j.stock, reason);
        }
    }

    function _forwardTips(address to) internal {
        uint256 bal = usdg.balanceOf(address(this));
        if (bal > 0) {
            usdg.safeTransfer(to, bal);
            emit TipsForwarded(to, bal);
        }
    }

    function _key(address vault, address stock) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(vault, stock));
    }
}
