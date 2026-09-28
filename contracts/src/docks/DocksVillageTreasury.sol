// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { DocksVillages, IDocksVillageTreasury } from "./DocksVillages.sol";
import { DocksIslands } from "./DocksIslands.sol";

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

/// @notice Village treasuries: permanent liquidity plus each member's RF allowance.
///
/// Every RF that comes into a village is split: half becomes permanent liquidity, half the
/// allowance of whoever paid it. Founders' allowance is half of what they locked; an enrollee's
/// is half of their fee. Allowances are spent only on items placed on the member's island in
/// the village (DocksItems), and that RF goes to the village's liquidity too. When a member's
/// island leaves, their unspent allowance goes to the liquidity. `harvest` collects the
/// liquidity's trading fees, buys RF back with the WETH part, burns the village's burn share
/// (half by default, set by vote) and shares the rest between members by Friend count.
/// Nothing can be withdrawn.
contract DocksVillageTreasury is IDocksVillageTreasury, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint16 public constant DEFAULT_BURN_BPS = 5000; // half of every buyback burned

    error NotVillages();
    error NotItems();
    error NotMember();
    error NotFounded();
    error NoFunds();

    event VillageFunded(uint256 indexed villageId, uint256 allowances, uint256 liquidityRf);
    event Deposited(uint256 indexed villageId, address indexed wallet, uint256 allowance, uint256 queuedForLiquidity);
    event LiquidityQueued(uint256 indexed villageId, uint256 rf);
    event LiquidityAdded(uint256 indexed villageId, uint256 rf);
    event Harvested(uint256 indexed villageId, uint256 rfFees, uint256 wethFees, uint256 rfBought, uint256 burned, uint256 shared);
    event AllowanceSpent(uint256 indexed villageId, address indexed wallet, uint256 amount);
    event Forfeited(uint256 indexed villageId, address indexed wallet, uint256 amount);
    event BurnShareSet(uint256 indexed villageId, uint16 burnBps);

    IERC20 public immutable rf;
    IERC20 public immutable weth;
    DocksVillages public immutable villages;
    IDocksLiquidity public immutable liquidity;
    IDocksBuyback public immutable buyback;

    mapping(uint256 villageId => uint256) public pendingLiquidity;
    mapping(uint256 villageId => bool) public funded;
    mapping(uint256 villageId => mapping(address wallet => uint256)) public credited; // beyond the founder half
    mapping(uint256 villageId => mapping(address wallet => uint256)) public spent;
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

    modifier onlyItems() {
        if (msg.sender != address(villages.items())) revert NotItems();
        _;
    }

    /// @notice RF this wallet can still spend on items for its island in the village.
    function allowanceOf(uint256 villageId, address wallet) public view returns (uint256) {
        uint256 total = villages.weightOf(villageId, wallet) / 2 + credited[villageId][wallet];
        uint256 used = spent[villageId][wallet];
        return total > used ? total - used : 0;
    }

    /// @inheritdoc IDocksVillageTreasury
    function found(uint256 villageId, uint256 treasuryRf, uint256 liquidityRf) external onlyVillages nonReentrant {
        funded[villageId] = true;
        pendingLiquidity[villageId] += liquidityRf - _provide(villageId, liquidityRf);
        emit VillageFunded(villageId, treasuryRf, liquidityRf);
    }

    /// @inheritdoc IDocksVillageTreasury
    function deposit(uint256 villageId, address wallet, uint256 amount) external onlyVillages {
        uint256 half = amount / 2;
        credited[villageId][wallet] += half;
        pendingLiquidity[villageId] += amount - half;
        emit Deposited(villageId, wallet, half, amount - half);
    }

    /// @inheritdoc IDocksVillageTreasury
    function forfeit(uint256 villageId, address wallet) external onlyVillages {
        uint256 left = allowanceOf(villageId, wallet);
        spent[villageId][wallet] += left;
        pendingLiquidity[villageId] += left;
        emit Forfeited(villageId, wallet, left);
    }

    /// @inheritdoc IDocksVillageTreasury
    function setBurnBps(uint256 villageId, uint16 burnBps) external onlyVillages {
        _burnBps[villageId] = burnBps + 1;
        emit BurnShareSet(villageId, burnBps);
    }

    /// @notice An item bought with `wallet`'s allowance: its RF goes to the village's liquidity.
    function payFromAllowance(uint256 villageId, address wallet, uint256 amount) external onlyItems {
        if (allowanceOf(villageId, wallet) < amount) revert NoFunds();
        spent[villageId][wallet] += amount;
        pendingLiquidity[villageId] += amount;
        emit AllowanceSpent(villageId, wallet, amount);
    }

    /// @notice RF already sent here for a village's liquidity (items, tickets, boosts).
    function queueLiquidity(uint256 villageId, uint256 amount) external onlyItems {
        pendingLiquidity[villageId] += amount;
        emit LiquidityQueued(villageId, amount);
    }

    /// @notice Add the RF queued for a village to its permanent liquidity. Anyone.
    function provideLiquidity(uint256 villageId) external nonReentrant {
        uint256 amount = pendingLiquidity[villageId];
        if (amount == 0) revert NoFunds();
        pendingLiquidity[villageId] = amount - _provide(villageId, amount);
    }

    /// @notice Collect the village's trading fees, buy RF with the WETH part, burn the
    /// village's burn share and share the rest between members by Friend count. Members only,
    /// since they set the minimum RF the buyback must return.
    function harvest(uint256 villageId, uint256 minRfOut) external nonReentrant returns (uint256 burned, uint256 shared) {
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
        if (burned > 0) rf.safeTransfer(BURN, burned);
        shared = _share(villageId, total - burned);
        emit Harvested(villageId, rfFees, wethFees, bought, burned, shared);
    }

    /// @dev Credits `amount` to members by Friend count; any rest (rounding, or nobody to
    /// share with) goes to the village's liquidity.
    function _share(uint256 villageId, uint256 amount) private returns (uint256 shared) {
        uint256 pop = villages.population(villageId);
        address[] memory m = villages.members(villageId);
        DocksIslands isl = villages.islands();
        for (uint256 i; i < m.length && pop > 0; ++i) {
            uint256 part = amount * isl.memberCount(villages.islandOf(villageId, m[i])) / pop;
            credited[villageId][m[i]] += part;
            shared += part;
        }
        pendingLiquidity[villageId] += amount - shared;
    }

    function burnBpsOf(uint256 villageId) public view returns (uint16) {
        uint16 b = _burnBps[villageId];
        return b == 0 ? DEFAULT_BURN_BPS : b - 1;
    }

    /// @dev Returns the RF actually used (any rounding dust stays queued).
    function _provide(uint256 villageId, uint256 amount) private returns (uint256 used) {
        rf.forceApprove(address(liquidity), amount);
        used = liquidity.provide(villageId, amount);
        rf.forceApprove(address(liquidity), 0);
        emit LiquidityAdded(villageId, used);
    }
}
