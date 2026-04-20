// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract StrategyExecutor is AccessControl, EIP712 {
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant STRATEGY_APPROVAL_TYPEHASH =
        keccak256(
            "StrategyApproval(address owner,bytes32 strategyIdHash,bytes32 strategyHash,bytes32 marketId,uint256 maxSlippageBps,uint256 nonce,uint256 deadline)"
        );

    struct StrategyApproval {
        address owner;
        bytes32 strategyIdHash;
        bytes32 strategyHash;
        bytes32 marketId;
        uint256 maxSlippageBps;
        uint256 nonce;
        uint256 deadline;
    }

    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    event StrategyApprovalConsumed(
        address indexed owner,
        bytes32 indexed strategyIdHash,
        bytes32 indexed marketId,
        bytes32 strategyHash,
        uint256 maxSlippageBps,
        uint256 nonce,
        uint256 deadline,
        address executor
    );

    error ExpiredApproval(uint256 deadline);
    error NonceAlreadyUsed(address owner, uint256 nonce);
    error InvalidSigner(address recovered);

    constructor(address admin, address executor)
        AccessControl()
        EIP712("SinergyStrategyExecutor", "1")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(EXECUTOR_ROLE, executor);
    }

    function consumeStrategyApproval(
        StrategyApproval calldata approval,
        bytes calldata signature
    ) external onlyRole(EXECUTOR_ROLE) {
        if (block.timestamp > approval.deadline) revert ExpiredApproval(approval.deadline);
        if (nonceUsed[approval.owner][approval.nonce]) {
            revert NonceAlreadyUsed(approval.owner, approval.nonce);
        }

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    STRATEGY_APPROVAL_TYPEHASH,
                    approval.owner,
                    approval.strategyIdHash,
                    approval.strategyHash,
                    approval.marketId,
                    approval.maxSlippageBps,
                    approval.nonce,
                    approval.deadline
                )
            )
        );

        address recovered = ECDSA.recover(digest, signature);
        if (recovered != approval.owner) revert InvalidSigner(recovered);

        nonceUsed[approval.owner][approval.nonce] = true;

        emit StrategyApprovalConsumed(
            approval.owner,
            approval.strategyIdHash,
            approval.marketId,
            approval.strategyHash,
            approval.maxSlippageBps,
            approval.nonce,
            approval.deadline,
            msg.sender
        );
    }
}
