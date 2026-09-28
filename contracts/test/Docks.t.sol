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
        vil = new DocksVillages(IERC20(address(rf)), reg, 1_000_000 ether, 30 days, 1000 ether, 10_000 ether);
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
    uint256 constant ENROLL = 10_000 ether;
    address dave = address(0xDA7E);

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

    /// alice (#1, #2) plants with 400k, bob (#10) locks 600k, founded. carol (#20) is not a founder.
    function _village() internal returns (uint256 v) {
        _world();
        v = _plant(alice, 400_000 ether);
        _lock(bob, v, 600_000 ether);
        vil.found(v);
    }

    function _bring(address who, uint256 v) internal {
        vm.prank(who);
        vil.bring(v, plotOf[who]);
    }

    function _enroll(address who, uint256 v) internal {
        rf.mint(who, 1_000_000 ether);
        vm.startPrank(who);
        rf.approve(address(vil), type(uint256).max);
        vil.enroll(v, plotOf[who]);
        vm.stopPrank();
    }

    /// dave: a docked island at berth 3,0 (next to carol) with `n` Gen 6 Friends.
    function _dave(uint256 n) internal {
        vm.prank(dave);
        plotOf[dave] = reg.create("");
        uint256[] memory ids = new uint256[](n);
        int32[] memory xs = new int32[](n);
        int32[] memory ys = new int32[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = 500 + i;
            _friend(ids[i], dave);
            xs[i] = int32(int256(i));
        }
        rf.mint(dave, 1000 ether);
        vm.startPrank(dave);
        rf.approve(address(reg), type(uint256).max);
        reg.arrange(plotOf[dave], ids, xs, ys);
        reg.dock(plotOf[dave], 3, 0);
        vm.stopPrank();
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
        assertEq(vil.islandOf(v, alice), plotOf[alice], "the planter's island is the seat");
        assertEq(tre.balanceOf(v), 500_000 ether, "half to the village treasury");
        assertEq(liq.provided(v), 500_000 ether, "half to permanent liquidity");
        assertEq(rf.balanceOf(address(vil)), 0, "nothing left to withdraw");
        assertEq(vil.enrollPrice(v), ENROLL, "open enrollment for the first week");
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

    function testEveryoneBringsOneIsland() public {
        uint256 v = _village();
        _bring(bob, v); // founders bring one island free, from anywhere
        vm.prank(bob);
        vm.expectRevert(DocksVillages.HasIsland.selector);
        vil.bring(v, plotOf[bob]);
        vm.prank(carol);
        vm.expectRevert(DocksVillages.NotFounder.selector);
        vil.bring(v, plotOf[carol]);

        uint256 carolBefore = rf.balanceOf(carol) + 1_000_000 ether;
        _enroll(carol, v); // everyone else pays into the pool: nobody joins free
        assertEq(carolBefore - rf.balanceOf(carol), ENROLL);
        assertEq(vil.villages(v).pool, TARGET + ENROLL);
        assertEq(tre.balanceOf(v), 500_000 ether + ENROLL / 2, "half the fee to the treasury");
        assertEq(tre.pendingLiquidity(v), ENROLL / 2, "half queued for liquidity");
        tre.provideLiquidity(v);
        assertEq(liq.provided(v), 500_000 ether + ENROLL / 2);
        assertEq(vil.members(v).length, 3);

        vm.prank(alice);
        vm.expectRevert(DocksVillages.SeatStays.selector);
        vil.leaveVillage(plotOf[alice]);
        vm.prank(carol);
        vil.leaveVillage(plotOf[carol]);
        assertEq(vil.villageOf(plotOf[carol]), 0);
        assertEq(vil.members(v).length, 2);
        _enroll(carol, v); // coming back costs the fee again
    }

    function testPowerIsFriendsTimesFounderShareAndEnrolleesDilute() public {
        uint256 v = _village();
        _bring(bob, v);
        assertEq(vil.powerOf(v, alice), 2 * 14_000, "2 Friends x 1.4 (40% of the pool)");
        assertEq(vil.powerOf(v, bob), 1 * 16_000, "1 Friend x 1.6");
        assertEq(vil.powerOf(v, carol), 0, "not in the village");
        _enroll(carol, v);
        assertEq(vil.powerOf(v, carol), 10_000, "enrollees: 1 vote per Friend, no multiplier");
        assertEq(vil.powerOf(v, alice), 2 * (10_000 + 400_000 ether * 10_000 / (TARGET + ENROLL)), "the fee diluted alice's share");
        _place(alice, 3, 2, 0);
        assertEq(vil.population(v), 5);
        assertEq(vil.powerOf(v, alice), 3 * (10_000 + 400_000 ether * 10_000 / (TARGET + ENROLL)), "more Friends, more votes");
    }

    function testEnrollmentAfterTheFirstWeekIsWhatTheVillageVotes() public {
        uint256 v = _village();
        _bring(bob, v);
        DocksVillages.Proposal memory p = vil.proposals(0);
        assertEq(uint8(p.kind), uint8(DocksVillages.Kind.Enrollment));
        vm.warp(block.timestamp + 7 days);
        assertEq(vil.enrollPrice(v), 0, "closed until the vote is settled");
        vm.expectRevert(DocksVillages.EnrollmentClosed.selector);
        this.enrollAs(carol, v);
        vil.settle(0); // nobody voted: keep open at the current price
        assertEq(vil.enrollPrice(v), ENROLL);

        vm.prank(carol);
        vm.expectRevert(DocksVillages.NotInVillage.selector);
        vil.proposeEnrollment(v);
        vm.prank(alice);
        uint256 close = vil.proposeEnrollment(v);
        vm.prank(bob);
        vm.expectRevert(DocksVillages.VoteRunning.selector);
        vil.proposeEnrollment(v);
        vm.prank(alice);
        vil.vote(close, 2); // close now
        vm.prank(alice);
        vm.expectRevert(DocksVillages.AlreadyVoted.selector);
        vil.vote(close, 2);
        vm.expectRevert(DocksVillages.VotingOpen.selector);
        vil.settle(close);
        vm.warp(block.timestamp + 3 days);
        vm.prank(bob);
        vm.expectRevert(DocksVillages.VotingClosed.selector);
        vil.vote(close, 0);
        assertEq(vil.settle(close), 2);
        assertEq(vil.enrollPrice(v), 0);
        vm.expectRevert(DocksVillages.Settled.selector);
        vil.settle(close);
    }

    function enrollAs(address who, uint256 v) external {
        _enroll(who, v);
    }

    function testChangingThePriceClosesUntilTheDayLongPriceVote() public {
        uint256 v = _village();
        _bring(bob, v);
        vm.prank(bob);
        vil.vote(0, 1); // change the price (bob 16,000 beats nothing)
        vm.warp(block.timestamp + 7 days);
        vil.settle(0);
        assertEq(vil.enrollPrice(v), 0, "closed while the new price is voted");
        DocksVillages.Proposal memory p = vil.proposals(1);
        assertEq(uint8(p.kind), uint8(DocksVillages.Kind.EnrollPrice));
        assertEq(p.options[0], 5000 ether);
        assertEq(p.options[1], 20_000 ether);
        assertEq(p.options[2], 50_000 ether);
        assertEq(p.ends, block.timestamp + 1 days);
        vm.prank(alice);
        vil.vote(1, 1); // 28,000 for 20k
        vm.prank(bob);
        vil.vote(1, 0); // 16,000 for 5k
        vm.warp(block.timestamp + 1 days);
        assertEq(vil.settle(1), 1);
        assertEq(vil.enrollPrice(v), 20_000 ether);
    }

    function testClosingAtAPopulationThreshold() public {
        uint256 v = _village();
        _bring(bob, v);
        vm.prank(alice);
        vil.vote(0, 3); // close at a population
        vm.warp(block.timestamp + 7 days);
        vil.settle(0);
        DocksVillages.Proposal memory p = vil.proposals(1);
        assertEq(uint8(p.kind), uint8(DocksVillages.Kind.EnrollCap));
        assertEq(p.options[0], 13, "population 3: +10");
        assertEq(p.options[1], 28);
        assertEq(p.options[2], 103);
        assertEq(vil.enrollPrice(v), 0);
        vm.prank(alice);
        vil.vote(1, 0);
        vm.warp(block.timestamp + 1 days);
        vil.settle(1);
        assertEq(vil.enrollPrice(v), ENROLL, "open again until the village reaches 13 Friends");
        _dave(9);
        rf.mint(dave, ENROLL);
        vm.startPrank(dave);
        rf.approve(address(vil), type(uint256).max);
        vil.enroll(v, plotOf[dave]);
        vm.stopPrank();
        assertEq(vil.population(v), 12);
        _enroll(carol, v);
        assertEq(vil.population(v), 13);
        assertEq(vil.enrollPrice(v), 0, "full: enrollment closed");
    }

    function testSpendVotesByFriendsAndEnrolleesCanOutvoteFounders() public {
        uint256 v = _village();
        _bring(bob, v);
        address market = address(0x3A12);
        vm.prank(carol);
        vm.expectRevert(DocksVillages.NotInVillage.selector);
        vil.propose(v, DocksVillages.Kind.Spend, market, 10_000 ether, "Upgrade");
        vm.prank(alice);
        uint256 spend = vil.propose(v, DocksVillages.Kind.Spend, market, 10_000 ether, "Buy the dock lanterns");
        vm.prank(alice);
        vil.vote(spend, 1);
        vm.prank(bob);
        vil.vote(spend, 0);
        vm.prank(carol);
        vm.expectRevert(DocksVillages.NoPower.selector);
        vil.vote(spend, 1);
        vm.warp(block.timestamp + 3 days);
        vil.settle(spend);
        assertEq(rf.balanceOf(market), 10_000 ether, "28,000 yes beats 16,000 no");
        assertEq(tre.balanceOf(v), 490_000 ether);

        // a newcomer with 5 Friends outvotes both founders' multipliers
        _dave(5);
        rf.mint(dave, ENROLL);
        vm.startPrank(dave);
        rf.approve(address(vil), type(uint256).max);
        vil.enroll(v, plotOf[dave]);
        uint256 more = vil.propose(v, DocksVillages.Kind.Spend, market, 1 ether, "");
        vil.vote(more, 0);
        vm.stopPrank();
        vm.prank(alice);
        vil.vote(more, 1);
        vm.warp(block.timestamp + 3 days);
        assertEq(vil.settle(more), 0, "rejected");
        assertEq(rf.balanceOf(market), 10_000 ether);
    }

    function testHarvestBuysBackRFBurnsHalfAndAVoteSetsTheBurnShare() public {
        uint256 v = _village();
        _bring(bob, v);
        liq.setFees(1000 ether, 2 ether); // 2 WETH buys 2,000 RF -> 3,000 RF of fees
        vm.prank(carol);
        vm.expectRevert(DocksVillageTreasury.NotMember.selector);
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

        vm.prank(alice);
        vm.expectRevert(DocksVillages.BadProposal.selector);
        vil.propose(v, DocksVillages.Kind.BurnShare, address(0), 10_001, "");
        vm.prank(bob);
        uint256 share = vil.propose(v, DocksVillages.Kind.BurnShare, address(0), 2500, "Keep more");
        vm.prank(bob);
        vil.vote(share, 1);
        vm.warp(block.timestamp + 3 days);
        vil.settle(share);
        assertEq(tre.burnBpsOf(v), 2500);
        liq.setFees(4000 ether, 0);
        vm.prank(alice);
        (b,) = tre.harvest(v, 0);
        assertEq(b, 1000 ether);
        vm.expectRevert(DocksVillageTreasury.NotVillages.selector);
        tre.spend(v, alice, 1);
    }

    function testVillageLaunchScope() public {
        uint256 v = _village();
        _bring(bob, v);
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.Village));
        vm.prank(bob);
        pad.claim(id, 10);
        vm.prank(carol);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 20);
        _enroll(carol, v);
        vm.prank(carol);
        pad.claim(id, 20);
    }
}
