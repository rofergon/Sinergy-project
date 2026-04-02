// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DarkStateAnchor} from "../src/DarkStateAnchor.sol";
import {DarkVaultV2} from "../src/DarkVaultV2.sol";
import {Groth16WithdrawalVerifier} from "../src/Groth16WithdrawalVerifier.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract Groth16WithdrawalVerifierTest {
    bytes32 private constant GENESIS_ROOT = keccak256("genesis-root");
    bytes32 private constant NEXT_ROOT = keccak256("next-root");
    bytes32 private constant NULLIFIER = keccak256("nullifier");
    bytes32 private constant RECEIVER_COMMITMENT = keccak256("receiver-commitment");

    function testWithdrawalSignalsExposeExpectedValues() public {
        Groth16WithdrawalVerifier verifier = new Groth16WithdrawalVerifier(address(this));
        uint256[5] memory actual =
            verifier.computePublicSignals(NEXT_ROOT, NULLIFIER, address(this), address(0xBEEF), 12345);

        require(actual[0] == uint256(NEXT_ROOT), "root mismatch");
        require(actual[1] == uint256(NULLIFIER), "nullifier mismatch");
        require(actual[2] == uint256(uint160(address(this))), "recipient mismatch");
        require(actual[3] == uint256(uint160(address(0xBEEF))), "token mismatch");
        require(actual[4] == 12345, "amount mismatch");
    }

    function testVerifierRejectsMalformedProof() public {
        Groth16WithdrawalVerifier verifier = new Groth16WithdrawalVerifier(address(this));
        bool valid =
            verifier.verifyWithdrawal(NEXT_ROOT, NULLIFIER, address(this), address(0xBEEF), 12345, hex"1234");
        require(!valid, "malformed proof should be rejected");
    }

    function testVaultRejectsInvalidGroth16Proof() public {
        DarkStateAnchor anchor = new DarkStateAnchor(address(this), address(this), GENESIS_ROOT);
        Groth16WithdrawalVerifier verifier = new Groth16WithdrawalVerifier(address(this));
        DarkVaultV2 vault = new DarkVaultV2(address(this), address(anchor), address(verifier));
        MockUSDC token = new MockUSDC(address(this));

        vault.setSupportedToken(address(token), true);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(address(token), 100_000, RECEIVER_COMMITMENT);
        anchor.anchorBatch(keccak256("batch"), NEXT_ROOT, keccak256("settlement"), 1);

        (bool ok,) = address(vault).call(
            abi.encodeWithSelector(
                vault.withdraw.selector,
                address(token),
                100_000,
                address(this),
                NEXT_ROOT,
                NULLIFIER,
                hex"1234"
            )
        );

        require(!ok, "vault should reject invalid Groth16 proof");
        require(!vault.nullifierUsed(NULLIFIER), "nullifier should remain unused");
    }
}
