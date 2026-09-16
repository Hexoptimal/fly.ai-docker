// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title $FLYAI staking for fly.ai compute
/// @notice Stake to raise your mining tier. Unstaking takes two steps: request it, which stops the amount
/// counting straight away, then withdraw once the cooldown has passed. The mining server reads `stakedOf`
/// each day and sets your points multiplier from it; tiers live on the server, not here.
/// @dev No owner and no admin functions: nobody but the staker can move staked tokens, and nothing can be
/// paused, upgraded or changed. The cooldown is what stops staking for a moment around the server's check.
contract FlyStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Unstaking {
        uint256 amount;
        uint64 unlocksAt;
    }

    IERC20 public immutable token;
    uint64 public immutable cooldown;
    uint256 public totalStaked;
    mapping(address => uint256) public stakedOf;
    mapping(address => Unstaking) public unstaking;

    event Staked(address indexed account, uint256 amount);
    event UnstakeRequested(address indexed account, uint256 amount, uint256 unlocksAt);
    event UnstakeCancelled(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    error ZeroAmount();
    error NotEnoughStaked();
    error NothingUnstaking();
    error StillCoolingDown(uint256 unlocksAt);
    error NotFullyReceived();
    error ZeroAddress();
    error BadCooldown();

    constructor(IERC20 token_, uint64 cooldown_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        // no cooldown removes the protection tiers rely on; a huge one would overflow unlocksAt and lock stakes forever
        if (cooldown_ < 1 days || cooldown_ > 90 days) revert BadCooldown();
        token = token_;
        cooldown = cooldown_;
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        // a fee-on-transfer token would credit more than the contract holds
        if (token.balanceOf(address(this)) - before != amount) revert NotFullyReceived();
        stakedOf[msg.sender] += amount;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
    }

    /// @notice Stop `amount` counting now; it can be withdrawn after the cooldown. Asking again adds to the
    /// amount waiting and restarts the cooldown for all of it.
    function requestUnstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > stakedOf[msg.sender]) revert NotEnoughStaked();
        stakedOf[msg.sender] -= amount;
        totalStaked -= amount;
        Unstaking storage u = unstaking[msg.sender];
        u.amount += amount;
        u.unlocksAt = uint64(block.timestamp) + cooldown;
        emit UnstakeRequested(msg.sender, u.amount, u.unlocksAt);
    }

    /// @notice Put everything waiting to unstake back into the stake.
    function cancelUnstake() external nonReentrant {
        uint256 amount = unstaking[msg.sender].amount;
        if (amount == 0) revert NothingUnstaking();
        delete unstaking[msg.sender];
        stakedOf[msg.sender] += amount;
        totalStaked += amount;
        emit UnstakeCancelled(msg.sender, amount);
    }

    function withdraw() external nonReentrant {
        Unstaking memory u = unstaking[msg.sender];
        if (u.amount == 0) revert NothingUnstaking();
        if (block.timestamp < u.unlocksAt) revert StillCoolingDown(u.unlocksAt);
        delete unstaking[msg.sender];
        token.safeTransfer(msg.sender, u.amount);
        emit Withdrawn(msg.sender, u.amount);
    }
}
