// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { DocksIslands } from "./DocksIslands.sol";
import { DocksFounderMarks } from "./DocksFounderMarks.sol";

/// @notice The village treasury as seen by DocksVillages (see DocksVillageTreasury).
interface IDocksVillageTreasury {
    /// @dev A flag was founded: `treasuryRf + liquidityRf` RF was sent to the treasury.
    function found(uint256 villageId, uint256 treasuryRf, uint256 liquidityRf) external;
    /// @dev An enrollment fee of `amount` RF was sent to the treasury.
    function deposit(uint256 villageId, uint256 amount) external;
    function spend(uint256 villageId, address to, uint256 amount) external;
    function setBurnBps(uint256 villageId, uint16 burnBps) external;
}

/// @notice Villages on The Docks: raised together, then grown by their people.
///
/// Flags. A holder plants a flag on a land cell of their docked island and locks the first RF.
/// Anyone can lock more until it reaches `flagTarget` (e.g. 1,000,000 RF). Every locker gets a
/// soulbound founder mark recording what they locked. Not full by the deadline: everyone can
/// take their RF back. Full: `found` (anyone) sends it all to the village treasury, half as
/// treasury RF and half as permanent liquidity. Nothing can be withdrawn after that.
///
/// People. Everyone in a village brings exactly one island (one per wallet): the planter's is
/// the seat; founders bring theirs free; anyone else enrolls for the enrollment price, which
/// goes into the village pool (half treasury, half liquidity). For the first ENROLL_WINDOW after
/// founding enrollment is open at `enrollPrice`; after that the village decides by vote.
///
/// Votes. Every Friend on a member's island is one vote, and founders multiply theirs by
/// (1 + their share of the pool): power = Friends × (1 + locked / pool). Enrollment fees grow
/// the pool, so every newcomer dilutes founder shares a little while adding their own Friends.
/// The more Friends a village has, the more it can do.
///  - Spend treasury RF (e.g. marketplace upgrades) or set the buyback burn share: yes/no,
///    VOTE_PERIOD, yes > no with QUORUM_BPS of all power voting.
///  - Enrollment (starts at founding and ends with the open window; any member can start one
///    later): keep open at the current price · change the price · close now · close when the
///    population (Friends in the village) reaches a threshold. Changing the price or setting a
///    threshold closes enrollment until a FOLLOW_UP_PERIOD vote between three prices or three
///    thresholds concludes. Most power wins; ties go to the earlier option.
contract DocksVillages is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev A full flag the treasury can't found (e.g. no market yet) can be refunded after this.
    uint256 public constant FOUNDING_GRACE = 7 days;
    uint256 public constant ENROLL_WINDOW = 7 days;
    uint256 public constant VOTE_PERIOD = 3 days;
    uint256 public constant FOLLOW_UP_PERIOD = 1 days;
    uint256 public constant QUORUM_BPS = 2000;
    uint256 private constant BPS = 10_000;

    enum Kind {
        Spend,
        BurnShare,
        Enrollment,
        EnrollPrice,
        EnrollCap
    }

    // Enrollment vote choices
    uint8 public constant KEEP_OPEN = 0;
    uint8 public constant CHANGE_PRICE = 1;
    uint8 public constant CLOSE_NOW = 2;
    uint8 public constant CLOSE_AT_POPULATION = 3;

    struct Village {
        string name;
        uint256 seatIsland; // the island the flag stands on
        int32 flagX; // island-local cell the flag stands on
        int32 flagY;
        uint64 deadline;
        uint64 foundedAt;
        uint128 locked; // RF locked into the flag by founders
        uint128 pool; // locked + every enrollment fee: the denominator of founder shares
        uint32 lockers;
        bool founded;
        bool enrollOpen; // after the open window, as decided by vote
        uint128 enrollPrice;
        uint64 enrollCap; // population at which enrollment closes (0: none)
        uint64 enrollVote; // active enrollment-family proposal + 1
    }

    struct Proposal {
        uint256 villageId;
        Kind kind;
        uint64 ends;
        bool settled;
        address to;
        uint256[3] options; // Spend: amount · BurnShare: bps · EnrollPrice / EnrollCap: the three choices
        uint256[4] tally; // yes/no: [no, yes]; enrollment: per choice
        string memo;
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
    error BadName();
    error NotOnLand();
    error SeatStays();
    error NotFounder();
    error HasIsland();
    error EnrollmentClosed();
    error NoPower();
    error BadProposal();
    error VoteRunning();
    error VotingClosed();
    error VotingOpen();
    error AlreadyVoted();
    error Settled();
    error AlreadyInitialized();

    event FlagPlanted(
        uint256 indexed villageId, uint256 indexed islandId, string name, int32 x, int32 y, uint64 deadline
    );
    event RFLocked(uint256 indexed villageId, address indexed wallet, uint256 amount, uint256 total);
    event Founded(uint256 indexed villageId, uint256 treasuryRf, uint256 liquidityRf);
    event Refunded(uint256 indexed villageId, address indexed wallet, uint256 amount);
    event Joined(uint256 indexed villageId, uint256 indexed islandId, address indexed wallet, uint256 paid);
    event Left(uint256 indexed villageId, uint256 indexed islandId);
    event Proposed(uint256 indexed proposalId, uint256 indexed villageId, Kind kind, uint64 ends);
    event Voted(uint256 indexed proposalId, address indexed wallet, uint8 choice, uint256 power);
    event ProposalSettled(uint256 indexed proposalId, uint8 winner);
    event EnrollmentSet(uint256 indexed villageId, bool open, uint256 price, uint256 cap);

    IERC20 public immutable rf;
    DocksIslands public immutable islands;
    DocksFounderMarks public immutable marks;
    uint256 public immutable flagTarget;
    uint256 public immutable flagDuration;
    uint256 public immutable minLock;
    uint256 public immutable startEnrollPrice;
    address private immutable _deployer;
    IDocksVillageTreasury public treasury;

    uint256 public villageCount;
    mapping(uint256 villageId => Village) private _villages;
    mapping(uint256 islandId => uint256 villageId) private _villageOf;
    mapping(uint256 villageId => mapping(address wallet => uint256 islandId)) public islandOf;
    mapping(uint256 villageId => address[]) private _members;
    mapping(uint256 villageId => mapping(address wallet => uint256 indexPlusOne)) private _memberIndex;
    Proposal[] private _proposals;
    mapping(uint256 proposalId => mapping(address wallet => bool)) public voted;

    constructor(
        IERC20 rf_,
        DocksIslands islands_,
        uint256 flagTarget_,
        uint256 flagDuration_,
        uint256 minLock_,
        uint256 enrollPrice_
    ) {
        rf = rf_;
        islands = islands_;
        flagTarget = flagTarget_;
        flagDuration = flagDuration_;
        minLock = minLock_;
        startEnrollPrice = enrollPrice_;
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
        Village storage v = _villages[villageId];
        v.name = name;
        v.seatIsland = islandId;
        v.flagX = x;
        v.flagY = y;
        v.deadline = uint64(block.timestamp + flagDuration);
        v.enrollPrice = uint128(startEnrollPrice);
        _villageOf[islandId] = villageId;
        emit FlagPlanted(villageId, islandId, name, x, y, v.deadline);
        _lock(villageId, amount);
    }

    /// @notice Lock RF into a rising flag. Anyone can add until it's full; the last lock is
    /// trimmed to exactly what's missing.
    function lock(uint256 villageId, uint256 amount) external nonReentrant returns (uint256 taken) {
        return _lock(villageId, amount);
    }

    /// @notice Turn a full flag into a village. Anyone may call it. Opens enrollment for
    /// ENROLL_WINDOW and the vote on what happens after it.
    function found(uint256 villageId) external nonReentrant {
        Village storage v = _villages[villageId];
        if (v.founded || v.seatIsland == 0) revert NotRising();
        if (v.locked < flagTarget) revert NotFull();
        v.founded = true;
        v.foundedAt = uint64(block.timestamp);
        v.pool = v.locked;
        address planter = islands.ownerOf(v.seatIsland);
        _addMember(villageId, planter, v.seatIsland);
        uint256 treasuryRf = uint256(v.locked) / 2;
        uint256 liquidityRf = uint256(v.locked) - treasuryRf;
        rf.safeTransfer(address(treasury), v.locked);
        treasury.found(villageId, treasuryRf, liquidityRf);
        emit Founded(villageId, treasuryRf, liquidityRf);
        uint256[3] memory none;
        v.enrollVote = uint64(_propose(villageId, Kind.Enrollment, address(0), none, "", ENROLL_WINDOW) + 1);
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

    /* ── people: everyone brings one island ── */

    /// @notice Founders bring one island of theirs into the village, free.
    function bring(uint256 villageId, uint256 islandId) external {
        if (marks.weightOf(villageId, msg.sender) == 0) revert NotFounder();
        _join(villageId, islandId);
        emit Joined(villageId, islandId, msg.sender, 0);
    }

    /// @notice Enroll one island of yours for the enrollment price, paid into the village pool.
    function enroll(uint256 villageId, uint256 islandId) external nonReentrant returns (uint256 paid) {
        paid = enrollPrice(villageId);
        if (paid == 0) revert EnrollmentClosed();
        _join(villageId, islandId);
        Village storage v = _villages[villageId];
        v.pool += uint128(paid);
        rf.safeTransferFrom(msg.sender, address(treasury), paid);
        treasury.deposit(villageId, paid);
        emit Joined(villageId, islandId, msg.sender, paid);
    }

    /// @notice Leave your village (free). The seat island, where the flag stands, stays.
    function leaveVillage(uint256 islandId) external {
        _onlyOwner(islandId);
        uint256 villageId = villageOf(islandId);
        if (villageId == 0) revert NotInVillage();
        if (_villages[villageId].seatIsland == islandId) revert SeatStays();
        delete _villageOf[islandId];
        delete islandOf[villageId][msg.sender];
        uint256 i = _memberIndex[villageId][msg.sender] - 1;
        address[] storage m = _members[villageId];
        address last = m[m.length - 1];
        m[i] = last;
        _memberIndex[villageId][last] = i + 1;
        m.pop();
        delete _memberIndex[villageId][msg.sender];
        emit Left(villageId, islandId);
    }

    /* ── votes ── */

    /// @notice Propose spending treasury RF (e.g. on a marketplace upgrade) or a new burn share.
    function propose(uint256 villageId, Kind kind, address to, uint256 value, string calldata memo)
        external
        returns (uint256 proposalId)
    {
        if (!_villages[villageId].founded) revert NotFounded();
        if (islandOf[villageId][msg.sender] == 0) revert NotInVillage();
        if (kind == Kind.Spend ? (to == address(0) || value == 0) : kind != Kind.BurnShare || value > BPS) {
            revert BadProposal();
        }
        if (bytes(memo).length > 140) revert BadProposal();
        uint256[3] memory opts;
        opts[0] = value;
        return _propose(villageId, kind, to, opts, memo, VOTE_PERIOD);
    }

    /// @notice Start an enrollment vote (keep open · change price · close now · close at a
    /// population). One enrollment vote runs at a time.
    function proposeEnrollment(uint256 villageId) external returns (uint256 proposalId) {
        Village storage v = _villages[villageId];
        if (!v.founded) revert NotFounded();
        if (islandOf[villageId][msg.sender] == 0) revert NotInVillage();
        if (v.enrollVote != 0) revert VoteRunning();
        uint256[3] memory none;
        proposalId = _propose(villageId, Kind.Enrollment, address(0), none, "", VOTE_PERIOD);
        v.enrollVote = uint64(proposalId + 1);
    }

    /// @notice Vote with your power: Friends on your village island × (1 + your founder share).
    /// Yes/no proposals: choice 1 = yes, 0 = no.
    function vote(uint256 proposalId, uint8 choice) external {
        Proposal storage p = _proposals[proposalId];
        if (block.timestamp >= p.ends) revert VotingClosed();
        if (voted[proposalId][msg.sender]) revert AlreadyVoted();
        if (choice >= _choices(p.kind)) revert BadProposal();
        uint256 power = powerOf(p.villageId, msg.sender);
        if (power == 0) revert NoPower();
        voted[proposalId][msg.sender] = true;
        p.tally[choice] += power;
        emit Voted(proposalId, msg.sender, choice, power);
    }

    /// @notice Carry out a proposal once its vote has ended. Anyone may call it.
    function settle(uint256 proposalId) external nonReentrant returns (uint8 winner) {
        Proposal storage p = _proposals[proposalId];
        if (p.settled) revert Settled();
        if (block.timestamp < p.ends) revert VotingOpen();
        p.settled = true;
        uint256 id = p.villageId;
        Village storage v = _villages[id];
        if (p.kind == Kind.Spend || p.kind == Kind.BurnShare) {
            winner = passed(proposalId) ? 1 : 0;
            if (winner == 1 && p.kind == Kind.Spend) treasury.spend(id, p.to, p.options[0]);
            if (winner == 1 && p.kind == Kind.BurnShare) treasury.setBurnBps(id, uint16(p.options[0]));
        } else {
            winner = _plurality(p);
            v.enrollVote = 0;
            if (p.kind == Kind.Enrollment) {
                v.enrollOpen = winner == KEEP_OPEN;
                if (winner == KEEP_OPEN || winner == CLOSE_NOW) v.enrollCap = 0;
                if (winner == CHANGE_PRICE) v.enrollVote = uint64(_followUp(id, Kind.EnrollPrice, _priceOptions(v)) + 1);
                if (winner == CLOSE_AT_POPULATION) {
                    v.enrollVote = uint64(_followUp(id, Kind.EnrollCap, _capOptions(population(id))) + 1);
                }
            } else if (p.kind == Kind.EnrollPrice) {
                v.enrollPrice = uint128(p.options[winner]);
                v.enrollCap = 0;
                v.enrollOpen = true;
            } else {
                v.enrollCap = uint64(p.options[winner]);
                v.enrollOpen = true;
            }
            emit EnrollmentSet(id, v.enrollOpen, v.enrollPrice, v.enrollCap);
        }
        emit ProposalSettled(proposalId, winner);
    }

    /* ── reads ── */

    /// @notice Voting power: Friends on the wallet's village island × (1 + locked / pool).
    function powerOf(uint256 villageId, address wallet) public view returns (uint256) {
        uint256 islandId = islandOf[villageId][wallet];
        if (islandId == 0) return 0;
        uint256 friends = islands.memberCount(islandId);
        uint256 pool = _villages[villageId].pool;
        uint256 share = pool == 0 ? 0 : marks.weightOf(villageId, wallet) * BPS / pool;
        return friends * (BPS + share);
    }

    /// @notice Sum of every member's power (used for quorum).
    function totalPower(uint256 villageId) public view returns (uint256 total) {
        address[] storage m = _members[villageId];
        for (uint256 i; i < m.length; ++i) total += powerOf(villageId, m[i]);
    }

    /// @notice Friends on the village's islands.
    function population(uint256 villageId) public view returns (uint256 total) {
        address[] storage m = _members[villageId];
        for (uint256 i; i < m.length; ++i) total += islands.memberCount(islandOf[villageId][m[i]]);
    }

    /// @notice The price to enroll right now, or 0 when enrollment is closed.
    function enrollPrice(uint256 villageId) public view returns (uint256) {
        Village storage v = _villages[villageId];
        if (!v.founded) return 0;
        if (block.timestamp >= v.foundedAt + ENROLL_WINDOW) {
            if (!v.enrollOpen) return 0;
            if (v.enrollCap != 0 && population(villageId) >= v.enrollCap) return 0;
        }
        return v.enrollPrice;
    }

    function passed(uint256 proposalId) public view returns (bool) {
        Proposal storage p = _proposals[proposalId];
        uint256 yes = p.tally[1];
        uint256 no = p.tally[0];
        return yes > no && (yes + no) * BPS >= totalPower(p.villageId) * QUORUM_BPS;
    }

    /// @notice The founded village an island belongs to, or 0.
    function villageOf(uint256 islandId) public view returns (uint256) {
        uint256 v = _villageOf[islandId];
        return v != 0 && _villages[v].founded ? v : 0;
    }

    function sameVillage(uint256 a, uint256 b) external view returns (bool) {
        uint256 v = villageOf(a);
        return v != 0 && v == villageOf(b);
    }

    function inVillage(uint256 villageId, address wallet) external view returns (bool) {
        return islandOf[villageId][wallet] != 0;
    }

    function villages(uint256 villageId) external view returns (Village memory) {
        return _villages[villageId];
    }

    function members(uint256 villageId) external view returns (address[] memory) {
        return _members[villageId];
    }

    function proposals(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    /// @notice RF this wallet locked into the village's flag.
    function weightOf(uint256 villageId, address wallet) external view returns (uint256) {
        return marks.weightOf(villageId, wallet);
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

    function _join(uint256 villageId, uint256 islandId) private {
        if (!_villages[villageId].founded) revert NotFounded();
        if (islandOf[villageId][msg.sender] != 0) revert HasIsland();
        _onlyOwner(islandId);
        _docked(islandId);
        if (_taken(islandId)) revert AlreadyInVillage();
        _addMember(villageId, msg.sender, islandId);
    }

    function _addMember(uint256 villageId, address wallet, uint256 islandId) private {
        _villageOf[islandId] = villageId;
        islandOf[villageId][wallet] = islandId;
        _members[villageId].push(wallet);
        _memberIndex[villageId][wallet] = _members[villageId].length;
    }

    function _propose(
        uint256 villageId,
        Kind kind,
        address to,
        uint256[3] memory options,
        string memory memo,
        uint256 period
    ) private returns (uint256 proposalId) {
        proposalId = _proposals.length;
        uint256[4] memory tally;
        uint64 ends = uint64(block.timestamp + period);
        _proposals.push(Proposal(villageId, kind, ends, false, to, options, tally, memo));
        emit Proposed(proposalId, villageId, kind, ends);
    }

    function _followUp(uint256 villageId, Kind kind, uint256[3] memory options) private returns (uint256) {
        return _propose(villageId, kind, address(0), options, "", FOLLOW_UP_PERIOD);
    }

    function _choices(Kind kind) private pure returns (uint8) {
        return kind == Kind.Enrollment ? 4 : kind == Kind.EnrollPrice || kind == Kind.EnrollCap ? 3 : 2;
    }

    function _plurality(Proposal storage p) private view returns (uint8 winner) {
        uint8 n = _choices(p.kind);
        for (uint8 i = 1; i < n; ++i) {
            if (p.tally[i] > p.tally[winner]) winner = i;
        }
    }

    /// @dev Three new prices: half, double and five times today's.
    function _priceOptions(Village storage v) private view returns (uint256[3] memory o) {
        o = [uint256(v.enrollPrice) / 2, uint256(v.enrollPrice) * 2, uint256(v.enrollPrice) * 5];
    }

    /// @dev Three populations to close at: 1.5×, 2× and 4× today's (at least +10, +25, +100).
    function _capOptions(uint256 pop) private pure returns (uint256[3] memory o) {
        o = [_max(pop * 3 / 2, pop + 10), _max(pop * 2, pop + 25), _max(pop * 4, pop + 100)];
    }

    function _max(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a : b;
    }

    /// @dev Seat of a flag that is still rising or full, or a member of a founded village.
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
