// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract DarkPoolVault is Ownable, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant WITHDRAWAL_TYPEHASH =
        keccak256(
            "Withdrawal(address recipient,address token,uint256 amount,uint256 nonce,uint256 deadline)"
        );

    mapping(address => bool) public supportedTokens;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    address public authorizedSigner;

    event SupportedTokenSet(address indexed token, bool supported);
    event AuthorizedSignerSet(address indexed signer);
    event Deposit(address indexed user, address indexed token, uint256 amount);
    event Withdraw(address indexed recipient, address indexed token, uint256 amount, uint256 nonce);

    error UnsupportedToken(address token);
    error ExpiredWithdrawal(uint256 deadline);
    error NonceAlreadyUsed(address user, uint256 nonce);
    error InvalidSigner(address recovered);

    constructor(address initialOwner, address initialSigner)
        Ownable(initialOwner)
        EIP712("SinergyDarkPoolVault", "1")
    {
        authorizedSigner = initialSigner;
        emit AuthorizedSignerSet(initialSigner);
    }

    function setSupportedToken(address token, bool supported) external onlyOwner {
        supportedTokens[token] = supported;
        emit SupportedTokenSet(token, supported);
    }

    function setAuthorizedSigner(address newSigner) external onlyOwner {
        authorizedSigner = newSigner;
        emit AuthorizedSignerSet(newSigner);
    }

    function deposit(address token, uint256 amount) external {
        if (!supportedTokens[token]) revert UnsupportedToken(token);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(msg.sender, token, amount);
    }

    function withdraw(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (!supportedTokens[token]) revert UnsupportedToken(token);
        if (block.timestamp > deadline) revert ExpiredWithdrawal(deadline);
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed(msg.sender, nonce);

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    WITHDRAWAL_TYPEHASH,
                    msg.sender,
                    token,
                    amount,
                    nonce,
                    deadline
                )
            )
        );

        address recovered = ECDSA.recover(digest, signature);
        if (recovered != authorizedSigner) revert InvalidSigner(recovered);

        nonceUsed[msg.sender][nonce] = true;
        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdraw(msg.sender, token, amount, nonce);
    }
}

