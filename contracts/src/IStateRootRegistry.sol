// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStateRootRegistry {
    function isKnownRoot(bytes32 root) external view returns (bool);
}
