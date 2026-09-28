// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import { DocksIslands, IDocksGenerations } from "../src/docks/DocksIslands.sol";
import { DocksLaunchpad } from "../src/docks/DocksLaunchpad.sol";
import { DocksVillages } from "../src/docks/DocksVillages.sol";
import { DocksFounderMarks } from "../src/docks/DocksFounderMarks.sol";
import { DocksVillageTreasury, IDocksLiquidity, IDocksBuyback } from "../src/docks/DocksVillageTreasury.sol";

contract MockRF is ERC20 {
    constructor() ERC20("RareFriends", "RF") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockActivation {
    mapping(uint256 => uint256) public amount;

    function set(uint256 id, uint256 a) external {
        amount[id] = a;
    }

    function positions(address, uint256 id) external view returns (uint8, uint256) {
        return (0, amount[id]);
    }
}

contract MockGenerations {
    mapping(uint256 => address) public owners;
    mapping(uint256 => uint8) public gens;
    address public activationManager;

    constructor(address manager) {
        activationManager = manager;
    }

    function set(uint256 id, address owner) external {
        owners[id] = owner;
    }

    function setGen(uint256 id, uint8 g) external {
        gens[id] = g;
    }

    function generation(uint256 id) external view returns (uint8) {
        return gens[id] == 0 ? 6 : gens[id];
    }

    function ownerOf(uint256 id) external view returns (address) {
        require(owners[id] != address(0), "nonexistent");
        return owners[id];
    }

    function tokenBoundAccount(uint256 id) external pure returns (address) {
        return address(uint160(0xB0B000 + id));
    }
}


/// Stands in for the Uniswap position: keeps the RF, pays out whatever fees the test sets.
/// Also the buyback: 1 WETH buys 1,000 RF.
contract MockLiquidity is IDocksLiquidity, IDocksBuyback {
    MockRF public rf;
    MockRF public weth;
    mapping(uint256 => uint256) public provided;
    uint256 public rfFees;
    uint256 public wethFees;

    constructor(MockRF rf_, MockRF weth_) {
        rf = rf_;
        weth = weth_;
    }

    function setFees(uint256 r, uint256 w) external {
        rfFees = r;
        wethFees = w;
    }

    function provide(uint256 villageId, uint256 amount) external returns (uint256) {
        rf.transferFrom(msg.sender, address(this), amount);
        provided[villageId] += amount;
        return amount;
    }

    function collect(uint256, address to) external returns (uint256 r, uint256 w) {
        (r, w) = (rfFees, wethFees);
        rf.mint(to, r);
        weth.mint(to, w);
        (rfFees, wethFees) = (0, 0);
    }

    function buyRf(uint256 wethIn, uint256 minOut, address to) external returns (uint256 out) {
        weth.transferFrom(msg.sender, address(this), wethIn);
        out = wethIn * 1000;
        require(out >= minOut, "slippage");
        rf.mint(to, out);
    }
}

contract DocksTest is Test {
    MockRF rf;
    MockActivation act;
    MockGenerations gen;
    DocksIslands reg;
    DocksLaunchpad pad;
    DocksVillages vil;
    DocksVillageTreasury tre;
    MockLiquidity liq;
    MockRF weth;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address treasury = address(0x7EA);
    mapping(address => uint256) plotOf;

    enum Scope_ {
        AnyDocked,
        HolderIsland,
        IslandAndNeighbours,
        Visitors,
        Village
    }

    function setUp() public {
        rf = new MockRF();
        act = new MockActivation();
        gen = new MockGenerations(address(act));
        reg = new DocksIslands(IDocksGenerations(address(gen)), IERC20(address(rf)));
        vil = new DocksVillages(IERC20(address(rf)), reg, 1_000_000 ether, 30 days, 1000 ether);
        weth = new MockRF();
        liq = new MockLiquidity(rf, weth);
        tre = new DocksVillageTreasury(IERC20(address(rf)), IERC20(address(weth)), vil, liq, liq);
        vil.init(tre);
        pad = new DocksLaunchpad(IERC20(address(rf)), reg, vil, treasury);
        _friend(1, alice);
        _friend(2, alice);
        _friend(3, alice);
        _friend(10, bob);
        _friend(20, carol);
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            rf.mint(who[i], 10_000 ether);
            vm.startPrank(who[i]);
            rf.approve(address(pad), type(uint256).max);
            rf.approve(address(reg), type(uint256).max);
            rf.approve(address(vil), type(uint256).max);
            plotOf[who[i]] = reg.create("");
            vm.stopPrank();
        }
    }

    function _friend(uint256 id, address owner) internal {
        gen.set(id, owner);
        act.set(id, 1 ether);
    }

    function _one(uint256 v) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = v;
    }

    function _i(int32 v) internal pure returns (int32[] memory a) {
        a = new int32[](1);
        a[0] = v;
    }

    function _place(address who, uint256 id, int32 x, int32 y) internal {
        vm.prank(who);
        reg.arrange(plotOf[who], _one(id), _i(x), _i(y));
    }

    function _burned() internal view returns (uint256) {
        return rf.balanceOf(reg.BURN());
    }

    function _dock(address who, int32 bx, int32 by) internal {
        vm.prank(who);
        reg.dock(plotOf[who], bx, by);
    }

    /* ── islands are not tokens ── */

    function testIslandsAreNotTokens() public {
        assertEq(reg.ownerOf(plotOf[alice]), alice);
        assertEq(reg.totalIslands(), 3);
        vm.prank(alice);
        uint256 second = reg.create("Harbour");
        assertEq(reg.ownerOf(second), alice);
        assertEq(reg.islandName(second), "Harbour");
        // no transfer, approve or sale surface exists: only the Friends are NFTs
        (bool ok,) = address(reg).call(abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, bob, second));
        assertFalse(ok);
    }

    /* ── holes: a saved Friend that leaves the wallet ── */

    function testSoldFriendLeavesAReservedHoleUntilReturned() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        gen.set(1, bob); // alice sells #1 (in Rare Friends this also clears activation)
        assertFalse(reg.isValid(1));
        assertTrue(reg.isHole(plotOf[alice], 1));
        (bool occ,, bool hole) = reg.friendAt(plotOf[alice], 0, 0);
        assertTrue(occ && hole);
        vm.expectRevert(DocksIslands.CellTaken.selector); // the hole is reserved
        _place(alice, 3, 0, 0);
        gen.set(1, alice); // returned: the hole heals by itself, free
        assertTrue(reg.isValid(1));
        assertFalse(reg.isHole(plotOf[alice], 1));
    }

    function testHoleIsBurnedInWhenTheNewOwnerPlacesTheFriend() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        gen.set(1, bob);
        _place(bob, 1, 3, 3); // bob builds with it: alice's island keeps a burned-in hole
        assertEq(reg.islandOf(1), plotOf[bob]);
        assertTrue(reg.isHole(plotOf[alice], 1));
        (bool occ, uint256 who, bool hole) = reg.friendAt(plotOf[alice], 0, 0);
        assertTrue(occ && hole);
        assertEq(who, 1);
        (,,, bool open) = reg.holeOf(plotOf[alice], 1);
        assertTrue(open);
        vm.expectRevert(DocksIslands.CellTaken.selector);
        _place(alice, 3, 0, 0);
    }

    function testFillHoleWithSameSizeFriendPaysItsFee() public {
        gen.setGen(1, 3);
        gen.setGen(3, 3);
        gen.setGen(2, 5);
        _place(alice, 1, 0, 0);
        gen.set(1, bob);
        _place(bob, 1, 0, 0);
        vm.prank(alice);
        vm.expectRevert(DocksIslands.WrongSize.selector); // #2 is Gen 5, the hole is Gen 3
        reg.fillHole(plotOf[alice], 1, 2);
        uint256 before = _burned();
        vm.prank(alice);
        assertEq(reg.fillHole(plotOf[alice], 1, 3), 20 ether);
        assertEq(_burned() - before, 20 ether);
        assertFalse(reg.isHole(plotOf[alice], 1));
        (, uint256 at, bool hole) = reg.friendAt(plotOf[alice], 0, 0);
        assertEq(at, 3);
        assertFalse(hole);
    }

    function testReturnedFriendFillsItsOwnHoleFree() public {
        _place(alice, 1, 0, 0);
        gen.set(1, bob);
        _place(bob, 1, 0, 0); // burned in on alice's island
        gen.set(1, alice); // bob sends it back
        uint256 before = _burned();
        vm.prank(alice);
        assertEq(reg.fillHole(plotOf[alice], 1, 1), 0);
        assertEq(_burned(), before);
        assertEq(reg.islandOf(1), plotOf[alice]);
        assertEq(reg.memberCount(plotOf[bob]), 0);
    }

    function testFillAPendingHoleWithAnotherFriend() public {
        _place(alice, 1, 0, 0);
        act.set(1, 0); // deactivated but still held: a pending hole
        assertTrue(reg.isHole(plotOf[alice], 1));
        vm.prank(alice);
        reg.fillHole(plotOf[alice], 1, 2);
        (, uint256 at,) = reg.friendAt(plotOf[alice], 0, 0);
        assertEq(at, 2);
        vm.prank(alice);
        vm.expectRevert(DocksIslands.NotAHole.selector);
        reg.fillHole(plotOf[alice], 2, 3);
    }


    function testOnlyIslandOwnerArranges() public {
        vm.prank(bob);
        vm.expectRevert(DocksIslands.NotIslandOwner.selector);
        reg.arrange(plotOf[alice], _one(10), _i(0), _i(0));
        vm.prank(alice);
        vm.expectRevert(DocksIslands.NotHolder.selector);
        reg.arrange(plotOf[alice], _one(10), _i(0), _i(0));
    }

    function testBurnPerFriendMovedByGeneration() public {
        gen.setGen(1, 1); // 100 RF
        gen.setGen(2, 3); // 20 RF
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 2;
        ids[2] = 3; // gen 6: 1 RF
        int32[] memory xs = new int32[](3);
        xs[1] = 8;
        xs[2] = 13;
        int32[] memory ys = new int32[](3);
        (uint256 cost, uint256 moved) = reg.arrangeCost(plotOf[alice], ids, xs, ys);
        assertEq(cost, 121 ether);
        assertEq(moved, 3);
        uint256 before = _burned();
        vm.prank(alice);
        assertEq(reg.arrange(plotOf[alice], ids, xs, ys), 121 ether);
        assertEq(_burned() - before, 121 ether);
        xs[2] = 14; // only #3 moves
        before = _burned();
        vm.prank(alice);
        assertEq(reg.arrange(plotOf[alice], ids, xs, ys), 1 ether);
        assertEq(_burned() - before, 1 ether);
    }

    function testArrangeNeedsRF() public {
        address dave = address(0xDA5E);
        _friend(40, dave);
        vm.startPrank(dave);
        uint256 plot = reg.create("");
        vm.expectRevert();
        reg.arrange(plot, _one(40), _i(0), _i(0));
        vm.stopPrank();
    }

    function testRemoveIsFree() public {
        _place(alice, 1, 0, 0);
        uint256 before = rf.balanceOf(alice);
        vm.prank(alice);
        reg.remove(_one(1));
        assertEq(rf.balanceOf(alice), before);
        assertEq(reg.memberCount(plotOf[alice]), 0);
    }

    function testIslandsHaveTheirOwnGrids() public {
        _place(alice, 1, 0, 0);
        _place(bob, 10, 0, 0); // same local cell, different island: fine
        (, uint256 a,) = reg.friendAt(plotOf[alice], 0, 0);
        (, uint256 b,) = reg.friendAt(plotOf[bob], 0, 0);
        assertEq(a, 1);
        assertEq(b, 10);
        vm.expectRevert(DocksIslands.CellTaken.selector);
        _place(alice, 2, 0, 0);
    }

    function testDeployAFriendToAnotherOfYourIslands() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        vm.prank(alice);
        uint256 second = reg.create("Outpost");
        uint256 before = _burned();
        vm.prank(alice);
        reg.arrange(second, _one(2), _i(0), _i(0)); // joining a new island counts as a move
        assertEq(_burned() - before, 1 ether);
        assertEq(reg.islandOf(2), second);
        assertEq(reg.memberCount(plotOf[alice]), 1);
        assertEq(reg.memberCount(second), 1);
        (bool occ,,) = reg.friendAt(plotOf[alice], 1, 0);
        assertFalse(occ);
    }

    function testCrewMovesTogetherSwappingCells() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        int32[] memory xs = new int32[](2);
        xs[0] = 1;
        xs[1] = 2;
        int32[] memory ys = new int32[](2);
        vm.prank(alice);
        reg.arrange(plotOf[alice], ids, xs, ys);
        (, uint256 at1,) = reg.friendAt(plotOf[alice], 1, 0);
        (, uint256 at2,) = reg.friendAt(plotOf[alice], 2, 0);
        assertEq(at1, 1);
        assertEq(at2, 2);
    }

    function testInactiveCannotPlace() public {
        act.set(3, 0);
        vm.expectRevert(DocksIslands.NotActive.selector);
        _place(alice, 3, 0, 0);
    }

    function testFriendsTouchAlongPartOfASide() public {
        gen.setGen(1, 3); // 5x4 cells
        gen.setGen(2, 2); // 5x5 cells
        _place(alice, 1, 0, 0);
        _place(alice, 2, 5, 2); // flush against the right edge, overlapping part of it
        assertTrue(reg.adjacent(1, 2));
        _place(alice, 2, 5, 4); // only a corner
        assertFalse(reg.adjacent(1, 2));
    }

    /* ── docking islands: one berth each, gas only ── */

    function testDockingIsGasOnlyAndNeedsALoadingZone() public {
        _place(alice, 1, 0, 0);
        _place(bob, 10, 0, 0);
        _place(carol, 20, 0, 0);
        uint256 before = rf.balanceOf(alice);
        _dock(alice, 0, 0); // first island docks anywhere
        assertEq(rf.balanceOf(alice), before);
        vm.prank(bob);
        vm.expectRevert(DocksIslands.NotLoadingZone.selector);
        reg.dock(plotOf[bob], 5, 5);
        vm.prank(bob);
        vm.expectRevert(DocksIslands.BerthTaken.selector);
        reg.dock(plotOf[bob], 0, 0);
        assertTrue(reg.isLoadingZone(1, 0));
        _dock(bob, 1, 0);
        assertTrue(reg.connected(plotOf[alice], plotOf[bob]));
        _dock(carol, 2, 0);
        assertFalse(reg.connected(plotOf[alice], plotOf[carol]));
        // move alice's island to the other side of carol
        _dock(alice, 3, 0);
        assertEq(reg.islandAtBerth(0, 0), 0);
        assertTrue(reg.connected(plotOf[alice], plotOf[carol]));
        assertEq(reg.dockedCount(), 3);
    }

    function testEmptyIslandCannotDock() public {
        vm.prank(alice);
        vm.expectRevert(DocksIslands.EmptyIsland.selector);
        reg.dock(plotOf[alice], 0, 0);
    }

    function testSizeDoesNotMatterForDocking() public {
        gen.setGen(1, 1); // a Gen 1 island (8x8 cells) still takes one berth
        _place(alice, 1, 0, 0);
        _place(bob, 10, 0, 0);
        _dock(alice, 0, 0);
        _dock(bob, 0, 1);
        assertTrue(reg.connected(plotOf[alice], plotOf[bob]));
    }

    /* ── bridges: RF per berth of distance ── */

    function testBridgeBurnsPerBerthAndBreaksWhenAnIslandMoves() public {
        _place(alice, 1, 0, 0);
        _place(bob, 10, 0, 0);
        _place(carol, 20, 0, 0);
        _dock(alice, 0, 0);
        _dock(bob, 1, 0);
        _dock(carol, 2, 0);
        assertEq(reg.bridgeCost(plotOf[alice], plotOf[carol]), 20 ether);
        vm.prank(alice);
        vm.expectRevert(DocksIslands.AlreadyConnected.selector);
        reg.buildBridge(plotOf[alice], plotOf[bob]);
        uint256 before = _burned();
        vm.prank(alice);
        reg.buildBridge(plotOf[alice], plotOf[carol]);
        assertEq(_burned() - before, 20 ether);
        assertTrue(reg.connected(plotOf[alice], plotOf[carol]));
        _dock(carol, 1, 1); // carol moves (under bob): the bridge is gone
        assertFalse(reg.hasBridge(plotOf[alice], plotOf[carol]));
    }

    function testAccess() public {
        assertTrue(reg.canVisit(plotOf[alice], bob));
        vm.prank(alice);
        reg.setIsland(plotOf[alice], "Alice Market", true);
        assertFalse(reg.canVisit(plotOf[alice], bob));
        vm.prank(alice);
        reg.setVisitor(plotOf[alice], bob, true);
        assertTrue(reg.canVisit(plotOf[alice], bob));
        assertFalse(reg.canVisit(plotOf[alice], carol));
        vm.prank(bob);
        vm.expectRevert(DocksIslands.NotIslandOwner.selector);
        reg.setIsland(plotOf[alice], "mine now", false);
    }

    /* ── launches ── */

    function _params(Scope_ s) internal pure returns (DocksLaunchpad.LaunchParams memory p) {
        p.name = "Dock Coin";
        p.symbol = "DOCK";
        p.creatorFriendId = 1;
        p.supply = 1_000_000 ether;
        p.claimPool = 100_000 ether;
        p.claimEach = 1000 ether;
        p.claimPrice = 5 ether;
        p.scope = DocksLaunchpad.Scope(uint8(s));
    }

    /// alice (#1, #2) at berth 0,0 · bob (#10) at 1,0 · carol (#20) at 2,0.
    function _world() internal {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        _place(bob, 10, 0, 0);
        _place(carol, 20, 0, 0);
        _dock(alice, 0, 0);
        _dock(bob, 1, 0);
        _dock(carol, 2, 0);
    }

    function testLaunchChargesFeeAirdropsInBatchesAndSendsRestToFriendWallet() public {
        _world();
        DocksLaunchpad.LaunchParams memory p = _params(Scope_.AnyDocked);
        p.airdropPool = 1000 ether;
        p.airdropEach = 50 ether;
        p.airdropScope = DocksLaunchpad.Scope.IslandAndNeighbours;
        uint256 burnBefore = _burned();
        uint256 rfBefore = rf.balanceOf(alice);
        vm.prank(alice);
        uint256 id = pad.launch(p);
        assertEq(_burned() - burnBefore, 500 ether);
        assertEq(rf.balanceOf(treasury), 500 ether);
        assertEq(rfBefore - rf.balanceOf(alice), 1000 ether);
        IERC20 t = IERC20(address(pad.launches(id).token));
        assertEq(t.balanceOf(gen.tokenBoundAccount(1)), 1_000_000 ether - 1000 ether - 100_000 ether);

        vm.prank(bob);
        vm.expectRevert(DocksLaunchpad.NotCreator.selector);
        pad.airdrop(id, _one(10));

        uint256[] memory ids = new uint256[](4);
        ids[0] = 2;
        ids[1] = 10; // docked next to alice
        ids[2] = 20; // two berths away: skipped
        ids[3] = 2; // repeat: skipped
        vm.prank(alice);
        assertEq(pad.airdrop(id, ids), 2);
        assertEq(t.balanceOf(gen.tokenBoundAccount(2)), 50 ether);
        assertEq(t.balanceOf(gen.tokenBoundAccount(10)), 50 ether);
        assertEq(t.balanceOf(gen.tokenBoundAccount(20)), 0);
        vm.prank(alice);
        pad.endAirdrop(id);
        assertEq(t.balanceOf(gen.tokenBoundAccount(1)), 1_000_000 ether - 100 ether - 100_000 ether);
    }

    function testLaunchNeedsADockedIslandYouHold() public {
        DocksLaunchpad.LaunchParams memory p = _params(Scope_.AnyDocked);
        vm.prank(alice);
        vm.expectRevert(DocksLaunchpad.NotDocked.selector);
        pad.launch(p);
        _place(alice, 1, 0, 0);
        vm.prank(alice);
        vm.expectRevert(DocksLaunchpad.NotDocked.selector); // on an island, but not docked
        pad.launch(p);
        _dock(alice, 0, 0);
        vm.prank(bob);
        vm.expectRevert(DocksLaunchpad.NotHolder.selector);
        pad.launch(p);
    }

    function testBadAllocationReverts() public {
        _world();
        DocksLaunchpad.LaunchParams memory p = _params(Scope_.AnyDocked);
        p.claimPool = p.supply + 1;
        vm.prank(alice);
        vm.expectRevert(DocksLaunchpad.BadAllocation.selector);
        pad.launch(p);
    }

    function testClaimBurnsRFOncePerFriend() public {
        _world();
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.AnyDocked));
        uint256 burnBefore = _burned();
        vm.prank(carol);
        pad.claim(id, 20);
        assertEq(_burned() - burnBefore, 5 ether);
        IERC20 t = IERC20(address(pad.launches(id).token));
        assertEq(t.balanceOf(gen.tokenBoundAccount(20)), 1000 ether);
        vm.prank(carol);
        vm.expectRevert(DocksLaunchpad.AlreadyClaimed.selector);
        pad.claim(id, 20);
    }

    function testClaimManyChargesOnlyForClaimsMade() public {
        _world();
        _place(alice, 3, 2, 0);
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.AnyDocked));
        vm.prank(alice);
        pad.claim(id, 2);
        uint256 rfBefore = rf.balanceOf(alice);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 2;
        ids[2] = 3;
        vm.prank(alice);
        assertEq(pad.claimMany(id, ids), 2);
        assertEq(rfBefore - rf.balanceOf(alice), 10 ether);
        vm.prank(bob);
        vm.expectRevert(DocksLaunchpad.NotHolder.selector);
        pad.claimMany(id, _one(1));
    }

    function testUndockedIslandCannotClaim() public {
        _world();
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.AnyDocked));
        vm.prank(carol);
        reg.undock(plotOf[carol]);
        vm.prank(carol);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 20);
    }

    function testHolderIslandScope() public {
        _world();
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.HolderIsland));
        vm.prank(alice);
        pad.claim(id, 2);
        vm.prank(bob);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 10);
    }

    function testNeighbourScopeIncludesBridges() public {
        _world();
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.IslandAndNeighbours));
        vm.prank(bob);
        pad.claim(id, 10);
        vm.prank(carol);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 20);
        vm.prank(carol);
        reg.buildBridge(plotOf[carol], plotOf[alice]);
        vm.prank(carol);
        pad.claim(id, 20);
    }

    function testVisitorScope() public {
        _world();
        vm.prank(alice);
        reg.setIsland(plotOf[alice], "", true);
        vm.prank(alice);
        reg.setVisitor(plotOf[alice], bob, true);
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.Visitors));
        vm.prank(bob);
        pad.claim(id, 10);
        vm.prank(carol);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 20);
    }

    function testFriendWalletCanClaimAndPoolEmpties() public {
        _world();
        DocksLaunchpad.LaunchParams memory p = _params(Scope_.AnyDocked);
        p.claimPool = 1000 ether;
        vm.prank(alice);
        uint256 id = pad.launch(p);
        address wallet = gen.tokenBoundAccount(10);
        rf.mint(wallet, 5 ether);
        vm.prank(wallet);
        rf.approve(address(pad), 5 ether);
        vm.prank(wallet);
        pad.claim(id, 10);
        vm.prank(alice);
        vm.expectRevert(DocksLaunchpad.PoolEmpty.selector);
        pad.claim(id, 1);
    }

    /// A big holder: 300 Gen 6 Friends arranged into one island in one transaction (300 RF
    /// burned), docked, then claimed for in one.
    function testScaleThreeHundredFriends() public {
        uint256 n = 300;
        uint256[] memory ids = new uint256[](n);
        int32[] memory xs = new int32[](n);
        int32[] memory ys = new int32[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = 1000 + i;
            _friend(ids[i], alice);
            xs[i] = int32(int256(i % 20));
            ys[i] = int32(int256(i / 20));
        }
        uint256 before = _burned();
        vm.prank(alice);
        reg.arrange(plotOf[alice], ids, xs, ys);
        assertEq(_burned() - before, n * 1 ether);
        _dock(alice, 0, 0);
        DocksLaunchpad.LaunchParams memory p = _params(Scope_.HolderIsland);
        p.creatorFriendId = 1000;
        p.claimEach = 100 ether;
        vm.prank(alice);
        uint256 id = pad.launch(p);
        vm.prank(alice);
        assertEq(pad.claimMany(id, ids), n);
    }

    /* ── villages: a flag everyone locks RF into until it's full ── */

    uint256 constant TARGET = 1_000_000 ether;

    function _plant(address who, uint256 amount) internal returns (uint256 v) {
        rf.mint(who, amount);
        vm.prank(who);
        v = vil.plant(plotOf[who], "Dock Town", 0, 0, amount);
    }

    function _lock(address who, uint256 v, uint256 amount) internal returns (uint256 taken) {
        rf.mint(who, amount);
        vm.prank(who);
        taken = vil.lock(v, amount);
    }

    /// alice plants with 400k, bob locks 600k, founded.
    function _village() internal returns (uint256 v) {
        _world();
        v = _plant(alice, 400_000 ether);
        _lock(bob, v, 600_000 ether);
        vil.found(v);
    }

    function _join(address who, uint256 v, address via) internal {
        vm.prank(who);
        vil.join(v, plotOf[who], plotOf[via]);
    }

    function testFlagFillsFromManyLockersThenFoundsAVillage() public {
        _world();
        uint256 v = _plant(alice, 400_000 ether);
        assertTrue(vil.rising(v));
        assertEq(_lock(bob, v, 300_000 ether), 300_000 ether);
        vm.expectRevert(DocksVillages.NotFull.selector);
        vil.found(v);
        uint256 carolBefore = rf.balanceOf(carol);
        assertEq(_lock(carol, v, 500_000 ether), 300_000 ether, "the last lock is trimmed to what's missing");
        assertEq(rf.balanceOf(carol) - carolBefore, 200_000 ether, "the rest never left carol");
        assertFalse(vil.rising(v));
        vm.expectRevert(DocksVillages.NotRising.selector);
        vil.lock(v, 1000 ether);
        assertEq(vil.villageOf(plotOf[alice]), 0, "not a village until founded");

        vil.found(v); // anyone can found a full flag
        assertEq(vil.villageOf(plotOf[alice]), v);
        assertEq(tre.balanceOf(v), 500_000 ether, "half to the village treasury");
        assertEq(liq.provided(v), 500_000 ether, "half to permanent liquidity");
        assertEq(rf.balanceOf(address(vil)), 0, "nothing left to withdraw");
        vm.expectRevert(DocksVillages.NotRising.selector);
        vil.found(v);
        vm.prank(alice);
        vm.expectRevert(DocksVillages.NotRising.selector);
        vil.refund(v);
    }

    function testFounderMarksAreSoulboundAndWeighted() public {
        uint256 v = _village();
        DocksFounderMarks m = vil.marks();
        uint256 aliceMark = m.markOf(v, alice);
        assertEq(m.ownerOf(aliceMark), alice);
        assertEq(m.balanceOf(alice), 1);
        assertEq(vil.weightOf(v, alice), 400_000 ether);
        assertEq(vil.weightOf(v, bob), 600_000 ether);
        assertEq(vil.totalWeight(v), TARGET);
        assertTrue(m.locked(aliceMark));
        vm.prank(alice);
        vm.expectRevert(DocksFounderMarks.Soulbound.selector);
        m.transferFrom(alice, bob, aliceMark);
        vm.prank(alice);
        vm.expectRevert(DocksFounderMarks.Soulbound.selector);
        m.approve(bob, aliceMark);
        assertEq(m.villages(), address(vil));
        vm.expectRevert(DocksFounderMarks.NotVillages.selector);
        m.add(v, carol, 1 ether);
        assertGt(bytes(m.tokenURI(aliceMark)).length, 50);
    }

    function testPlantChecks() public {
        _place(alice, 1, 0, 0);
        rf.mint(alice, 10_000 ether);
        vm.startPrank(alice);
        rf.approve(address(vil), type(uint256).max);
        vm.expectRevert(DocksVillages.NotDocked.selector);
        vil.plant(plotOf[alice], "Dock Town", 0, 0, 1000 ether);
        vm.stopPrank();
        _dock(alice, 0, 0);
        vm.startPrank(alice);
        vm.expectRevert(DocksVillages.NotOnLand.selector);
        vil.plant(plotOf[alice], "Dock Town", 5, 5, 1000 ether);
        vm.expectRevert(DocksVillages.TooSmall.selector);
        vil.plant(plotOf[alice], "Dock Town", 0, 0, 999 ether);
        vm.expectRevert(DocksVillages.BadName.selector);
        vil.plant(plotOf[alice], "", 0, 0, 1000 ether);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(DocksVillages.NotIslandOwner.selector);
        vil.plant(plotOf[alice], "Dock Town", 0, 0, 1000 ether);
        vm.startPrank(alice);
        vil.plant(plotOf[alice], "Dock Town", 0, 0, 1000 ether);
        vm.expectRevert(DocksVillages.AlreadyInVillage.selector);
        vil.plant(plotOf[alice], "Second flag", 0, 0, 1000 ether);
        vm.stopPrank();
    }

    function testFlagThatDoesNotFillInTimeRefundsEveryone() public {
        _world();
        uint256 v = _plant(alice, 100_000 ether);
        _lock(bob, v, 50_000 ether);
        vm.prank(bob);
        vm.expectRevert(DocksVillages.StillOpen.selector);
        vil.refund(v);
        vm.warp(block.timestamp + 30 days);
        rf.mint(carol, 10_000 ether);
        vm.prank(carol);
        vm.expectRevert(DocksVillages.NotRising.selector);
        vil.lock(v, 10_000 ether);
        uint256 bobBefore = rf.balanceOf(bob);
        vm.prank(bob);
        assertEq(vil.refund(v), 50_000 ether);
        assertEq(rf.balanceOf(bob) - bobBefore, 50_000 ether);
        assertEq(vil.marks().balanceOf(bob), 0, "mark burned");
        vm.prank(bob);
        vm.expectRevert(DocksFounderMarks.NoMark.selector);
        vil.refund(v);
        vm.prank(alice);
        vil.refund(v);
        assertEq(rf.balanceOf(address(vil)), 0);
        _plant(alice, 1000 ether); // the island is free for a new flag
    }

    function testAFullFlagThatCantBeFoundedRefundsAfterGrace() public {
        _world();
        uint256 v = _plant(alice, 400_000 ether);
        _lock(bob, v, 600_000 ether);
        vm.warp(block.timestamp + 30 days);
        vm.prank(bob);
        vm.expectRevert(DocksVillages.StillOpen.selector);
        vil.refund(v);
        vm.warp(block.timestamp + 7 days);
        vm.prank(bob);
        vil.refund(v);
        vm.expectRevert(DocksVillages.NotFull.selector);
        vil.found(v);
    }

    function testIslandsJoinWhenConnectedAndTheSeatStays() public {
        _world();
        uint256 v = _plant(alice, 400_000 ether);
        vm.prank(bob);
        vm.expectRevert(DocksVillages.NotFounded.selector);
        vil.join(v, plotOf[bob], plotOf[alice]);
        _lock(bob, v, 600_000 ether);
        vil.found(v);
        uint256 bobRf = rf.balanceOf(bob);
        _join(bob, v, alice); // docked next to alice: gas only
        assertEq(rf.balanceOf(bob), bobRf);
        vm.prank(carol);
        vm.expectRevert(DocksVillages.NotConnected.selector);
        vil.join(v, plotOf[carol], plotOf[alice]); // two berths away
        _join(carol, v, bob); // the village grows island by island
        assertEq(vil.villages(v).members, 3);
        assertTrue(vil.sameVillage(plotOf[alice], plotOf[carol]));
        vm.prank(alice);
        vm.expectRevert(DocksVillages.SeatStays.selector);
        vil.leaveVillage(plotOf[alice]);
        vm.prank(bob);
        vil.leaveVillage(plotOf[bob]);
        assertEq(vil.villageOf(plotOf[bob]), 0);
    }

    function testHarvestBuysBackRFBurnsHalfAndFillsTheTreasury() public {
        uint256 v = _village();
        liq.setFees(1000 ether, 2 ether); // 2 WETH buys 2,000 RF → 3,000 RF of fees
        vm.prank(carol);
        vm.expectRevert(DocksVillageTreasury.NotFounder.selector);
        tre.harvest(v, 0);
        uint256 burned = _burned();
        vm.prank(bob);
        vm.expectRevert(bytes("slippage"));
        tre.harvest(v, 2001 ether);
        vm.prank(bob);
        (uint256 b, uint256 k) = tre.harvest(v, 2000 ether);
        assertEq(b, 1500 ether);
        assertEq(k, 1500 ether);
        assertEq(_burned() - burned, 1500 ether);
        assertEq(tre.balanceOf(v), 500_000 ether + 1500 ether);
    }

    function testFoundersVoteToSpendTheTreasuryAndSetTheBurnShare() public {
        uint256 v = _village();
        address market = address(0x3A12);
        vm.prank(carol);
        vm.expectRevert(DocksVillageTreasury.NotFounder.selector);
        tre.propose(v, DocksVillageTreasury.Kind.Spend, market, 10_000 ether, 0, "Upgrade");
        vm.prank(alice);
        uint256 spend = tre.propose(v, DocksVillageTreasury.Kind.Spend, market, 10_000 ether, 0, "Buy the dock lanterns");
        vm.prank(alice);
        tre.vote(spend, true); // 400k for
        vm.prank(alice);
        vm.expectRevert(DocksVillageTreasury.AlreadyVoted.selector);
        tre.vote(spend, true);
        vm.prank(carol);
        vm.expectRevert(DocksVillageTreasury.NotFounder.selector);
        tre.vote(spend, true);
        vm.expectRevert(DocksVillageTreasury.VotingOpen.selector);
        tre.execute(spend);
        vm.warp(block.timestamp + 3 days);
        vm.prank(bob);
        vm.expectRevert(DocksVillageTreasury.VotingClosed.selector);
        tre.vote(spend, false);
        tre.execute(spend);
        assertEq(rf.balanceOf(market), 10_000 ether);
        assertEq(tre.balanceOf(v), 490_000 ether);
        vm.expectRevert(DocksVillageTreasury.Executed.selector);
        tre.execute(spend);

        // bob (600k) outvotes alice: rejected
        vm.prank(alice);
        uint256 more = tre.propose(v, DocksVillageTreasury.Kind.Spend, market, 1 ether, 0, "");
        vm.prank(alice);
        tre.vote(more, true);
        vm.prank(bob);
        tre.vote(more, false);
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(DocksVillageTreasury.Rejected.selector);
        tre.execute(more);

        // burn a quarter instead of half
        vm.prank(bob);
        uint256 share = tre.propose(v, DocksVillageTreasury.Kind.SetBurnShare, address(0), 0, 2500, "Keep more");
        vm.prank(bob);
        tre.vote(share, true);
        vm.warp(block.timestamp + 3 days);
        tre.execute(share);
        assertEq(tre.burnBpsOf(v), 2500);
        liq.setFees(4000 ether, 0);
        vm.prank(alice);
        (uint256 b,) = tre.harvest(v, 0);
        assertEq(b, 1000 ether);
    }

    function testVillageLaunchScope() public {
        uint256 v = _village();
        _join(bob, v, alice);
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.Village));
        vm.prank(bob);
        pad.claim(id, 10);
        vm.prank(carol);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 20);
        _join(carol, v, bob);
        vm.prank(carol);
        pad.claim(id, 20);
    }
}
