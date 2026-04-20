// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {StrategyExecutor} from "../src/StrategyExecutor.sol";

contract StrategyExecutorTest is Test {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    StrategyExecutor internal executor;

    uint256 internal ownerPk = 0xA11CE;
    address internal owner = vm.addr(ownerPk);
    address internal admin = address(0xBEEF);
    address internal worker = address(0xCAFE);

    function setUp() public {
        executor = new StrategyExecutor(admin, worker);
    }

    function testConsumesValidApproval() public {
        StrategyExecutor.StrategyApproval memory approval = StrategyExecutor.StrategyApproval({
            owner: owner,
            strategyIdHash: keccak256("strategy-1"),
            strategyHash: keccak256("strategy-payload"),
            marketId: keccak256("market-1"),
            maxSlippageBps: 125,
            nonce: 7,
            deadline: block.timestamp + 1 hours
        });

        bytes32 structHash = keccak256(
            abi.encode(
                executor.STRATEGY_APPROVAL_TYPEHASH(),
                approval.owner,
                approval.strategyIdHash,
                approval.strategyHash,
                approval.marketId,
                approval.maxSlippageBps,
                approval.nonce,
                approval.deadline
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(_domainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(worker);
        executor.consumeStrategyApproval(approval, signature);

        assertTrue(executor.nonceUsed(owner, approval.nonce));
    }

    function testRejectsReusedNonce() public {
        StrategyExecutor.StrategyApproval memory approval = StrategyExecutor.StrategyApproval({
            owner: owner,
            strategyIdHash: keccak256("strategy-1"),
            strategyHash: keccak256("strategy-payload"),
            marketId: keccak256("market-1"),
            maxSlippageBps: 125,
            nonce: 7,
            deadline: block.timestamp + 1 hours
        });

        bytes32 structHash = keccak256(
            abi.encode(
                executor.STRATEGY_APPROVAL_TYPEHASH(),
                approval.owner,
                approval.strategyIdHash,
                approval.strategyHash,
                approval.marketId,
                approval.maxSlippageBps,
                approval.nonce,
                approval.deadline
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(_domainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.startPrank(worker);
        executor.consumeStrategyApproval(approval, signature);
        vm.expectRevert(
            abi.encodeWithSelector(
                StrategyExecutor.NonceAlreadyUsed.selector,
                owner,
                approval.nonce
            )
        );
        executor.consumeStrategyApproval(approval, signature);
        vm.stopPrank();
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("SinergyStrategyExecutor")),
                keccak256(bytes("1")),
                block.chainid,
                address(executor)
            )
        );
    }
}
