// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { DocksIslands } from "./DocksIslands.sol";

/// @notice Villages on The Docks. Plant a flag on one of your docked islands for 100,000 RF
/// (half burned, half to the treasury) to start a village. Other islands choose to join: an
/// island can join while it is docked next to, or bridged to, an island already in the village
/// (gas only). One village per island. Villages are not tokens and can't be sold.
/// @dev Membership is kept when an island later moves; it only needs to be connected to join.
/// If the founding island leaves, the flag comes down and the village is gone for everyone.
contract DocksVillages {
    using SafeERC20 for IERC20;

    uint256 public constant FLAG_FEE = 100_000 ether;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    struct Village {
        string name;
        uint256 founderIsland;
        int32 flagX; // island-local cell the flag stands on
        int32 flagY;
        uint32 members;
        bool standing;
    }

    error NotIslandOwner();
    error NotDocked();
    error AlreadyInVillage();
    error NotInVillage();
    error FlagDown();
    error NotConnected();
    error BadName();
    error NotOnLand();

    event FlagPlanted(uint256 indexed villageId, uint256 indexed islandId, string name, int32 x, int32 y, uint256 rfPaid);
    event Joined(uint256 indexed villageId, uint256 indexed islandId);
    event Left(uint256 indexed villageId, uint256 indexed islandId);
    event FlagTakenDown(uint256 indexed villageId);

    IERC20 public immutable rf;
    DocksIslands public immutable islands;
    address public immutable treasury;

    uint256 public villageCount;
    mapping(uint256 villageId => Village) private _villages;
    mapping(uint256 islandId => uint256 villageId) private _villageOf;

    constructor(IERC20 rf_, DocksIslands islands_, address treasury_) {
        rf = rf_;
        islands = islands_;
        treasury = treasury_;
    }

    /// @notice Plant a flag at an island-local cell of your docked island, starting a village.
    function plant(uint256 islandId, string calldata name, int32 x, int32 y) external returns (uint256 villageId) {
        _onlyOwner(islandId);
        _docked(islandId);
        if (villageOf(islandId) != 0) revert AlreadyInVillage();
        uint256 len = bytes(name).length;
        if (len == 0 || len > 32) revert BadName();
        (bool occupied,, bool hole) = islands.friendAt(islandId, x, y);
        if (!occupied || hole) revert NotOnLand();

        rf.safeTransferFrom(msg.sender, BURN, FLAG_FEE / 2);
        rf.safeTransferFrom(msg.sender, treasury, FLAG_FEE - FLAG_FEE / 2);

        villageId = ++villageCount;
        _villages[villageId] = Village(name, islandId, x, y, 1, true);
        _villageOf[islandId] = villageId;
        emit FlagPlanted(villageId, islandId, name, x, y, FLAG_FEE);
    }

    /// @notice Join a village: your island must be docked next to (or bridged to) `viaIslandId`,
    /// an island already in that village.
    function join(uint256 villageId, uint256 islandId, uint256 viaIslandId) external {
        _onlyOwner(islandId);
        _docked(islandId);
        if (!_villages[villageId].standing) revert FlagDown();
        if (villageOf(islandId) != 0) revert AlreadyInVillage();
        if (villageOf(viaIslandId) != villageId) revert NotInVillage();
        if (!islands.connected(islandId, viaIslandId)) revert NotConnected();
        _villageOf[islandId] = villageId;
        ++_villages[villageId].members;
        emit Joined(villageId, islandId);
    }

    /// @notice Leave your village. The founding island leaving takes the flag down.
    function leave(uint256 islandId) external {
        _onlyOwner(islandId);
        uint256 villageId = villageOf(islandId);
        if (villageId == 0) revert NotInVillage();
        Village storage v = _villages[villageId];
        delete _villageOf[islandId];
        --v.members;
        emit Left(villageId, islandId);
        if (v.founderIsland == islandId) {
            v.standing = false;
            emit FlagTakenDown(villageId);
        }
    }

    /* ── reads ── */

    /// @notice The standing village an island belongs to, or 0.
    function villageOf(uint256 islandId) public view returns (uint256) {
        uint256 v = _villageOf[islandId];
        return v != 0 && _villages[v].standing ? v : 0;
    }

    function sameVillage(uint256 a, uint256 b) external view returns (bool) {
        uint256 v = villageOf(a);
        return v != 0 && v == villageOf(b);
    }

    function villages(uint256 villageId) external view returns (Village memory) {
        return _villages[villageId];
    }

    /* ── internals ── */

    function _onlyOwner(uint256 islandId) private view {
        if (islands.ownerOf(islandId) != msg.sender) revert NotIslandOwner();
    }

    function _docked(uint256 islandId) private view {
        (,, bool docked,) = islands.berthOf(islandId);
        if (!docked) revert NotDocked();
    }
}
