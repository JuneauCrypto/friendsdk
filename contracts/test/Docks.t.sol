// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import { DocksRegistry, IDocksGenerations } from "../src/docks/DocksRegistry.sol";
import { DocksLaunchpad, DocksToken } from "../src/docks/DocksLaunchpad.sol";

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
    address public activationManager;

    constructor(address manager) {
        activationManager = manager;
    }

    function set(uint256 id, address owner) external {
        owners[id] = owner;
    }

    function ownerOf(uint256 id) external view returns (address) {
        require(owners[id] != address(0), "nonexistent");
        return owners[id];
    }

    mapping(uint256 => uint8) public gens;

    function setGen(uint256 id, uint8 g) external {
        gens[id] = g;
    }

    function generation(uint256 id) external view returns (uint8) {
        return gens[id] == 0 ? 6 : gens[id];
    }

    function tokenBoundAccount(uint256 id) external pure returns (address) {
        return address(uint160(0xB0B000 + id));
    }
}

contract DocksTest is Test {
    MockRF rf;
    MockActivation act;
    MockGenerations gen;
    DocksRegistry reg;
    DocksLaunchpad pad;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address treasury = address(0x7EA);

    function setUp() public {
        rf = new MockRF();
        act = new MockActivation();
        gen = new MockGenerations(address(act));
        reg = new DocksRegistry(IDocksGenerations(address(gen)));
        pad = new DocksLaunchpad(IERC20(address(rf)), reg, treasury);
        _friend(1, alice);
        _friend(2, alice);
        _friend(3, alice);
        _friend(10, bob);
        _friend(20, carol);
        for (uint256 i; i < 3; ++i) {
            address a = [alice, bob, carol][i];
            rf.mint(a, 10_000 ether);
            vm.prank(a);
            rf.approve(address(pad), type(uint256).max);
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
        reg.place(_one(id), _i(x), _i(y));
    }

    function testPlaceMoveAndDock() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        _place(bob, 10, 2, 0);
        assertTrue(reg.adjacent(2, 10));
        assertFalse(reg.adjacent(1, 10));
        (bool occ, uint256 id) = reg.friendAt(1, 0);
        assertTrue(occ);
        assertEq(id, 2);
        assertEq(reg.placedCount(), 3);
        // move 2 away, old cell frees
        _place(alice, 2, 5, 5);
        (occ,) = reg.friendAt(1, 0);
        assertFalse(occ);
        assertEq(reg.placedCount(), 3);
    }

    function testCannotTakeOthersCellOrFriend() public {
        _place(bob, 10, 0, 0);
        vm.expectRevert(DocksRegistry.CellTaken.selector);
        _place(alice, 1, 0, 0);
        vm.expectRevert(DocksRegistry.NotHolder.selector);
        _place(alice, 10, 3, 3);
    }

    function testInactiveCannotPlace() public {
        act.set(3, 0);
        vm.expectRevert(DocksRegistry.NotActive.selector);
        _place(alice, 3, 0, 0);
    }

    function testGangMovesTogetherSwappingCells() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        int32[] memory xs = new int32[](2);
        xs[0] = 1; // 1 moves into 2's old cell
        xs[1] = 2;
        int32[] memory ys = new int32[](2);
        vm.prank(alice);
        reg.place(ids, xs, ys);
        (, uint256 at1) = reg.friendAt(1, 0);
        (, uint256 at2) = reg.friendAt(2, 0);
        assertEq(at1, 1);
        assertEq(at2, 2);
        (bool occ,) = reg.friendAt(0, 0);
        assertFalse(occ);
    }

    function testSoldFriendGoesStaleAndCellFrees() public {
        _place(bob, 10, 0, 0);
        gen.set(10, carol); // sold on the marketplace
        assertFalse(reg.isValid(10));
        _place(alice, 1, 0, 0); // stale occupant gives way
        (, uint256 id) = reg.friendAt(0, 0);
        assertEq(id, 1);
        (,,, bool placed) = reg.spotOf(10);
        assertFalse(placed);
    }

    function testClearOnlyWhenStale() public {
        _place(bob, 10, 0, 0);
        vm.expectRevert(DocksRegistry.StillValid.selector);
        reg.clear(10);
        act.set(10, 0);
        reg.clear(10);
        assertEq(reg.placedCount(), 0);
    }

    function testAccess() public {
        assertTrue(reg.canVisit(alice, bob));
        vm.prank(alice);
        reg.setPlot("Alice Market", true);
        assertFalse(reg.canVisit(alice, bob));
        vm.prank(alice);
        reg.setVisitor(bob, true);
        assertTrue(reg.canVisit(alice, bob));
        assertFalse(reg.canVisit(alice, carol));
    }

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

    enum Scope_ {
        AnyDocked,
        HolderPlot,
        PlotAndNeighbours,
        Visitors
    }

    function _two(uint256 x, uint256 y) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = x;
        a[1] = y;
    }

    function testLaunchChargesFeeAirdropsInBatchesAndSendsRestToFriendWallet() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        _place(bob, 10, 2, 0); // docked to alice's #2
        _place(carol, 20, 9, 9); // far away
        DocksLaunchpad.LaunchParams memory p = _params(Scope_.AnyDocked);
        p.airdropPool = 1000 ether;
        p.airdropEach = 50 ether;
        p.airdropScope = DocksLaunchpad.Scope.PlotAndNeighbours;
        uint256 burnBefore = rf.balanceOf(pad.BURN());
        vm.prank(alice);
        uint256 id = pad.launch(p);
        assertEq(rf.balanceOf(pad.BURN()) - burnBefore, 500 ether);
        assertEq(rf.balanceOf(treasury), 500 ether);
        assertEq(rf.balanceOf(alice), 9000 ether);
        IERC20 t = IERC20(address(pad.launches(id).token));
        assertEq(t.balanceOf(gen.tokenBoundAccount(1)), 1_000_000 ether - 1000 ether - 100_000 ether);

        vm.prank(bob);
        vm.expectRevert(DocksLaunchpad.NotCreator.selector);
        pad.airdrop(id, _one(10), _one(2));

        // #20 is not a neighbour and is skipped; #2 and #10 (via #2) receive; repeats are skipped
        uint256[] memory ids = new uint256[](4);
        ids[0] = 2;
        ids[1] = 10;
        ids[2] = 20;
        ids[3] = 2;
        uint256[] memory vias = new uint256[](4);
        vias[1] = 2;
        vm.prank(alice);
        assertEq(pad.airdrop(id, ids, vias), 2);
        assertEq(t.balanceOf(gen.tokenBoundAccount(2)), 50 ether);
        assertEq(t.balanceOf(gen.tokenBoundAccount(10)), 50 ether);
        assertEq(t.balanceOf(gen.tokenBoundAccount(20)), 0);
        vm.prank(alice);
        pad.endAirdrop(id);
        assertEq(t.balanceOf(gen.tokenBoundAccount(1)), 1_000_000 ether - 100 ether - 100_000 ether);
    }

    function testClaimManyChargesOnlyForClaimsMade() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        _place(alice, 3, 2, 0);
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.AnyDocked));
        vm.prank(alice);
        pad.claim(id, 2, 0);
        uint256 rfBefore = rf.balanceOf(alice);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 2; // already claimed: skipped
        ids[2] = 3;
        vm.prank(alice);
        assertEq(pad.claimMany(id, ids, new uint256[](3)), 2);
        assertEq(rfBefore - rf.balanceOf(alice), 10 ether);
        vm.prank(bob);
        vm.expectRevert(DocksLaunchpad.NotHolder.selector);
        pad.claimMany(id, _one(1), _one(0));
    }

    /// A big holder: 300 Gen 6 Friends placed in one transaction, then claimed for in one.
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
        vm.prank(alice);
        reg.place(ids, xs, ys);
        assertEq(reg.placedCount(), n);
        DocksLaunchpad.LaunchParams memory p = _params(Scope_.HolderPlot);
        p.creatorFriendId = 1000;
        p.claimEach = 100 ether;
        vm.prank(alice);
        uint256 id = pad.launch(p);
        vm.prank(alice);
        assertEq(pad.claimMany(id, ids, new uint256[](n)), n);
        assertEq(rf.balanceOf(pad.BURN()), 500 ether + n * 5 ether);
    }

    function testLaunchNeedsDockedFriendYouHold() public {
        DocksLaunchpad.LaunchParams memory p = _params(Scope_.AnyDocked);
        vm.prank(alice);
        vm.expectRevert(DocksLaunchpad.NotDocked.selector);
        pad.launch(p);
        _place(alice, 1, 0, 0);
        vm.prank(bob);
        vm.expectRevert(DocksLaunchpad.NotHolder.selector);
        pad.launch(p);
    }

    function testBadAllocationReverts() public {
        _place(alice, 1, 0, 0);
        DocksLaunchpad.LaunchParams memory p = _params(Scope_.AnyDocked);
        p.claimPool = p.supply + 1;
        vm.prank(alice);
        vm.expectRevert(DocksLaunchpad.BadAllocation.selector);
        pad.launch(p);
    }

    function testClaimBurnsRFOncePerFriend() public {
        _place(alice, 1, 0, 0);
        _place(bob, 10, 7, 7);
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.AnyDocked));
        uint256 burnBefore = rf.balanceOf(pad.BURN());
        vm.prank(bob);
        pad.claim(id, 10, 0);
        assertEq(rf.balanceOf(pad.BURN()) - burnBefore, 5 ether);
        IERC20 t = IERC20(address(pad.launches(id).token));
        assertEq(t.balanceOf(gen.tokenBoundAccount(10)), 1000 ether);
        vm.prank(bob);
        vm.expectRevert(DocksLaunchpad.AlreadyClaimed.selector);
        pad.claim(id, 10, 0);
    }

    function testUndockedCannotClaim() public {
        _place(alice, 1, 0, 0);
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.AnyDocked));
        vm.prank(carol);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 20, 0);
    }

    function testHolderPlotScope() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        _place(bob, 10, 2, 0);
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.HolderPlot));
        vm.prank(alice);
        pad.claim(id, 2, 0);
        vm.prank(bob);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 10, 0);
    }

    function testNeighbourScope() public {
        _place(alice, 1, 0, 0);
        _place(alice, 2, 1, 0);
        _place(bob, 10, 2, 0); // docked to alice's #2
        _place(carol, 20, 9, 9); // far away
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.PlotAndNeighbours));
        vm.prank(bob);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 10, 1); // #1 is not next to #10
        vm.prank(bob);
        pad.claim(id, 10, 2);
        vm.prank(carol);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 20, 2);
    }

    function testVisitorScope() public {
        _place(alice, 1, 0, 0);
        _place(bob, 10, 5, 5);
        _place(carol, 20, 9, 9);
        vm.prank(alice);
        reg.setPlot("", true);
        vm.prank(alice);
        reg.setVisitor(bob, true);
        vm.prank(alice);
        uint256 id = pad.launch(_params(Scope_.Visitors));
        vm.prank(bob);
        pad.claim(id, 10, 0);
        vm.prank(carol);
        vm.expectRevert(DocksLaunchpad.NotEligible.selector);
        pad.claim(id, 20, 0);
    }

    function testFriendWalletCanClaimAndPoolEmpties() public {
        _place(alice, 1, 0, 0);
        _place(bob, 10, 5, 5);
        DocksLaunchpad.LaunchParams memory p = _params(Scope_.AnyDocked);
        p.claimPool = 1000 ether;
        vm.prank(alice);
        uint256 id = pad.launch(p);
        address wallet = gen.tokenBoundAccount(10);
        rf.mint(wallet, 5 ether);
        vm.prank(wallet);
        rf.approve(address(pad), 5 ether);
        vm.prank(wallet);
        pad.claim(id, 10, 0);
        vm.prank(alice);
        vm.expectRevert(DocksLaunchpad.PoolEmpty.selector);
        pad.claim(id, 1, 0);
    }

    function testTrueSizeFootprintsDockEdgeToEdge() public {
        gen.setGen(1, 3); // 5x4 cells
        gen.setGen(10, 2); // 5x5 cells
        _place(alice, 1, 0, 0);
        (, uint256 at) = reg.friendAt(4, 3);
        assertEq(at, 1);
        vm.expectRevert(DocksRegistry.CellTaken.selector);
        _place(bob, 10, 4, 3); // overlaps
        _place(bob, 10, 5, 2); // flush against the right edge
        assertTrue(reg.adjacent(1, 10));
        _place(bob, 10, 5, 4); // only touches at a corner
        assertFalse(reg.adjacent(1, 10));
        (bool occ,) = reg.friendAt(5, 2);
        assertFalse(occ); // old cells freed on move
    }

    function testPlacedPageMarksStale() public {
        _place(alice, 1, 0, 0);
        _place(bob, 10, 1, 0);
        act.set(10, 0);
        (uint256[] memory ids,, bool[] memory valid) = reg.placedPage(0, 10);
        assertEq(ids.length, 2);
        assertTrue(valid[0]);
        assertFalse(valid[1]);
    }
}
