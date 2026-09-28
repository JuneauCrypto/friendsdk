// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { DocksVillages, IDocksVillageTreasury } from "./DocksVillages.sol";

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

/// @notice Village treasuries and votes.
///
/// When a village is founded, half its flag's RF lands here as the village treasury (RF only)
/// and half becomes permanent liquidity (IDocksLiquidity). `harvest` collects the liquidity's
/// trading fees, buys RF back with the WETH part, burns `burnBps` of all the RF (half by
/// default) and adds the rest to the treasury.
///
/// Founders vote with the RF they locked (their soulbound founder marks). A proposal passes
/// after VOTING_PERIOD when yes > no and at least QUORUM_BPS of the village's founder weight
/// voted. What a village can vote on today:
///  - Spend: send treasury RF to a recipient, e.g. to buy upgrades on a Rare Friends marketplace.
///  - SetBurnShare: change how much of each harvest is burned (the rest fills the treasury).
/// More options are meant to be added for every village to choose from.
contract DocksVillageTreasury is IDocksVillageTreasury, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant VOTING_PERIOD = 3 days;
    uint256 public constant QUORUM_BPS = 2000; // 20% of founder weight must vote
    uint16 public constant DEFAULT_BURN_BPS = 5000; // half of every buyback burned

    enum Kind {
        Spend,
        SetBurnShare
    }

    struct Proposal {
        uint256 villageId;
        Kind kind;
        address to;
        uint256 amount;
        uint16 burnBps;
        uint64 ends;
        bool executed;
        uint256 yes;
        uint256 no;
        string memo;
    }

    error NotVillages();
    error NotFounder();
    error NotFounded();
    error BadProposal();
    error VotingClosed();
    error AlreadyVoted();
    error VotingOpen();
    error Rejected();
    error Executed();
    error NoFunds();

    event VillageFunded(uint256 indexed villageId, uint256 treasuryRf, uint256 liquidityRf);
    event Harvested(uint256 indexed villageId, uint256 rfFees, uint256 wethFees, uint256 rfBought, uint256 burned, uint256 toTreasury);
    event Proposed(uint256 indexed proposalId, uint256 indexed villageId, Kind kind, address to, uint256 amount, uint16 burnBps, string memo);
    event Voted(uint256 indexed proposalId, address indexed wallet, bool support, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId);

    IERC20 public immutable rf;
    IERC20 public immutable weth;
    DocksVillages public immutable villages;
    IDocksLiquidity public immutable liquidity;
    IDocksBuyback public immutable buyback;

    mapping(uint256 villageId => uint256) public balanceOf; // treasury RF
    mapping(uint256 villageId => bool) public funded;
    mapping(uint256 villageId => uint16) private _burnBps; // stored +1 so 0 can mean "unset"
    Proposal[] private _proposals;
    mapping(uint256 proposalId => mapping(address wallet => bool)) public voted;

    constructor(IERC20 rf_, IERC20 weth_, DocksVillages villages_, IDocksLiquidity liquidity_, IDocksBuyback buyback_) {
        rf = rf_;
        weth = weth_;
        villages = villages_;
        liquidity = liquidity_;
        buyback = buyback_;
    }

    /// @inheritdoc IDocksVillageTreasury
    function found(uint256 villageId, uint256 treasuryRf, uint256 liquidityRf) external nonReentrant {
        if (msg.sender != address(villages)) revert NotVillages();
        funded[villageId] = true;
        rf.forceApprove(address(liquidity), liquidityRf);
        uint256 used = liquidity.provide(villageId, liquidityRf);
        rf.forceApprove(address(liquidity), 0);
        balanceOf[villageId] += treasuryRf + (liquidityRf - used); // any rounding dust stays with the village
        emit VillageFunded(villageId, treasuryRf, used);
    }

    /// @notice Collect the village's trading fees, buy RF with the WETH part, burn the
    /// village's burn share and add the rest to its treasury. Founders only, since they set
    /// the minimum RF the buyback must return.
    function harvest(uint256 villageId, uint256 minRfOut) external nonReentrant returns (uint256 burned, uint256 kept) {
        if (!funded[villageId]) revert NotFounded();
        if (villages.weightOf(villageId, msg.sender) == 0) revert NotFounder();
        (uint256 rfFees, uint256 wethFees) = liquidity.collect(villageId, address(this));
        uint256 bought;
        if (wethFees > 0) {
            weth.forceApprove(address(buyback), wethFees);
            bought = buyback.buyRf(wethFees, minRfOut, address(this));
        }
        uint256 total = rfFees + bought;
        burned = total * burnBpsOf(villageId) / 10_000;
        kept = total - burned;
        if (burned > 0) rf.safeTransfer(BURN, burned);
        balanceOf[villageId] += kept;
        emit Harvested(villageId, rfFees, wethFees, bought, burned, kept);
    }

    function burnBpsOf(uint256 villageId) public view returns (uint16) {
        uint16 b = _burnBps[villageId];
        return b == 0 ? DEFAULT_BURN_BPS : b - 1;
    }

    /* ── votes ── */

    function propose(uint256 villageId, Kind kind, address to, uint256 amount, uint16 burnBps, string calldata memo)
        external
        returns (uint256 proposalId)
    {
        if (!funded[villageId]) revert NotFounded();
        if (villages.weightOf(villageId, msg.sender) == 0) revert NotFounder();
        if (kind == Kind.Spend && (to == address(0) || amount == 0)) revert BadProposal();
        if (kind == Kind.SetBurnShare && burnBps > 10_000) revert BadProposal();
        if (bytes(memo).length > 140) revert BadProposal();
        proposalId = _proposals.length;
        _proposals.push(
            Proposal(villageId, kind, to, amount, burnBps, uint64(block.timestamp + VOTING_PERIOD), false, 0, 0, memo)
        );
        emit Proposed(proposalId, villageId, kind, to, amount, burnBps, memo);
    }

    /// @notice Vote with the RF you locked into the village's flag.
    function vote(uint256 proposalId, bool support) external {
        Proposal storage p = _proposals[proposalId];
        if (block.timestamp >= p.ends) revert VotingClosed();
        if (voted[proposalId][msg.sender]) revert AlreadyVoted();
        uint256 w = villages.weightOf(p.villageId, msg.sender);
        if (w == 0) revert NotFounder();
        voted[proposalId][msg.sender] = true;
        if (support) p.yes += w;
        else p.no += w;
        emit Voted(proposalId, msg.sender, support, w);
    }

    /// @notice Carry out a proposal that passed. Anyone may call it.
    function execute(uint256 proposalId) external nonReentrant {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert Executed();
        if (block.timestamp < p.ends) revert VotingOpen();
        if (!passed(proposalId)) revert Rejected();
        p.executed = true;
        if (p.kind == Kind.Spend) {
            if (balanceOf[p.villageId] < p.amount) revert NoFunds();
            balanceOf[p.villageId] -= p.amount;
            rf.safeTransfer(p.to, p.amount);
        } else {
            _burnBps[p.villageId] = p.burnBps + 1;
        }
        emit ProposalExecuted(proposalId);
    }

    function passed(uint256 proposalId) public view returns (bool) {
        Proposal storage p = _proposals[proposalId];
        uint256 quorum = villages.totalWeight(p.villageId) * QUORUM_BPS / 10_000;
        return p.yes > p.no && p.yes + p.no >= quorum;
    }

    function proposals(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }
}
