// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { DocksIslands } from "./DocksIslands.sol";
import { DocksFounderMarks } from "./DocksFounderMarks.sol";

interface IDocksVillageTreasury {
    /// @dev Called once when a village is founded, after `treasuryRf + liquidityRf` RF was
    /// sent to the treasury.
    function found(uint256 villageId, uint256 treasuryRf, uint256 liquidityRf) external;
}

/// @notice Villages on The Docks, started by planting a flag and raised together.
///
/// A holder plants a flag on a land cell of their docked island and locks the first RF. Anyone
/// can then lock more RF into the flag until it reaches `flagTarget` (set at deployment,
/// e.g. 1,000,000 RF). Every locker gets a soulbound founder mark recording how much they
/// locked, which is their weight in the village's votes. Locked RF never comes back once
/// the village is founded: there is no owner, no admin and no withdraw, so it can't be rugged.
///
/// When the flag is full, `found` (anyone may call it) makes it a village: half the RF goes to
/// the village treasury (RF only, spent by founder vote, e.g. on marketplace upgrades) and
/// half becomes permanent RF/ETH liquidity whose trading fees buy back RF (see
/// DocksVillageTreasury). If the flag isn't full by its deadline, every locker can take their
/// RF back and the mark is burned.
///
/// Islands docked next to (or bridged to) a village island can choose to join it (gas only);
/// one village per island. The flag's own island is the village seat and stays in it.
contract DocksVillages is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev A full flag the treasury can't found (e.g. no market yet) can be refunded after this.
    uint256 public constant FOUNDING_GRACE = 7 days;

    struct Village {
        string name;
        uint256 seatIsland; // the island the flag stands on
        int32 flagX; // island-local cell the flag stands on
        int32 flagY;
        uint64 deadline;
        uint128 locked; // RF locked into the flag (stays counted after founding)
        uint32 lockers;
        uint32 members; // islands in the village once founded
        bool founded;
    }

    error NotIslandOwner();
    error NotDocked();
    error AlreadyInVillage();
    error NotInVillage();
    error NotRising();
    error NotFounded();
    error NotFull();
    error StillOpen();
    error TooSmall();
    error NotConnected();
    error BadName();
    error NotOnLand();
    error SeatStays();
    error AlreadyInitialized();

    event FlagPlanted(
        uint256 indexed villageId, uint256 indexed islandId, string name, int32 x, int32 y, uint64 deadline
    );
    event RFLocked(uint256 indexed villageId, address indexed wallet, uint256 amount, uint256 total);
    event Founded(uint256 indexed villageId, uint256 treasuryRf, uint256 liquidityRf);
    event Refunded(uint256 indexed villageId, address indexed wallet, uint256 amount);
    event Joined(uint256 indexed villageId, uint256 indexed islandId);
    event Left(uint256 indexed villageId, uint256 indexed islandId);

    IERC20 public immutable rf;
    DocksIslands public immutable islands;
    DocksFounderMarks public immutable marks;
    uint256 public immutable flagTarget;
    uint256 public immutable flagDuration;
    uint256 public immutable minLock;
    address private immutable _deployer;
    IDocksVillageTreasury public treasury;

    uint256 public villageCount;
    mapping(uint256 villageId => Village) private _villages;
    mapping(uint256 islandId => uint256 villageId) private _villageOf;

    constructor(IERC20 rf_, DocksIslands islands_, uint256 flagTarget_, uint256 flagDuration_, uint256 minLock_) {
        rf = rf_;
        islands = islands_;
        flagTarget = flagTarget_;
        flagDuration = flagDuration_;
        minLock = minLock_;
        marks = new DocksFounderMarks();
        _deployer = msg.sender;
    }

    /// @notice One-time wiring to the treasury (deployed after this contract). No other admin.
    function init(IDocksVillageTreasury treasury_) external {
        if (msg.sender != _deployer || address(treasury) != address(0)) revert AlreadyInitialized();
        treasury = treasury_;
    }

    /* ── flags ── */

    /// @notice Plant a flag on a land cell of your docked island and lock the first RF.
    function plant(uint256 islandId, string calldata name, int32 x, int32 y, uint256 amount)
        external
        nonReentrant
        returns (uint256 villageId)
    {
        _onlyOwner(islandId);
        _docked(islandId);
        if (_taken(islandId)) revert AlreadyInVillage();
        uint256 len = bytes(name).length;
        if (len == 0 || len > 32) revert BadName();
        (bool occupied,, bool hole) = islands.friendAt(islandId, x, y);
        if (!occupied || hole) revert NotOnLand();

        villageId = ++villageCount;
        uint64 deadline = uint64(block.timestamp + flagDuration);
        _villages[villageId] = Village(name, islandId, x, y, deadline, 0, 0, 1, false);
        _villageOf[islandId] = villageId;
        emit FlagPlanted(villageId, islandId, name, x, y, deadline);
        _lock(villageId, amount);
    }

    /// @notice Lock RF into a rising flag. Anyone can add until it's full; the last lock is
    /// trimmed to exactly what's missing.
    function lock(uint256 villageId, uint256 amount) external nonReentrant returns (uint256 taken) {
        return _lock(villageId, amount);
    }

    /// @notice Turn a full flag into a village. Anyone may call it.
    function found(uint256 villageId) external nonReentrant {
        Village storage v = _villages[villageId];
        if (v.founded || v.seatIsland == 0) revert NotRising();
        if (v.locked < flagTarget) revert NotFull();
        v.founded = true;
        uint256 treasuryRf = uint256(v.locked) / 2;
        uint256 liquidityRf = uint256(v.locked) - treasuryRf;
        rf.safeTransfer(address(treasury), v.locked);
        treasury.found(villageId, treasuryRf, liquidityRf);
        emit Founded(villageId, treasuryRf, liquidityRf);
    }

    /// @notice Take your RF back from a flag that didn't become a village in time.
    function refund(uint256 villageId) external nonReentrant returns (uint256 amount) {
        Village storage v = _villages[villageId];
        if (v.founded || v.seatIsland == 0) revert NotRising();
        uint256 closes = v.deadline + (v.locked >= flagTarget ? FOUNDING_GRACE : 0);
        if (block.timestamp < closes) revert StillOpen();
        amount = marks.burn(villageId, msg.sender);
        v.locked -= uint128(amount);
        --v.lockers;
        rf.safeTransfer(msg.sender, amount);
        emit Refunded(villageId, msg.sender, amount);
    }

    /* ── islands join ── */

    /// @notice Join a founded village: your docked island must be next to (or bridged to)
    /// `viaIslandId`, an island already in it.
    function join(uint256 villageId, uint256 islandId, uint256 viaIslandId) external {
        _onlyOwner(islandId);
        _docked(islandId);
        if (!_villages[villageId].founded) revert NotFounded();
        if (_taken(islandId)) revert AlreadyInVillage();
        if (villageOf(viaIslandId) != villageId) revert NotInVillage();
        if (!islands.connected(islandId, viaIslandId)) revert NotConnected();
        _villageOf[islandId] = villageId;
        ++_villages[villageId].members;
        emit Joined(villageId, islandId);
    }

    /// @notice Leave your village (free). The seat island, where the flag stands, stays.
    function leaveVillage(uint256 islandId) external {
        _onlyOwner(islandId);
        uint256 villageId = villageOf(islandId);
        if (villageId == 0) revert NotInVillage();
        if (_villages[villageId].seatIsland == islandId) revert SeatStays();
        delete _villageOf[islandId];
        --_villages[villageId].members;
        emit Left(villageId, islandId);
    }

    /* ── reads ── */

    /// @notice The founded village an island belongs to, or 0.
    function villageOf(uint256 islandId) public view returns (uint256) {
        uint256 v = _villageOf[islandId];
        return v != 0 && _villages[v].founded ? v : 0;
    }

    function sameVillage(uint256 a, uint256 b) external view returns (bool) {
        uint256 v = villageOf(a);
        return v != 0 && v == villageOf(b);
    }

    function villages(uint256 villageId) external view returns (Village memory) {
        return _villages[villageId];
    }

    /// @notice Founder weight: RF this wallet locked into the village's flag.
    function weightOf(uint256 villageId, address wallet) external view returns (uint256) {
        return marks.weightOf(villageId, wallet);
    }

    function totalWeight(uint256 villageId) external view returns (uint256) {
        return _villages[villageId].locked;
    }

    /// @notice Whether a flag is still taking RF.
    function rising(uint256 villageId) public view returns (bool) {
        Village storage v = _villages[villageId];
        return v.seatIsland != 0 && !v.founded && block.timestamp < v.deadline && v.locked < flagTarget;
    }

    /* ── internals ── */

    function _lock(uint256 villageId, uint256 amount) private returns (uint256 taken) {
        if (!rising(villageId)) revert NotRising();
        Village storage v = _villages[villageId];
        uint256 missing = flagTarget - v.locked;
        taken = amount > missing ? missing : amount;
        if (taken < minLock && taken != missing) revert TooSmall();
        rf.safeTransferFrom(msg.sender, address(this), taken);
        if (marks.markOf(villageId, msg.sender) == 0) ++v.lockers;
        marks.add(villageId, msg.sender, taken);
        v.locked += uint128(taken);
        emit RFLocked(villageId, msg.sender, taken, v.locked);
    }

    /// @dev Seat of a flag that is still rising or founded, or a member of a founded village.
    function _taken(uint256 islandId) private view returns (bool) {
        uint256 v = _villageOf[islandId];
        if (v == 0) return false;
        Village storage x = _villages[v];
        if (x.founded) return true;
        return x.seatIsland == islandId && (rising(v) || x.locked >= flagTarget);
    }

    function _onlyOwner(uint256 islandId) private view {
        if (islands.ownerOf(islandId) != msg.sender) revert NotIslandOwner();
    }

    function _docked(uint256 islandId) private view {
        (,, bool docked,) = islands.berthOf(islandId);
        if (!docked) revert NotDocked();
    }
}
