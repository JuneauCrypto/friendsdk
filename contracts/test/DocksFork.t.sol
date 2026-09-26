// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { DocksRegistry, IDocksGenerations } from "../src/docks/DocksRegistry.sol";
import { DocksLaunchpad } from "../src/docks/DocksLaunchpad.sol";

/// @notice Local mainnet-fork check of The Docks against the real Generations, activation
/// manager and RF. Set FRIENDSDK_FORK_RPC to run; nothing leaves the local fork.
contract DocksForkTest is Test {
    address private constant RF = 0x0779369854d3EcdEA927206718FFD7730C67B71f;
    address private constant GENERATIONS = 0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D;

    function testForkPlaceLaunchClaim() public {
        string memory rpc = vm.envOr("FRIENDSDK_FORK_RPC", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);
        IDocksGenerations gen = IDocksGenerations(GENERATIONS);
        DocksRegistry reg = new DocksRegistry(gen);
        DocksLaunchpad pad = new DocksLaunchpad(IERC20(RF), reg, address(0x7EA));

        assertTrue(reg.isActive(67111));
        assertTrue(reg.isActive(7153));
        assertFalse(reg.isActive(1));

        address a = gen.ownerOf(67111);
        address b = gen.ownerOf(7153);
        uint256[] memory ids = new uint256[](1);
        int32[] memory xs = new int32[](1);
        int32[] memory ys = new int32[](1);
        ids[0] = 67111;
        vm.prank(a);
        reg.place(ids, xs, ys);
        ids[0] = 7153;
        xs[0] = 5; // #67111 is Gen 2: 5 cells wide
        vm.prank(b);
        reg.place(ids, xs, ys);
        assertTrue(reg.adjacent(67111, 7153));

        deal(RF, a, 2000 ether);
        deal(RF, b, 10 ether);
        vm.prank(a);
        IERC20(RF).approve(address(pad), type(uint256).max);
        vm.prank(b);
        IERC20(RF).approve(address(pad), type(uint256).max);

        DocksLaunchpad.LaunchParams memory p;
        p.name = "Market Coin";
        p.symbol = "MKT";
        p.creatorFriendId = 67111;
        p.supply = 1_000_000 ether;
        p.claimPool = 10_000 ether;
        p.claimEach = 100 ether;
        p.claimPrice = 1 ether;
        p.scope = DocksLaunchpad.Scope.PlotAndNeighbours;
        vm.prank(a);
        uint256 id = pad.launch(p);
        vm.prank(b);
        pad.claim(id, 7153, 67111);
        IERC20 t = IERC20(address(pad.launches(id).token));
        assertEq(t.balanceOf(gen.tokenBoundAccount(7153)), 100 ether);
        assertEq(t.balanceOf(gen.tokenBoundAccount(67111)), 990_000 ether);
    }
}
