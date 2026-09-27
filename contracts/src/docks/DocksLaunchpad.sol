// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { DocksPlots, IDocksGenerations } from "./DocksPlots.sol";

/// @notice Fixed-supply token launched from a plot. No owner, no minting after launch.
contract DocksToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply)
        ERC20(name_, symbol_)
    {
        _mint(msg.sender, supply);
    }
}

/// @notice Launch a token from your plot (an NFT on DocksPlots) for 1,000 RF (half burned, half to the treasury),
/// airdrop it into Friend wallets and/or open a claim pool. Every claim costs the launch's
/// RF claim price, which is burned. Tokens always land in the Friend's own wallet.
/// @dev Airdrops and claims are sent in batches (`airdrop`, `claimMany`) so they scale to
/// plots and docks of any size; eligibility is checked per Friend when each batch lands.
contract DocksLaunchpad is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Scope {
        AnyDocked,
        HolderPlot,
        PlotAndNeighbours,
        Visitors
    }

    struct Launch {
        DocksToken token;
        address creator;
        uint256 creatorFriendId;
        uint256 creatorPlotId;
        Scope scope;
        uint256 claimEach;
        uint256 claimPrice;
        uint256 claimRemaining;
        Scope airdropScope;
        uint256 airdropEach;
        uint256 airdropRemaining;
    }

    struct LaunchParams {
        string name;
        string symbol;
        uint256 creatorFriendId;
        uint256 supply;
        uint256 airdropPool;
        uint256 airdropEach;
        Scope airdropScope;
        uint256 claimPool;
        uint256 claimEach;
        uint256 claimPrice;
        Scope scope;
    }

    uint256 public constant LAUNCH_FEE = 1000 ether;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    error NotHolder();
    error NotDocked();
    error BadAllocation();
    error NotEligible();
    error AlreadyClaimed();
    error PoolEmpty();
    error UnknownLaunch();
    error NotCreator();
    
    event Launched(
        uint256 indexed launchId,
        address indexed token,
        address indexed creator,
        uint256 creatorFriendId,
        Scope scope,
        uint256 claimEach,
        uint256 claimPrice
    );
    event Airdropped(uint256 indexed launchId, uint256 indexed friendId, uint256 amount);
    event Claimed(uint256 indexed launchId, uint256 indexed friendId, uint256 amount, uint256 rfBurned);

    IERC20 public immutable rf;
    DocksPlots public immutable registry;
    IDocksGenerations public immutable generations;
    address public immutable treasury;

    Launch[] private _launches;
    mapping(uint256 launchId => mapping(uint256 friendId => bool)) public claimed;
    mapping(uint256 launchId => mapping(uint256 friendId => bool)) public airdropped;

    constructor(IERC20 rf_, DocksPlots registry_, address treasury_) {
        rf = rf_;
        registry = registry_;
        generations = registry_.generations();
        treasury = treasury_;
    }

    function launch(LaunchParams calldata p) external nonReentrant returns (uint256 launchId) {
        if (!_controls(msg.sender, p.creatorFriendId)) revert NotHolder();
        if (!registry.isValid(p.creatorFriendId)) revert NotDocked();
        (,, bool docked,) = registry.berthOf(registry.plotOf(p.creatorFriendId));
        if (!docked) revert NotDocked();
        if (p.supply == 0 || p.airdropPool + p.claimPool > p.supply) revert BadAllocation();
        if ((p.claimPool == 0) != (p.claimEach == 0) || p.claimEach > p.claimPool) {
            revert BadAllocation();
        }
        if ((p.airdropPool == 0) != (p.airdropEach == 0) || p.airdropEach > p.airdropPool) {
            revert BadAllocation();
        }

        rf.safeTransferFrom(msg.sender, BURN, LAUNCH_FEE / 2);
        rf.safeTransferFrom(msg.sender, treasury, LAUNCH_FEE - LAUNCH_FEE / 2);

        DocksToken token = new DocksToken(p.name, p.symbol, p.supply);
        address creator = generations.ownerOf(p.creatorFriendId);
        launchId = _launches.length;
        _launches.push(
            Launch(
                token,
                creator,
                p.creatorFriendId,
                registry.plotOf(p.creatorFriendId),
                p.scope,
                p.claimEach,
                p.claimPrice,
                p.claimPool,
                p.airdropScope,
                p.airdropEach,
                p.airdropPool
            )
        );
        emit Launched(
            launchId, address(token), creator, p.creatorFriendId, p.scope, p.claimEach, p.claimPrice
        );
        uint256 rest = p.supply - p.airdropPool - p.claimPool;
        if (rest > 0) IERC20(address(token)).safeTransfer(_wallet(p.creatorFriendId), rest);
    }

    /// @notice Creator sends the airdrop in batches. Friends that are not eligible under the
    /// airdrop scope, or already received it, are skipped.
    function airdrop(uint256 launchId, uint256[] calldata friendIds)
        external
        nonReentrant
        returns (uint256 sent)
    {
        if (launchId >= _launches.length) revert UnknownLaunch();
        Launch storage l = _launches[launchId];
        if (msg.sender != l.creator) revert NotCreator();
        for (uint256 i; i < friendIds.length && l.airdropRemaining >= l.airdropEach; ++i) {
            uint256 id = friendIds[i];
            if (airdropped[launchId][id] || !_eligible(l, l.airdropScope, id)) continue;
            airdropped[launchId][id] = true;
            l.airdropRemaining -= l.airdropEach;
            IERC20(address(l.token)).safeTransfer(_wallet(id), l.airdropEach);
            emit Airdropped(launchId, id, l.airdropEach);
            ++sent;
        }
    }

    /// @notice Creator ends the airdrop; what is left goes to the launching Friend's wallet.
    function endAirdrop(uint256 launchId) external nonReentrant {
        if (launchId >= _launches.length) revert UnknownLaunch();
        Launch storage l = _launches[launchId];
        if (msg.sender != l.creator) revert NotCreator();
        uint256 rest = l.airdropRemaining;
        l.airdropRemaining = 0;
        if (rest > 0) IERC20(address(l.token)).safeTransfer(_wallet(l.creatorFriendId), rest);
    }

    /// @notice Claim for many Friends you hold in one transaction. Friends that are not
    /// eligible, already claimed, or beyond the pool are skipped; RF is taken only for claims made.
    function claimMany(uint256 launchId, uint256[] calldata friendIds)
        external
        nonReentrant
        returns (uint256 made)
    {
        if (launchId >= _launches.length) revert UnknownLaunch();
        Launch storage l = _launches[launchId];
        if (l.claimEach == 0) revert PoolEmpty();
        for (uint256 i; i < friendIds.length && l.claimRemaining >= l.claimEach; ++i) {
            uint256 id = friendIds[i];
            if (!_controls(msg.sender, id)) revert NotHolder();
            if (claimed[launchId][id] || !_eligible(l, l.scope, id)) continue;
            claimed[launchId][id] = true;
            l.claimRemaining -= l.claimEach;
            IERC20(address(l.token)).safeTransfer(_wallet(id), l.claimEach);
            emit Claimed(launchId, id, l.claimEach, l.claimPrice);
            ++made;
        }
        if (made > 0 && l.claimPrice > 0) rf.safeTransferFrom(msg.sender, BURN, made * l.claimPrice);
    }

    /// @notice Claim for a docked Friend you hold (from your wallet or the Friend's wallet).
    function claim(uint256 launchId, uint256 friendId) external nonReentrant {
        if (launchId >= _launches.length) revert UnknownLaunch();
        Launch storage l = _launches[launchId];
        if (!_controls(msg.sender, friendId)) revert NotHolder();
        if (claimed[launchId][friendId]) revert AlreadyClaimed();
        if (l.claimRemaining < l.claimEach || l.claimEach == 0) revert PoolEmpty();
        if (!_eligible(l, l.scope, friendId)) revert NotEligible();

        claimed[launchId][friendId] = true;
        l.claimRemaining -= l.claimEach;
        if (l.claimPrice > 0) rf.safeTransferFrom(msg.sender, BURN, l.claimPrice);
        IERC20(address(l.token)).safeTransfer(_wallet(friendId), l.claimEach);
        emit Claimed(launchId, friendId, l.claimEach, l.claimPrice);
    }

    function eligible(uint256 launchId, uint256 friendId) public view returns (bool) {
        Launch storage l = _launches[launchId];
        return _eligible(l, l.scope, friendId);
    }

    /// @dev Scopes: any Friend on a docked island · the launching island · the launching island
    /// and every island docked next to it or bridged to it · visitors allowed onto it.
    function _eligible(Launch storage l, Scope scope, uint256 friendId) private view returns (bool) {
        if (!registry.isValid(friendId)) return false;
        uint256 plot = registry.plotOf(friendId);
        if (plot == l.creatorPlotId) return true;
        (,, bool docked,) = registry.berthOf(plot);
        if (!docked || scope == Scope.HolderPlot) return false;
        if (scope == Scope.AnyDocked) return true;
        if (scope == Scope.PlotAndNeighbours) return registry.connected(plot, l.creatorPlotId);
        return registry.canVisit(l.creatorPlotId, generations.ownerOf(friendId));
    }

    function launchCount() external view returns (uint256) {
        return _launches.length;
    }

    function launches(uint256 launchId) external view returns (Launch memory) {
        if (launchId >= _launches.length) revert UnknownLaunch();
        return _launches[launchId];
    }

    function _controls(address account, uint256 friendId) private view returns (bool) {
        return account == generations.ownerOf(friendId) || account == _wallet(friendId);
    }

    function _wallet(uint256 friendId) private view returns (address) {
        return generations.tokenBoundAccount(friendId);
    }
}
