// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";
import {BaseTest} from "../BaseTest.sol";
import {HourlyVault} from "../../src/vault/HourlyVault.sol";
import {EpochKeeper} from "../../src/keeper/EpochKeeper.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {IPlanVault} from "../../src/interfaces/IPlanVault.sol";
import {FeeConfig, VaultParams} from "../../src/vault/VaultTypes.sol";

/// @dev The hourly vault is plain PlanVault with a 1-hour epoch and the 90 bps default fee. Mirrors TestVault.t.sol:
///      what the scheduler and the deploy script rely on — origin aligned to the top of the hour, `isEpochDue`
///      flipping at each of the 24 boundaries in a day, the keeper job path, missed hours skipped — plus the two
///      hourly-specific facts: the default fee IS the inclusive cap (cannot be raised, perk holders pay 45) and the
///      fee key the production deploy reads from config/fees.json exists.
contract HourlyVaultTest is BaseTest {
    using stdJson for string;

    uint32 internal constant EPOCH = 1 hours;

    HourlyVault internal hv;
    EpochKeeper internal k;
    address internal bot = makeAddr("bot");

    /// @dev Where `hv` is created: T0 (14:00:00 UTC, on the hour) + 37 minutes, so the aligned origin (T0) differs
    ///      from the creation time, unlike the fixture's `hourly` which was created exactly on the hour.
    uint256 internal constant CREATED_AT = T0 + 37 minutes;

    function setUp() public override {
        super.setUp();
        vm.warp(CREATED_AT);
        // Origin from the constant, not `EpochLib.alignToHour(block.timestamp)`: the via-IR optimizer treats
        // TIMESTAMP as invariant within a call frame (true on a real chain), so after `vm.warp` in the same frame
        // as `super.setUp()` it reuses the `block.timestamp % 1 hours` computed there for the fixture (= 0) and the
        // origin would silently come out unaligned. Every test below that warps and then needs the aligned value
        // passes the warped-to timestamp explicitly for the same reason. test_params pins the equivalence.
        hv = new HourlyVault(_params(EpochLib.alignToHour(CREATED_AT)));
        k = new EpochKeeper(address(usdg), owner);
        vm.startPrank(owner);
        hv.setPriceGuard(300, false, address(0), 0); // price guard has its own suite (PlanVault.PriceGuard.t.sol)
        hv.setKeeper(address(k), true);
        k.addJob(address(hv), address(nvda));
        k.setOperator(bot, true);
        vm.stopPrank();
        vm.prank(alice);
        usdg.approve(address(hv), type(uint256).max);
    }

    function _params(uint64 origin) internal view returns (VaultParams memory) {
        return VaultParams({
            owner: owner,
            usdg: address(usdg),
            weth: address(weth),
            dca: address(dca),
            registry: address(registry),
            router: address(router),
            feeRecipient: treasury,
            epochLength: 0,
            origin: origin,
            purchaseFeeBps: 0
        });
    }

    // ------------------------------------------------------------------
    // Parameters (AC1)
    // ------------------------------------------------------------------

    function test_params() public view {
        assertEq(hv.epochLength(), 3_600);
        assertEq(hv.EPOCH_LENGTH(), EPOCH);
        assertEq(hv.vaultKind(), "hourly");
        assertEq(hv.fees().purchaseFeeBps, 90);
        assertEq(hv.DEFAULT_PURCHASE_FEE_BPS(), 90);
        assertEq(hv.origin() % EPOCH, 0, "origin aligned to the top of the hour");
        assertEq(hv.origin(), T0, "14:37 aligns down to 14:00");
        assertEq(hv.origin(), EpochLib.alignToHour(CREATED_AT));
        assertLt(CREATED_AT - hv.origin(), EPOCH, "created inside epoch 0");
        assertEq(hv.currentEpochId(), 0);
        assertEq(hv.nextEpochStart(), uint256(hv.origin()) + EPOCH);
        assertEq(hv.nextEpochStart(), T0 + 1 hours, "first fire at 15:00");
        // the shared fixture's instance is the same contract, created on the hour
        assertEq(hourly.epochLength(), 3_600);
        assertEq(hourly.vaultKind(), "hourly");
        assertEq(hourly.fees().purchaseFeeBps, 90);
        assertEq(hourly.origin(), T0);
    }

    /// The remaining fee config is PlanVault's shared default, exactly as on the other vaults.
    function test_otherFeesMatchTheOtherVaults() public view {
        FeeConfig memory f = hv.fees();
        FeeConfig memory d = daily.fees();
        assertEq(f.depositFeeBps, d.depositFeeBps);
        assertEq(f.withdrawFeeBps, d.withdrawFeeBps);
        assertEq(f.claimFeeBps, d.claimFeeBps);
        assertEq(f.keeperTipBps, d.keeperTipBps);
        assertEq(f.swapSlippageBps, d.swapSlippageBps);
        assertEq(hv.minAmountPerEpoch(), 10e6, "same 10 USDG per-buy minimum: >= 7,200 USDG per 30 days");
        assertEq(hv.minDeposit(), 10e6);
    }

    // ------------------------------------------------------------------
    // Fee tier sits on the inclusive cap
    // ------------------------------------------------------------------

    function test_defaultFeeIsTheCap_cannotBeRaised() public {
        assertEq(hv.DEFAULT_PURCHASE_FEE_BPS(), FeeMath.MAX_FEE_BPS, "90 bps == the inclusive cap");
        FeeConfig memory f = hv.fees();
        f.purchaseFeeBps = 90;
        vm.prank(owner);
        hv.setFees(f); // re-setting the cap value is fine (Deploy.s.sol does exactly this from fees.json)
        assertEq(hv.fees().purchaseFeeBps, 90);
        f.purchaseFeeBps = 91;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(FeeMath.FeeTooHigh.selector, 91, 90));
        hv.setFees(f);
        // lowering is always possible; raising back to 90 too, but never above
        f.purchaseFeeBps = 60;
        vm.prank(owner);
        hv.setFees(f);
        assertEq(hv.fees().purchaseFeeBps, 60);
    }

    /// Full fee: 200 USDG x 0.90% = 1.8 USDG, net 198.2. Perk holder: halved to 45 bps = 0.9 USDG, net 199.1,
    /// and (100k $DCA also clears the auto-distribute threshold) the stock lands in the wallet with no claim fee.
    function test_fill_fullFeeAndPerkHalfFee() public {
        uint256 a = _createUsdgPlan(hv, alice, address(nvda), 200e6, 1_000e6);
        _fund(bob);
        vm.prank(bob);
        usdg.approve(address(hv), type(uint256).max);
        _giveDca(bob, 100_000);
        uint256 b = _createUsdgPlan(hv, bob, address(nvda), 200e6, 1_000e6);
        assertEq(hv.effectivePurchaseFeeBps(alice), 90);
        assertEq(hv.effectivePurchaseFeeBps(bob), 45, "perk holders pay bps / 2");

        vm.warp(hv.nextEpochStart());
        vm.prank(bot);
        assertTrue(k.run(0, 0, ""));

        assertEq(hv.getPlan(a).stockAccrued, _nvdaFor(198.2e6), "alice: 90 bps");
        assertEq(hv.getPlan(a).usdgIdle, 800e6);
        assertEq(hv.getPlan(b).stockAccrued, 0, "bob: auto-distributed");
        assertEq(nvda.balanceOf(bob), _nvdaFor(199.1e6), "bob: 45 bps, delivered to wallet");
        assertEq(usdg.balanceOf(treasury), 1.8e6 + 0.9e6, "both purchase fees");
    }

    // ------------------------------------------------------------------
    // Scheduling (AC2, AC3)
    // ------------------------------------------------------------------

    /// 24 consecutive boundaries in a day: not due one second early, due at hh:00:00, not due once run.
    function test_epochDueAtEveryOfThe24Boundaries() public {
        _createUsdgPlan(hv, alice, address(nvda), 100e6, 10_000e6);
        assertFalse(hv.isEpochDue(address(nvda)), "epoch 0 never executes");

        for (uint32 e = 1; e <= 24; ++e) {
            uint256 boundary = hv.nextEpochStart();
            assertEq(boundary % 1 hours, 0, "fires on the hour");
            assertEq(boundary, T0 + e * 1 hours, "one boundary per hour from the origin");
            vm.warp(boundary - 1);
            assertFalse(hv.isEpochDue(address(nvda)));
            vm.warp(boundary);
            assertEq(hv.currentEpochId(), e);
            assertTrue(hv.isEpochDue(address(nvda)));

            uint256[] memory due = k.dueJobs();
            assertEq(due.length, 1);
            vm.prank(bot);
            assertTrue(k.run(due[0], 0, ""));
            assertFalse(hv.isEpochDue(address(nvda)));
            assertEq(hv.lastExecutedEpoch(address(nvda)), e);
        }
        assertEq(hv.epochsCompleted(), 24);
        assertEq(hv.getPlan(1).usdgIdle, 10_000e6 - 24 * 100e6, "one buy per hour, 24 in the day");
        assertEq(hv.nextEpochStart(), T0 + 25 hours, "a full day passed");
    }

    function test_missedEpochsAreSkippedNotCaughtUp() public {
        _createUsdgPlan(hv, alice, address(nvda), 100e6, 10_000e6);
        vm.warp(hv.nextEpochStart() + 10 * EPOCH); // scheduler was down for ten hours
        assertEq(hv.currentEpochId(), 11);
        vm.prank(bot);
        k.run(0, 0, "");
        assertEq(hv.getPlan(1).usdgIdle, 10_000e6 - 100e6, "charged once, not eleven times");
        assertEq(hv.lastExecutedEpoch(address(nvda)), 11);
        uint32 cur = hv.currentEpochId();
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(IPlanVault.EpochNotDue.selector, address(nvda), cur));
        k.run(0, 0, "");
    }

    /// An `alignToHour` origin satisfies `origin <= now < origin + 1 hours` anywhere inside the hour — including
    /// the very last second — so a vault built with it never reverts `BadOrigin` (AC2).
    function test_alignToHourOrigin_neverBadOrigin() public {
        uint256[3] memory offsets = [uint256(0), 30 minutes, 59 minutes + 59 seconds];
        for (uint256 i; i < offsets.length; ++i) {
            uint256 at = T0 + 3 hours + offsets[i];
            vm.warp(at);
            HourlyVault v = new HourlyVault(_params(EpochLib.alignToHour(at)));
            assertEq(v.origin(), T0 + 3 hours);
            assertEq(v.currentEpochId(), 0);
            assertEq(v.nextEpochStart(), T0 + 4 hours);
        }
    }

    /// The deploy window: a top-of-hour origin computed in the PREVIOUS hour is rejected, which is why the deploy
    /// scripts create the hourly vault first.
    function test_badOriginReverts_originFromThePreviousHour() public {
        // now is 14:37; an origin of 13:00 puts "now" in epoch 1, not epoch 0
        uint64 lastHour = EpochLib.alignToHour(CREATED_AT) - EPOCH;
        assertEq(lastHour, T0 - 1 hours);
        vm.expectRevert(IPlanVault.BadOrigin.selector);
        new HourlyVault(_params(lastHour));
        // computed at 14:59:59 but mined at 15:00:00 -> BadOrigin
        uint256 lastSecond = T0 + 59 minutes + 59 seconds;
        uint64 origin = EpochLib.alignToHour(lastSecond);
        assertEq(origin, T0);
        vm.warp(lastSecond + 1);
        vm.expectRevert(IPlanVault.BadOrigin.selector);
        new HourlyVault(_params(origin));
        // one second earlier it would have been fine
        vm.warp(lastSecond);
        new HourlyVault(_params(origin));
        // a future origin is rejected too
        vm.expectRevert(IPlanVault.BadOrigin.selector);
        new HourlyVault(_params(uint64(lastSecond + 1)));
    }

    /// Hourly and daily epochs interleave as expected: after one hour only the hourly vault is due; at midnight both.
    function test_hourlyAndDaily_interleave() public {
        _createUsdgPlan(hv, alice, address(nvda), 100e6, 10_000e6);
        _createUsdgPlan(daily, alice, address(nvda), 100e6, 10_000e6);
        vm.warp(hv.nextEpochStart()); // 15:00
        assertTrue(hv.isEpochDue(address(nvda)));
        assertFalse(daily.isEpochDue(address(nvda)));
        uint256 midnight = daily.nextEpochStart(); // 00:00 next day = also an hourly boundary
        assertEq(midnight, T0 + 10 hours);
        assertEq(midnight % 1 hours, 0);
        vm.warp(midnight);
        assertTrue(hv.isEpochDue(address(nvda)));
        assertTrue(daily.isEpochDue(address(nvda)));
        assertEq(hv.currentEpochId(), 10, "14:00 origin -> 00:00 is epoch 10");
        assertEq(daily.currentEpochId(), 1);
    }

    // ------------------------------------------------------------------
    // Config the production deploy reads (AC7)
    // ------------------------------------------------------------------

    /// `Deploy.s.sol` applies fees by exact JSON key (`readUint`, no default): a missing `hourlyPurchaseFeeBps`
    /// would revert the whole script. Pin the key, its value and that the value is accepted by `setFees`.
    function test_feesJson_hasHourlyKeyAtTheCap() public {
        string memory json = vm.readFile("config/fees.json");
        uint256 bps = json.readUint(".hourlyPurchaseFeeBps");
        assertEq(bps, 90);
        assertEq(bps, FeeMath.MAX_FEE_BPS);
        assertEq(json.readUint(".maxFeeBps"), FeeMath.MAX_FEE_BPS, "config cap matches the library cap");
        FeeConfig memory f = hv.fees();
        f.purchaseFeeBps = uint16(bps);
        vm.prank(owner);
        hv.setFees(f);
        assertEq(hv.fees().purchaseFeeBps, 90);
    }
}
