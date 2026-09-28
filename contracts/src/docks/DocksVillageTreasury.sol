// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { DocksVillages, IDocksVillageTreasury } from "./DocksVillages.sol";
import { DocksIslands, IDocksFeeSink } from "./DocksIslands.sol";

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

/// @notice Village treasuries: permanent liquidity plus each member's RF allowance. Nothing is
/// burned here: RF that comes in builds liquidity, whose trading fees buy more RF to build with.
///
/// - Fees (arranging, bridges, holes, token launches and claims, items, boosts, raffle tickets)
///   all go to a permanent RF/ETH pool: the pool of the island's village, or the shared Docks
///   pool (village 0) for islands in no village.
/// - Flag RF when a village is founded: half liquidity, half founders' allowances (half of what
///   each locked). Enrollment fees: half liquidity, half the enrollee's allowance. Allowances are
///   spent only on items for the member's village island (DocksItems); that RF goes to the
///   village's liquidity too. A member's unspent allowance goes to liquidity when they leave.
/// - `harvest` collects a village pool's trading fees and buys RF with the WETH part. `poolBpsOf`
///   of it (half by default, set by village vote) goes back into the pool; the rest is shared
///   between members by Friend count.
/// - The shared Docks pool: every fee from islands in no village stays in it as permanent
///   liquidity. Its trading fees are kept as earned, in RF and WETH, in the Docks rewards
///   reserve (`docksRewardsRf`, `docksRewardsWeth`), set aside for leaders and games later.
///   There is no way to spend the reserve yet; that needs a later, reviewed contract.
/// - Platform fee: a share of every fee (not of flag locks), 0 to start, at most 5%, set by
///   the platform address. Nothing else can be withdrawn.
contract DocksVillageTreasury is IDocksVillageTreasury, IDocksFeeSink, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant DEFAULT_POOL_BPS = 5000; // half of every buyback back into the pool
    uint16 public constant MAX_PLATFORM_FEE_BPS = 500; // 5%
    uint256 public constant DOCKS_POOL = 0; // the shared pool of islands in no village

    error NotVillages();
    error NotItems();
    error NotMember();
    error NotFounded();
    error NoFunds();
    error NotPlatform();
    error FeeTooHigh();
    error NotFeePayer();
    error AlreadyInitialized();

    event VillageFunded(uint256 indexed villageId, uint256 allowances, uint256 liquidityRf);
    event Deposited(uint256 indexed villageId, address indexed wallet, uint256 allowance, uint256 queuedForLiquidity);
    event LiquidityQueued(uint256 indexed villageId, uint256 rf);
    event LiquidityAdded(uint256 indexed villageId, uint256 rf);
    event DocksRewardsCollected(uint256 rf, uint256 weth);
    event Harvested(uint256 indexed villageId, uint256 rfFees, uint256 wethFees, uint256 rfBought, uint256 toPool, uint256 shared);
    event FeeReceived(uint256 indexed villageId, uint256 amount, uint256 platformCut);
    event PlatformFeeSet(uint16 bps);
    event PlatformSet(address platform);
    event AllowanceSpent(uint256 indexed villageId, address indexed wallet, uint256 amount);
    event Forfeited(uint256 indexed villageId, address indexed wallet, uint256 amount);
    event PoolShareSet(uint256 indexed villageId, uint16 poolBps);

    IERC20 public immutable rf;
    IERC20 public immutable weth;
    DocksVillages public immutable villages;
    IDocksLiquidity public immutable liquidity;
    IDocksBuyback public immutable buyback;

    mapping(uint256 villageId => uint256) public pendingLiquidity;
    mapping(uint256 villageId => bool) public funded;
    mapping(uint256 villageId => mapping(address wallet => uint256)) public credited; // beyond the founder half
    mapping(uint256 villageId => mapping(address wallet => uint256)) public spent;
    mapping(uint256 villageId => uint16) private _poolBps; // stored +1 so 0 can mean "unset"
    uint256 public docksRewardsRf; // the Docks pool's trading fees, kept for leaders and games later
    uint256 public docksRewardsWeth;
    address public platform;
    uint16 public platformFeeBps;
    address public launchpad;
    address private immutable _deployer;

    constructor(IERC20 rf_, IERC20 weth_, DocksVillages villages_, IDocksLiquidity liquidity_, IDocksBuyback buyback_) {
        rf = rf_;
        weth = weth_;
        villages = villages_;
        liquidity = liquidity_;
        buyback = buyback_;
        platform = msg.sender;
        _deployer = msg.sender;
    }

    /// @notice One-time wiring to the launchpad (deployed after this contract).
    function initLaunchpad(address launchpad_) external {
        if (msg.sender != _deployer || launchpad != address(0)) revert AlreadyInitialized();
        launchpad = launchpad_;
    }

    /* ── platform fee: 0 to start, never above 5% ── */

    function setPlatformFee(uint16 bps) external {
        if (msg.sender != platform) revert NotPlatform();
        if (bps > MAX_PLATFORM_FEE_BPS) revert FeeTooHigh();
        platformFeeBps = bps;
        emit PlatformFeeSet(bps);
    }

    function setPlatform(address platform_) external {
        if (msg.sender != platform) revert NotPlatform();
        platform = platform_;
        emit PlatformSet(platform_);
    }

    /* ── fees ── */

    /// @inheritdoc IDocksFeeSink
    function onFee(uint256 islandId, uint256 amount) external {
        if (msg.sender != address(villages.islands()) && msg.sender != launchpad && msg.sender != address(villages.items())) {
            revert NotFeePayer();
        }
        _fee(villages.villageOf(islandId), amount);
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
        amount -= _platformCut(amount);
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
    function setPoolBps(uint256 villageId, uint16 poolBps) external onlyVillages {
        _poolBps[villageId] = poolBps + 1;
        emit PoolShareSet(villageId, poolBps);
    }

    /// @notice An item bought with `wallet`'s allowance: its RF goes to the village's liquidity.
    function payFromAllowance(uint256 villageId, address wallet, uint256 amount) external onlyItems {
        if (allowanceOf(villageId, wallet) < amount) revert NoFunds();
        spent[villageId][wallet] += amount;
        pendingLiquidity[villageId] += amount;
        emit AllowanceSpent(villageId, wallet, amount);
    }

    /// @notice RF already sent here for a village's liquidity (raffle tickets).
    function queueLiquidity(uint256 villageId, uint256 amount) external onlyItems {
        _fee(villageId, amount);
    }

    /// @notice Add the RF queued for a village to its permanent liquidity. Anyone.
    function provideLiquidity(uint256 villageId) external nonReentrant {
        uint256 amount = pendingLiquidity[villageId];
        if (amount == 0) revert NoFunds();
        pendingLiquidity[villageId] = amount - _provide(villageId, amount);
    }

    /// @notice Collect the shared Docks pool's trading fees into the Docks rewards reserve, as
    /// earned (RF and WETH, no swap). Anyone.
    function collectDocksRewards() external nonReentrant returns (uint256 rfFees, uint256 wethFees) {
        (rfFees, wethFees) = liquidity.collect(DOCKS_POOL, address(this));
        docksRewardsRf += rfFees;
        docksRewardsWeth += wethFees;
        emit DocksRewardsCollected(rfFees, wethFees);
    }

    /// @notice Collect a village pool's trading fees and buy RF with the WETH part: the pool
    /// share goes back into the pool, the rest is shared between members by Friend count.
    /// Members only (they set the minimum RF the buyback must return).
    function harvest(uint256 villageId, uint256 minRfOut) external nonReentrant returns (uint256 toPool, uint256 shared) {
        if (villageId == DOCKS_POOL) revert NotFounded(); // the Docks pool: collectDocksRewards
        if (!funded[villageId]) revert NotFounded();
        if (!villages.inVillage(villageId, msg.sender)) revert NotMember();
        (uint256 rfFees, uint256 wethFees) = liquidity.collect(villageId, address(this));
        uint256 bought;
        if (wethFees > 0) {
            weth.forceApprove(address(buyback), wethFees);
            bought = buyback.buyRf(wethFees, minRfOut, address(this));
        }
        uint256 total = rfFees + bought;
        toPool = total * poolBpsOf(villageId) / 10_000;
        pendingLiquidity[villageId] += toPool;
        shared = _share(villageId, total - toPool);
        emit Harvested(villageId, rfFees, wethFees, bought, toPool, shared);
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

    function poolBpsOf(uint256 villageId) public view returns (uint16) {
        uint16 b = _poolBps[villageId];
        return b == 0 ? DEFAULT_POOL_BPS : b - 1;
    }

    function _fee(uint256 villageId, uint256 amount) private {
        uint256 cut = _platformCut(amount);
        pendingLiquidity[villageId] += amount - cut;
        emit FeeReceived(villageId, amount, cut);
    }

    function _platformCut(uint256 amount) private returns (uint256 cut) {
        cut = amount * platformFeeBps / 10_000;
        if (cut > 0) rf.safeTransfer(platform, cut);
    }

    /// @dev Returns the RF actually used (any rounding dust stays queued).
    function _provide(uint256 villageId, uint256 amount) private returns (uint256 used) {
        rf.forceApprove(address(liquidity), amount);
        used = liquidity.provide(villageId, amount);
        rf.forceApprove(address(liquidity), 0);
        emit LiquidityAdded(villageId, used);
    }
}
