// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { DocksVillages, IDocksVillageTreasury } from "./DocksVillages.sol";

/// @notice Permanent RF liquidity for a village. `provide` takes RF and keeps it as liquidity
/// forever (there is deliberately no way to remove it); `collect` sends the trading fees earned
/// so far to `to` as (RF, WETH).
interface IDocksLiquidity {
    function provide(uint256 villageId, uint256 rfAmount) external returns (uint256 used);
    function collect(uint256 villageId, address to) external returns (uint256 rfFees, uint256 wethFees);
}

/// @notice Buys RF with WETH (on Robinhood Chain: a Uniswap v3 swap through SwapRouter02).
interface IDocksBuyback {
    function buyRf(uint256 wethIn, uint256 minRfOut, address to) external returns (uint256 rfOut);
}

/// @notice Village treasuries.
///
/// When a village is founded, half its flag's RF lands here as the village treasury (RF only)
/// and half becomes permanent liquidity (IDocksLiquidity). Enrollment fees are split the same
/// way: half to the treasury, half queued and added to liquidity by `provideLiquidity`.
/// `harvest` collects the liquidity's trading fees, buys RF back with the WETH part, burns the
/// village's burn share (half by default) and adds the rest to the treasury. Spending and the
/// burn share are decided by the village's votes in DocksVillages; nothing else moves the RF.
contract DocksVillageTreasury is IDocksVillageTreasury, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint16 public constant DEFAULT_BURN_BPS = 5000; // half of every buyback burned

    error NotVillages();
    error NotMember();
    error NotFounded();
    error NoFunds();

    event VillageFunded(uint256 indexed villageId, uint256 treasuryRf, uint256 liquidityRf);
    event Deposited(uint256 indexed villageId, uint256 treasuryRf, uint256 queuedForLiquidity);
    event LiquidityAdded(uint256 indexed villageId, uint256 rf);
    event Harvested(uint256 indexed villageId, uint256 rfFees, uint256 wethFees, uint256 rfBought, uint256 burned, uint256 toTreasury);
    event Spent(uint256 indexed villageId, address indexed to, uint256 amount);
    event BurnShareSet(uint256 indexed villageId, uint16 burnBps);

    IERC20 public immutable rf;
    IERC20 public immutable weth;
    DocksVillages public immutable villages;
    IDocksLiquidity public immutable liquidity;
    IDocksBuyback public immutable buyback;

    mapping(uint256 villageId => uint256) public balanceOf; // treasury RF
    mapping(uint256 villageId => uint256) public pendingLiquidity;
    mapping(uint256 villageId => bool) public funded;
    mapping(uint256 villageId => uint16) private _burnBps; // stored +1 so 0 can mean "unset"

    constructor(IERC20 rf_, IERC20 weth_, DocksVillages villages_, IDocksLiquidity liquidity_, IDocksBuyback buyback_) {
        rf = rf_;
        weth = weth_;
        villages = villages_;
        liquidity = liquidity_;
        buyback = buyback_;
    }

    modifier onlyVillages() {
        if (msg.sender != address(villages)) revert NotVillages();
        _;
    }

    /// @inheritdoc IDocksVillageTreasury
    function found(uint256 villageId, uint256 treasuryRf, uint256 liquidityRf) external onlyVillages nonReentrant {
        funded[villageId] = true;
        balanceOf[villageId] += treasuryRf + (liquidityRf - _provide(villageId, liquidityRf));
        emit VillageFunded(villageId, treasuryRf, liquidityRf);
    }

    /// @inheritdoc IDocksVillageTreasury
    function deposit(uint256 villageId, uint256 amount) external onlyVillages {
        uint256 toTreasury = amount / 2;
        balanceOf[villageId] += toTreasury;
        pendingLiquidity[villageId] += amount - toTreasury;
        emit Deposited(villageId, toTreasury, amount - toTreasury);
    }

    /// @notice Add the enrollment RF queued for a village to its permanent liquidity. Anyone.
    function provideLiquidity(uint256 villageId) external nonReentrant {
        uint256 amount = pendingLiquidity[villageId];
        if (amount == 0) revert NoFunds();
        pendingLiquidity[villageId] = 0;
        balanceOf[villageId] += amount - _provide(villageId, amount);
    }

    /// @inheritdoc IDocksVillageTreasury
    function spend(uint256 villageId, address to, uint256 amount) external onlyVillages {
        if (balanceOf[villageId] < amount) revert NoFunds();
        balanceOf[villageId] -= amount;
        rf.safeTransfer(to, amount);
        emit Spent(villageId, to, amount);
    }

    /// @inheritdoc IDocksVillageTreasury
    function setBurnBps(uint256 villageId, uint16 burnBps) external onlyVillages {
        _burnBps[villageId] = burnBps + 1;
        emit BurnShareSet(villageId, burnBps);
    }

    /// @notice Collect the village's trading fees, buy RF with the WETH part, burn the
    /// village's burn share and add the rest to its treasury. Members only, since they set
    /// the minimum RF the buyback must return.
    function harvest(uint256 villageId, uint256 minRfOut) external nonReentrant returns (uint256 burned, uint256 kept) {
        if (!funded[villageId]) revert NotFounded();
        if (!villages.inVillage(villageId, msg.sender)) revert NotMember();
        (uint256 rfFees, uint256 wethFees) = liquidity.collect(villageId, address(this));
        uint256 bought;
        if (wethFees > 0) {
            weth.forceApprove(address(buyback), wethFees);
            bought = buyback.buyRf(wethFees, minRfOut, address(this));
        }
        uint256 total = rfFees + bought;
        burned = total * burnBpsOf(villageId) / 10_000;
        kept = total - burned;
        if (burned > 0) rf.safeTransfer(BURN, burned);
        balanceOf[villageId] += kept;
        emit Harvested(villageId, rfFees, wethFees, bought, burned, kept);
    }

    function burnBpsOf(uint256 villageId) public view returns (uint16) {
        uint16 b = _burnBps[villageId];
        return b == 0 ? DEFAULT_BURN_BPS : b - 1;
    }

    /// @dev Returns the RF actually used (any rounding dust stays with the village).
    function _provide(uint256 villageId, uint256 amount) private returns (uint256 used) {
        rf.forceApprove(address(liquidity), amount);
        used = liquidity.provide(villageId, amount);
        rf.forceApprove(address(liquidity), 0);
        emit LiquidityAdded(villageId, used);
    }
}
