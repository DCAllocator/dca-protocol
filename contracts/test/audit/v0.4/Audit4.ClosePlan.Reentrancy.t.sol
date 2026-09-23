// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../../BaseTest.sol";
import {MockStrategy} from "../../mocks/MockStrategy.sol";
import {IPlanVault} from "../../../src/interfaces/IPlanVault.sol";
import {PlanVault} from "../../../src/vault/PlanVault.sol";
import {Plan} from "../../../src/vault/VaultTypes.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Re-enters the vault from inside a call the vault makes, recording the revert selector of every attempt.
///      Shared by the malicious strategy and the malicious stock token below.
abstract contract Reenterer {
    PlanVault public vault;
    uint256 public planId;
    address public stock;
    bytes4[] public outcomes;
    bool internal armed;

    function outcomeCount() external view returns (uint256) {
        return outcomes.length;
    }

    function _arm(PlanVault v, uint256 id, address s) internal {
        vault = v;
        planId = id;
        stock = s;
        armed = true;
    }

    /// @dev Every vault entry that reaches PlanExitLib (and the unboost leg), tried once each, once.
    function _reenterAll() internal {
        if (!armed) return;
        armed = false;
        _try(abi.encodeCall(IPlanVault.closePlan, (planId)));
        _try(abi.encodeCall(IPlanVault.withdrawIdle, (planId, type(uint256).max)));
        _try(abi.encodeCall(IPlanVault.claim, (planId, type(uint256).max)));
        _try(abi.encodeCall(IPlanVault.claimAll, (stock)));
        _try(abi.encodeCall(IPlanVault.prunePlan, (planId)));
        _try(abi.encodeCall(IPlanVault.setPlanBoost, (planId, false)));
    }

    function _try(bytes memory data) private {
        (bool ok, bytes memory ret) = address(vault).call(data);
        if (ok) outcomes.push(bytes4(0));
        else outcomes.push(ret.length >= 4 ? bytes4(ret) : bytes4(0xffffffff));
    }
}

/// @dev Boost strategy that re-enters the vault while paying the unboost leg of `closePlan` out.
contract ReentrantStrategy is MockStrategy, Reenterer {
    constructor(IERC20 asset_) MockStrategy(asset_) {}

    function arm(PlanVault v, uint256 id, address s) external {
        _arm(v, id, s);
    }

    function withdraw(uint256 assets, address receiver, address owner_) public override returns (uint256) {
        _reenterAll();
        return super.withdraw(assets, receiver, owner_);
    }
}

/// @dev Stock token whose transfers call the recipient back (an ERC-777-style hook): re-enters from the claim leg.
contract HookedStock is ERC20 {
    address public hook;

    constructor() ERC20("Hooked Stock", "HOOK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(address h) external {
        hook = h;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == hook) ReentrantRecipient(hook).onStock(); // same `onStock()` selector on RecipientSwitcher
    }
}

/// @dev Plan owner + recipient that re-enters when it receives stock (during the claim leg of `closePlan`).
contract ReentrantRecipient is Reenterer {
    function open(PlanVault v, IERC20 usdg, address s, uint256 deposit) external returns (uint256 id) {
        usdg.approve(address(v), type(uint256).max);
        id = v.createPlan(s, 100e6, address(this), deposit, 0, 0, false);
        _arm(v, id, s);
    }

    function close() external {
        vault.closePlan(planId);
    }

    function onStock() external {
        _reenterAll();
    }
}

/// @dev Plan owner + recipient that, from the stock hook, re-enters the UNGUARDED owner setter `setPlanRecipient`
///      (review CP-02): the call succeeds — only the owner can make it — so the question is whether the payout
///      and the `Claimed` event still agree on who was paid.
contract RecipientSwitcher {
    PlanVault public vault;
    uint256 public planId;
    address public constant DECOY = address(0xBEEF);
    uint256 public hookCalls;

    function open(PlanVault v, IERC20 usdg, address s, uint256 deposit) external returns (uint256 id) {
        vault = v;
        usdg.approve(address(v), type(uint256).max);
        id = v.createPlan(s, 100e6, address(this), deposit, 0, 0, false);
        planId = id;
    }

    function close() external {
        vault.closePlan(planId);
    }

    function onStock() external {
        hookCalls++;
        vault.setPlanRecipient(planId, DECOY);
    }
}

