// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IStateRootRegistry} from "./IStateRootRegistry.sol";

contract DarkStateAnchor is AccessControl, IStateRootRegistry {
    bytes32 public constant MATCHER_ROLE = keccak256("MATCHER_ROLE");

    struct Batch {
        bytes32 batchId;
        bytes32 stateRoot;
        bytes32 settlementRoot;
        uint256 matchCount;
        uint256 anchoredAt;
    }

    uint256 public currentEpoch;
    bytes32 public currentRoot;

    mapping(uint256 => Batch) public batches;
    mapping(bytes32 => bool) private knownRoots;

    event BatchAnchored(
        uint256 indexed epoch,
        bytes32 indexed batchId,
        bytes32 indexed stateRoot,
        bytes32 settlementRoot,
        uint256 matchCount,
        uint256 anchoredAt
    );

    constructor(address admin, address matcher, bytes32 genesisRoot) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MATCHER_ROLE, matcher);

        if (genesisRoot != bytes32(0)) {
            currentEpoch = 1;
            currentRoot = genesisRoot;
            knownRoots[genesisRoot] = true;

            batches[1] = Batch({
                batchId: bytes32(0),
                stateRoot: genesisRoot,
                settlementRoot: bytes32(0),
                matchCount: 0,
                anchoredAt: block.timestamp
            });

            emit BatchAnchored(1, bytes32(0), genesisRoot, bytes32(0), 0, block.timestamp);
        }
    }

    function anchorBatch(
        bytes32 batchId,
        bytes32 stateRoot,
        bytes32 settlementRoot,
        uint256 matchCount
    ) external onlyRole(MATCHER_ROLE) returns (uint256 epoch) {
        require(stateRoot != bytes32(0), "state root required");

        epoch = currentEpoch + 1;
        currentEpoch = epoch;
        currentRoot = stateRoot;
        knownRoots[stateRoot] = true;

        batches[epoch] = Batch({
            batchId: batchId,
            stateRoot: stateRoot,
            settlementRoot: settlementRoot,
            matchCount: matchCount,
            anchoredAt: block.timestamp
        });

        emit BatchAnchored(epoch, batchId, stateRoot, settlementRoot, matchCount, block.timestamp);
    }

    function isKnownRoot(bytes32 root) external view returns (bool) {
        return knownRoots[root];
    }
}
