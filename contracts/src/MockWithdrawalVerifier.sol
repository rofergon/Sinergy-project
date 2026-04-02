// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWithdrawalVerifier} from "./IWithdrawalVerifier.sol";

contract MockWithdrawalVerifier is IWithdrawalVerifier {
    mapping(bytes32 => bool) public approvedProofs;

    function proofKey(
        bytes32 root,
        bytes32 nullifier,
        address recipient,
        address token,
        uint256 amount,
        bytes memory proof
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(root, nullifier, recipient, token, amount, proof));
    }

    function setProofResult(
        bytes32 root,
        bytes32 nullifier,
        address recipient,
        address token,
        uint256 amount,
        bytes calldata proof,
        bool approved
    ) external {
        approvedProofs[proofKey(root, nullifier, recipient, token, amount, proof)] = approved;
    }

    function verifyWithdrawal(
        bytes32 root,
        bytes32 nullifier,
        address recipient,
        address token,
        uint256 amount,
        bytes calldata proof
    ) external view returns (bool) {
        return approvedProofs[proofKey(root, nullifier, recipient, token, amount, proof)];
    }
}
