// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IWithdrawalVerifier {
    function verifyWithdrawal(
        bytes32 root,
        bytes32 nullifier,
        address recipient,
        address token,
        uint256 amount,
        bytes calldata proof
    ) external view returns (bool);
}
