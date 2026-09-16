// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FlyStaking} from "../src/FlyStaking.sol";
import {TestToken, FeeToken} from "./MonthlyClaims.t.sol";

contract FlyStakingTest is Test {
    TestToken token;
    FlyStaking staking;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint64 constant COOLDOWN = 7 days;

    function setUp() public {
        token = new TestToken();
        staking = new FlyStaking(token, COOLDOWN);
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            token.mint(who, 1_000e18);
            vm.prank(who);
            token.approve(address(staking), type(uint256).max);
        }
    }

    function test_stakeCountsAtOnce() public {
        vm.prank(alice);
        staking.stake(100e18);
        assertEq(staking.stakedOf(alice), 100e18);
        assertEq(staking.totalStaked(), 100e18);
        assertEq(token.balanceOf(address(staking)), 100e18);
        assertEq(token.balanceOf(alice), 900e18);
    }

    function test_unstakeStopsCountingButWaitsForCooldown() public {
        vm.startPrank(alice);
        staking.stake(100e18);
        staking.requestUnstake(40e18);
        assertEq(staking.stakedOf(alice), 60e18);
        assertEq(staking.totalStaked(), 60e18);
        (uint256 amount, uint64 unlocksAt) = staking.unstaking(alice);
        assertEq(amount, 40e18);
        assertEq(unlocksAt, block.timestamp + COOLDOWN);
        vm.expectRevert(abi.encodeWithSelector(FlyStaking.StillCoolingDown.selector, unlocksAt));
        staking.withdraw();
        vm.warp(unlocksAt);
        staking.withdraw();
        assertEq(token.balanceOf(alice), 940e18);
        vm.expectRevert(FlyStaking.NothingUnstaking.selector);
        staking.withdraw();
        vm.stopPrank();
    }

    function test_secondRequestAddsAndRestartsCooldown() public {
        vm.startPrank(alice);
        staking.stake(100e18);
        staking.requestUnstake(10e18);
        vm.warp(block.timestamp + 5 days);
        staking.requestUnstake(20e18);
        (uint256 amount, uint64 unlocksAt) = staking.unstaking(alice);
        assertEq(amount, 30e18);
        assertEq(unlocksAt, block.timestamp + COOLDOWN);
        vm.stopPrank();
    }

    function test_cancelPutsItBack() public {
        vm.startPrank(alice);
        staking.stake(100e18);
        staking.requestUnstake(100e18);
        staking.cancelUnstake();
        assertEq(staking.stakedOf(alice), 100e18);
        assertEq(staking.totalStaked(), 100e18);
        (uint256 amount,) = staking.unstaking(alice);
        assertEq(amount, 0);
        vm.expectRevert(FlyStaking.NothingUnstaking.selector);
        staking.cancelUnstake();
        vm.stopPrank();
    }

    function test_cantUnstakeMoreThanStakedOrZero() public {
        vm.startPrank(alice);
        staking.stake(10e18);
        vm.expectRevert(FlyStaking.NotEnoughStaked.selector);
        staking.requestUnstake(11e18);
        vm.expectRevert(FlyStaking.ZeroAmount.selector);
        staking.requestUnstake(0);
        vm.expectRevert(FlyStaking.ZeroAmount.selector);
        staking.stake(0);
        vm.stopPrank();
    }

    function test_constructorRefusesBadInputs() public {
        vm.expectRevert(FlyStaking.ZeroAddress.selector);
        new FlyStaking(IERC20(address(0)), COOLDOWN);
        vm.expectRevert(FlyStaking.BadCooldown.selector);
        new FlyStaking(token, 0); // request and withdraw in one transaction
        vm.expectRevert(FlyStaking.BadCooldown.selector);
        new FlyStaking(token, 91 days);
        vm.expectRevert(FlyStaking.BadCooldown.selector);
        new FlyStaking(token, type(uint64).max); // would overflow unlocksAt and lock every stake
    }

    function test_stakersAreSeparate() public {
        vm.prank(alice);
        staking.stake(100e18);
        vm.prank(bob);
        staking.stake(50e18);
        vm.prank(bob);
        vm.expectRevert(FlyStaking.NotEnoughStaked.selector);
        staking.requestUnstake(60e18);
        assertEq(staking.totalStaked(), 150e18);
    }

    function test_feeOnTransferTokenRefused() public {
        FeeToken fee = new FeeToken();
        FlyStaking s = new FlyStaking(IERC20(address(fee)), COOLDOWN);
        fee.mint(alice, 100e18);
        vm.startPrank(alice);
        fee.approve(address(s), 100e18);
        vm.expectRevert(FlyStaking.NotFullyReceived.selector);
        s.stake(100e18);
        vm.stopPrank();
    }

    /// whatever anyone does, the contract holds exactly what's staked plus what's waiting to be withdrawn
    function testFuzz_balanceMatchesBooks(uint96 stakeA, uint96 unstakeA, uint96 stakeB, bool cancel, bool wait) public {
        stakeA = uint96(bound(stakeA, 1, 1_000e18));
        stakeB = uint96(bound(stakeB, 1, 1_000e18));
        unstakeA = uint96(bound(unstakeA, 1, stakeA));
        vm.prank(alice);
        staking.stake(stakeA);
        vm.prank(bob);
        staking.stake(stakeB);
        vm.prank(alice);
        staking.requestUnstake(unstakeA);
        if (cancel) {
            vm.prank(alice);
            staking.cancelUnstake();
        } else if (wait) {
            vm.warp(block.timestamp + COOLDOWN);
            vm.prank(alice);
            staking.withdraw();
        }
        (uint256 waiting,) = staking.unstaking(alice);
        assertEq(token.balanceOf(address(staking)), staking.totalStaked() + waiting);
        assertEq(staking.totalStaked(), staking.stakedOf(alice) + staking.stakedOf(bob));
    }
}
