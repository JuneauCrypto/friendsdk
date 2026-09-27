// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import { DocksPlots, IDocksGenerations } from "../src/docks/DocksPlots.sol";
import { DocksLaunchpad } from "../src/docks/DocksLaunchpad.sol";

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

contract DocksTest is Test {
    MockRF rf;
    MockActivation act;
    MockGenerations gen;
    DocksPlots reg;
    DocksLaunchpad pad;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address treasury = address(0x7EA);
    mapping(address => uint256) plotOf;

    enum Scope_ {
        AnyDocked,
        HolderPlot,
        PlotAndNeighbours,
        Visitors
    }

    function setUp() public {
        rf = new MockRF();
        act = new MockActivation();
        gen = new MockGenerations(address(act));
        reg = new DocksPlots(IDocksGenerations(address(gen)), IERC20(address(rf)));
        pad = new DocksLaunchpad(IERC20(address(rf)), reg, treasury);
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
            plotOf[who[i]] = reg.mint("");
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

    /* ── plots are NFTs ── */

    function testPlotsAreNFTs() public {
        assertEq(reg.ownerOf(plotOf[alice]), alice);
        assertEq(reg.totalPlots(), 3);
        vm.prank(alice);
        uint256 second = reg.mint("Harbour");
        assertEq(reg.ownerOf(second), alice);
        assertEq(reg.plotName(second), "Harbour");
    }

    function testTokenURIIsOnChainJson() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        vm.prank(alice);
        reg.setPlot(plotOf[alice], 'Alice "Market"', false);
        string memory uri = reg.tokenURI(plotOf[alice]);
        assertTrue(_startsWith(uri, "data:application/json;base64,"));
    }

    function _startsWith(string memory s, string memory p) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(p);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; ++i) if (a[i] != b[i]) return false;
        return true;
    }

    function testOnlyPlotOwnerArranges() public {
        vm.prank(bob);
        vm.expectRevert(DocksPlots.NotPlotOwner.selector);
        reg.arrange(plotOf[alice], _one(10), _i(0), _i(0));
        vm.prank(alice);
        vm.expectRevert(DocksPlots.NotHolder.selector);
        reg.arrange(plotOf[alice], _one(10), _i(0), _i(0));
    }

    function testTransferringPlotWithoutFriendsLeavesThemStale() public {
        _place(alice, 1, 0, 0);
        assertTrue(reg.isValid(1));
        vm.prank(alice);
        reg.transferFrom(alice, bob, plotOf[alice]);
        assertFalse(reg.isValid(1));
        reg.clear(1);
        assertEq(reg.memberCount(plotOf[alice]), 0);
    }

    /* ── islands: arranging burns RF per Friend moved, by generation ── */

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
        uint256 plot = reg.mint("");
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
        (, uint256 a) = reg.friendAt(plotOf[alice], 0, 0);
        (, uint256 b) = reg.friendAt(plotOf[bob], 0, 0);
        assertEq(a, 1);
        assertEq(b, 10);
        vm.expectRevert(DocksPlots.CellTaken.selector);
        _place(alice, 2, 0, 0);
    }

    function testDeployAFriendToAnotherOfYourPlots() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        vm.prank(alice);
        uint256 second = reg.mint("Outpost");
        uint256 before = _burned();
        vm.prank(alice);
        reg.arrange(second, _one(2), _i(0), _i(0)); // joining a new island counts as a move
        assertEq(_burned() - before, 1 ether);
        assertEq(reg.plotOf(2), second);
        assertEq(reg.memberCount(plotOf[alice]), 1);
        assertEq(reg.memberCount(second), 1);
        (bool occ,) = reg.friendAt(plotOf[alice], 1, 0);
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
        (, uint256 at1) = reg.friendAt(plotOf[alice], 1, 0);
        (, uint256 at2) = reg.friendAt(plotOf[alice], 2, 0);
        assertEq(at1, 1);
        assertEq(at2, 2);
    }

    function testSoldFriendGoesStaleAndCellFrees() public {
        _place(alice, 1, 0, 0);
        gen.set(1, carol); // sold on the marketplace
        assertFalse(reg.isValid(1));
        _place(alice, 2, 0, 0); // stale occupant gives way
        (, uint256 id) = reg.friendAt(plotOf[alice], 0, 0);
        assertEq(id, 2);
    }

    function testClearOnlyWhenStale() public {
        _place(bob, 10, 0, 0);
        vm.expectRevert(DocksPlots.StillValid.selector);
        reg.clear(10);
        act.set(10, 0);
        reg.clear(10);
        assertEq(reg.memberCount(plotOf[bob]), 0);
    }

    function testInactiveCannotPlace() public {
        act.set(3, 0);
        vm.expectRevert(DocksPlots.NotActive.selector);
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
        vm.expectRevert(DocksPlots.NotLoadingZone.selector);
        reg.dock(plotOf[bob], 5, 5);
        vm.prank(bob);
        vm.expectRevert(DocksPlots.BerthTaken.selector);
        reg.dock(plotOf[bob], 0, 0);
        assertTrue(reg.isLoadingZone(1, 0));
        _dock(bob, 1, 0);
        assertTrue(reg.connected(plotOf[alice], plotOf[bob]));
        _dock(carol, 2, 0);
        assertFalse(reg.connected(plotOf[alice], plotOf[carol]));
        // move alice's island to the other side of carol
        _dock(alice, 3, 0);
        assertEq(reg.plotAtBerth(0, 0), 0);
        assertTrue(reg.connected(plotOf[alice], plotOf[carol]));
        assertEq(reg.dockedCount(), 3);
    }

    function testEmptyIslandCannotDock() public {
        vm.prank(alice);
        vm.expectRevert(DocksPlots.EmptyPlot.selector);
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
        vm.expectRevert(DocksPlots.AlreadyConnected.selector);
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
        reg.setPlot(plotOf[alice], "Alice Market", true);
        assertFalse(reg.canVisit(plotOf[alice], bob));
        vm.prank(alice);
        reg.setVisitor(plotOf[alice], bob, true);
        assertTrue(reg.canVisit(plotOf[alice], bob));
        assertFalse(reg.canVisit(plotOf[alice], carol));
        vm.prank(bob);
        vm.expectRevert(DocksPlots.NotPlotOwner.selector);
        reg.setPlot(plotOf[alice], "mine now", false);
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
        p.airdropScope = DocksLaunchpad.Scope.PlotAndNeighbours;
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

    function testHolderPlotScope() public {
        _world();
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.HolderPlot));
        vm.prank(alice);
        pad.claim(id, 2);
        vm.prank(bob);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 10);
    }

    function testNeighbourScopeIncludesBridges() public {
        _world();
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.PlotAndNeighbours));
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
        reg.setPlot(plotOf[alice], "", true);
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
        DocksLaunchpad.LaunchParams memory p = _params(Scope_.HolderPlot);
        p.creatorFriendId = 1000;
        p.claimEach = 100 ether;
        vm.prank(alice);
        uint256 id = pad.launch(p);
        vm.prank(alice);
        assertEq(pad.claimMany(id, ids), n);
    }
}
