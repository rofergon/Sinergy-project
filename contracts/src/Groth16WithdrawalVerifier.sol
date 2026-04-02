// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Groth16BN254} from "./Groth16BN254.sol";
import {IWithdrawalVerifier} from "./IWithdrawalVerifier.sol";

contract Groth16WithdrawalVerifier is Ownable, IWithdrawalVerifier {
    using Groth16BN254 for Groth16BN254.G1Point;

    uint256 public constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct VerifyingKey {
        Groth16BN254.G1Point alpha1;
        Groth16BN254.G2Point beta2;
        Groth16BN254.G2Point gamma2;
        Groth16BN254.G2Point delta2;
        Groth16BN254.G1Point[6] ic;
    }

    VerifyingKey private verifyingKey;
    bool public verifyingKeyConfigured;

    event VerifyingKeySet();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setVerifyingKey(
        uint256[2] calldata alpha1,
        uint256[2][2] calldata beta2,
        uint256[2][2] calldata gamma2,
        uint256[2][2] calldata delta2,
        uint256[2][6] calldata ic
    ) external onlyOwner {
        verifyingKey.alpha1 = Groth16BN254.G1Point(alpha1[0], alpha1[1]);
        verifyingKey.beta2 = Groth16BN254.G2Point(beta2[0], beta2[1]);
        verifyingKey.gamma2 = Groth16BN254.G2Point(gamma2[0], gamma2[1]);
        verifyingKey.delta2 = Groth16BN254.G2Point(delta2[0], delta2[1]);

        for (uint256 i = 0; i < 6; i++) {
            verifyingKey.ic[i] = Groth16BN254.G1Point(ic[i][0], ic[i][1]);
        }
        verifyingKeyConfigured = true;

        emit VerifyingKeySet();
    }

    function computePublicSignals(
        bytes32 root,
        bytes32 nullifier,
        address recipient,
        address token,
        uint256 amount
    ) public pure returns (uint256[5] memory signals) {
        signals[0] = uint256(root);
        signals[1] = uint256(nullifier);
        signals[2] = uint256(uint160(recipient));
        signals[3] = uint256(uint160(token));
        signals[4] = amount;
    }

    function verifyWithdrawal(
        bytes32 root,
        bytes32 nullifier,
        address recipient,
        address token,
        uint256 amount,
        bytes calldata proof
    ) external view returns (bool) {
        if (!verifyingKeyConfigured || proof.length != 256) {
            return false;
        }

        uint256[5] memory publicSignals = computePublicSignals(
            root,
            nullifier,
            recipient,
            token,
            amount
        );

        for (uint256 i = 0; i < publicSignals.length; i++) {
            if (publicSignals[i] >= SNARK_SCALAR_FIELD) {
                return false;
            }
        }

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));

        return verifyProof(a, b, c, publicSignals);
    }

    function verifyProof(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[5] memory inputSignals
    ) public view returns (bool) {
        if (!verifyingKeyConfigured) {
            return false;
        }

        Groth16BN254.G1Point memory vkX = verifyingKey.ic[0];
        for (uint256 i = 0; i < inputSignals.length; i++) {
            if (inputSignals[i] >= SNARK_SCALAR_FIELD) {
                return false;
            }

            vkX = vkX.plus(
                Groth16BN254.G1Point(verifyingKey.ic[i + 1].x, verifyingKey.ic[i + 1].y).scalarMul(
                    inputSignals[i]
                )
            );
        }

        Groth16BN254.G1Point[] memory p1 = new Groth16BN254.G1Point[](4);
        Groth16BN254.G2Point[] memory p2 = new Groth16BN254.G2Point[](4);

        p1[0] = Groth16BN254.negate(Groth16BN254.G1Point(a[0], a[1]));
        p2[0] = Groth16BN254.G2Point(b[0], b[1]);

        p1[1] = verifyingKey.alpha1;
        p2[1] = verifyingKey.beta2;

        p1[2] = vkX;
        p2[2] = verifyingKey.gamma2;

        p1[3] = Groth16BN254.G1Point(c[0], c[1]);
        p2[3] = verifyingKey.delta2;

        return Groth16BN254.pairing(p1, p2);
    }
}
