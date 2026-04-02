// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DarkStateAnchor} from "../src/DarkStateAnchor.sol";
import {DarkVaultV2} from "../src/DarkVaultV2.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockWithdrawalVerifier} from "../src/MockWithdrawalVerifier.sol";

contract DarkVaultV2Test {
    DarkStateAnchor private anchor;
    DarkVaultV2 private vault;
    MockUSDC private token;
    MockWithdrawalVerifier private verifier;

    bytes32 private constant GENESIS_ROOT = keccak256("genesis-root");
    bytes32 private constant NEXT_ROOT = keccak256("next-root");
    bytes32 private constant BATCH_ID = keccak256("batch-1");
    bytes32 private constant SETTLEMENT_ROOT = keccak256("settlement-root");
    bytes32 private constant RECEIVER_COMMITMENT = keccak256("receiver-commitment");
    bytes32 private constant NULLIFIER = keccak256("nullifier-1");

    function setUp() public {
        anchor = new DarkStateAnchor(address(this), address(this), GENESIS_ROOT);
        verifier = new MockWithdrawalVerifier();
        vault = new DarkVaultV2(address(this), address(anchor), address(verifier));
        token = new MockUSDC(address(this));

        vault.setSupportedToken(address(token), true);
        token.approve(address(vault), type(uint256).max);
    }

    function testDepositAndProofBackedWithdrawal() public {
        uint256 amount = 250_000;
        bytes memory proof = abi.encodePacked("valid-proof");

        vault.deposit(address(token), amount, RECEIVER_COMMITMENT);
        require(token.balanceOf(address(vault)) == amount, "deposit not held in vault");

        anchor.anchorBatch(BATCH_ID, NEXT_ROOT, SETTLEMENT_ROOT, 1);
        verifier.setProofResult(
            NEXT_ROOT,
            NULLIFIER,
            address(this),
            address(token),
            amount,
            proof,
            true
        );

        uint256 balanceBefore = token.balanceOf(address(this));
        vault.withdraw(address(token), amount, address(this), NEXT_ROOT, NULLIFIER, proof);

        require(token.balanceOf(address(vault)) == 0, "vault should release funds");
        require(token.balanceOf(address(this)) == balanceBefore + amount, "recipient not paid");
        require(vault.nullifierUsed(NULLIFIER), "nullifier not consumed");
    }

    function testRejectsUnknownRoot() public {
        uint256 amount = 100_000;
        bytes memory proof = abi.encodePacked("proof");

        vault.deposit(address(token), amount, RECEIVER_COMMITMENT);

        (bool ok,) = address(vault).call(
            abi.encodeWithSelector(
                vault.withdraw.selector,
                address(token),
                amount,
                address(this),
                keccak256("unknown-root"),
                NULLIFIER,
                proof
            )
        );

        require(!ok, "withdraw should fail for unknown root");
    }

    function testRejectsNullifierReuse() public {
        uint256 amount = 150_000;
        bytes memory proof = abi.encodePacked("valid-proof");

        vault.deposit(address(token), amount, RECEIVER_COMMITMENT);
        anchor.anchorBatch(BATCH_ID, NEXT_ROOT, SETTLEMENT_ROOT, 1);
        verifier.setProofResult(
            NEXT_ROOT,
            NULLIFIER,
            address(this),
            address(token),
            amount,
            proof,
            true
        );

        vault.withdraw(address(token), amount, address(this), NEXT_ROOT, NULLIFIER, proof);

        token.mint(address(vault), amount);
        (bool ok,) = address(vault).call(
            abi.encodeWithSelector(
                vault.withdraw.selector,
                address(token),
                amount,
                address(this),
                NEXT_ROOT,
                NULLIFIER,
                proof
            )
        );

        require(!ok, "withdraw should fail when nullifier is reused");
    }
}
