// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

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

/// @notice The Docks world: activated Friends placed on one shared grid of 4x4-tile cells.
/// Each Friend covers the cells of its land at true size (Gen 1: 8x8 cells ... Gen 6: 1x1).
/// A holder's plot is every cell holding a Friend they own; Friends in adjacent cells of
/// different holders are docked (their footprints share an edge). Plots are open or invite-only with an approved-visitor list.
/// @dev A placement is valid only while the Friend is activated and still held by the
/// account that placed it. Invalid placements can be cleared by anyone.
contract DocksRegistry {
    struct Spot {
        int32 x;
        int32 y;
        address holder;
        bool placed;
    }

    error NotHolder();
    error NotActive();
    error CellTaken();
    error NotPlaced();
    error StillValid();
    error LengthMismatch();

    event Placed(uint256 indexed friendId, address indexed holder, int32 x, int32 y);
    event Removed(uint256 indexed friendId);
    event PlotUpdated(address indexed holder, string name, bool inviteOnly);
    event VisitorSet(address indexed holder, address indexed visitor, bool approved);
    event VisitRequested(address indexed holder, address indexed visitor);

    IDocksGenerations public immutable generations;

    mapping(uint256 friendId => Spot) public spotOf;
    mapping(bytes32 cell => uint256 friendIdPlusOne) private _cell;
    uint256[] private _placed;
    mapping(uint256 friendId => uint256 indexPlusOne) private _index;

    mapping(address holder => string) public plotName;
    mapping(address holder => bool) public inviteOnly;
    mapping(address holder => mapping(address visitor => bool)) public approved;

    constructor(IDocksGenerations generations_) {
        generations = generations_;
    }

    /// @notice Places or moves Friends you hold. Moving several at once is one transaction,
    /// so a whole plot can relocate; cells vacated earlier in the batch can be reused.
    function place(uint256[] calldata friendIds, int32[] calldata xs, int32[] calldata ys)
        external
    {
        if (friendIds.length != xs.length || friendIds.length != ys.length) {
            revert LengthMismatch();
        }
        for (uint256 i; i < friendIds.length; ++i) {
            _vacate(friendIds[i]);
        }
        for (uint256 i; i < friendIds.length; ++i) {
            _place(friendIds[i], xs[i], ys[i]);
        }
    }

    /// @notice Takes Friends you hold off the grid.
    function remove(uint256[] calldata friendIds) external {
        for (uint256 i; i < friendIds.length; ++i) {
            if (generations.ownerOf(friendIds[i]) != msg.sender) revert NotHolder();
            if (!spotOf[friendIds[i]].placed) revert NotPlaced();
            _remove(friendIds[i]);
        }
    }

    /// @notice Clears a placement that is no longer valid (Friend sold or deactivated).
    function clear(uint256 friendId) external {
        if (!spotOf[friendId].placed) revert NotPlaced();
        if (isValid(friendId)) revert StillValid();
        _remove(friendId);
    }

    function setPlot(string calldata name, bool inviteOnly_) external {
        plotName[msg.sender] = name;
        inviteOnly[msg.sender] = inviteOnly_;
        emit PlotUpdated(msg.sender, name, inviteOnly_);
    }

    function setVisitor(address visitor, bool approved_) external {
        approved[msg.sender][visitor] = approved_;
        emit VisitorSet(msg.sender, visitor, approved_);
    }

    function requestVisit(address holder) external {
        emit VisitRequested(holder, msg.sender);
    }

    function canVisit(address holder, address visitor) external view returns (bool) {
        return holder == visitor || !inviteOnly[holder] || approved[holder][visitor];
    }

    function isActive(uint256 friendId) public view returns (bool) {
        (, uint256 amount) = IDocksActivation(generations.activationManager())
            .positions(address(generations), friendId);
        return amount > 0;
    }

    function isValid(uint256 friendId) public view returns (bool) {
        Spot storage spot = spotOf[friendId];
        return spot.placed && _holds(spot.holder, friendId) && isActive(friendId);
    }

    /// @notice Footprint in cells (width, depth) by generation; lands are 30, 20, 18x16, 12,
    /// 8 and 4 tiles across, rounded up to whole 4-tile cells.
    function footprint(uint256 friendId) public view returns (int32 w, int32 h) {
        uint8 g = generations.generation(friendId);
        if (g == 1) return (8, 8);
        if (g == 2) return (5, 5);
        if (g == 3) return (5, 4);
        if (g == 4) return (3, 3);
        if (g == 5) return (2, 2);
        return (1, 1);
    }

    function friendAt(int32 x, int32 y) public view returns (bool occupied, uint256 friendId) {
        uint256 value = _cell[_key(x, y)];
        return (value != 0, value == 0 ? 0 : value - 1);
    }

    /// @notice Whether two placed Friends' footprints share an edge (they are docked).
    function adjacent(uint256 a, uint256 b) public view returns (bool) {
        Spot storage sa = spotOf[a];
        Spot storage sb = spotOf[b];
        if (!sa.placed || !sb.placed) return false;
        (int32 aw, int32 ah) = footprint(a);
        (int32 bw, int32 bh) = footprint(b);
        bool xTouch = sa.x + aw == sb.x || sb.x + bw == sa.x;
        bool yTouch = sa.y + ah == sb.y || sb.y + bh == sa.y;
        bool xOverlap = sa.x < sb.x + bw && sb.x < sa.x + aw;
        bool yOverlap = sa.y < sb.y + bh && sb.y < sa.y + ah;
        return (xTouch && yOverlap) || (yTouch && xOverlap);
    }

    function placedCount() external view returns (uint256) {
        return _placed.length;
    }

    /// @notice Page through every placement for discovery.
    function placedPage(uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory ids, Spot[] memory spots, bool[] memory valid)
    {
        uint256 end = start + count > _placed.length ? _placed.length : start + count;
        uint256 n = end > start ? end - start : 0;
        ids = new uint256[](n);
        spots = new Spot[](n);
        valid = new bool[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = _placed[start + i];
            spots[i] = spotOf[ids[i]];
            valid[i] = _validOrFalse(ids[i]);
        }
    }

    function _place(uint256 friendId, int32 x, int32 y) private {
        if (generations.ownerOf(friendId) != msg.sender) revert NotHolder();
        if (!isActive(friendId)) revert NotActive();
        (int32 w, int32 h) = footprint(friendId);
        for (int32 j; j < h; ++j) {
            for (int32 i; i < w; ++i) {
                bytes32 key = _key(x + i, y + j);
                uint256 occupant = _cell[key];
                if (occupant != 0) {
                    // A stale occupant (sold or deactivated) gives way; a valid one does not.
                    if (isValid(occupant - 1)) revert CellTaken();
                    _remove(occupant - 1);
                }
                _cell[key] = friendId + 1;
            }
        }
        spotOf[friendId] = Spot(x, y, msg.sender, true);
        if (_index[friendId] == 0) {
            _placed.push(friendId);
            _index[friendId] = _placed.length;
        }
        emit Placed(friendId, msg.sender, x, y);
    }

    function _vacate(uint256 friendId) private {
        if (generations.ownerOf(friendId) != msg.sender) revert NotHolder();
        if (spotOf[friendId].placed) _clearCells(friendId);
    }

    function _clearCells(uint256 friendId) private {
        Spot storage spot = spotOf[friendId];
        (int32 w, int32 h) = footprint(friendId);
        for (int32 j; j < h; ++j) {
            for (int32 i; i < w; ++i) {
                bytes32 key = _key(spot.x + i, spot.y + j);
                if (_cell[key] == friendId + 1) delete _cell[key];
            }
        }
    }

    function _remove(uint256 friendId) private {
        _clearCells(friendId);
        delete spotOf[friendId];
        uint256 index = _index[friendId];
        if (index != 0) {
            uint256 last = _placed[_placed.length - 1];
            _placed[index - 1] = last;
            _index[last] = index;
            _placed.pop();
            delete _index[friendId];
        }
        emit Removed(friendId);
    }

    function _holds(address holder, uint256 friendId) private view returns (bool) {
        try generations.ownerOf(friendId) returns (address owner) {
            return owner == holder;
        } catch {
            return false;
        }
    }

    function _validOrFalse(uint256 friendId) private view returns (bool) {
        try this.isValid(friendId) returns (bool valid) {
            return valid;
        } catch {
            return false;
        }
    }

    function _key(int32 x, int32 y) private pure returns (bytes32) {
        return keccak256(abi.encode(x, y));
    }
}