/// @title AUDIT v0.4 — `closePlan` / PlanExitLib re-entrancy surface
///
/// PlanExitLib returns the `totalUsdgIdle` delta for the vault to apply AFTER the delegatecall, which is only
/// sound if nothing can re-enter the vault in between. Three checks: (1) re-entering from the boost strategy while
/// the unboost leg pays out; (2) re-entering from the stock token while the claim leg pays the recipient; (3) every
/// state-changing PlanExitLib entry point is reachable ONLY by delegatecall from a `nonReentrant` vault function —
/// a direct CALL to the library address is refused by Solidity's library call protection.
contract Audit4_ClosePlan_Reentrancy is BaseTest {
    bytes4 internal constant REENTRANT = bytes4(keccak256("ReentrancyGuardReentrantCall()"));

    /// @dev PlanExitLib's external selectors (`forge inspect PlanExitLib methodIdentifiers`). Pinned here so a new
    ///      entry point must be added to this audit on purpose: `test_exitLib_directCallsAreRefused_onlyFourEntryPoints`
    ///      reads the dispatcher off the library runtime and fails when the dispatched set is not exactly these four.
    bytes4 internal constant SEL_WITHDRAW_IDLE = 0xf67c66ae;
    bytes4 internal constant SEL_CLAIM = 0x95a29d5f;
    bytes4 internal constant SEL_PRUNE = 0xb0d178d8;
    bytes4 internal constant SEL_CLOSE = 0xda5ac5e9;

    function _assertAllReentrant(Reenterer r) internal view {
        uint256 n = r.outcomeCount();
        assertEq(n, 6, "every re-entry was attempted");
        for (uint256 i; i < n; ++i) {
            assertEq(r.outcomes(i), REENTRANT, "re-entry refused by the guard, before any other check");
        }
    }

    // ------------------------------------------------------------------
    // (1) from the boost strategy, inside the unboost leg
    // ------------------------------------------------------------------

    function test_reentryFromStrategy_duringUnboostLeg_isRefused() public {
        ReentrantStrategy evil = new ReentrantStrategy(usdg);
        vm.prank(owner);
        daily.setBoostStrategy(address(evil)); // no positions open yet: allowed
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        evil.arm(daily, id, address(nvda));
        uint256 aliceUsdg = usdg.balanceOf(alice);
        uint256 stock = daily.getPlan(id).stockAccrued;

        vm.prank(alice);
        daily.closePlan(id);

        _assertAllReentrant(evil);
        // and the close itself completed exactly once
        assertEq(usdg.balanceOf(alice) - aliceUsdg, 800e6 - 2e6, "paid once");
        assertEq(nvda.balanceOf(alice), stock - (stock * 25) / 10_000);
        Plan memory p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0);
        assertEq(p.boostShares, 0);
        assertEq(daily.totalUsdgIdle(), 0, "the delta was applied once, after the guarded call");
        assertEq(daily.stockPlanCount(address(nvda)), 0);
        assertEq(usdg.balanceOf(address(daily)), 0);
    }

    // ------------------------------------------------------------------
    // (2) from the stock token, inside the claim leg
    // ------------------------------------------------------------------

    function test_reentryFromStockToken_duringClaimLeg_isRefused() public {
        HookedStock hooked = new HookedStock();
        vm.prank(owner);
        registry.listStock(address(hooked), "HOOK", false, true);
        router.setRate(address(usdg), address(hooked), 1e18, 100e6);
        ReentrantRecipient mallory = new ReentrantRecipient();
        hooked.setHook(address(mallory));
        usdg.mint(address(mallory), 1_000e6);
        uint256 id = mallory.open(daily, usdg, address(hooked), 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(hooked));
        uint256 stock = daily.getPlan(id).stockAccrued;
        assertGt(stock, 0);

        mallory.close();

        _assertAllReentrant(mallory);
        assertEq(hooked.balanceOf(address(mallory)), stock - (stock * 25) / 10_000, "paid once");
        assertEq(usdg.balanceOf(address(mallory)), 900e6 - 2.25e6);
        assertEq(daily.totalUsdgIdle(), 0);
        assertEq(daily.totalStockAccrued(address(hooked)), 0);
        assertEq(daily.stockPlanCount(address(hooked)), 0);
        assertEq(usdg.balanceOf(address(daily)), 0);
        assertEq(hooked.balanceOf(address(daily)), 0);
    }

    /// @dev Review CP-02: `setPlanRecipient` / `setPlanPaused` / `setPlanAmount` are owner-gated but not
    ///      `nonReentrant`, so an owner contract can change the recipient from inside the claim leg's transfer
    ///      hook. That is self-inflicted and moves no funds, but the `Claimed` event must still name the address
    ///      the stock was actually paid to, not the one set afterwards — indexers attribute payouts by that topic.
    function test_reentryFromStockToken_recipientSwitch_claimedEventNamesTheActualPayee() public {
        HookedStock hooked = new HookedStock();
        vm.prank(owner);
        registry.listStock(address(hooked), "HOOK", false, true);
        router.setRate(address(usdg), address(hooked), 1e18, 100e6);
        RecipientSwitcher sw = new RecipientSwitcher();
        hooked.setHook(address(sw));
        usdg.mint(address(sw), 1_000e6);
        uint256 id = sw.open(daily, usdg, address(hooked), 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(hooked));
        uint256 stock = daily.getPlan(id).stockAccrued;
        assertGt(stock, 0);
        uint256 fee = (stock * 25) / 10_000;

        vm.expectEmit(true, true, true, true);
        emit IPlanVault.Claimed(id, address(hooked), address(sw), stock, fee);
        sw.close();

        assertEq(sw.hookCalls(), 1, "the hook ran once, during the net transfer");
        assertEq(hooked.balanceOf(address(sw)), stock - fee, "paid to the recipient of record at transfer time");
        assertEq(hooked.balanceOf(sw.DECOY()), 0, "the decoy got nothing");
        assertEq(daily.getPlan(id).recipient, sw.DECOY(), "the owner's setter did take effect (unguarded, owner-only)");
        assertEq(daily.totalStockAccrued(address(hooked)), 0);
        assertEq(daily.stockPlanCount(address(hooked)), 0);
    }

    // ------------------------------------------------------------------
    // (3) PlanExitLib is unreachable except by the vault's delegatecalls
    // ------------------------------------------------------------------

    /// @dev Find the linked PlanExitLib: the PUSH20 target in the vault's runtime whose code dispatches all four
    ///      library selectors (external library functions are dispatched like a contract's).
    function _findExitLib() internal view returns (address lib) {
        bytes memory code = address(daily).code;
        for (uint256 i; i + 21 <= code.length; ++i) {
            if (code[i] != 0x73) continue; // PUSH20
            address cand;
            assembly ("memory-safe") {
                cand := shr(96, mload(add(add(code, 0x20), add(i, 1))))
            }
            if (cand.code.length == 0 || cand == address(daily)) continue;
            bytes memory c = cand.code;
            if (_has(c, SEL_WITHDRAW_IDLE) && _has(c, SEL_CLAIM) && _has(c, SEL_PRUNE) && _has(c, SEL_CLOSE)) {
                return cand;
            }
        }
    }

    function _has(bytes memory code, bytes4 sel) internal pure returns (bool) {
        for (uint256 i; i + 4 <= code.length; ++i) {
            if (code[i] == sel[0] && code[i + 1] == sel[1] && code[i + 2] == sel[2] && code[i + 3] == sel[3]) {
                return true;
            }
        }
        return false;
    }

    /// @dev The library's whole external surface, read off its runtime: solc dispatches every external function
    ///      as `DUP1 PUSH4 <selector> EQ PUSH2 <tag> JUMPI`, so the distinct 4-byte immediates that are pushed
    ///      and immediately compared with EQ are exactly the dispatched selectors. (Error selectors and the ones
    ///      built for outgoing calls are pushed then shifted / stored, never EQ-compared; a binary-search pivot
    ///      is compared with GT / LT and is itself one of the dispatched selectors, so it adds nothing.)
    function _dispatchedSelectors(bytes memory code) internal pure returns (bytes4[] memory sels) {
        bytes4[] memory found = new bytes4[](64);
        uint256 n;
        for (uint256 i; i + 6 <= code.length; ++i) {
            if (code[i] != 0x63 || code[i + 5] != 0x14) continue; // PUSH4 <sel> EQ
            bytes4 sel = bytes4(bytes.concat(code[i + 1], code[i + 2], code[i + 3], code[i + 4]));
            bool dup;
            for (uint256 j; j < n; ++j) {
                if (found[j] == sel) dup = true;
            }
            if (!dup) found[n++] = sel;
        }
        sels = new bytes4[](n);
        for (uint256 j; j < n; ++j) {
            sels[j] = found[j];
        }
    }

    function _contains(bytes4[] memory sels, bytes4 sel) internal pure returns (bool) {
        for (uint256 i; i < sels.length; ++i) {
            if (sels[i] == sel) return true;
        }
        return false;
    }

    /// @dev Enforces the doc claim above: the four pinned selectors ARE the library's whole dispatched surface (a
    ///      fifth state-changing entry point — reachable, say, from a vault stub that forgot `nonReentrant` —
    ///      fails this test until it is audited and pinned here), and each of them refuses a direct CALL.
    function test_exitLib_directCallsAreRefused_onlyFourEntryPoints() public {
        address lib = _findExitLib();
        assertTrue(lib != address(0), "PlanExitLib linked into the vault");
        bytes4[4] memory sels = [SEL_WITHDRAW_IDLE, SEL_CLAIM, SEL_PRUNE, SEL_CLOSE];
        bytes memory code = lib.code;
        bytes4[] memory dispatched = _dispatchedSelectors(code);
        assertEq(dispatched.length, 4, "PlanExitLib dispatches exactly the four pinned selectors");
        for (uint256 i; i < 4; ++i) {
            assertTrue(_contains(dispatched, sels[i]), "pinned selector dispatched by the library");
            // a direct CALL (storage would be the library's own): refused by the call protection, whatever the args
            (bool ok,) = lib.call(abi.encodePacked(sels[i], new bytes(32 * 12)));
            assertFalse(ok, "direct call to a state-changing library function must revert");
        }
        // the vault's guarded entries, on the other hand, do reach it (sanity: the address is the right one)
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 200e6, 1_000e6);
        vm.prank(alice);
        daily.closePlan(id);
        assertEq(daily.stockPlanCount(address(nvda)), 0);
    }

    /// @dev The vault side of the same claim: every function that delegatecalls into PlanExitLib (or burns shares)
    ///      is `nonReentrant`, checked before any other modifier — so a re-entry never even reaches `onlyPlanOwner`.
    function test_vaultEntries_guardBeforeOwnerCheck() public {
        ReentrantStrategy evil = new ReentrantStrategy(usdg);
        vm.prank(owner);
        weekly.setBoostStrategy(address(evil));
        uint256 id = _createBoostedPlan(weekly, alice, address(nvda), 200e6, 1_000e6);
        // the strategy is not the plan owner: without the guard these re-entries would fail NotPlanOwner /
        // PlanNotEmpty instead — the recorded selector tells the two apart
        evil.arm(weekly, id, address(nvda));
        vm.prank(alice);
        weekly.withdrawIdle(id, 500e6); // partial boosted withdraw: strategy.withdraw is called from PlanExitLib
        _assertAllReentrant(evil);
        assertEq(weekly.getPlan(id).usdgIdle, 0);
        assertGt(weekly.getPlan(id).boostShares, 0);
        assertEq(usdg.balanceOf(address(weekly)), 0, "USDG paid out, none stranded");
    }
}
