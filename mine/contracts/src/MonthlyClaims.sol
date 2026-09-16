// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title Monthly $FLYAI claims for fly.ai compute miners
/// @notice Nothing is funded while a month runs. After it ends, the mining server splits a pool the owner
/// chooses across wallets by points and publishes a Merkle root of (wallet, amount). The owner opens the
/// month with that root and funds exactly its total in the same transaction; each wallet then claims its
/// own amount with a proof. Once the claim window is over, the owner can sweep what's left.
/// @dev What the owner can't do: change a month's root once posted, or take a month's funds before its
/// window closes. Claims never exceed the month's total, whatever the root says. The owner is trusted to post
/// the root the mining server computed; a root that pays the owner is possible, so the owner should be a multisig.
/// Leaves are OpenZeppelin's standard: keccak256(bytes.concat(keccak256(abi.encode(account, amount)))).
contract MonthlyClaims is Ownable2Step {
    using SafeERC20 for IERC20;

    struct Month {
        bytes32 root;
        uint128 total;
        uint128 claimed;
        uint64 deadline;
        bool swept;
    }

    IERC20 public immutable token;
    /// @notice seconds a month stays claimable after it's opened
    uint64 public immutable claimWindow;
    /// @notice by month id, YYYYMM (202609 is September 2026)
    mapping(uint256 => Month) public months;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    event MonthOpened(uint256 indexed month, bytes32 root, uint256 total, uint256 deadline);
    event Claimed(uint256 indexed month, address indexed account, uint256 amount);
    event Swept(uint256 indexed month, address indexed to, uint256 amount);

    error BadMonth();
    error MonthExists();
    error UnknownMonth();
    error EmptyRoot();
    error NotFullyFunded();
    error AlreadyClaimed();
    error BadProof();
    error OverTotal();
    error WindowOpen();
    error WindowClosed();
    error AlreadySwept();
    error ZeroAddress();
    error BadWindow();
    error RenounceDisabled();

    constructor(IERC20 token_, uint64 claimWindow_, address owner_) Ownable(owner_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        // too short and the owner could sweep before anyone has had a chance to claim
        if (claimWindow_ < 7 days || claimWindow_ > 730 days) revert BadWindow();
        token = token_;
        claimWindow = claimWindow_;
    }

    /// @notice Post a month's root and fund it. The owner must have approved `total` first.
    function openMonth(uint256 month, bytes32 root, uint128 total) external onlyOwner {
        if (month < 202001 || month > 299912 || month % 100 == 0 || month % 100 > 12) revert BadMonth();
        if (months[month].root != bytes32(0)) revert MonthExists();
        if (root == bytes32(0)) revert EmptyRoot();
        uint64 deadline = uint64(block.timestamp) + claimWindow;
        months[month] = Month(root, total, 0, deadline, false);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), total);
        // a token that takes a fee on transfer would leave the month short of what claims add up to
        if (token.balanceOf(address(this)) - before != total) revert NotFullyFunded();
        emit MonthOpened(month, root, total, deadline);
    }

    /// @notice Pay `account` its amount for `month`. Anyone may send it; the tokens always go to `account`.
    function claim(uint256 month, address account, uint256 amount, bytes32[] calldata proof) public {
        Month storage m = months[month];
        if (m.root == bytes32(0)) revert UnknownMonth();
        if (block.timestamp > m.deadline) revert WindowClosed();
        if (hasClaimed[month][account]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
        if (!MerkleProof.verifyCalldata(proof, m.root, leaf)) revert BadProof();
        if (amount > m.total - m.claimed) revert OverTotal();
        hasClaimed[month][account] = true;
        m.claimed += uint128(amount);
        token.safeTransfer(account, amount);
        emit Claimed(month, account, amount);
    }

    /// @notice Disabled: without an owner no month could be opened and unclaimed tokens could never be swept.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice After a month's window, return what nobody claimed.
    function sweep(uint256 month, address to) external onlyOwner {
        Month storage m = months[month];
        if (m.root == bytes32(0)) revert UnknownMonth();
        if (block.timestamp <= m.deadline) revert WindowOpen();
        if (m.swept) revert AlreadySwept();
        m.swept = true;
        uint256 left = m.total - m.claimed;
        token.safeTransfer(to, left);
        emit Swept(month, to, left);
    }
}
