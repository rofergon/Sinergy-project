// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStateRootRegistry} from "./IStateRootRegistry.sol";
import {IWithdrawalVerifier} from "./IWithdrawalVerifier.sol";

contract DarkVaultV2 is Ownable {
    using SafeERC20 for IERC20;

    mapping(address => bool) public supportedTokens;
    mapping(bytes32 => bool) public nullifierUsed;

    IStateRootRegistry public stateAnchor;
    IWithdrawalVerifier public withdrawalVerifier;

    event SupportedTokenSet(address indexed token, bool supported);
    event StateAnchorSet(address indexed anchor);
    event WithdrawalVerifierSet(address indexed verifier);
    event Deposit(
        address indexed depositor,
        bytes32 indexed receiverCommitment,
        address indexed token,
        uint256 amount
    );
    event Withdraw(
        address indexed recipient,
        address indexed token,
        uint256 amount,
        bytes32 nullifier,
        bytes32 root
    );

    error UnsupportedToken(address token);
    error UnknownRoot(bytes32 root);
    error NullifierAlreadyUsed(bytes32 nullifier);
    error InvalidWithdrawalProof();

    constructor(
        address initialOwner,
        address initialStateAnchor,
        address initialWithdrawalVerifier
    ) Ownable(initialOwner) {
        stateAnchor = IStateRootRegistry(initialStateAnchor);
        withdrawalVerifier = IWithdrawalVerifier(initialWithdrawalVerifier);

        emit StateAnchorSet(initialStateAnchor);
        emit WithdrawalVerifierSet(initialWithdrawalVerifier);
    }

    function setSupportedToken(address token, bool supported) external onlyOwner {
        supportedTokens[token] = supported;
        emit SupportedTokenSet(token, supported);
    }

    function setStateAnchor(address newStateAnchor) external onlyOwner {
        stateAnchor = IStateRootRegistry(newStateAnchor);
        emit StateAnchorSet(newStateAnchor);
    }

    function setWithdrawalVerifier(address newWithdrawalVerifier) external onlyOwner {
        withdrawalVerifier = IWithdrawalVerifier(newWithdrawalVerifier);
        emit WithdrawalVerifierSet(newWithdrawalVerifier);
    }

    function deposit(address token, uint256 amount, bytes32 receiverCommitment) external {
        if (!supportedTokens[token]) revert UnsupportedToken(token);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(msg.sender, receiverCommitment, token, amount);
    }

    function withdraw(
        address token,
        uint256 amount,
        address recipient,
        bytes32 root,
        bytes32 nullifier,
        bytes calldata proof
    ) external {
        if (!supportedTokens[token]) revert UnsupportedToken(token);
        if (!stateAnchor.isKnownRoot(root)) revert UnknownRoot(root);
        if (nullifierUsed[nullifier]) revert NullifierAlreadyUsed(nullifier);

        bool valid = withdrawalVerifier.verifyWithdrawal(
            root,
            nullifier,
            recipient,
            token,
            amount,
            proof
        );

        if (!valid) revert InvalidWithdrawalProof();

        nullifierUsed[nullifier] = true;
        IERC20(token).safeTransfer(recipient, amount);

        emit Withdraw(recipient, token, amount, nullifier, root);
    }
}
