// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeReceiver} from "../../src/treasury/FeeReceiver.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {BurnableDCA, MockOraclePool} from "../mocks/FeeReceiverMocks.sol";

/// @dev Random walk over one FeeReceiver: fees land in four tokens (including $DCA itself and raw ETH), the
///      operator distributes / converts / buys back in random sizes with random partial fills. Ghost counters record
///      what every call reported so the invariants can check the contract's books against them.
contract FeeReceiverHandler is Test {
    FeeReceiver public fr;
    MockERC20 public usdg;
    MockWETH public weth;
    BurnableDCA public dca;
    MockERC20 public nvda;
    MockRouter public router;
    MockOraclePool public pool;
    address public operator;
    address public treasury;
    address[] public tokens;
    uint256 public guardBlocks; // swaps refused by the price guard

    uint256 public calls;
    uint256 public distributes;
    uint256 public buybacks;
    uint256 public converts;
    mapping(address => uint256) public ghostToTreasury;
    mapping(address => uint256) public ghostToReserve;
    mapping(address => uint256) public ghostReserveOut; // reserve spent by buyback/convert
    mapping(address => uint256) public ghostReserveIn; // reserve credited by convert (and hop-2 refunds: none here)
    uint256 public ghostBurned;
    uint256 public ghostDcaMinted; // DCA the router minted into the receiver (all of it must be burned)
    uint256 public ghostDcaFees; // DCA that arrived as a fee

    constructor(
        FeeReceiver _fr,
        MockERC20 _usdg,
        MockWETH _weth,
        BurnableDCA _dca,
        MockERC20 _nvda,
        MockRouter _router,
        MockOraclePool _pool,
        address _operator,
        address _treasury
    ) {
        fr = _fr;
        pool = _pool;
        usdg = _usdg;
        weth = _weth;
        dca = _dca;
        nvda = _nvda;
        router = _router;
        operator = _operator;
        treasury = _treasury;
        tokens.push(address(usdg));
        tokens.push(address(weth));
        tokens.push(address(nvda));
        tokens.push(address(dca));
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function _tok(uint256 seed) internal view returns (address) {
        return tokens[seed % tokens.length];
    }

    // ---- actions ----

    function feeArrives(uint256 seed, uint96 amount) external {
        calls++;
        address t = _tok(seed);
        if (amount == 0) return;
        MockERC20(t).mint(address(fr), amount);
        if (t == address(dca)) ghostDcaFees += amount;
    }

    function ethArrives(uint96 amount) external {
        calls++;
        if (amount == 0) return;
        vm.deal(address(this), amount);
        (bool ok,) = address(fr).call{value: amount}("");
        require(ok);
        fr.wrapEth();
    }

    function distribute(uint256 seed) external {
        calls++;
        address t = _tok(seed);
        uint256 pendingBefore = fr.pending(t);
        if (pendingBefore == 0) return;
        vm.prank(operator);
        (uint256 toT, uint256 toB) = fr.distribute(t);
        assertEq(toT + toB, pendingBefore, "split is exact");
        assertEq(toT, (pendingBefore * 7_000) / 10_000, "treasury share is floor(70%)");
        ghostToTreasury[t] += toT;
        ghostToReserve[t] += toB;
        distributes++;
    }

    function setFill(uint256 seed, uint16 bps) external {
        calls++;
        bps = uint16(bound(bps, 1_000, 10_000));
        address t = _tok(seed);
        if (t == address(dca)) return;
        router.setFill(t, address(dca), bps);
        if (t == address(nvda)) router.setFill(t, address(usdg), bps);
    }

    /// Push the pool's spot tick around its (fixed, 0) TWAP: inside or outside the guard's tolerance.
    function setSpot(int24 spot) external {
        calls++;
        spot = int24(bound(int256(spot), -600, 600));
        pool.setTicks(spot, 0);
    }

    function _deviated() internal view returns (bool) {
        int256 dev = int256(pool.spotTick());
        if (dev < 0) dev = -dev;
        return uint256(dev) > fr.guardMaxTicks();
    }

    function _deviationError() internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            FeeReceiver.PriceDeviates.selector, address(pool), pool.spotTick(), int24(0), fr.guardMaxTicks()
        );
    }

    function buyback(uint256 seed, uint96 amount) external {
        calls++;
        address t = _tok(seed);
        uint256 r = fr.buybackReserve(t);
        if (r == 0) return;
        uint256 amt = bound(amount, 1, r);
        if (t != address(dca)) {
            (uint256 q,) = router.quote(t, address(dca), amt);
            if ((q * (10_000 - fr.maxSlippageBps())) / 10_000 == 0) return;
            if (_deviated()) {
                // a pushed pool blocks every reserve outflow, whatever the operator asks for
                bytes memory err = _deviationError();
                vm.expectRevert(err);
                vm.prank(operator);
                fr.buyback(t, amt, 0);
                guardBlocks++;
                return;
            }
        }
        uint256 dcaBefore = dca.balanceOf(address(fr));
        vm.prank(operator);
        (uint256 spent, uint256 burned) = fr.buyback(t, amt, 0);
        assertLe(spent, amt, "never spends more than asked");
        // bought DCA never lingers; a DCA-reserve burn takes exactly `burned` off the balance
        assertEq(dca.balanceOf(address(fr)), t == address(dca) ? dcaBefore - burned : dcaBefore, "no lingering DCA");
        ghostReserveOut[t] += spent;
        ghostBurned += burned;
        if (t != address(dca)) ghostDcaMinted += burned;
        buybacks++;
    }

    function convert(uint256 toSeed, uint96 amount) external {
        calls++;
        address tOut = toSeed % 2 == 0 ? address(usdg) : address(weth);
        uint256 r = fr.buybackReserve(address(nvda));
        if (r == 0) return;
        uint256 amt = bound(amount, 1, r);
        (uint256 q,) = router.quote(address(nvda), tOut, amt);
        if ((q * (10_000 - fr.maxSlippageBps())) / 10_000 == 0) return;
        if (_deviated()) {
            bytes memory err = _deviationError();
            vm.expectRevert(err);
            vm.prank(operator);
            fr.convert(address(nvda), tOut, amt, 0);
            guardBlocks++;
            return;
        }
        vm.prank(operator);
        (uint256 spent, uint256 out) = fr.convert(address(nvda), tOut, amt, 0);
        ghostReserveOut[address(nvda)] += spent;
        ghostReserveIn[tOut] += out;
        converts++;
    }

    function distributeAll() external {
        calls++;
        address[] memory list = tokens;
        uint256[] memory pend = new uint256[](list.length);
        for (uint256 i; i < list.length; ++i) {
            pend[i] = fr.pending(list[i]);
        }
        vm.prank(operator);
        fr.distributeMany(list);
        for (uint256 i; i < list.length; ++i) {
            uint256 toT = (pend[i] * 7_000) / 10_000;
            ghostToTreasury[list[i]] += toT;
            ghostToReserve[list[i]] += pend[i] - toT;
            if (pend[i] > 0) distributes++;
        }
    }
}

