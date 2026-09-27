// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

interface IDocksGenerations {
    function ownerOf(uint256 friendId) external view returns (address);
    function tokenBoundAccount(uint256 friendId) external view returns (address);
    function activationManager() external view returns (address);
    function generation(uint256 friendId) external view returns (uint8);
}

/// @dev Deployed Rare Friends activation manager: `positions(generations, id)` returns the
/// activation tier and the activated RF amount; an amount of zero means not activated.
interface IDocksActivation {
    function positions(address generations, uint256 friendId)
        external
        view
        returns (uint8 tier, uint256 amount);
}

/// @notice The Docks: floating islands made of activated Rare Friends.
///
/// The only NFTs are the activated Rare Friends. An island is not a token and can't be sold
/// or transferred: it is a saved layout that belongs to the wallet that created it.
///
/// - Island: the creator's Friends laid out on the island's own grid of 4x4-tile cells (each
///   Friend covers its land at true size: Gen 1 8x8 cells ... Gen 6 1x1). A Friend is on at
///   most one island; a holder can deploy their Friends across as many islands as they like.
/// - Arranging is the core action and is paid in RF: saving burns RF for every Friend whose
///   spot changes (new to the island or moved), by generation. Unmoved Friends are free.
/// - Holes: if a saved Friend leaves the wallet (a transfer also clears its activation) or is
///   deactivated, its spot becomes a hole in the island. The hole stays, reserved, until the
///   same Friend returns and is active again (it heals by itself, free) or the owner fills it
///   with another activated Friend of the same size (`fillHole`, normal arrange fee).
/// - Docking: islands float on one shared berth grid, one island per berth whatever its size,
///   so the world grows with the number of islands. Dock at a free berth next to another
///   island (a loading zone); islands on neighbouring berths are connected. Gas only.
/// - Bridges: link your island to one you can't dock next to, for RF burned per berth of
///   distance. A bridge lasts until either island moves.
/// - Access: each island is open or invite-only with approved visitors.
contract DocksIslands {
    using SafeERC20 for IERC20;

    struct Spot {
        uint256 islandId;
        int32 x;
        int32 y;
        bool placed;
    }

    /// @dev A spot burned into an island by a Friend that left and was placed elsewhere.
    struct Hole {
        int32 x;
        int32 y;
        uint8 gen;
        bool open;
    }

    struct Berth {
        int32 x;
        int32 y;
        bool docked;
        uint64 epoch;
    }

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    /// @notice RF burned per Friend moved on its island, by generation (Gen 1 ... Gen 6).
    uint256 public constant FEE_GEN1 = 100 ether;
    uint256 public constant FEE_GEN2 = 50 ether;
    uint256 public constant FEE_GEN3 = 20 ether;
    uint256 public constant FEE_GEN4 = 10 ether;
    uint256 public constant FEE_GEN5 = 5 ether;
    uint256 public constant FEE_GEN6 = 1 ether;
    /// @notice RF burned per berth of distance a bridge spans.
    uint256 public constant BRIDGE_FEE_PER_BERTH = 10 ether;

    error NotIslandOwner();
    error NotHolder();
    error NotActive();
    error CellTaken();
    error NotPlaced();
    error LengthMismatch();
    error EmptyIsland();
    error BerthTaken();
    error NotLoadingZone();
    error NotDocked();
    error AlreadyConnected();
    error NotAHole();
    error WrongSize();

    event IslandCreated(uint256 indexed islandId, address indexed owner, string name);
    event Arranged(uint256 indexed islandId, uint256 moved, uint256 rfBurned);
    event Placed(uint256 indexed friendId, uint256 indexed islandId, int32 x, int32 y);
    event Removed(uint256 indexed friendId, uint256 indexed islandId);
    event HoleBurned(uint256 indexed islandId, uint256 indexed friendId, int32 x, int32 y);
    event HoleFilled(uint256 indexed islandId, uint256 indexed oldFriendId, uint256 indexed newFriendId);
    event Docked(uint256 indexed islandId, int32 x, int32 y);
    event Undocked(uint256 indexed islandId);
    event BridgeBuilt(uint256 indexed from, uint256 indexed to, uint256 rfBurned);
    event IslandUpdated(uint256 indexed islandId, string name, bool inviteOnly);
    event VisitorSet(uint256 indexed islandId, address indexed visitor, bool approved);
    event VisitRequested(uint256 indexed islandId, address indexed visitor);

    IDocksGenerations public immutable generations;
    IERC20 public immutable rf;

    uint256 public totalIslands;
    uint256 public dockedCount;
    mapping(uint256 islandId => address) public ownerOf;
    mapping(uint256 islandId => string) public islandName;
    mapping(uint256 islandId => bool) public inviteOnly;
    mapping(uint256 islandId => mapping(address visitor => bool)) public approved;

    mapping(uint256 friendId => Spot) public spotOf;
    mapping(bytes32 islandCell => uint256 friendIdPlusOne) private _cell;
    mapping(uint256 islandId => mapping(uint256 friendId => Hole)) public holeOf;
    mapping(bytes32 islandCell => uint256 friendIdPlusOne) private _holeCell;
    mapping(uint256 islandId => uint256[]) private _members;
    mapping(uint256 friendId => uint256 indexPlusOne) private _memberIndex;

    mapping(uint256 islandId => Berth) public berthOf;
    mapping(bytes32 berth => uint256 islandIdPlusOne) private _berth;
    mapping(bytes32 pair => uint128 epochs) private _bridge;

    constructor(IDocksGenerations generations_, IERC20 rf_) {
        generations = generations_;
        rf = rf_;
    }

    /* ── islands (not tokens: they belong to the wallet that made them) ── */

    function create(string calldata name) external returns (uint256 islandId) {
        islandId = ++totalIslands;
        ownerOf[islandId] = msg.sender;
        islandName[islandId] = name;
        emit IslandCreated(islandId, msg.sender, name);
    }

    function setIsland(uint256 islandId, string calldata name, bool inviteOnly_) external {
        _onlyOwner(islandId);
        islandName[islandId] = name;
        inviteOnly[islandId] = inviteOnly_;
        emit IslandUpdated(islandId, name, inviteOnly_);
    }

    function setVisitor(uint256 islandId, address visitor, bool approved_) external {
        _onlyOwner(islandId);
        approved[islandId][visitor] = approved_;
        emit VisitorSet(islandId, visitor, approved_);
    }

    function requestVisit(uint256 islandId) external {
        emit VisitRequested(islandId, msg.sender);
    }

    function canVisit(uint256 islandId, address visitor) public view returns (bool) {
        return ownerOf[islandId] == visitor || !inviteOnly[islandId] || approved[islandId][visitor];
    }

    /* ── arranging (the core action) ── */

    /// @notice RF burned per Friend moved, by generation.
    function feeOf(uint256 friendId) public view returns (uint256) {
        return _fee(generations.generation(friendId));
    }

    /// @notice The RF an `arrange` call would burn (Friends whose spot would change).
    function arrangeCost(
        uint256 islandId,
        uint256[] calldata friendIds,
        int32[] calldata xs,
        int32[] calldata ys
    ) external view returns (uint256 cost, uint256 moved) {
        if (friendIds.length != xs.length || friendIds.length != ys.length) revert LengthMismatch();
        for (uint256 i; i < friendIds.length; ++i) {
            if (_changes(islandId, friendIds[i], xs[i], ys[i])) {
                cost += feeOf(friendIds[i]);
                ++moved;
            }
        }
    }

    /// @notice Save island positions for Friends you hold on an island you own (also deploys a
    /// Friend from another of your islands, or brings in a Friend that was on someone else's
    /// island, which burns a hole there). Friends whose spot changes burn their generation's
    /// fee; the rest are free. Cells vacated earlier in the call can be reused.
    function arrange(
        uint256 islandId,
        uint256[] calldata friendIds,
        int32[] calldata xs,
        int32[] calldata ys
    ) external returns (uint256 burned) {
        _onlyOwner(islandId);
        if (friendIds.length != xs.length || friendIds.length != ys.length) revert LengthMismatch();
        uint256 moved;
        bool[] memory changed = new bool[](friendIds.length);
        for (uint256 i; i < friendIds.length; ++i) {
            uint256 id = friendIds[i];
            if (generations.ownerOf(id) != msg.sender) revert NotHolder();
            if (!isActive(id)) revert NotActive();
            if (!_changes(islandId, id, xs[i], ys[i])) continue;
            changed[i] = true;
            burned += feeOf(id);
            ++moved;
            _leave(id);
        }
        for (uint256 i; i < friendIds.length; ++i) {
            if (changed[i]) _place(islandId, friendIds[i], xs[i], ys[i]);
        }
        if (burned > 0) rf.safeTransferFrom(msg.sender, BURN, burned);
        emit Arranged(islandId, moved, burned);
    }

    /// @notice Take Friends you hold off their islands. Free. (A Friend you hold, taken off
    /// your own island, leaves no hole.)
    function remove(uint256[] calldata friendIds) external {
        for (uint256 i; i < friendIds.length; ++i) {
            uint256 id = friendIds[i];
            if (generations.ownerOf(id) != msg.sender) revert NotHolder();
            if (!spotOf[id].placed) revert NotPlaced();
            _leave(id);
        }
    }

    /// @notice Fill a hole on your island with an activated Friend of the same size. The
    /// Friend that left can fill its own hole for free when it comes back; any other Friend
    /// pays its normal arrange fee.
    function fillHole(uint256 islandId, uint256 oldFriendId, uint256 newFriendId)
        external
        returns (uint256 burned)
    {
        _onlyOwner(islandId);
        if (generations.ownerOf(newFriendId) != msg.sender) revert NotHolder();
        if (!isActive(newFriendId)) revert NotActive();
        (int32 x, int32 y, uint8 gen) = _takeHole(islandId, oldFriendId);
        if (generations.generation(newFriendId) != gen) revert WrongSize();
        if (newFriendId != oldFriendId) burned = _fee(gen);
        _leave(newFriendId);
        _place(islandId, newFriendId, x, y);
        if (burned > 0) rf.safeTransferFrom(msg.sender, BURN, burned);
        emit HoleFilled(islandId, oldFriendId, newFriendId);
    }

    /* ── docking islands (gas only) ── */

    /// @notice Dock (or move) your island at a free berth next to another island. The first
    /// island in the world may dock anywhere.
    function dock(uint256 islandId, int32 x, int32 y) external {
        _onlyOwner(islandId);
        if (_members[islandId].length == 0) revert EmptyIsland();
        bytes32 key = _key(x, y);
        uint256 there = _berth[key];
        if (there != 0 && there != islandId + 1) revert BerthTaken();
        Berth storage b = berthOf[islandId];
        uint64 epoch = b.epoch;
        if (b.docked) {
            delete _berth[_key(b.x, b.y)];
            --dockedCount;
        }
        if (dockedCount > 0 && !_nextToIsland(x, y)) revert NotLoadingZone();
        _berth[key] = islandId + 1;
        berthOf[islandId] = Berth(x, y, true, epoch + 1);
        ++dockedCount;
        emit Docked(islandId, x, y);
    }

    function undock(uint256 islandId) external {
        _onlyOwner(islandId);
        Berth storage b = berthOf[islandId];
        if (!b.docked) revert NotDocked();
        delete _berth[_key(b.x, b.y)];
        b.docked = false;
        ++b.epoch;
        --dockedCount;
        emit Undocked(islandId);
    }

    /// @notice Whether a free berth is a loading zone: next to a docked island.
    function isLoadingZone(int32 x, int32 y) external view returns (bool) {
        return _berth[_key(x, y)] == 0 && (dockedCount == 0 || _nextToIsland(x, y));
    }

    function islandAtBerth(int32 x, int32 y) external view returns (uint256) {
        uint256 v = _berth[_key(x, y)];
        return v == 0 ? 0 : v - 1;
    }

    /* ── bridges (RF burned per berth of distance) ── */

    function bridgeCost(uint256 from, uint256 to) public view returns (uint256) {
        Berth storage a = berthOf[from];
        Berth storage b = berthOf[to];
        if (!a.docked || !b.docked) revert NotDocked();
        return _distance(a, b) * BRIDGE_FEE_PER_BERTH;
    }

    function buildBridge(uint256 from, uint256 to) external returns (uint256 burned) {
        _onlyOwner(from);
        if (connected(from, to) || from == to) revert AlreadyConnected();
        burned = bridgeCost(from, to);
        _bridge[_pair(from, to)] = _epochs(from, to);
        rf.safeTransferFrom(msg.sender, BURN, burned);
        emit BridgeBuilt(from, to, burned);
    }

    function hasBridge(uint256 a, uint256 b) public view returns (bool) {
        uint128 e = _bridge[_pair(a, b)];
        return e != 0 && e == _epochs(a, b) && berthOf[a].docked && berthOf[b].docked;
    }

    /// @notice Islands you can walk between: docked on neighbouring berths, or bridged.
    function connected(uint256 a, uint256 b) public view returns (bool) {
        Berth storage ba = berthOf[a];
        Berth storage bb = berthOf[b];
        if (!ba.docked || !bb.docked || a == b) return false;
        return _distance(ba, bb) == 1 || hasBridge(a, b);
    }

    /* ── reads ── */

    function isActive(uint256 friendId) public view returns (bool) {
        (, uint256 amount) = IDocksActivation(generations.activationManager())
            .positions(address(generations), friendId);
        return amount > 0;
    }

    /// @notice A placed Friend counts while it is activated and held by its island's owner.
    function isValid(uint256 friendId) public view returns (bool) {
        Spot storage spot = spotOf[friendId];
        return spot.placed && _holds(ownerOf[spot.islandId], friendId) && isActive(friendId);
    }

    /// @notice Whether an island has a hole where `friendId` was: it left the owner's wallet
    /// or was deactivated (still in place, pending), or it was placed elsewhere (burned in).
    function isHole(uint256 islandId, uint256 friendId) public view returns (bool) {
        if (holeOf[islandId][friendId].open) return true;
        Spot storage s = spotOf[friendId];
        return s.placed && s.islandId == islandId && !isValid(friendId);
    }

    /// @notice Footprint in cells (width, depth) by generation; lands are 30, 20, 18x16, 12,
    /// 8 and 4 tiles across, rounded up to whole 4-tile cells.
    function footprint(uint256 friendId) public view returns (int32 w, int32 h) {
        return _size(generations.generation(friendId));
    }

    function friendAt(uint256 islandId, int32 x, int32 y)
        public
        view
        returns (bool occupied, uint256 friendId, bool hole)
    {
        bytes32 key = _cellKey(islandId, x, y);
        uint256 v = _cell[key];
        if (v != 0) return (true, v - 1, !isValid(v - 1));
        v = _holeCell[key];
        return (v != 0, v == 0 ? 0 : v - 1, v != 0);
    }

    /// @notice Whether two Friends on the same island share (part of) an edge.
    function adjacent(uint256 a, uint256 b) public view returns (bool) {
        Spot storage sa = spotOf[a];
        Spot storage sb = spotOf[b];
        if (!sa.placed || !sb.placed || sa.islandId != sb.islandId) return false;
        (int32 aw, int32 ah) = footprint(a);
        (int32 bw, int32 bh) = footprint(b);
        bool xTouch = sa.x + aw == sb.x || sb.x + bw == sa.x;
        bool yTouch = sa.y + ah == sb.y || sb.y + bh == sa.y;
        bool xOverlap = sa.x < sb.x + bw && sb.x < sa.x + aw;
        bool yOverlap = sa.y < sb.y + bh && sb.y < sa.y + ah;
        return (xTouch && yOverlap) || (yTouch && xOverlap);
    }

    function islandOf(uint256 friendId) external view returns (uint256) {
        return spotOf[friendId].placed ? spotOf[friendId].islandId : 0;
    }

    function memberCount(uint256 islandId) external view returns (uint256) {
        return _members[islandId].length;
    }

    /// @notice Page through one island's Friends and holes (burned-in holes have `hole` set;
    /// members that left but are still in place are reported with `valid` false).
    function members(uint256 islandId, uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory ids, Spot[] memory spots, bool[] memory valid)
    {
        uint256[] storage list = _members[islandId];
        uint256 end = start + count > list.length ? list.length : start + count;
        uint256 n = end > start ? end - start : 0;
        ids = new uint256[](n);
        spots = new Spot[](n);
        valid = new bool[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = list[start + i];
            spots[i] = spotOf[ids[i]];
            valid[i] = isValid(ids[i]);
        }
    }

    /* ── internals ── */

    function _onlyOwner(uint256 islandId) private view {
        if (ownerOf[islandId] != msg.sender) revert NotIslandOwner();
    }

    function _changes(uint256 islandId, uint256 id, int32 x, int32 y) private view returns (bool) {
        Spot storage s = spotOf[id];
        return !s.placed || s.islandId != islandId || s.x != x || s.y != y;
    }

    /// @dev Takes a Friend off wherever it is. Off an island it doesn't count on (it left
    /// that island's owner), its spot is burned into that island as a hole.
    function _leave(uint256 friendId) private {
        Spot storage s = spotOf[friendId];
        if (!s.placed) return;
        uint256 islandId = s.islandId;
        bool burnHole = ownerOf[islandId] != msg.sender;
        (int32 w, int32 h) = footprint(friendId);
        for (int32 j; j < h; ++j) {
            for (int32 i; i < w; ++i) {
                bytes32 key = _cellKey(islandId, s.x + i, s.y + j);
                if (_cell[key] == friendId + 1) {
                    delete _cell[key];
                    if (burnHole) _holeCell[key] = friendId + 1;
                }
            }
        }
        if (burnHole) {
            holeOf[islandId][friendId] = Hole(s.x, s.y, generations.generation(friendId), true);
            emit HoleBurned(islandId, friendId, s.x, s.y);
        }
        _dropMember(friendId, islandId);
        delete spotOf[friendId];
        emit Removed(friendId, islandId);
    }

    /// @dev Opens up a hole for filling: a burned-in hole, or a member still in place that
    /// is no longer valid (its cells are released and it leaves the island).
    function _takeHole(uint256 islandId, uint256 friendId) private returns (int32 x, int32 y, uint8 gen) {
        Hole storage hole = holeOf[islandId][friendId];
        if (hole.open) {
            (x, y, gen) = (hole.x, hole.y, hole.gen);
            (int32 w, int32 h) = _size(gen);
            for (int32 j; j < h; ++j) {
                for (int32 i; i < w; ++i) delete _holeCell[_cellKey(islandId, x + i, y + j)];
            }
            delete holeOf[islandId][friendId];
            return (x, y, gen);
        }
        Spot storage s = spotOf[friendId];
        if (!s.placed || s.islandId != islandId) revert NotAHole();
        (x, y, gen) = (s.x, s.y, generations.generation(friendId));
        if (isValid(friendId)) {
            // Its own Friend, back and active: nothing to fill. Anything else is not a hole.
            revert NotAHole();
        }
        (int32 fw, int32 fh) = _size(gen);
        for (int32 j; j < fh; ++j) {
            for (int32 i; i < fw; ++i) delete _cell[_cellKey(islandId, x + i, y + j)];
        }
        _dropMember(friendId, islandId);
        delete spotOf[friendId];
        emit Removed(friendId, islandId);
    }

    function _place(uint256 islandId, uint256 friendId, int32 x, int32 y) private {
        (int32 w, int32 h) = footprint(friendId);
        for (int32 j; j < h; ++j) {
            for (int32 i; i < w; ++i) {
                bytes32 key = _cellKey(islandId, x + i, y + j);
                if (_cell[key] != 0 || _holeCell[key] != 0) revert CellTaken();
                _cell[key] = friendId + 1;
            }
        }
        spotOf[friendId] = Spot(islandId, x, y, true);
        _members[islandId].push(friendId);
        _memberIndex[friendId] = _members[islandId].length;
        emit Placed(friendId, islandId, x, y);
    }

    function _dropMember(uint256 friendId, uint256 islandId) private {
        uint256[] storage list = _members[islandId];
        uint256 index = _memberIndex[friendId];
        if (index == 0) return;
        uint256 last = list[list.length - 1];
        list[index - 1] = last;
        _memberIndex[last] = index;
        list.pop();
        delete _memberIndex[friendId];
    }

    function _fee(uint8 g) private pure returns (uint256) {
        if (g == 1) return FEE_GEN1;
        if (g == 2) return FEE_GEN2;
        if (g == 3) return FEE_GEN3;
        if (g == 4) return FEE_GEN4;
        if (g == 5) return FEE_GEN5;
        return FEE_GEN6;
    }

    function _size(uint8 g) private pure returns (int32 w, int32 h) {
        if (g == 1) return (8, 8);
        if (g == 2) return (5, 5);
        if (g == 3) return (5, 4);
        if (g == 4) return (3, 3);
        if (g == 5) return (2, 2);
        return (1, 1);
    }

    function _nextToIsland(int32 x, int32 y) private view returns (bool) {
        return _berth[_key(x + 1, y)] != 0 || _berth[_key(x - 1, y)] != 0
            || _berth[_key(x, y + 1)] != 0 || _berth[_key(x, y - 1)] != 0;
    }

    function _distance(Berth storage a, Berth storage b) private view returns (uint256) {
        int256 dx = int256(a.x) - int256(b.x);
        int256 dy = int256(a.y) - int256(b.y);
        return uint256(dx < 0 ? -dx : dx) + uint256(dy < 0 ? -dy : dy);
    }

    function _pair(uint256 a, uint256 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// @dev Both islands' berth epochs, low id first; a bridge is live while they match.
    function _epochs(uint256 a, uint256 b) private view returns (uint128) {
        (uint256 lo, uint256 hi) = a < b ? (a, b) : (b, a);
        return (uint128(berthOf[lo].epoch) << 64) | uint128(berthOf[hi].epoch);
    }

    function _holds(address holder, uint256 friendId) private view returns (bool) {
        try generations.ownerOf(friendId) returns (address owner) {
            return owner == holder;
        } catch {
            return false;
        }
    }

    function _key(int32 x, int32 y) private pure returns (bytes32) {
        return keccak256(abi.encode(x, y));
    }

    function _cellKey(uint256 islandId, int32 x, int32 y) private pure returns (bytes32) {
        return keccak256(abi.encode(islandId, x, y));
    }
}
