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

/// @notice The Docks: every plot is an NFT. A plot is an arrangement of activated Friends,
/// held by the plot's owner, on one shared grid of 4x4-tile cells. Each Friend covers the
/// cells of its land at true size (Gen 1: 8x8 cells ... Gen 6: 1x1). Friends of different
/// plots in edge-touching cells are docked. Plots are open or invite-only.
///
/// Arranging is the core action and it is paid for in RF: saving an arrangement burns RF for
/// every Friend whose spot changes (new to the plot or moved), scaled by generation. Friends
/// that stay put cost nothing; taking a Friend off a plot is free.
///
/// @dev A Friend counts on its plot only while it is activated and held by the plot NFT's
/// owner. Selling a Friend (which also clears its activation) or transferring the plot NFT
/// without the Friends leaves stale placements; anyone can clear those. Friends are never
/// escrowed: moving a Friend's ownership would clear its activation.
contract DocksPlots is ERC721 {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    struct Spot {
        uint256 plotId;
        int32 x;
        int32 y;
        bool placed;
    }

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    /// @notice RF burned per Friend moved, by generation (Gen 1 ... Gen 6).
    uint256 public constant FEE_GEN1 = 100 ether;
    uint256 public constant FEE_GEN2 = 50 ether;
    uint256 public constant FEE_GEN3 = 20 ether;
    uint256 public constant FEE_GEN4 = 10 ether;
    uint256 public constant FEE_GEN5 = 5 ether;
    uint256 public constant FEE_GEN6 = 1 ether;

    error NotPlotOwner();
    error NotHolder();
    error NotActive();
    error CellTaken();
    error NotPlaced();
    error StillValid();
    error LengthMismatch();

    event PlotMinted(uint256 indexed plotId, address indexed owner, string name);
    event Arranged(uint256 indexed plotId, uint256 moved, uint256 rfBurned);
    event Placed(uint256 indexed friendId, uint256 indexed plotId, int32 x, int32 y);
    event Removed(uint256 indexed friendId, uint256 indexed plotId);
    event PlotUpdated(uint256 indexed plotId, string name, bool inviteOnly);
    event VisitorSet(uint256 indexed plotId, address indexed visitor, bool approved);
    event VisitRequested(uint256 indexed plotId, address indexed visitor);

    IDocksGenerations public immutable generations;
    IERC20 public immutable rf;

    uint256 public totalPlots;
    mapping(uint256 plotId => string) public plotName;
    mapping(uint256 plotId => bool) public inviteOnly;
    mapping(uint256 plotId => mapping(address visitor => bool)) public approved;

    mapping(uint256 friendId => Spot) public spotOf;
    mapping(bytes32 cell => uint256 friendIdPlusOne) private _cell;
    uint256[] private _placed;
    mapping(uint256 friendId => uint256 indexPlusOne) private _index;
    mapping(uint256 plotId => uint256[]) private _members;
    mapping(uint256 friendId => uint256 indexPlusOne) private _memberIndex;

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
        address owner = _ownerOf(plotId);
        return owner == visitor || !inviteOnly[plotId] || approved[plotId][visitor];
    }

    /* ── arranging (the core action) ── */

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

    /// @notice Save positions for Friends you hold on a plot you own. Friends whose spot
    /// changes (new to this plot, or moved) burn their generation's RF fee; the rest are free.
    /// One call can move a whole crew, and cells vacated earlier in the call can be reused.
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

    function friendAt(int32 x, int32 y) public view returns (bool occupied, uint256 friendId) {
        uint256 value = _cell[_key(x, y)];
        return (value != 0, value == 0 ? 0 : value - 1);
    }

    /// @notice Whether two placed Friends' footprints share (part of) an edge.
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

    function plotOf(uint256 friendId) external view returns (uint256) {
        return spotOf[friendId].placed ? spotOf[friendId].plotId : 0;
    }

    function memberCount(uint256 plotId) external view returns (uint256) {
        return _members[plotId].length;
    }

    /// @notice Page through one plot's Friends.
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

    function placedCount() external view returns (uint256) {
        return _placed.length;
    }

    /// @notice Page through every placement in the world, for discovery.
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

    /// @notice Fully on-chain metadata: a top-down map of the plot's Friends.
    function tokenURI(uint256 plotId) public view override returns (string memory) {
        _requireOwned(plotId);
        uint256[] storage list = _members[plotId];
        uint256 shown = list.length > 400 ? 400 : list.length;
        int256 x0 = type(int256).max;
        int256 y0 = type(int256).max;
        int256 x1 = type(int256).min;
        int256 y1 = type(int256).min;
        for (uint256 i; i < shown; ++i) {
            Spot storage s = spotOf[list[i]];
            (int32 w, int32 h) = footprint(list[i]);
            if (s.x < x0) x0 = s.x;
            if (s.y < y0) y0 = s.y;
            if (s.x + w > x1) x1 = s.x + w;
            if (s.y + h > y1) y1 = s.y + h;
        }
        if (shown == 0) (x0, y0, x1, y1) = (0, 0, 1, 1);
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
        string memory json = string(abi.encodePacked(
            '{"name":"', _name(plotId), '","description":"A plot on The Docks: activated Rare Friends arranged side by side.",',
            '"attributes":[{"trait_type":"Friends","value":', list.length.toString(),
            '},{"trait_type":"Access","value":"', inviteOnly[plotId] ? "Invite only" : "Open", '"}],',
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
        if (old.placed && old.plotId != plotId) _leavePlot(friendId, old.plotId);
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
        bool wasOnPlot = old.placed && old.plotId == plotId;
        spotOf[friendId] = Spot(plotId, x, y, true);
        if (!wasOnPlot) {
            _members[plotId].push(friendId);
            _memberIndex[friendId] = _members[plotId].length;
        }
        if (_index[friendId] == 0) {
            _placed.push(friendId);
            _index[friendId] = _placed.length;
        }
        emit Placed(friendId, plotId, x, y);
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
        uint256 index = _index[friendId];
        if (index != 0) {
            uint256 last = _placed[_placed.length - 1];
            _placed[index - 1] = last;
            _index[last] = index;
            _placed.pop();
            delete _index[friendId];
        }
        emit Removed(friendId, plotId);
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
