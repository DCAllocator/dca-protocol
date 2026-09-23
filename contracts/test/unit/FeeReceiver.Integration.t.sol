// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "../BaseTest.sol";
import {FeeReceiver} from "../../src/treasury/FeeReceiver.sol";
import {FeeConfig} from "../../src/vault/VaultTypes.sol";
import {FeeMath} from "../../src/libraries/FeeMath.sol";
import {MockOraclePool} from "../mocks/FeeReceiverMocks.sol";

/// @dev End to end on the shared fixture: the Daily vault's `feeRecipient` is a FeeReceiver; every fee path of the
///      vault (purchase, deposit, withdraw, claim, dust) lands there, gets split 70/30, and the 30% ends up as
///      burned $DCA. Also pins that a contract recipient changes nothing for users (claims / withdrawals go through).
contract FeeReceiverIntegrationTest is BaseTest {
    FeeReceiver internal fr;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public override {
        super.setUp();
        // The mock router pays swaps by minting the output token, so it must be able to mint mDCA.
        vm.prank(owner);
        dca.transferOwnership(address(router));
        router.setRate(address(usdg), address(dca), 1e18, 1e6); // 1 USDG = 1 DCA
        router.setRate(address(nvda), address(usdg), 500e6, 1e18);
        router.setRate(address(weth), address(dca), 3000e18, 1e18); // 1 WETH = 3000 DCA
        // Buyback routes name a V3-style pool so the receiver's on-path price guard (on by default) can read it.
        MockOraclePool pool = new MockOraclePool(address(dca), address(usdg));
        router.setPathExtra(address(usdg), address(dca), abi.encode(address(pool)));
        router.setPathExtra(address(weth), address(dca), abi.encode(address(pool)));
        router.setPathExtra(address(nvda), address(usdg), abi.encode(address(pool)));

        fr = new FeeReceiver(address(usdg), address(weth), address(dca), address(router), treasury, owner);
        vm.startPrank(owner);
        daily.setFeeRecipient(address(fr));
        FeeConfig memory f = daily.fees();
        f.depositFeeBps = 10; // so WETH deposits produce a WETH fee too
        daily.setFees(f);
        vm.stopPrank();
    }

    function test_vaultFeesFlowThroughReceiverToTreasuryAndBurn() public {
        // 1. USDG plan: 10 bps deposit fee on creation, then the purchase fee (75 bps daily) on the epoch spend
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        uint256 createFee = FeeMath.feeOf(1_000e6, 10);
        assertEq(usdg.balanceOf(address(fr)), createFee, "deposit fee landed on the receiver");
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 purchaseFee = FeeMath.feeOf(100e6, 75);
        assertEq(usdg.balanceOf(address(fr)), createFee + purchaseFee, "purchase fee landed on the receiver");

        // 2. WETH deposit: 10 bps deposit fee in WETH
        vm.prank(alice);
        daily.depositWETH(id, 1e18, 0);
        uint256 wethFee = FeeMath.feeOf(1e18, 10);
        assertEq(weth.balanceOf(address(fr)), wethFee);

        // 3. Claim: 25 bps claim fee in NVDA (alice holds no $DCA -> no auto-distribute)
        uint256 accrued = _plan(daily, id).stockAccrued;
        assertGt(accrued, 0);
        vm.prank(alice);
        daily.claim(id, type(uint256).max);
        uint256 claimFee = FeeMath.feeOf(accrued, 25);
        assertEq(nvda.balanceOf(address(fr)), claimFee, "claim fee in stock landed on the receiver");

        // 4. Withdraw: 25 bps withdraw fee in USDG
        uint256 idle = _plan(daily, id).usdgIdle;
        vm.prank(alice);
        daily.withdrawIdle(id, idle);
        uint256 withdrawFee = FeeMath.feeOf(idle, 25);
        uint256 usdgFees = createFee + purchaseFee + withdrawFee;
        assertEq(usdg.balanceOf(address(fr)), usdgFees);

        // Vault accounting is untouched by where fees go.
        assertEq(usdg.balanceOf(address(daily)), daily.totalUsdgIdle() + daily.usdgDust());

        // 5. Split everything 70/30
        address[] memory toks = new address[](3);
        toks[0] = address(usdg);
        toks[1] = address(weth);
        toks[2] = address(nvda);
        vm.prank(owner);
        fr.distributeMany(toks);
        assertEq(usdg.balanceOf(treasury), FeeMath.feeOf(usdgFees, 7_000));
        assertEq(weth.balanceOf(treasury), FeeMath.feeOf(wethFee, 7_000));
        assertEq(nvda.balanceOf(treasury), FeeMath.feeOf(claimFee, 7_000));
        uint256 usdgReserve = usdgFees - FeeMath.feeOf(usdgFees, 7_000);
        uint256 wethReserve = wethFee - FeeMath.feeOf(wethFee, 7_000);
        uint256 nvdaReserve = claimFee - FeeMath.feeOf(claimFee, 7_000);
        assertEq(fr.buybackReserve(address(usdg)), usdgReserve);
        assertEq(fr.buybackReserve(address(weth)), wethReserve);
        assertEq(fr.buybackReserve(address(nvda)), nvdaReserve);

        // 6. Stock reserve -> USDG reserve, then everything -> $DCA -> burned (mDCA has no burn(): dead address)
        vm.startPrank(owner);
        (, uint256 usdgFromNvda) = fr.convert(address(nvda), address(usdg), type(uint256).max, 0);
        fr.buyback(address(usdg), type(uint256).max, 0);
        fr.buyback(address(weth), type(uint256).max, 0);
        vm.stopPrank();

        uint256 expectedBurn = (usdgReserve + usdgFromNvda) * 1e12 + wethReserve * 3000; // 1 WETH = 3000 USDG = 3000 DCA
        assertEq(fr.totalBurned(), expectedBurn);
        assertEq(dca.balanceOf(DEAD), expectedBurn);
        assertEq(fr.buybackReserve(address(usdg)), 0);
        assertEq(fr.buybackReserve(address(weth)), 0);
        assertEq(fr.buybackReserve(address(nvda)), 0);
        assertEq(usdg.balanceOf(address(fr)), 0);
        assertEq(weth.balanceOf(address(fr)), 0);
        assertEq(nvda.balanceOf(address(fr)), 0);
        assertEq(dca.balanceOf(address(fr)), 0);
    }

    function test_contractRecipientDoesNotBlockUserExits() public {
        uint256 id = _createUsdgPlan(daily, alice, address(nvda), 100e6, 1_000e6);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        vm.startPrank(alice);
        daily.claim(id, type(uint256).max);
        daily.withdrawIdle(id, type(uint256).max);
        vm.stopPrank();
        assertGt(usdg.balanceOf(address(fr)), 0);
        assertGt(nvda.balanceOf(address(fr)), 0);
    }

    function test_forceSweepDustLandsOnReceiver() public {
        // Three plans with odd amounts leave USDG rounding dust after a partial fill; the owner can force-sweep it.
        _createUsdgPlan(daily, alice, address(nvda), 33e6, 1_000e6);
        _createUsdgPlan(daily, bob, address(nvda), 33e6, 1_000e6);
        _createUsdgPlan(daily, carol, address(nvda), 33e6, 1_000e6);
        router.setFill(address(usdg), address(nvda), 3_333);
        _nextEpoch(daily);
        _advance(daily, address(nvda));
        uint256 before = usdg.balanceOf(address(fr));
        vm.prank(owner);
        daily.sweepDust();
        assertGe(usdg.balanceOf(address(fr)), before);
        assertEq(daily.usdgDust(), 0);
    }
}
