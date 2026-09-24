// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {BaseTest} from "../BaseTest.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {PlanVault} from "../../src/vault/PlanVault.sol";
import {Plan} from "../../src/vault/VaultTypes.sol";
import {ClaimHelper} from "../../src/periphery/ClaimHelper.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";

/// @dev User-testing report: "withdrawing from a boosted plan leaves dust behind; a second withdrawal clears
///      it". Pins where that residual comes from and whose it is:
///      - an EXPLICIT amount below the balance at execution leaves the plan's own shares behind: the amount the
///        web read at block N (Max pressed, then a positions poll or a slow mine) misses the interest accrued
///        since, and the slider / typed amounts miss the fraction the UI rounds away;
///      - `withdrawIdle(MAX)`, `closePlan` and the unboost -> withdraw(MAX) -> claim(MAX) -> prune fallback
///        leave nothing, interest included;
///      - no exit takes value from another plan beyond 1 raw unit (1e-6 USDG) of the strategy's rounding; the
///        only value no plan owns is the pool's rounding gap (virtual share + per-plan floors, a few raw units),
///        which stays in the vault's strategy position.
contract BoostDustTest is BaseTest {
    uint256 internal constant MAX = type(uint256).max;
    /// @dev The web's positions poll: react-query `refetchInterval` (apps/web/src/components/Providers.tsx).
    uint256 internal constant POLL = 15 seconds;
    uint16 internal constant WITHDRAW_FEE_BPS = 25;
    uint16 internal constant CLAIM_FEE_BPS = 25;

    ClaimHelper internal helper;

    function setUp() public override {
        super.setUp();
        helper = new ClaimHelper();
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /// @dev What "My plans" shows as the plan's balance and fills in on Max: `planBalance(p)` =
    ///      `usdgIdle + boostValue` of the ClaimHelper.positions read.
    function _shown(PlanVault v, address user, uint256 id) internal view returns (uint256) {
        IPlanVault[] memory vs = new IPlanVault[](1);
        vs[0] = v;
        ClaimHelper.Position[] memory ps = helper.positions(vs, user);
        for (uint256 i; i < ps.length; ++i) {
            if (ps[i].planId == id) return uint256(ps[i].usdgIdle) + ps[i].boostValue;
        }
        revert("plan not found");
    }

    function _fee(uint256 amount, uint16 bps) internal pure returns (uint256) {
        return FeeMath.feeOf(amount, bps);
    }

    /// @dev Value no plan owns: the pool minus the sum of every plan's boosted balance (reverts if negative).
    function _gap(PlanVault v) internal view returns (uint256) {
        uint256 values;
        for (uint256 id = 1; id < v.nextPlanId(); ++id) {
            values += _boostValue(v, id);
        }
        assertLe(values, v.boostAssets(), "plan values never exceed the pool");
        return v.boostAssets() - values;
    }

    function _assertEmpty(PlanVault v, uint256 id) internal view {
        Plan memory p = v.getPlan(id);
        assertEq(p.usdgIdle, 0, "no idle left");
        assertEq(p.boostShares, 0, "no boost shares left");
        assertEq(p.stockAccrued, 0, "no stock left");
        assertEq(p.boostPrincipal, 0, "no cost basis left");
    }

    /// @dev Boosted plan holding all three kinds of value: a boosted balance with 30 days of interest, a plain
    ///      idle residual (a 90% fill hands the unspent net back as idle) and accrued NVDA.
    function _mixedBoostedPlan(address user) internal returns (uint256 id) {
        id = _createBoostedPlan(daily, user, address(nvda), 100e6, 1_000e6);
        router.setFill(address(usdg), address(nvda), 9_000);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        router.setFill(address(usdg), address(nvda), 10_000);
        vm.warp(block.timestamp + 30 days);
        Plan memory p = daily.getPlan(id);
        assertGt(p.usdgIdle, 0, "idle residual");
        assertGt(p.stockAccrued, 0, "stock accrued");
        assertGt(_boostValue(daily, id), 900e6, "boosted balance");
    }

    // ------------------------------------------------------------------
    // (a) H1: an amount read at block N, executed later
    // ------------------------------------------------------------------

    /// @dev Max pressed at block N, then one positions poll lands before Withdraw: the input still holds the
    ///      block-N balance, `all = wei >= available` is false, and the explicit amount is sent. What is left is
    ///      exactly the interest the plan's OWN position earned between the read and the execution.
    function test_staleAmount_leavesOwnInterestSinceTheRead() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        vm.warp(block.timestamp + 7 days);
        uint256 seen = _shown(daily, alice, id); // block N
        uint256 rate = strategy.supplyRatePerSecond();
        vm.warp(block.timestamp + POLL); // execution block
        uint256 atExec = _boostValue(daily, id);
        uint256 accrued = atExec - seen;
        assertGt(accrued, 0, "the position earned in between");
        // ~1,000 USDG x 4.95% APR x 15 s = ~23.5 raw units
        assertApproxEqAbs(accrued, (seen * rate * POLL) / 1e18, 3, "accrued = balance x supply rate x time");

        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        daily.withdrawIdle(id, seen);
        assertEq(usdg.balanceOf(alice) - before, seen - _fee(seen, WITHDRAW_FEE_BPS), "paid exactly the amount sent");

        Plan memory p = daily.getPlan(id);
        uint256 residual = _boostValue(daily, id);
        assertGt(p.boostShares, 0, "shares survive an explicit amount");
        assertEq(residual, _shown(daily, alice, id), "the web now shows exactly this residual");
        assertLe(residual, accrued, "never more than the plan's own interest since the read");
        assertGe(residual + 1, accrued, "and all of it, bar the 1-unit round-up of the burn");
        console2.log("stale Max, 1,000 USDG, 15 s: residual (raw USDG units)", residual);

        // the second withdrawal the testers needed: Max right away sends the sentinel and clears it
        vm.prank(alice);
        daily.withdrawIdle(id, MAX);
        assertEq(daily.getPlan(id).boostShares, 0);
        assertEq(daily.totalBoostShares(), 0);
    }

    /// @dev Same, fuzzed over balance, age and gap: the residual is always the plan's own interest since the
    ///      read (never more; at most 1 raw unit less) and the plan's own shares.
    function testFuzz_staleAmount_residualIsOwnInterest(uint128 dep, uint32 age, uint32 gap) public {
        uint256 d = bound(dep, 10e6, 1_000_000e6);
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 100e6, d);
        vm.warp(block.timestamp + bound(age, 0, 365 days));
        uint256 seen = _shown(daily, alice, id);
        vm.warp(block.timestamp + bound(gap, 1, 1 days));
        uint256 accrued = _boostValue(daily, id) - seen;
        vm.prank(alice);
        daily.withdrawIdle(id, seen);
        uint256 residual = _boostValue(daily, id);
        assertLe(residual, accrued, "residual <= own interest since the read");
        assertGe(residual + 1, accrued, "residual >= own interest - 1");
    }

    /// @dev How much a stale read misses per poll (15 s) and per local-anvil block gap (the scheduler mines about
    ///      every 2 minutes; eth_call answers at the LAST block's timestamp), at the mock market's ~5% APY and at
    ///      ~10% APY (twice the borrow rate).
    function test_interestPerPoll_quantified() public {
        uint256 small = _createBoostedPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        uint256 large = _createBoostedPlan(daily, bob, address(nvda), 100e6, 100_000e6);
        uint256[2] memory rates = [BORROW_RATE_PER_SECOND, BORROW_RATE_PER_SECOND * 2];
        uint256[2] memory gaps = [POLL, 2 minutes];
        for (uint256 r; r < 2; ++r) {
            irm.setRate(rates[r]);
            morpho.accrueInterest(marketParams);
            for (uint256 g; g < 2; ++g) {
                uint256 s0 = _boostValue(daily, small);
                uint256 l0 = _boostValue(daily, large);
                vm.warp(block.timestamp + gaps[g]);
                uint256 ds = _boostValue(daily, small) - s0;
                uint256 dl = _boostValue(daily, large) - l0;
                console2.log("borrow-rate multiple / gap (s):", r + 1, gaps[g]);
                console2.log("  interest on 1,000 / 100,000 USDG (raw units):", ds, dl);
                // under a cent on 1,000 USDG even at ~10% APY over 2 minutes
                assertLt(ds, 0.01e6);
                assertGt(ds, 0);
            }
        }
    }

    // ------------------------------------------------------------------
    // (a') H2: amounts the UI rounds (slider step = 1 USDG, fmtUsd cents)
    // ------------------------------------------------------------------

    /// @dev Slider dragged to the end: `<input type=range step=1>` cannot reach a fractional max, so it sends the
    ///      whole-USDG floor. Typing the displayed "In plan: $x.yz" back sends the cent-rounded value; when that
    ///      rounded DOWN it is below the balance (explicit amount, residual < half a cent), when it rounded up
    ///      `wei >= available` holds and the UI sends MAX instead.
    function test_roundedAmounts_leaveTheRoundedAwayFraction() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 100e6, 1_000_123_456);
        vm.warp(block.timestamp + 30 days);
        uint256 available = _shown(daily, alice, id);
        uint256 slider = (available / 1e6) * 1e6;
        uint256 displayed = ((available * 100 + 5e5) / 1e6) * 1e4; // fmtUsd: round half up to cents
        assertLt(slider, available);

        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        daily.withdrawIdle(id, slider);
        uint256 residual = _boostValue(daily, id);
        assertLe(residual, available - slider);
        assertGe(residual + 1, available - slider, "the whole fraction the slider could not reach");
        assertLt(residual, 1e6, "under 1 USDG");
        console2.log("slider at the end: residual (raw units)", residual);
        vm.revertToState(snap);

        vm.prank(alice);
        daily.withdrawIdle(id, displayed < available ? displayed : MAX);
        residual = _boostValue(daily, id);
        if (displayed < available) {
            assertGe(residual + 1, available - displayed);
            assertLt(residual, 5_000, "under half a cent");
        } else {
            assertEq(residual, 0, "rounded up: the UI's all-branch sends MAX");
        }
        console2.log("typed the displayed cents: residual (raw units)", residual);
    }

    // ------------------------------------------------------------------
    // (b) H3: withdrawIdle(MAX) clears the plan, stale or not
    // ------------------------------------------------------------------

    function test_staleMax_clearsEverything() public {
        uint256 id = _mixedBoostedPlan(alice);
        uint256 seen = _shown(daily, alice, id); // read at block N ...
        vm.warp(block.timestamp + POLL); // ... executed later
        Plan memory p = daily.getPlan(id);
        uint256 atExec = p.usdgIdle + _boostValue(daily, id);
        assertGt(atExec, seen, "the read is stale");
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        daily.withdrawIdle(id, MAX);
        assertEq(
            usdg.balanceOf(alice) - before, atExec - _fee(atExec, WITHDRAW_FEE_BPS), "all of it, interest included"
        );
        p = daily.getPlan(id);
        assertEq(p.usdgIdle, 0);
        assertEq(p.boostShares, 0, "every share burned");
        assertEq(daily.totalBoostShares(), 0);
        vm.prank(alice);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.withdrawIdle(id, MAX);
    }

    /// @dev Whenever the boosted balance is worth at least one raw unit, MAX burns every share (fuzzed after a
    ///      random partial withdrawal and a random wait).
    function testFuzz_withdrawMax_burnsEveryShare(uint128 dep, uint32 age, uint128 part, uint32 gap) public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 100e6, bound(dep, 10e6, 1_000_000e6));
        vm.warp(block.timestamp + bound(age, 0, 365 days));
        uint256 w = bound(part, 0, _boostValue(daily, id));
        if (w > 0) {
            vm.prank(alice);
            daily.withdrawIdle(id, w);
        }
        vm.warp(block.timestamp + bound(gap, 0, 30 days));
        if (_boostValue(daily, id) == 0) return; // (g) covers worthless shares
        vm.prank(alice);
        daily.withdrawIdle(id, MAX);
        assertEq(daily.getPlan(id).boostShares, 0);
        assertEq(daily.getPlan(id).usdgIdle, 0);
    }

    // ------------------------------------------------------------------
    // (c) closePlan on a boosted plan with interest
    // ------------------------------------------------------------------

    /// @dev "Delete" empties the plan completely: idle + the full boosted value (interest to the close block)
    ///      minus the withdraw fee to the owner, the stock minus the claim fee to the recipient, nothing left.
    ///      The record stays readable and owner-callable afterwards; there is simply nothing to take.
    function test_closePlan_boostedWithInterest_leavesNothing() public {
        uint256 other = _createBoostedPlan(daily, bob, address(aapl), 100e6, 5_000e6);
        uint256 id = _mixedBoostedPlan(alice);
        vm.warp(block.timestamp + POLL);
        Plan memory p = daily.getPlan(id);
        uint256 out = p.usdgIdle + _boostValue(daily, id);
        uint256 stock = p.stockAccrued;
        uint256 otherBefore = _boostValue(daily, other);
        uint256 usdgBefore = usdg.balanceOf(alice);
        uint256 nvdaBefore = nvda.balanceOf(alice);
        uint256 treasuryBefore = usdg.balanceOf(treasury);

        vm.prank(alice);
        daily.closePlan(id);

        assertEq(usdg.balanceOf(alice) - usdgBefore, out - _fee(out, WITHDRAW_FEE_BPS), "owner: idle + boosted - fee");
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, _fee(out, WITHDRAW_FEE_BPS), "treasury: the fee only");
        assertEq(nvda.balanceOf(alice) - nvdaBefore, stock - _fee(stock, CLAIM_FEE_BPS), "stock to the recipient");
        _assertEmpty(daily, id);
        assertFalse(daily.getPlan(id).boosted);
        assertEq(daily.getPlan(id).owner, alice, "the record persists");
        assertFalse(_isIndexed(daily, id), "and is out of the epoch list");
        assertGe(_boostValue(daily, other), otherBefore, "bob's plan lost nothing");
        assertEq(daily.totalBoostShares(), daily.getPlan(other).boostShares, "only bob's shares remain");

        vm.startPrank(alice);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.withdrawIdle(id, MAX);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.claim(id, MAX);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(daily)), daily.totalUsdgIdle() + daily.usdgDust(), "usdg tight");
    }

    // ------------------------------------------------------------------
    // (d) the remove fallback: setPlanBoost(false) -> withdrawIdle(MAX) -> claim(MAX) -> prunePlan
    // ------------------------------------------------------------------

    /// @dev One leg per block, like the wallet sends them. The unboost realises the boosted value (interest to
    ///      that block) into `usdgIdle`, which earns nothing more, so the later withdraw(MAX) takes all of it.
    function test_removeFallback_leavesNothing() public {
        uint256 id = _mixedBoostedPlan(alice);
        Plan memory p = daily.getPlan(id);
        uint256 idle = p.usdgIdle;
        uint256 stock = p.stockAccrued;
        uint256 usdgBefore = usdg.balanceOf(alice);

        vm.warp(block.timestamp + POLL);
        uint256 value = _boostValue(daily, id);
        vm.prank(alice);
        daily.setPlanBoost(id, false);
        assertEq(daily.getPlan(id).usdgIdle, idle + value, "boosted value, interest included, now idle");
        assertEq(daily.getPlan(id).boostShares, 0);

        vm.warp(block.timestamp + 12);
        vm.prank(alice);
        daily.withdrawIdle(id, MAX);
        vm.warp(block.timestamp + 12);
        vm.prank(alice);
        daily.claim(id, MAX);
        vm.warp(block.timestamp + 12);
        daily.prunePlan(id);

        uint256 out = idle + value;
        assertEq(usdg.balanceOf(alice) - usdgBefore, out - _fee(out, WITHDRAW_FEE_BPS));
        assertEq(nvda.balanceOf(alice), stock - _fee(stock, CLAIM_FEE_BPS));
        _assertEmpty(daily, id);
        assertFalse(_isIndexed(daily, id));
        assertEq(daily.totalBoostShares(), 0);
    }

    // ------------------------------------------------------------------
    // (e) H4: several boosted plans — an exit takes nothing from anyone else (bar 1 raw unit of rounding)
    // ------------------------------------------------------------------

    /// @dev Three owners on the daily vault plus one on the weekly vault (the strategy is shared by every
    ///      vault). Each exit is checked in its own block: every OTHER plan's value is >= before, the sum of
    ///      values never exceeds the pool, and the unowned gap stays within `plans + share price` raw units.
    function test_threePlans_exitsNeverTakeFromOthers() public {
        uint256[3] memory ids;
        ids[0] = _createBoostedPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        ids[1] = _createBoostedPlan(daily, bob, address(aapl), 100e6, 25_000_123_457);
        ids[2] = _createBoostedPlan(daily, carol, address(nvda), 100e6, 12_500_001);
        uint256 weeklyId = _createBoostedPlan(weekly, carol, address(aapl), 100e6, 3_333_333_333);
        vm.warp(block.timestamp + 45 days);

        uint256 maxGap = _gap(daily);
        for (uint256 step; step < 5; ++step) {
            vm.warp(block.timestamp + POLL);
            uint256[3] memory before;
            for (uint256 i; i < 3; ++i) {
                before[i] = _boostValue(daily, ids[i]);
            }
            uint256 weeklyBefore = _boostValue(weekly, weeklyId);
            uint256 actor;
            if (step == 0) {
                // alice: an explicit amount 20 raw units short (about one poll of interest on 1,000 USDG)
                actor = 0;
                vm.prank(alice);
                daily.withdrawIdle(ids[0], before[0] - 20);
            } else if (step == 1) {
                actor = 1;
                vm.prank(bob);
                daily.withdrawIdle(ids[1], 12_345_678_901);
            } else if (step == 2) {
                actor = 2;
                vm.prank(carol);
                daily.closePlan(ids[2]);
            } else if (step == 3) {
                actor = 0;
                vm.prank(alice);
                daily.withdrawIdle(ids[0], MAX);
            } else {
                actor = 1;
                vm.prank(bob);
                daily.closePlan(ids[1]);
            }
            for (uint256 i; i < 3; ++i) {
                if (i != actor) assertGe(_boostValue(daily, ids[i]), before[i], "another plan lost value");
            }
            assertGe(_boostValue(weekly, weeklyId), weeklyBefore, "another vault's plan lost value");
            uint256 g = _gap(daily);
            if (g > maxGap) maxGap = g;
            uint256 price = (daily.boostAssets() + 1) / (daily.totalBoostShares() + 1);
            assertLe(g, 3 + price, "gap <= plans + share price");
        }
        console2.log("max unowned gap on the daily pool (raw units)", maxGap);
        assertEq(daily.totalBoostShares(), 0, "every daily boosted plan has exited");
    }

    /// @dev H4, fuzzed (20,000 runs clean at this bound): a withdrawal (explicit or MAX) or close by one plan
    ///      lowers another plan's value — same vault, or another vault on the same strategy — by at most 1 raw
    ///      unit, and grows the unowned gap by at most 2.
    function testFuzz_exitCostsOtherPlansAtMostOneRawUnit(
        uint128 depA,
        uint128 depB,
        uint128 depC,
        uint32 age,
        uint128 wd,
        uint8 how
    ) public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 100e6, bound(depA, 10e6, 1_000_000e6));
        uint256 b = _createBoostedPlan(daily, bob, address(aapl), 100e6, bound(depB, 10e6, 1_000_000e6));
        uint256 c = _createBoostedPlan(weekly, carol, address(aapl), 100e6, bound(depC, 10e6, 1_000_000e6));
        vm.warp(block.timestamp + bound(age, 0, 365 days));
        uint256 vb = _boostValue(daily, b);
        uint256 vc = _boostValue(weekly, c);
        uint256 gapBefore = _gap(daily);
        uint256 mode = how % 3;
        vm.startPrank(alice);
        if (mode == 0) daily.withdrawIdle(a, bound(wd, 1, _boostValue(daily, a)));
        else if (mode == 1) daily.withdrawIdle(a, MAX);
        else daily.closePlan(a);
        vm.stopPrank();
        assertGe(_boostValue(daily, b) + 1, vb, "same-vault plan loses at most 1 raw unit");
        assertGe(_boostValue(weekly, c) + 1, vc, "other-vault plan loses at most 1 raw unit");
        assertLe(_gap(daily), gapBefore + 2, "an exit adds at most 2 raw units to the unowned gap");
    }

    /// @dev KNOWN, 1 raw unit: the fuzz above found that an exit CAN lower another plan's value by 1 raw unit
    ///      (1e-6 USDG). A full exit burns exactly the plan's shares and pays it exactly their value, but pulling
    ///      that out of the strategy cost the vault's position one unit more (MorphoBlueStrategy / Morpho round a
    ///      withdrawal against the withdrawer — here the vault — and the position's value floors), so the plans
    ///      that stay carry that unit. Rounding only; orders of magnitude below the dust the testers saw.
    function test_KNOWN_exitCanCostAnotherPlanOneRawUnit() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 100e6, 999_990_000_100);
        uint256 b = _createBoostedPlan(daily, bob, address(aapl), 100e6, 999_990_000_006);
        _createBoostedPlan(weekly, carol, address(aapl), 100e6, 999_990_000_025); // same strategy, other vault
        vm.warp(block.timestamp + 3);
        uint256 poolBefore = daily.boostAssets();
        uint256 va = _boostValue(daily, a);
        uint256 vb = _boostValue(daily, b);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        daily.closePlan(a);
        assertEq(usdg.balanceOf(alice) - before, va - _fee(va, WITHDRAW_FEE_BPS), "alice got exactly her value");
        assertEq(poolBefore - daily.boostAssets(), va + 1, "the strategy withdrawal cost the pool one unit more");
        assertEq(_boostValue(daily, b) + 1, vb, "bob carries that unit");
        console2.log("bob before / after (raw units)", vb, _boostValue(daily, b));
    }

    // ------------------------------------------------------------------
    // (f) the last boosted plan exits
    // ------------------------------------------------------------------

    /// @dev What stays in the vault's strategy position once no plan holds a share: the pool's rounding gap (a
    ///      raw unit or two). No plan can withdraw it, a later boosted plan does not absorb it (it stays with the
    ///      virtual share), and it keeps earning. The owner can recover it only by clearing the strategy while
    ///      nothing is boosted, after which the strategy shares are an ordinary rescuable token.
    function test_lastBoostedPlanExits_remainderStaysInTheVaultPosition() public {
        uint256 a = _createBoostedPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        uint256 b = _createBoostedPlan(daily, bob, address(aapl), 100e6, 7_777_777_777);
        vm.warp(block.timestamp + 90 days);
        uint256 amount = _boostValue(daily, a) - 1_000; // leaves a small explicit-amount residual
        vm.prank(alice);
        daily.withdrawIdle(a, amount);
        vm.warp(block.timestamp + POLL);
        vm.prank(bob);
        daily.closePlan(b);
        vm.prank(alice);
        daily.closePlan(a);

        assertEq(daily.totalBoostShares(), 0);
        uint256 remainder = daily.boostAssets();
        uint256 held = strategy.balanceOf(address(daily));
        console2.log("left in the daily vault's strategy position (raw units)", remainder);
        console2.log("  as strategy shares", held);
        assertLe(remainder, 3, "a few raw units of rounding, never a plan's balance");

        // a new boosted plan: its value is its deposit (to rounding); the remainder stays unowned
        uint256 c = _createBoostedPlan(daily, carol, address(nvda), 100e6, 500e6);
        assertApproxEqAbs(_boostValue(daily, c), 500e6, 1);
        assertLe(_boostValue(daily, c), 500e6 + 1, "the next plan does not pick the remainder up");
        vm.prank(carol);
        daily.closePlan(c);
        assertEq(daily.totalBoostShares(), 0);
        assertLe(daily.boostAssets(), remainder + 2);

        // owner-only recovery: clear the strategy (allowed with no shares), then the shares are rescuable
        held = strategy.balanceOf(address(daily));
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.TokenNotRescuable.selector, address(strategy)));
        daily.rescueERC20(address(strategy), owner, held);
        daily.setBoostStrategy(address(0));
        daily.rescueERC20(address(strategy), owner, held);
        uint256 got = strategy.previewRedeem(held) == 0 ? 0 : strategy.redeem(held, owner, owner);
        vm.stopPrank();
        console2.log("owner recovered (raw units)", got);
        assertLe(got, 3);
    }

    // ------------------------------------------------------------------
    // (g) boost shares worth nothing
    // ------------------------------------------------------------------

    /// @dev Shares whose value floors to 0 need a share price well below 1, i.e. bad debt (the no-loss fuzz below
    ///      never produced one). With `usdgIdle == 0` too, `withdrawIdle(MAX)` resolves to
    ///      0 and reverts `ZeroAmount`, the web shows $0.00 (`looksEmpty`) but `prunePlan` reverts
    ///      `PlanNotEmpty`; `setPlanBoost(false)` and `closePlan` both burn them. They hold no value, so nothing
    ///      is lost either way.
    function test_worthlessShares_clearedByUnboostOrClose() public {
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        vm.warp(block.timestamp + 1 days);
        uint256 amount = _boostValue(daily, id) - 2; // a few shares survive
        vm.prank(alice);
        daily.withdrawIdle(id, amount);
        morpho.mockLoss(marketId, (morpho.market(marketId).totalBorrowAssets * 99) / 100); // price falls below 1
        Plan memory p = daily.getPlan(id);
        assertGt(p.boostShares, 0);
        assertEq(p.usdgIdle, 0);
        assertEq(_boostValue(daily, id), 0, "worth nothing");
        assertEq(_shown(daily, alice, id), 0, "the web shows $0.00");

        vm.prank(alice);
        vm.expectRevert(IPlanVault.ZeroAmount.selector);
        daily.withdrawIdle(id, MAX);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.PlanNotEmpty.selector, id));
        daily.prunePlan(id);

        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        daily.setPlanBoost(id, false);
        assertEq(daily.getPlan(id).boostShares, 0, "unboost burns them");
        assertEq(daily.getPlan(id).usdgIdle, 0, "for nothing");
        daily.prunePlan(id);
        vm.revertToState(snap);

        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        daily.closePlan(id);
        _assertEmpty(daily, id);
        assertFalse(_isIndexed(daily, id), "closePlan clears and drops it");
        assertEq(usdg.balanceOf(alice), before, "nothing to pay");
        assertEq(daily.totalBoostShares(), 0);
    }

    /// @dev Without bad debt, a near-full explicit withdrawal (the value minus 1-5 raw units, the region a stale
    ///      Max lands in) never leaves shares worth 0 — even in the deposit block, where the pool can be
    ///      credited a unit short and the share price sits just under 1. Such a remainder is therefore always
    ///      reachable with `withdrawIdle(MAX)`.
    function testFuzz_noLoss_nearFullWithdrawLeavesWithdrawableShares(uint32 pre, uint128 dep, uint8 short, uint32 gap)
        public
    {
        vm.warp(block.timestamp + bound(pre, 0, 30 days)); // Morpho's share price need not be round
        uint256 id = _createBoostedPlan(daily, alice, address(nvda), 100e6, bound(dep, 10e6, 1_000_000e6));
        vm.warp(block.timestamp + bound(gap, 0, 1 days)); // 0 = the deposit block itself
        uint256 amount = _boostValue(daily, id) - bound(short, 1, 5);
        vm.prank(alice);
        daily.withdrawIdle(id, amount);
        if (daily.getPlan(id).boostShares == 0) return;
        assertGt(_boostValue(daily, id), 0, "surviving shares are worth at least a raw unit");
        vm.prank(alice);
        daily.withdrawIdle(id, MAX);
        assertEq(daily.getPlan(id).boostShares, 0);
    }
}
