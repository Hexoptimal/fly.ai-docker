// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MonthlyClaims} from "../src/MonthlyClaims.sol";

contract TestToken is ERC20 {
    constructor() ERC20("Test", "TEST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// takes 1% of every transfer, like the tokens MonthlyClaims must refuse
contract FeeToken is TestToken {
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            super._update(from, address(0xdead), value / 100);
            value -= value / 100;
        }
        super._update(from, to, value);
    }
}

/// Claims are made with contracts/test/fixtures/snapshot.json, written by the server's payout code
/// (npm run test:payouts), so these tests also check that its Merkle proofs verify on-chain.
contract MonthlyClaimsTest is Test {
    TestToken token;
    MonthlyClaims claims;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    uint64 constant WINDOW = 30 days;

    uint256 month;
    bytes32 root;
    uint256 total;
    address[] accounts;
    uint256[] amounts;
    string json;

    function setUp() public {
        json = vm.readFile("test/fixtures/snapshot.json");
        month = vm.parseJsonUint(json, ".month");
        root = vm.parseJsonBytes32(json, ".root");
        total = vm.parseJsonUint(json, ".total");
        accounts = vm.parseJsonAddressArray(json, ".accounts");
        amounts = vm.parseJsonUintArray(json, ".amounts");

        token = new TestToken();
        claims = new MonthlyClaims(token, WINDOW, owner);
        token.mint(owner, total * 3);
        vm.prank(owner);
        token.approve(address(claims), type(uint256).max);
    }

    function proof(uint256 i) internal view returns (bytes32[] memory) {
        return vm.parseJsonBytes32Array(json, string.concat(".proofs[", vm.toString(i), "]"));
    }

    function open() internal {
        vm.prank(owner);
        claims.openMonth(month, root, uint128(total));
    }

    function test_openPullsExactlyTheTotal() public {
        uint256 before = token.balanceOf(owner);
        open();
        assertEq(token.balanceOf(address(claims)), total);
        assertEq(before - token.balanceOf(owner), total);
        (bytes32 r, uint128 t, uint128 c, uint64 deadline, bool swept) = claims.months(month);
        assertEq(r, root);
        assertEq(t, total);
        assertEq(c, 0);
        assertEq(deadline, block.timestamp + WINDOW);
        assertFalse(swept);
    }

    function test_rootCantBeReplaced() public {
        open();
        vm.prank(owner);
        vm.expectRevert(MonthlyClaims.MonthExists.selector);
        claims.openMonth(month, keccak256("another root"), uint128(total));
    }

    function test_onlyOwnerOpens() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        claims.openMonth(month, root, uint128(total));
    }

    function test_badMonthsAndEmptyRoot() public {
        vm.startPrank(owner);
        vm.expectRevert(MonthlyClaims.BadMonth.selector);
        claims.openMonth(202613, root, 1);
        vm.expectRevert(MonthlyClaims.BadMonth.selector);
        claims.openMonth(202600, root, 1);
        vm.expectRevert(MonthlyClaims.EmptyRoot.selector);
        claims.openMonth(month, bytes32(0), 1);
        vm.stopPrank();
    }

    function test_everyoneInTheSnapshotClaims() public {
        open();
        address relayer = makeAddr("relayer");
        for (uint256 i = 0; i < accounts.length; i++) {
            vm.prank(relayer); // anyone may send a claim; the tokens go to the account
            claims.claim(month, accounts[i], amounts[i], proof(i));
            assertEq(token.balanceOf(accounts[i]), amounts[i]);
            assertTrue(claims.hasClaimed(month, accounts[i]));
        }
        assertEq(token.balanceOf(relayer), 0);
        assertEq(token.balanceOf(address(claims)), 0);
        (,, uint128 claimed,,) = claims.months(month);
        assertEq(claimed, total);
    }

    function test_claimingTwiceFails() public {
        open();
        claims.claim(month, accounts[0], amounts[0], proof(0));
        vm.expectRevert(MonthlyClaims.AlreadyClaimed.selector);
        claims.claim(month, accounts[0], amounts[0], proof(0));
    }

    function test_wrongAmountAccountOrMonthFails() public {
        open();
        bytes32[] memory p = proof(0);
        vm.expectRevert(MonthlyClaims.BadProof.selector);
        claims.claim(month, accounts[0], amounts[0] + 1, p);
        vm.expectRevert(MonthlyClaims.BadProof.selector);
        claims.claim(month, accounts[1], amounts[0], p);
        vm.expectRevert(MonthlyClaims.UnknownMonth.selector);
        claims.claim(month + 1, accounts[0], amounts[0], p);
    }

    function test_claimsNeverExceedTheFundedTotal() public {
        // the owner funds one wei less than the snapshot adds up to
        vm.prank(owner);
        claims.openMonth(month, root, uint128(total - 1));
        uint256 last = accounts.length - 1;
        for (uint256 i = 0; i < last; i++) claims.claim(month, accounts[i], amounts[i], proof(i));
        vm.expectRevert(MonthlyClaims.OverTotal.selector);
        claims.claim(month, accounts[last], amounts[last], proof(last));
    }

    function test_noClaimsAfterTheWindow() public {
        open();
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(MonthlyClaims.WindowClosed.selector);
        claims.claim(month, accounts[0], amounts[0], proof(0));
    }

    function test_sweepOnlyAfterTheWindowAndOnce() public {
        open();
        claims.claim(month, accounts[0], amounts[0], proof(0));
        vm.startPrank(owner);
        vm.expectRevert(MonthlyClaims.WindowOpen.selector);
        claims.sweep(month, treasury);
        vm.warp(block.timestamp + WINDOW + 1);
        claims.sweep(month, treasury);
        assertEq(token.balanceOf(treasury), total - amounts[0]);
        vm.expectRevert(MonthlyClaims.AlreadySwept.selector);
        claims.sweep(month, treasury);
        vm.stopPrank();
    }

    function test_onlyOwnerSweeps() public {
        open();
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        claims.sweep(month, address(this));
    }

    function test_feeOnTransferTokenRefused() public {
        FeeToken fee = new FeeToken();
        MonthlyClaims c = new MonthlyClaims(IERC20(address(fee)), WINDOW, owner);
        fee.mint(owner, total);
        vm.startPrank(owner);
        fee.approve(address(c), total);
        vm.expectRevert(MonthlyClaims.NotFullyFunded.selector);
        c.openMonth(month, root, uint128(total));
        vm.stopPrank();
    }

    function test_constructorRefusesBadInputs() public {
        vm.expectRevert(MonthlyClaims.ZeroAddress.selector);
        new MonthlyClaims(IERC20(address(0)), WINDOW, owner);
        vm.expectRevert(MonthlyClaims.BadWindow.selector);
        new MonthlyClaims(token, 0, owner); // the owner could sweep the next block
        vm.expectRevert(MonthlyClaims.BadWindow.selector);
        new MonthlyClaims(token, 6 days, owner);
        vm.expectRevert(MonthlyClaims.BadWindow.selector);
        new MonthlyClaims(token, 731 days, owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MonthlyClaims(token, WINDOW, address(0));
    }

    function test_ownershipCantBeRenounced() public {
        vm.prank(owner);
        vm.expectRevert(MonthlyClaims.RenounceDisabled.selector);
        claims.renounceOwnership();
        assertEq(claims.owner(), owner);
    }

    function test_monthIdUpperBound() public {
        vm.prank(owner);
        vm.expectRevert(MonthlyClaims.BadMonth.selector);
        claims.openMonth(999912, root, 1);
    }

    function test_monthsAreIndependent() public {
        open();
        vm.prank(owner);
        claims.openMonth(month + 1, root, uint128(total));
        claims.claim(month, accounts[0], amounts[0], proof(0));
        claims.claim(month + 1, accounts[0], amounts[0], proof(0));
        assertEq(token.balanceOf(accounts[0]), amounts[0] * 2);
    }
}
