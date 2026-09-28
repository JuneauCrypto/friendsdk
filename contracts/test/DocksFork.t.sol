// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { DocksIslands, IDocksGenerations } from "../src/docks/DocksIslands.sol";
import { DocksLaunchpad } from "../src/docks/DocksLaunchpad.sol";
import { DocksVillages, IDocksVillageItems } from "../src/docks/DocksVillages.sol";
import { DocksVillageTreasury, IDocksLiquidity, IDocksBuyback } from "../src/docks/DocksVillageTreasury.sol";
import {
    DocksUniV3Liquidity, IUniV3Factory, IUniV3Pool, IUniV3PositionManager, ISwapRouter02
} from "../src/docks/DocksUniV3Liquidity.sol";

interface IUniV3FactoryFull {
    function createPool(address a, address b, uint24 fee) external returns (address);
}

interface IUniV3PoolInit {
    function initialize(uint160 sqrtPriceX96) external;
}

interface IPositionsRead {
    function positions(uint256 id)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128 liquidity, uint256, uint256, uint128, uint128);
}

/// @notice Local mainnet-fork check of The Docks against the real Generations, activation
/// manager and RF. Set FRIENDSDK_FORK_RPC to run; nothing leaves the local fork.
contract DocksForkTest is Test {
    address private constant RF = 0x0779369854d3EcdEA927206718FFD7730C67B71f;
    address private constant GENERATIONS = 0x14C49e6118F46525dE9ab41a51cBAA3c6EBF181D;
    // Uniswap v3 on Robinhood Chain (github.com/Uniswap/contracts deployments/4663)
    address private constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address private constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address private constant V3_POSITIONS = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address private constant SWAP_ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;

    function testForkPlaceLaunchClaim() public {
        string memory rpc = vm.envOr("FRIENDSDK_FORK_RPC", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);
        IDocksGenerations gen = IDocksGenerations(GENERATIONS);
        DocksIslands reg = new DocksIslands(gen, IERC20(RF));
        DocksLaunchpad pad = new DocksLaunchpad(IERC20(RF), reg, new DocksVillages(IERC20(RF), reg, 1_000_000 ether, 30 days, 1000 ether, 10_000 ether), address(0x7EA));

        assertTrue(reg.isActive(67111));
        assertTrue(reg.isActive(7153));
        assertFalse(reg.isActive(1));

        address a = gen.ownerOf(67111);
        address b = gen.ownerOf(7153);
        _dock(reg, address(pad), a, b);
        DocksLaunchpad.LaunchParams memory p;
        p.name = "Market Coin";
        p.symbol = "MKT";
        p.creatorFriendId = 67111;
        p.supply = 1_000_000 ether;
        p.claimPool = 10_000 ether;
        p.claimEach = 100 ether;
        p.claimPrice = 1 ether;
        p.scope = DocksLaunchpad.Scope.IslandAndNeighbours;
        vm.prank(a);
        uint256 id = pad.launch(p);
        vm.prank(b);
        pad.claim(id, 7153);
        IERC20 t = IERC20(address(pad.launches(id).token));
        assertEq(t.balanceOf(gen.tokenBoundAccount(7153)), 100 ether);
        assertEq(t.balanceOf(gen.tokenBoundAccount(67111)), 990_000 ether);
    }

    function _dock(DocksIslands reg, address pad, address a, address b) private returns (uint256 plotA, uint256 plotB) {
        deal(RF, a, 2000 ether);
        deal(RF, b, 100 ether);
        uint256[] memory ids = new uint256[](1);
        int32[] memory xs = new int32[](1);
        int32[] memory ys = new int32[](1);
        ids[0] = 67111;
        vm.startPrank(a);
        IERC20(RF).approve(address(reg), type(uint256).max);
        IERC20(RF).approve(address(pad), type(uint256).max);
        plotA = reg.create("Market");
        uint256 burnBefore = IERC20(RF).balanceOf(reg.BURN());
        reg.arrange(plotA, ids, xs, ys); // Gen 2: burns 50 RF
        reg.dock(plotA, 0, 0);
        vm.stopPrank();
        assertEq(IERC20(RF).balanceOf(reg.BURN()) - burnBefore, 50 ether);
        ids[0] = 7153;
        xs[0] = 0; // its own island's grid
        vm.startPrank(b);
        IERC20(RF).approve(address(reg), type(uint256).max);
        IERC20(RF).approve(address(pad), type(uint256).max);
        plotB = reg.create("Reading Row");
        reg.arrange(plotB, ids, xs, ys); // Gen 3: burns 20 RF
        reg.dock(plotB, 1, 0); // loading zone next to the Market island
        vm.stopPrank();
        assertTrue(reg.connected(plotA, plotB));
        assertEq(reg.ownerOf(plotA), a);
    }

    /// A village founded on the real chain: its liquidity half goes one-sided into a real
    /// Uniswap v3 RF/WETH pool, traders buy through it, and the harvest buys back and burns RF.
    function testForkVillageOnUniswap() public {
        string memory rpc = vm.envOr("FRIENDSDK_FORK_RPC", string(""));
        vm.skip(bytes(rpc).length == 0);
        vm.createSelectFork(rpc);
        IDocksGenerations gen = IDocksGenerations(GENERATIONS);
        DocksIslands reg = new DocksIslands(gen, IERC20(RF));
        DocksVillages vil = new DocksVillages(IERC20(RF), reg, 1_000_000 ether, 30 days, 1000 ether, 10_000 ether);
        DocksUniV3Liquidity liq = new DocksUniV3Liquidity(
            IERC20(RF), IERC20(WETH), IUniV3Factory(V3_FACTORY), IUniV3PositionManager(V3_POSITIONS), ISwapRouter02(SWAP_ROUTER02), 3000
        );
        DocksVillageTreasury tre = new DocksVillageTreasury(IERC20(RF), IERC20(WETH), vil, liq, liq);
        vil.init(tre, IDocksVillageItems(address(0)));
        reg.init(vil);
        liq.init(address(tre));

        address pool = _seedPool();
        address a = gen.ownerOf(67111);
        address b = gen.ownerOf(7153);
        (uint256 plotA, uint256 plotB) = _dock(reg, address(0xBEEF), a, b);

        deal(RF, a, 400_000 ether);
        vm.startPrank(a);
        IERC20(RF).approve(address(vil), type(uint256).max);
        uint256 v = vil.plant(plotA, "Market Town", 0, 0, 400_000 ether);
        vm.stopPrank();
        deal(RF, b, 600_000 ether);
        vm.startPrank(b);
        IERC20(RF).approve(address(vil), type(uint256).max);
        vil.lock(v, 600_000 ether);
        vm.stopPrank();
        (, int24 tickBefore,,,,,) = IUniV3Pool(pool).slot0();
        vil.found(v);
        assertEq(tre.allowanceOf(v, a) + tre.allowanceOf(v, b), 500_000 ether, "half to allowances");
        uint256[] memory pos = liq.positionsOf(v);
        assertEq(pos.length, 1);
        (,,,,, int24 lower,, uint128 liquidity,,,,) = IPositionsRead(V3_POSITIONS).positions(pos[0]);
        assertGt(liquidity, 0);
        assertGt(lower, tickBefore, "one-sided: only RF, just above the price");

        vm.prank(b);
        vil.bring(v, plotB);
        assertTrue(vil.sameVillage(plotA, plotB));

        _tradeThrough(pool, lower);
        _harvest(tre, v, a, b);
    }

    function _tradeThrough(address pool, int24 lower) private {
        address trader = address(0x7EAD);
        deal(WETH, trader, 50 ether);
        vm.startPrank(trader);
        IERC20(WETH).approve(SWAP_ROUTER02, type(uint256).max);
        ISwapRouter02(SWAP_ROUTER02).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(WETH, RF, 3000, trader, 50 ether, 0, 0)
        );
        vm.stopPrank();
        (, int24 tickAfter,,,,,) = IUniV3Pool(pool).slot0();
        assertGt(tickAfter, lower, "the price moved into the village's range");
    }

    function _harvest(DocksVillageTreasury tre, uint256 v, address a, address b) private {
        uint256 burnBefore = IERC20(RF).balanceOf(tre.BURN());
        uint256 before = tre.allowanceOf(v, a) + tre.allowanceOf(v, b);
        vm.prank(a);
        (uint256 burned, uint256 shared) = tre.harvest(v, 1);
        assertGt(burned, 0, "fees bought back RF and burned half");
        assertApproxEqAbs(burned, shared, 2);
        assertEq(IERC20(RF).balanceOf(tre.BURN()) - burnBefore, burned);
        assertEq(tre.allowanceOf(v, a) + tre.allowanceOf(v, b), before + shared, "the rest shared by Friends");
    }

    /// No RF/WETH v3 pool exists on chain yet: create one at 1 RF = 0.000001 ETH with some
    /// two-sided depth from an LP.
    function _seedPool() private returns (address pool) {
        pool = IUniV3Factory(V3_FACTORY).getPool(RF, WETH, 3000);
        if (pool == address(0)) {
            pool = IUniV3FactoryFull(V3_FACTORY).createPool(RF, WETH, 3000);
            IUniV3PoolInit(pool).initialize(79_228_162_514_264_337_593_543_950); // sqrt(1e-6) * 2^96
        }
        address lp = address(0x1111);
        deal(RF, lp, 2_000_000 ether);
        deal(WETH, lp, 2 ether);
        vm.startPrank(lp);
        IERC20(RF).approve(V3_POSITIONS, type(uint256).max);
        IERC20(WETH).approve(V3_POSITIONS, type(uint256).max);
        IUniV3PositionManager(V3_POSITIONS).mint(
            IUniV3PositionManager.MintParams(RF, WETH, 3000, -887_220, 887_220, 2_000_000 ether, 2 ether, 0, 0, lp, block.timestamp)
        );
        vm.stopPrank();
    }
}
