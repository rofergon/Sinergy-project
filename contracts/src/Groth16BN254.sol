// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library Groth16BN254 {
    uint256 internal constant PRIME_Q =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct G1Point {
        uint256 x;
        uint256 y;
    }

    struct G2Point {
        uint256[2] x;
        uint256[2] y;
    }

    function negate(G1Point memory p) internal pure returns (G1Point memory) {
        if (p.x == 0 && p.y == 0) {
            return G1Point(0, 0);
        }

        return G1Point(p.x, PRIME_Q - (p.y % PRIME_Q));
    }

    function plus(G1Point memory p1, G1Point memory p2) internal view returns (G1Point memory r) {
        uint256[4] memory input = [p1.x, p1.y, p2.x, p2.y];
        bool success;

        assembly {
            success := staticcall(gas(), 6, input, 0x80, r, 0x40)
        }

        require(success, "g1 add failed");
    }

    function scalarMul(G1Point memory p, uint256 s) internal view returns (G1Point memory r) {
        uint256[3] memory input = [p.x, p.y, s];
        bool success;

        assembly {
            success := staticcall(gas(), 7, input, 0x60, r, 0x40)
        }

        require(success, "g1 mul failed");
    }

    function pairing(
        G1Point[] memory p1,
        G2Point[] memory p2
    ) internal view returns (bool) {
        require(p1.length == p2.length, "pairing length mismatch");

        uint256 elements = p1.length;
        uint256 inputSize = elements * 6;
        uint256[] memory input = new uint256[](inputSize);

        for (uint256 i = 0; i < elements; i++) {
            uint256 offset = i * 6;
            input[offset] = p1[i].x;
            input[offset + 1] = p1[i].y;
            input[offset + 2] = p2[i].x[0];
            input[offset + 3] = p2[i].x[1];
            input[offset + 4] = p2[i].y[0];
            input[offset + 5] = p2[i].y[1];
        }

        uint256[1] memory out;
        bool success;

        assembly {
            success := staticcall(gas(), 8, add(input, 0x20), mul(inputSize, 0x20), out, 0x20)
        }

        require(success, "pairing failed");
        return out[0] != 0;
    }
}
