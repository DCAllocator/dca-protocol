// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// forge-lint: disable-start(unsafe-typecast)

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolKey, V4SwapParams, IUnlockCallback} from "../../src/interfaces/IUniswapV4.sol";

/// @dev Minimal PoolManager: unlock/callback, constant-price exact-input swaps, sync/settle/take, extsload of
///      slot0 at the v4-core StateLibrary location. Not a delta-accounting model — enough to exercise the adapter.
contract MockV4PoolManager {
    struct PoolState {
        bool exists;
        uint160 sqrtP;
        uint256 impactBps;
        uint256 maxOut;
    }

    bytes32 public constant POOLS_SLOT = bytes32(uint256(6));
    uint256 internal constant Q96 = 2 ** 96;

    mapping(bytes32 => PoolState) public pools;
    mapping(bytes32 => bytes32) internal _slots;
    address internal _synced;
    uint256 internal _syncedBal;
    bool public unlocked;
    uint256 public swapCount;

    function toId(PoolKey memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function initPool(PoolKey memory key, uint160 sqrtP) external {
        bytes32 id = toId(key);
        pools[id] = PoolState({exists: true, sqrtP: sqrtP, impactBps: 0, maxOut: 0});
        _slots[keccak256(abi.encodePacked(id, POOLS_SLOT))] = bytes32(uint256(sqrtP));
    }

    function setImpact(PoolKey memory key, uint256 bps) external {
        pools[toId(key)].impactBps = bps;
    }

    function setMaxOut(PoolKey memory key, uint256 m) external {
        pools[toId(key)].maxOut = m;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(!unlocked, "AlreadyUnlocked");
        unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        unlocked = false;
    }

    function swap(PoolKey memory key, V4SwapParams memory params, bytes calldata) external returns (int256 delta) {
        require(unlocked, "ManagerLocked");
        PoolState storage st = pools[toId(key)];
        require(st.exists, "PoolNotInitialized");
        require(params.amountSpecified < 0, "exact in only");
        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 mid = params.zeroForOne
            ? Math.mulDiv(Math.mulDiv(amountIn, st.sqrtP, Q96), st.sqrtP, Q96)
            : Math.mulDiv(Math.mulDiv(amountIn, Q96, st.sqrtP), Q96, st.sqrtP);
        uint256 out = (mid * (1_000_000 - key.fee)) / 1_000_000;
        out = (out * (10_000 - st.impactBps)) / 10_000;
        if (st.maxOut != 0 && out > st.maxOut) {
            amountIn = (amountIn * st.maxOut) / out;
            out = st.maxOut;
        }
        int128 a0 = params.zeroForOne ? -int128(int256(amountIn)) : int128(int256(out));
        int128 a1 = params.zeroForOne ? int128(int256(out)) : -int128(int256(amountIn));
        assembly {
            delta := or(shl(128, a0), and(sub(shl(128, 1), 1), a1))
        }
        swapCount++;
    }

    function sync(address currency) external {
        _synced = currency;
        _syncedBal = IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        require(_synced != address(0), "NotSynced");
        paid = IERC20(_synced).balanceOf(address(this)) - _syncedBal;
        _synced = address(0);
    }

    function take(address currency, address to, uint256 amount) external {
        require(unlocked, "ManagerLocked");
        require(IERC20(currency).transfer(to, amount));
    }

    function extsload(bytes32 slot) external view returns (bytes32) {
        return _slots[slot];
    }
}