contract FeeReceiverInvariantsTest is Test {
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal operator = makeAddr("operator");
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    MockERC20 internal usdg;
    MockWETH internal weth;
    BurnableDCA internal dca;
    MockERC20 internal nvda;
    MockRouter internal router;
    MockOraclePool internal pool;
    FeeReceiver internal fr;
    FeeReceiverHandler internal handler;

    function setUp() public {
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        weth = new MockWETH();
        dca = new BurnableDCA();
        nvda = new MockERC20("NVIDIA Stock Token", "NVDAst", 18);
        router = new MockRouter(address(weth));
        router.setRate(address(usdg), address(dca), 1e18, 1e6);
        router.setRate(address(weth), address(dca), 3000e18, 1e18);
        router.setRate(address(nvda), address(usdg), 500e6, 1e18);
        router.setRate(address(nvda), address(weth), 1e18, 6e18);
        router.setRate(address(nvda), address(dca), 500e18, 1e18);
        pool = new MockOraclePool(address(dca), address(usdg));
        bytes memory extra = abi.encode(address(pool));
        router.setPathExtra(address(usdg), address(dca), extra);
        router.setPathExtra(address(weth), address(dca), extra);
        router.setPathExtra(address(nvda), address(usdg), extra);
        router.setPathExtra(address(nvda), address(weth), extra);
        router.setPathExtra(address(nvda), address(dca), extra);
        fr = new FeeReceiver(address(usdg), address(weth), address(dca), address(router), treasury, owner);
        vm.prank(owner);
        fr.setOperator(operator, true);
        handler = new FeeReceiverHandler(fr, usdg, weth, dca, nvda, router, pool, operator, treasury);
        targetContract(address(handler));
    }

    /// balance >= reserve for every token, and pending is exactly the difference
    function invariant_reserveBackedByBalance() public view {
        for (uint256 i; i < handler.tokenCount(); ++i) {
            address t = handler.tokens(i);
            uint256 bal = MockERC20(t).balanceOf(address(fr));
            uint256 r = fr.buybackReserve(t);
            assertGe(bal, r, "reserve backed");
            assertEq(fr.pending(t), bal - r, "pending = balance - reserve");
        }
    }

    /// the treasury received exactly the sum of every reported 70% share; nothing else ever reaches it
    function invariant_treasuryGetsExactlyItsShare() public view {
        for (uint256 i; i < handler.tokenCount(); ++i) {
            address t = handler.tokens(i);
            assertEq(MockERC20(t).balanceOf(treasury), handler.ghostToTreasury(t), "treasury == sum(70%)");
        }
    }

    /// reserve == credited - spent, per token (the 30% is fully accounted from booking to burn)
    function invariant_reserveLedgerBalances() public view {
        for (uint256 i; i < handler.tokenCount(); ++i) {
            address t = handler.tokens(i);
            uint256 expected = handler.ghostToReserve(t) + handler.ghostReserveIn(t) - handler.ghostReserveOut(t);
            assertEq(fr.buybackReserve(t), expected, "reserve ledger");
        }
    }

    /// every $DCA that entered via a buyback left circulation; the receiver never holds bought $DCA
    function invariant_boughtDcaIsBurned() public view {
        assertEq(fr.totalBurned(), handler.ghostBurned(), "totalBurned == sum(burned)");
        assertEq(dca.balanceOf(DEAD), 0, "BurnableDCA burns, never parks at DEAD");
        assertEq(
            dca.totalSupply(),
            handler.ghostDcaFees() + handler.ghostDcaMinted() - handler.ghostBurned(),
            "supply = fees + bought - burned"
        );
        // whatever DCA the receiver holds arrived as a fee (pending or reserved), never from a buyback
        assertLe(dca.balanceOf(address(fr)), handler.ghostDcaFees());
    }

    /// nothing but the split moves value: every USDG that left the receiver went to the treasury or to a buyback
    function invariant_usdgOutflowIsTreasuryPlusBuybacks() public view {
        // every USDG in this world was minted straight into the receiver (fees and conversions alike)
        uint256 outflow = usdg.totalSupply() - usdg.balanceOf(address(fr));
        assertEq(outflow, handler.ghostToTreasury(address(usdg)) + handler.ghostReserveOut(address(usdg)));
    }
}
