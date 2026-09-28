// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { DocksIslands } from "./DocksIslands.sol";
import { DocksVillages, IDocksVillageItems } from "./DocksVillages.sol";
import { DocksVillageTreasury } from "./DocksVillageTreasury.sol";
import { IDiceEntropy } from "../ChanceGame.sol";

/// @notice Items built on island cells, from a fixed RF-priced catalog (until Rare Friends
/// marketplace items can be placed the same way).
///
/// - Village items: a member buys them with their village allowance for their own village
///   island. They belong to the village, stay on that island, and when the island leaves the
///   village they go to a raffle only the members who stayed can enter, with RF tickets. The
///   winner keeps the item as their own.
/// - Own items: bought with your own RF; always yours to place on, move between and take off
///   your islands.
/// - Building: a new item appears after its kind's build time; anyone can speed it up with
///   RF (`boost`). Every RF paid here (own items, tickets, boosts, and allowances spent on
///   village items) goes to the permanent liquidity of the island's village, or the shared
///   Docks pool for an island in no village. Nothing is burned.
/// - Raffle draws use Dice (entropy V2); anyone pays Dice's native fee to draw.
contract DocksItems is IDocksVillageItems, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_ITEMS_PER_ISLAND = 64;
    uint256 public constant RAFFLE_PERIOD = 3 days;
    uint32 public constant CALLBACK_GAS_LIMIT = 200_000;

    struct Item {
        uint32 kind;
        uint64 village; // village items: the owning village; own items: 0
        address owner; // own items: the owner; village items: 0
        uint64 island; // 0 while not placed
        int32 x;
        int32 y;
        uint64 readyAt;
    }

    struct Raffle {
        uint64 village;
        uint64 ends;
        uint64 sequence;
        bool requested;
        bool fulfilled;
        bytes32 word;
        uint256 tickets;
    }

    error UnknownKind();
    error NotYours();
    error NotOnLand();
    error CellTaken();
    error IslandFull();
    error NotInVillage();
    error NotPlaced();
    error NotBuilding();
    error NotRaffled();
    error RaffleOpen();
    error RaffleClosed();
    error AlreadyRequested();
    error IncorrectOracleFee();
    error UnauthorizedRandomness();
    error RandomnessPending();
    error NotVillages();

    event Built(uint256 indexed itemId, uint32 kind, uint256 indexed island, int32 x, int32 y, uint64 readyAt, uint256 indexed village);
    event Moved(uint256 indexed itemId, uint256 island, int32 x, int32 y);
    event Boosted(uint256 indexed itemId, uint256 rf, uint64 readyAt);
    event Raffled(uint256 indexed itemId, uint256 indexed village, uint64 ends);
    event TicketsBought(uint256 indexed itemId, address indexed wallet, uint256 count, uint256 rf);
    event RaffleWon(uint256 indexed itemId, address indexed winner);

    IERC20 public immutable rf;
    DocksIslands public immutable islands;
    DocksVillages public immutable villages;
    IDiceEntropy public immutable entropy;
    address public immutable provider;
    uint256 public immutable ticketPrice;
    uint256 public immutable boostSecondsPerRf; // build time cut per 1 RF

    uint256[] public priceOf; // by kind
    uint32[] public buildTimeOf; // seconds, by kind
    Item[] private _items;
    mapping(bytes32 islandCell => uint256 itemIdPlusOne) private _itemAt;
    mapping(uint256 island => uint256[]) private _onIsland;
    mapping(uint256 itemId => Raffle) public raffles;
    mapping(uint256 itemId => address[]) private _ticketBuyers;
    mapping(uint256 itemId => uint256[]) private _ticketsUpTo; // cumulative
    mapping(uint64 sequence => uint256 itemIdPlusOne) private _requestItem;

    constructor(
        IERC20 rf_,
        DocksVillages villages_,
        IDiceEntropy entropy_,
        address provider_,
        uint256 ticketPrice_,
        uint256 boostSecondsPerRf_,
        uint256[] memory prices,
        uint32[] memory buildTimes
    ) {
        rf = rf_;
        villages = villages_;
        islands = villages_.islands();
        entropy = entropy_;
        provider = provider_;
        ticketPrice = ticketPrice_;
        boostSecondsPerRf = boostSecondsPerRf_;
        priceOf = prices;
        buildTimeOf = buildTimes;
    }

    /* ── building ── */

    /// @notice Build a village item on your island in `villageId`, paid from your allowance.
    function buyForVillage(uint256 villageId, uint32 kind, int32 x, int32 y) external nonReentrant returns (uint256 itemId) {
        uint256 island = villages.islandOf(villageId, msg.sender);
        if (island == 0) revert NotInVillage();
        uint256 price = _price(kind);
        _treasury().payFromAllowance(villageId, msg.sender, price);
        itemId = _new(kind, uint64(villageId), address(0), island, x, y);
    }

    /// @notice Build an item of your own on one of your islands, paid with your RF.
    function buy(uint32 kind, uint256 island, int32 x, int32 y) external nonReentrant returns (uint256 itemId) {
        if (islands.ownerOf(island) != msg.sender) revert NotYours();
        _pay(island, _price(kind));
        itemId = _new(kind, 0, msg.sender, island, x, y);
    }

    /// @notice Speed up an item that is still being built: each RF cuts `boostSecondsPerRf`.
    function boost(uint256 itemId, uint256 amount) external nonReentrant returns (uint64 readyAt) {
        Item storage it = _items[itemId];
        if (it.island == 0 || block.timestamp >= it.readyAt) revert NotBuilding();
        _pay(it.island, amount);
        uint256 cut = amount * boostSecondsPerRf / 1 ether;
        readyAt = it.readyAt - block.timestamp <= cut ? uint64(block.timestamp) : uint64(it.readyAt - cut);
        it.readyAt = readyAt;
        emit Boosted(itemId, amount, readyAt);
    }

    /// @notice Move an item: your own items to any cell of your islands; a village item
    /// within the island it's on, by that island's owner.
    function move(uint256 itemId, uint256 island, int32 x, int32 y) external {
        Item storage it = _items[itemId];
        if (islands.ownerOf(island) != msg.sender) revert NotYours();
        if (it.owner != msg.sender && (it.village == 0 || it.island != island)) revert NotYours();
        _unplace(itemId);
        _place(itemId, island, x, y);
        emit Moved(itemId, island, x, y);
    }

    /// @notice Take one of your own items off its island (it stays yours).
    function takeOff(uint256 itemId) external {
        Item storage it = _items[itemId];
        if (it.owner != msg.sender) revert NotYours();
        if (it.island == 0) revert NotPlaced();
        _unplace(itemId);
        emit Moved(itemId, 0, 0, 0);
    }

    /* ── raffles for the items an island leaves behind ── */

    /// @inheritdoc IDocksVillageItems
    function onIslandLeft(uint256 villageId, uint256 islandId) external {
        if (msg.sender != address(villages)) revert NotVillages();
        uint256[] storage list = _onIsland[islandId];
        for (uint256 i = list.length; i > 0; --i) {
            uint256 itemId = list[i - 1];
            if (_items[itemId].village != villageId) continue;
            _unplace(itemId);
            _openRaffle(itemId, uint64(villageId));
        }
    }

    /// @notice Buy raffle tickets with RF (to the village's liquidity). Members only.
    function buyTickets(uint256 itemId, uint256 count) external nonReentrant {
        Raffle storage r = raffles[itemId];
        if (r.village == 0) revert NotRaffled();
        if (block.timestamp >= r.ends) revert RaffleClosed();
        if (villages.islandOf(r.village, msg.sender) == 0) revert NotInVillage();
        uint256 cost = count * ticketPrice;
        rf.safeTransferFrom(msg.sender, address(_treasury()), cost);
        _treasury().queueLiquidity(r.village, cost);
        r.tickets += count;
        _ticketBuyers[itemId].push(msg.sender);
        _ticketsUpTo[itemId].push(r.tickets);
        emit TicketsBought(itemId, msg.sender, count, cost);
    }

    /// @notice After a raffle ends, anyone pays Dice's fee to draw it. A raffle nobody entered
    /// runs again.
    function draw(uint256 itemId) external payable nonReentrant returns (uint64 sequence) {
        Raffle storage r = raffles[itemId];
        if (r.village == 0) revert NotRaffled();
        if (block.timestamp < r.ends) revert RaffleOpen();
        if (r.requested) revert AlreadyRequested();
        if (r.tickets == 0) {
            if (msg.value != 0) revert IncorrectOracleFee();
            r.ends = uint64(block.timestamp + RAFFLE_PERIOD);
            emit Raffled(itemId, r.village, r.ends);
            return 0;
        }
        if (msg.value != entropy.getFeeV2(provider, CALLBACK_GAS_LIMIT)) revert IncorrectOracleFee();
        r.requested = true;
        sequence = entropy.requestV2{ value: msg.value }(
            provider, keccak256(abi.encode(address(this), block.chainid, itemId)), CALLBACK_GAS_LIMIT
        );
        r.sequence = sequence;
        _requestItem[sequence] = itemId + 1;
    }

    /// @notice Dice callback: stores the word; `claim` hands the item over.
    function _entropyCallback(uint64 sequence, address provider_, bytes32 word) external {
        if (msg.sender != address(entropy) || provider_ != provider) revert UnauthorizedRandomness();
        uint256 itemIdPlusOne = _requestItem[sequence];
        Raffle storage r = raffles[itemIdPlusOne - 1];
        if (itemIdPlusOne == 0 || r.fulfilled) revert UnauthorizedRandomness();
        r.word = word;
        r.fulfilled = true;
    }

    /// @notice Give a drawn item to its winner, as their own item. Anyone may call it.
    function claim(uint256 itemId) external returns (address winner) {
        Raffle storage r = raffles[itemId];
        if (r.village == 0) revert NotRaffled();
        if (!r.fulfilled) revert RandomnessPending();
        uint256 ticket = uint256(keccak256(abi.encode(r.word, address(this), block.chainid, itemId))) % r.tickets;
        uint256[] storage upTo = _ticketsUpTo[itemId];
        (uint256 lo, uint256 hi) = (0, upTo.length - 1);
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (upTo[mid] > ticket) hi = mid;
            else lo = mid + 1;
        }
        winner = _ticketBuyers[itemId][lo];
        Item storage it = _items[itemId];
        it.owner = winner;
        it.village = 0;
        delete raffles[itemId];
        delete _ticketBuyers[itemId];
        delete _ticketsUpTo[itemId];
        emit RaffleWon(itemId, winner);
    }

    /* ── reads ── */

    function items(uint256 itemId) external view returns (Item memory) {
        return _items[itemId];
    }

    function itemCount() external view returns (uint256) {
        return _items.length;
    }

    function itemsOn(uint256 island) external view returns (uint256[] memory) {
        return _onIsland[island];
    }

    function itemAt(uint256 island, int32 x, int32 y) external view returns (uint256 itemIdPlusOne) {
        return _itemAt[_cellKey(island, x, y)];
    }

    /// @notice Whether an item is placed and finished building.
    function ready(uint256 itemId) external view returns (bool) {
        Item storage it = _items[itemId];
        return it.island != 0 && block.timestamp >= it.readyAt;
    }

    function kinds() external view returns (uint256) {
        return priceOf.length;
    }

    /* ── internals ── */

    function _new(uint32 kind, uint64 village, address owner, uint256 island, int32 x, int32 y)
        private
        returns (uint256 itemId)
    {
        itemId = _items.length;
        uint64 readyAt = uint64(block.timestamp + buildTimeOf[kind]);
        _items.push(Item(kind, village, owner, 0, 0, 0, readyAt));
        _place(itemId, island, x, y);
        emit Built(itemId, kind, island, x, y, readyAt, village);
    }

    function _place(uint256 itemId, uint256 island, int32 x, int32 y) private {
        (bool occupied,, bool hole) = islands.friendAt(island, x, y);
        if (!occupied || hole) revert NotOnLand();
        bytes32 key = _cellKey(island, x, y);
        if (_itemAt[key] != 0) revert CellTaken();
        if (_onIsland[island].length >= MAX_ITEMS_PER_ISLAND) revert IslandFull();
        _itemAt[key] = itemId + 1;
        _onIsland[island].push(itemId);
        Item storage it = _items[itemId];
        (it.island, it.x, it.y) = (uint64(island), x, y);
    }

    function _unplace(uint256 itemId) private {
        Item storage it = _items[itemId];
        uint256 island = it.island;
        if (island == 0) return;
        delete _itemAt[_cellKey(island, it.x, it.y)];
        uint256[] storage list = _onIsland[island];
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == itemId) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
        it.island = 0;
    }

    function _openRaffle(uint256 itemId, uint64 village) private {
        uint64 ends = uint64(block.timestamp + RAFFLE_PERIOD);
        raffles[itemId] = Raffle(village, ends, 0, false, false, bytes32(0), 0);
        emit Raffled(itemId, village, ends);
    }

    /// @dev RF to the pool of the island's village, or the shared Docks pool.
    function _pay(uint256 island, uint256 amount) private {
        rf.safeTransferFrom(msg.sender, address(_treasury()), amount);
        _treasury().onFee(island, amount);
    }

    function _price(uint32 kind) private view returns (uint256) {
        if (kind >= priceOf.length) revert UnknownKind();
        return priceOf[kind];
    }

    function _treasury() private view returns (DocksVillageTreasury) {
        return DocksVillageTreasury(address(villages.treasury()));
    }

    function _cellKey(uint256 island, int32 x, int32 y) private pure returns (bytes32) {
        return keccak256(abi.encode(island, x, y));
    }
}
