// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC721 } from "lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import { Base64 } from "lib/openzeppelin-contracts/contracts/utils/Base64.sol";
import { Strings } from "lib/openzeppelin-contracts/contracts/utils/Strings.sol";

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

/// @notice The Docks: floating islands made of activated Rare Friends. Every plot is an NFT.
///
/// - Island: a plot's Friends, arranged on the plot's own grid of 4x4-tile cells (each Friend
///   covers its land at true size: Gen 1 8x8 cells ... Gen 6 1x1). A Friend is on at most one
///   plot; a holder can deploy their Friends across as many plots as they like.
/// - Arranging is the core action and is paid in RF: saving burns RF for every Friend whose
///   spot on its island changes (new to the plot or moved), by generation. Unmoved Friends
///   are free; taking a Friend off is free.
/// - Docking: islands float on one shared berth grid, one island per berth whatever its size,
///   so the world grows with the number of plots, not their size. An island docks at a free
///   berth next to an existing island (a loading zone); islands on neighbouring berths are
///   docked to each other. Docking and moving an island cost only gas.
/// - Bridges: link your island to one you can't dock next to, for RF burned per berth of
///   distance. A bridge lasts until either island moves.
/// - Access: each plot is open or invite-only with approved visitors.
///
/// @dev A Friend counts on its plot only while it is activated and held by the plot NFT's
/// owner; stale placements can be cleared by anyone. Friends are never escrowed: a Rare
/// Friends transfer clears activation, so a plot NFT can't carry its Friends with it.
contract DocksPlots is ERC721 {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    struct Spot {
        uint256 plotId;
        int32 x;
        int32 y;
        bool placed;
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

    error NotPlotOwner();
    error NotHolder();
    error NotActive();
    error CellTaken();
    error NotPlaced();
    error StillValid();
    error LengthMismatch();
    error EmptyPlot();
    error BerthTaken();
    error NotLoadingZone();
    error NotDocked();
    error AlreadyConnected();

    event PlotMinted(uint256 indexed plotId, address indexed owner, string name);
    event Arranged(uint256 indexed plotId, uint256 moved, uint256 rfBurned);
    event Placed(uint256 indexed friendId, uint256 indexed plotId, int32 x, int32 y);
    event Removed(uint256 indexed friendId, uint256 indexed plotId);
    event Docked(uint256 indexed plotId, int32 x, int32 y);
    event Undocked(uint256 indexed plotId);
    event BridgeBuilt(uint256 indexed from, uint256 indexed to, uint256 rfBurned);
    event PlotUpdated(uint256 indexed plotId, string name, bool inviteOnly);
    event VisitorSet(uint256 indexed plotId, address indexed visitor, bool approved);
    event VisitRequested(uint256 indexed plotId, address indexed visitor);

    IDocksGenerations public immutable generations;
    IERC20 public immutable rf;

    uint256 public totalPlots;
    uint256 public dockedCount;
    mapping(uint256 plotId => string) public plotName;
    mapping(uint256 plotId => bool) public inviteOnly;
    mapping(uint256 plotId => mapping(address visitor => bool)) public approved;

    mapping(uint256 friendId => Spot) public spotOf;
    mapping(bytes32 plotCell => uint256 friendIdPlusOne) private _cell;
    mapping(uint256 plotId => uint256[]) private _members;
    mapping(uint256 friendId => uint256 indexPlusOne) private _memberIndex;

    mapping(uint256 plotId => Berth) public berthOf;
    mapping(bytes32 berth => uint256 plotIdPlusOne) private _berth;
    mapping(bytes32 pair => uint128 epochs) private _bridge;

    constructor(IDocksGenerations generations_, IERC20 rf_) ERC721("The Docks Plot", "PLOT") {
        generations = generations_;
        rf = rf_;
    }

    /* ── plots ── */

    /// @notice Mint a new, empty plot NFT to yourself. Only gas.
    function mint(string calldata name) external returns (uint256 plotId) {
        plotId = ++totalPlots;
        _mint(msg.sender, plotId);
        plotName[plotId] = name;
        emit PlotMinted(plotId, msg.sender, name);
    }

    function setPlot(uint256 plotId, string calldata name, bool inviteOnly_) external {
        _onlyPlotOwner(plotId);
        plotName[plotId] = name;
        inviteOnly[plotId] = inviteOnly_;
        emit PlotUpdated(plotId, name, inviteOnly_);
    }

    function setVisitor(uint256 plotId, address visitor, bool approved_) external {
        _onlyPlotOwner(plotId);
        approved[plotId][visitor] = approved_;
        emit VisitorSet(plotId, visitor, approved_);
    }

    function requestVisit(uint256 plotId) external {
        emit VisitRequested(plotId, msg.sender);
    }

    function canVisit(uint256 plotId, address visitor) public view returns (bool) {
        return _ownerOf(plotId) == visitor || !inviteOnly[plotId] || approved[plotId][visitor];
    }

    /* ── arranging an island (the core action) ── */

    /// @notice RF burned per Friend moved, by generation.
    function feeOf(uint256 friendId) public view returns (uint256) {
        uint8 g = generations.generation(friendId);
        if (g == 1) return FEE_GEN1;
        if (g == 2) return FEE_GEN2;
        if (g == 3) return FEE_GEN3;
        if (g == 4) return FEE_GEN4;
        if (g == 5) return FEE_GEN5;
        return FEE_GEN6;
    }

    /// @notice The RF an `arrange` call would burn (Friends whose spot would change).
    function arrangeCost(
        uint256 plotId,
        uint256[] calldata friendIds,
        int32[] calldata xs,
        int32[] calldata ys
    ) external view returns (uint256 cost, uint256 moved) {
        if (friendIds.length != xs.length || friendIds.length != ys.length) revert LengthMismatch();
        for (uint256 i; i < friendIds.length; ++i) {
            if (_changes(plotId, friendIds[i], xs[i], ys[i])) {
                cost += feeOf(friendIds[i]);
                ++moved;
            }
        }
    }

    /// @notice Save island positions for Friends you hold on a plot you own (also deploys a
    /// Friend from another of your plots). Friends whose spot changes burn their generation's
    /// fee; the rest are free. Cells vacated earlier in the call can be reused.
    function arrange(
        uint256 plotId,
        uint256[] calldata friendIds,
        int32[] calldata xs,
        int32[] calldata ys
    ) external returns (uint256 burned) {
        _onlyPlotOwner(plotId);
        if (friendIds.length != xs.length || friendIds.length != ys.length) revert LengthMismatch();
        uint256 moved;
        bool[] memory changed = new bool[](friendIds.length);
        for (uint256 i; i < friendIds.length; ++i) {
            uint256 id = friendIds[i];
            if (generations.ownerOf(id) != msg.sender) revert NotHolder();
            if (!isActive(id)) revert NotActive();
            if (!_changes(plotId, id, xs[i], ys[i])) continue;
            changed[i] = true;
            burned += feeOf(id);
            ++moved;
            if (spotOf[id].placed) _clearCells(id);
        }
        for (uint256 i; i < friendIds.length; ++i) {
            if (changed[i]) _place(plotId, friendIds[i], xs[i], ys[i]);
        }
        if (burned > 0) rf.safeTransferFrom(msg.sender, BURN, burned);
        emit Arranged(plotId, moved, burned);
    }

    /// @notice Take Friends you hold off their plots. Free.
    function remove(uint256[] calldata friendIds) external {
        for (uint256 i; i < friendIds.length; ++i) {
            if (generations.ownerOf(friendIds[i]) != msg.sender) revert NotHolder();
            if (!spotOf[friendIds[i]].placed) revert NotPlaced();
            _remove(friendIds[i]);
        }
    }

    /// @notice Clears a placement that is no longer valid (Friend sold or deactivated, or the
    /// plot NFT now belongs to someone who doesn't hold the Friend).
    function clear(uint256 friendId) external {
        if (!spotOf[friendId].placed) revert NotPlaced();
        if (isValid(friendId)) revert StillValid();
        _remove(friendId);
    }

    /* ── docking islands (gas only) ── */

    /// @notice Dock (or move) your island at a free berth next to another island. The first
    /// island in the world may dock anywhere.
    function dock(uint256 plotId, int32 x, int32 y) external {
        _onlyPlotOwner(plotId);
        if (_members[plotId].length == 0) revert EmptyPlot();
        bytes32 key = _key(x, y);
        uint256 there = _berth[key];
        if (there != 0 && there != plotId + 1) revert BerthTaken();
        Berth storage b = berthOf[plotId];
        if (b.docked) {
            delete _berth[_key(b.x, b.y)];
            --dockedCount;
        }
        if (dockedCount > 0 && !_nextToIsland(x, y)) revert NotLoadingZone();
        _berth[key] = plotId + 1;
        berthOf[plotId] = Berth(x, y, true, b.epoch + 1);
        ++dockedCount;
        emit Docked(plotId, x, y);
    }

    function undock(uint256 plotId) external {
        _onlyPlotOwner(plotId);
        _undock(plotId);
    }

    /// @notice Anyone can undock an island whose Friends have all been cleared.
    function undockEmpty(uint256 plotId) external {
        if (_members[plotId].length != 0) revert StillValid();
        _undock(plotId);
    }

    /// @notice Whether a free berth is a loading zone: next to a docked island.
    function isLoadingZone(int32 x, int32 y) external view returns (bool) {
        return _berth[_key(x, y)] == 0 && (dockedCount == 0 || _nextToIsland(x, y));
    }

    function plotAtBerth(int32 x, int32 y) external view returns (uint256) {
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

    /// @notice Build a bridge from your island to one you aren't docked next to.
    function buildBridge(uint256 from, uint256 to) external returns (uint256 burned) {
        _onlyPlotOwner(from);
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

    function isValid(uint256 friendId) public view returns (bool) {
        Spot storage spot = spotOf[friendId];
        if (!spot.placed) return false;
        address plotOwner = _ownerOf(spot.plotId);
        return plotOwner != address(0) && _holds(plotOwner, friendId) && isActive(friendId);
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

    function friendAt(uint256 plotId, int32 x, int32 y) public view returns (bool occupied, uint256 friendId) {
        uint256 value = _cell[_cellKey(plotId, x, y)];
        return (value != 0, value == 0 ? 0 : value - 1);
    }

    /// @notice Whether two Friends on the same island share (part of) an edge.
    function adjacent(uint256 a, uint256 b) public view returns (bool) {
        Spot storage sa = spotOf[a];
        Spot storage sb = spotOf[b];
        if (!sa.placed || !sb.placed || sa.plotId != sb.plotId) return false;
        (int32 aw, int32 ah) = footprint(a);
        (int32 bw, int32 bh) = footprint(b);
        bool xTouch = sa.x + aw == sb.x || sb.x + bw == sa.x;
        bool yTouch = sa.y + ah == sb.y || sb.y + bh == sa.y;
        bool xOverlap = sa.x < sb.x + bw && sb.x < sa.x + aw;
        bool yOverlap = sa.y < sb.y + bh && sb.y < sa.y + ah;
        return (xTouch && yOverlap) || (yTouch && xOverlap);
    }

    function plotOf(uint256 friendId) external view returns (uint256) {
        return spotOf[friendId].placed ? spotOf[friendId].plotId : 0;
    }

    function memberCount(uint256 plotId) external view returns (uint256) {
        return _members[plotId].length;
    }

    /// @notice Page through one island's Friends.
    function members(uint256 plotId, uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory ids, Spot[] memory spots)
    {
        uint256[] storage list = _members[plotId];
        uint256 end = start + count > list.length ? list.length : start + count;
        uint256 n = end > start ? end - start : 0;
        ids = new uint256[](n);
        spots = new Spot[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = list[start + i];
            spots[i] = spotOf[ids[i]];
        }
    }

    /// @notice Fully on-chain metadata: a top-down map of the island's Friends.
    function tokenURI(uint256 plotId) public view override returns (string memory) {
        _requireOwned(plotId);
        uint256[] storage list = _members[plotId];
        uint256 shown = list.length > 400 ? 400 : list.length;
        (int256 x0, int256 y0, int256 x1, int256 y1) = _bounds(list, shown);
        bytes memory rects;
        for (uint256 i; i < shown; ++i) {
            Spot storage s = spotOf[list[i]];
            (int32 w, int32 h) = footprint(list[i]);
            rects = abi.encodePacked(
                rects,
                '<rect x="', _u(int256(s.x) - x0), '" y="', _u(int256(s.y) - y0),
                '" width="', _u(int256(w)), '" height="', _u(int256(h)),
                '" fill="#fff" stroke="#000" stroke-width="0.1"/>'
            );
        }
        string memory svg = string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ', _u(x1 - x0 + 2), " ",
            _u(y1 - y0 + 2), '"><rect x="-1" y="-1" width="100%" height="100%" fill="#000"/>',
            rects, "</svg>"
        ));
        Berth storage b = berthOf[plotId];
        string memory json = string(abi.encodePacked(
            '{"name":"', _name(plotId), '","description":"A floating island on The Docks, made of activated Rare Friends.",',
            '"attributes":[{"trait_type":"Friends","value":', list.length.toString(),
            '},{"trait_type":"Access","value":"', inviteOnly[plotId] ? "Invite only" : "Open",
            '"},{"trait_type":"Docked","value":"', b.docked ? "Yes" : "No", '"}],',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '"}'
        ));
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(bytes(json))));
    }

    /* ── internals ── */

    function _onlyPlotOwner(uint256 plotId) private view {
        if (_ownerOf(plotId) != msg.sender) revert NotPlotOwner();
    }

    function _changes(uint256 plotId, uint256 id, int32 x, int32 y) private view returns (bool) {
        Spot storage s = spotOf[id];
        return !s.placed || s.plotId != plotId || s.x != x || s.y != y;
    }

    function _place(uint256 plotId, uint256 friendId, int32 x, int32 y) private {
        Spot storage old = spotOf[friendId];
        bool wasOnPlot = old.placed && old.plotId == plotId;
        if (old.placed && !wasOnPlot) _leavePlot(friendId, old.plotId);
        (int32 w, int32 h) = footprint(friendId);
        for (int32 j; j < h; ++j) {
            for (int32 i; i < w; ++i) {
                bytes32 key = _cellKey(plotId, x + i, y + j);
                uint256 occupant = _cell[key];
                if (occupant != 0) {
                    // A stale occupant (sold or deactivated) gives way; a valid one does not.
                    if (isValid(occupant - 1)) revert CellTaken();
                    _remove(occupant - 1);
                }
                _cell[key] = friendId + 1;
            }
        }
        spotOf[friendId] = Spot(plotId, x, y, true);
        if (!wasOnPlot) {
            _members[plotId].push(friendId);
            _memberIndex[friendId] = _members[plotId].length;
        }
        emit Placed(friendId, plotId, x, y);
    }

    function _clearCells(uint256 friendId) private {
        Spot storage spot = spotOf[friendId];
        (int32 w, int32 h) = footprint(friendId);
        for (int32 j; j < h; ++j) {
            for (int32 i; i < w; ++i) {
                bytes32 key = _cellKey(spot.plotId, spot.x + i, spot.y + j);
                if (_cell[key] == friendId + 1) delete _cell[key];
            }
        }
    }

    function _leavePlot(uint256 friendId, uint256 plotId) private {
        uint256[] storage list = _members[plotId];
        uint256 index = _memberIndex[friendId];
        if (index == 0) return;
        uint256 last = list[list.length - 1];
        list[index - 1] = last;
        _memberIndex[last] = index;
        list.pop();
        delete _memberIndex[friendId];
    }

    function _remove(uint256 friendId) private {
        uint256 plotId = spotOf[friendId].plotId;
        _clearCells(friendId);
        _leavePlot(friendId, plotId);
        delete spotOf[friendId];
        emit Removed(friendId, plotId);
    }

    function _undock(uint256 plotId) private {
        Berth storage b = berthOf[plotId];
        if (!b.docked) revert NotDocked();
        delete _berth[_key(b.x, b.y)];
        b.docked = false;
        ++b.epoch;
        --dockedCount;
        emit Undocked(plotId);
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

    function _bounds(uint256[] storage list, uint256 shown)
        private
        view
        returns (int256 x0, int256 y0, int256 x1, int256 y1)
    {
        if (shown == 0) return (0, 0, 1, 1);
        (x0, y0, x1, y1) = (type(int256).max, type(int256).max, type(int256).min, type(int256).min);
        for (uint256 i; i < shown; ++i) {
            Spot storage s = spotOf[list[i]];
            (int32 w, int32 h) = footprint(list[i]);
            if (s.x < x0) x0 = s.x;
            if (s.y < y0) y0 = s.y;
            if (s.x + w > x1) x1 = s.x + w;
            if (s.y + h > y1) y1 = s.y + h;
        }
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

    function _cellKey(uint256 plotId, int32 x, int32 y) private pure returns (bytes32) {
        return keccak256(abi.encode(plotId, x, y));
    }

    function _u(int256 v) private pure returns (string memory) {
        return uint256(v).toString();
    }

    /// @dev Plot names are user text: keep JSON-safe characters only.
    function _name(uint256 plotId) private view returns (string memory) {
        bytes memory raw = bytes(plotName[plotId]);
        bytes memory out = new bytes(raw.length);
        uint256 n;
        for (uint256 i; i < raw.length && n < 48; ++i) {
            bytes1 c = raw[i];
            if (c >= 0x20 && c != '"' && c != "\\" && c < 0x7f) out[n++] = c;
        }
        assembly { mstore(out, n) }
        return n == 0 ? string(abi.encodePacked("Plot #", plotId.toString())) : string(out);
    }
}
