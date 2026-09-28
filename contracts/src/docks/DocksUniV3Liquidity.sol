// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { IDocksLiquidity, IDocksBuyback } from "./DocksVillageTreasury.sol";

interface IUniV3Factory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

interface IUniV3Pool {
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function tickSpacing() external view returns (int24);
}

interface IUniV3PositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata p)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata p) external payable returns (uint256 amount0, uint256 amount1);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut);
}

/// @notice A village's permanent RF/WETH liquidity on Uniswap v3 (live on Robinhood Chain).
///
/// `provide` puts the village's RF into the RF/WETH pool one-sided: a range that starts just
/// past today's price and runs to the end of the curve, so it holds only RF and needs no ETH.
/// As people buy RF with ETH, the position sells into them and fills with ETH, earning the
/// pool fee on every trade through it. The position NFT stays in this contract, and this
/// contract has no function that removes liquidity, so the village's liquidity can never be
/// pulled. `collect` only takes the fees.
///
/// Also the treasury's buyback: `buyRf` swaps WETH for RF in the same pool.
/// @dev The RF/WETH pool at `fee` must already exist and be initialized.
contract DocksUniV3Liquidity is IDocksLiquidity, IDocksBuyback {
    using SafeERC20 for IERC20;

    int24 private constant MIN_TICK = -887_272;
    int24 private constant MAX_TICK = 887_272;

    error NotTreasury();
    error NoPool();
    error AlreadyInitialized();

    event Provided(uint256 indexed villageId, uint256 indexed positionId, int24 tickLower, int24 tickUpper, uint256 rf);

    IERC20 public immutable rf;
    IERC20 public immutable weth;
    IUniV3Factory public immutable factory;
    IUniV3PositionManager public immutable positions;
    ISwapRouter02 public immutable router;
    uint24 public immutable fee;
    bool public immutable rfIsToken0;
    address private immutable _deployer;
    address public treasury;

    mapping(uint256 villageId => uint256[]) private _positionsOf;

    constructor(
        IERC20 rf_,
        IERC20 weth_,
        IUniV3Factory factory_,
        IUniV3PositionManager positions_,
        ISwapRouter02 router_,
        uint24 fee_
    ) {
        rf = rf_;
        weth = weth_;
        factory = factory_;
        positions = positions_;
        router = router_;
        fee = fee_;
        rfIsToken0 = address(rf_) < address(weth_);
        _deployer = msg.sender;
    }

    /// @notice One-time wiring to the treasury. No other admin.
    function init(address treasury_) external {
        if (msg.sender != _deployer || treasury != address(0)) revert AlreadyInitialized();
        treasury = treasury_;
    }

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotTreasury();
        _;
    }

    /// @inheritdoc IDocksLiquidity
    function provide(uint256 villageId, uint256 rfAmount) external onlyTreasury returns (uint256 used) {
        (int24 lower, int24 upper) = oneSidedRange();
        rf.safeTransferFrom(msg.sender, address(this), rfAmount);
        rf.forceApprove(address(positions), rfAmount);
        (address t0, address t1) = rfIsToken0 ? (address(rf), address(weth)) : (address(weth), address(rf));
        (uint256 tokenId,, uint256 a0, uint256 a1) = positions.mint(
            IUniV3PositionManager.MintParams(
                t0,
                t1,
                fee,
                lower,
                upper,
                rfIsToken0 ? rfAmount : 0,
                rfIsToken0 ? 0 : rfAmount,
                0,
                0,
                address(this),
                block.timestamp
            )
        );
        rf.forceApprove(address(positions), 0);
        used = rfIsToken0 ? a0 : a1;
        if (used < rfAmount) rf.safeTransfer(msg.sender, rfAmount - used);
        _positionsOf[villageId].push(tokenId);
        emit Provided(villageId, tokenId, lower, upper, used);
    }

    /// @inheritdoc IDocksLiquidity
    function collect(uint256 villageId, address to) external onlyTreasury returns (uint256 rfFees, uint256 wethFees) {
        uint256[] storage ids = _positionsOf[villageId];
        for (uint256 i; i < ids.length; ++i) {
            (uint256 a0, uint256 a1) = positions.collect(
                IUniV3PositionManager.CollectParams(ids[i], to, type(uint128).max, type(uint128).max)
            );
            (uint256 r, uint256 w) = rfIsToken0 ? (a0, a1) : (a1, a0);
            rfFees += r;
            wethFees += w;
        }
    }

    /// @inheritdoc IDocksBuyback
    function buyRf(uint256 wethIn, uint256 minRfOut, address to) external onlyTreasury returns (uint256 rfOut) {
        weth.safeTransferFrom(msg.sender, address(this), wethIn);
        weth.forceApprove(address(router), wethIn);
        rfOut = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(address(weth), address(rf), fee, to, wethIn, minRfOut, 0)
        );
    }

    /// @notice The range a village's RF goes into right now: from the first tick past the
    /// current price (on the side where the position holds only RF) to the end of the curve.
    function oneSidedRange() public view returns (int24 lower, int24 upper) {
        address pool = factory.getPool(address(rf), address(weth), fee);
        if (pool == address(0)) revert NoPool();
        (uint160 sqrtP, int24 tick,,,,,) = IUniV3Pool(pool).slot0();
        if (sqrtP == 0) revert NoPool();
        int24 s = IUniV3Pool(pool).tickSpacing();
        int24 floorTick = tick / s * s;
        if (tick < 0 && tick % s != 0) floorTick -= s;
        if (rfIsToken0) {
            // token0 only: the whole range above the current tick
            lower = floorTick + s;
            upper = MAX_TICK / s * s;
        } else {
            // token1 only: the whole range at or below the current tick
            lower = MIN_TICK / s * s;
            upper = floorTick;
        }
    }

    function positionsOf(uint256 villageId) external view returns (uint256[] memory) {
        return _positionsOf[villageId];
    }

    /// @dev Uniswap position NFTs are minted with _mint, but accept safe transfers just in case.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
