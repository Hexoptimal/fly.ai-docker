// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MonthlyClaims} from "../src/MonthlyClaims.sol";
import {FlyStaking} from "../src/FlyStaking.sol";

/// Deploy MonthlyClaims and FlyStaking.
///   TOKEN=0x... OWNER=0x... CLAIM_WINDOW_DAYS=90 COOLDOWN_DAYS=7 forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <key>
/// Robinhood Chain: --rpc-url https://rpc.mainnet.chain.robinhood.com, $FLYAI = 0x0088CE7905025c4B5ea1d49aB6179B6aaADB3B9C
contract Deploy is Script {
    function run() external returns (MonthlyClaims claims, FlyStaking staking) {
        address token = vm.envAddress("TOKEN");
        address owner = vm.envAddress("OWNER");
        uint256 days_ = vm.envOr("CLAIM_WINDOW_DAYS", uint256(90));
        uint256 cooldownDays = vm.envOr("COOLDOWN_DAYS", uint256(7));
        vm.startBroadcast();
        claims = new MonthlyClaims(IERC20(token), SafeCast.toUint64(days_ * 1 days), owner);
        staking = new FlyStaking(IERC20(token), SafeCast.toUint64(cooldownDays * 1 days));
        vm.stopBroadcast();
        console.log("MonthlyClaims", address(claims));
        console.log("FlyStaking", address(staking));
    }
}
