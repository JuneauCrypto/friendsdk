// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import { DocksRegistry, IDocksGenerations } from "./DocksRegistry.sol";

/// @notice Fixed-supply token launched from a plot. No owner, no minting after launch.
contract DocksToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply)
        ERC20(name_, symbol_)
    {
        _mint(msg.sender, supply);
    }
}

/// @notice Launch a token from your plot for 1,000 RF (half burned, half to the treasury),
/// airdrop it into Friend wallets and/or open a claim pool. Every claim costs the launch's
/// RF claim price, which is burned. Tokens always land in the Friend's own wallet.
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
        Scope scope;
        uint256 claimEach;
        uint256 claimPrice;
        uint256 claimRemaining;
    }

    struct LaunchParams {
        string name;
        string symbol;
        uint256 creatorFriendId;
        uint256 supply;
        uint256[] airdropFriendIds;
        uint256 airdropEach;
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
    DocksRegistry public immutable registry;
    IDocksGenerations public immutable generations;
    address public immutable treasury;

    Launch[] private _launches;
    mapping(uint256 launchId => mapping(uint256 friendId => bool)) public claimed;

    constructor(IERC20 rf_, DocksRegistry registry_, address treasury_) {
        rf = rf_;
        registry = registry_;
        generations = registry_.generations();
        treasury = treasury_;
    }

    function launch(LaunchParams calldata p) external nonReentrant returns (uint256 launchId) {
        if (!_controls(msg.sender, p.creatorFriendId)) revert NotHolder();
        if (!registry.isValid(p.creatorFriendId)) revert NotDocked();
        uint256 airdropTotal = p.airdropFriendIds.length * p.airdropEach;
        if (p.supply == 0 || airdropTotal + p.claimPool > p.supply) revert BadAllocation();
        if ((p.claimPool == 0) != (p.claimEach == 0) || p.claimEach > p.claimPool) {
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
                p.scope,
                p.claimEach,
                p.claimPrice,
                p.claimPool
            )
        );
        emit Launched(
            launchId, address(token), creator, p.creatorFriendId, p.scope, p.claimEach, p.claimPrice
        );

        for (uint256 i; i < p.airdropFriendIds.length; ++i) {
            IERC20(address(token)).safeTransfer(_wallet(p.airdropFriendIds[i]), p.airdropEach);
            emit Airdropped(launchId, p.airdropFriendIds[i], p.airdropEach);
        }
        uint256 rest = p.supply - airdropTotal - p.claimPool;
        if (rest > 0) IERC20(address(token)).safeTransfer(_wallet(p.creatorFriendId), rest);
    }

    /// @notice Claim for a docked Friend you hold (from your wallet or the Friend's wallet).
    /// @param via For PlotAndNeighbours: a creator Friend next to `friendId`; else ignored.
    function claim(uint256 launchId, uint256 friendId, uint256 via) external nonReentrant {
        if (launchId >= _launches.length) revert UnknownLaunch();
        Launch storage l = _launches[launchId];
        if (!_controls(msg.sender, friendId)) revert NotHolder();
        if (claimed[launchId][friendId]) revert AlreadyClaimed();
        if (l.claimRemaining < l.claimEach || l.claimEach == 0) revert PoolEmpty();
        if (!eligible(launchId, friendId, via)) revert NotEligible();

        claimed[launchId][friendId] = true;
        l.claimRemaining -= l.claimEach;
        if (l.claimPrice > 0) rf.safeTransferFrom(msg.sender, BURN, l.claimPrice);
        IERC20(address(l.token)).safeTransfer(_wallet(friendId), l.claimEach);
        emit Claimed(launchId, friendId, l.claimEach, l.claimPrice);
    }

    function eligible(uint256 launchId, uint256 friendId, uint256 via)
        public
        view
        returns (bool)
    {
        Launch storage l = _launches[launchId];
        if (!registry.isValid(friendId)) return false;
        address holder = generations.ownerOf(friendId);
        if (l.scope == Scope.AnyDocked) return true;
        if (l.scope == Scope.HolderPlot) return holder == l.creator;
        if (l.scope == Scope.PlotAndNeighbours) {
            if (holder == l.creator) return true;
            return registry.isValid(via) && generations.ownerOf(via) == l.creator
                && registry.adjacent(friendId, via);
        }
        return registry.canVisit(l.creator, holder);
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
