// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract DarkPoolMarket is AccessControl {
    bytes32 public constant MATCHER_ROLE = keccak256("MATCHER_ROLE");

    struct Market {
        string symbol;
        address baseToken;
        address quoteToken;
        bool active;
    }

    mapping(bytes32 => Market) public markets;

    event MarketListed(
        bytes32 indexed marketId,
        string symbol,
        address indexed baseToken,
        address indexed quoteToken
    );
    event MarketStatusChanged(bytes32 indexed marketId, bool active);
    event BatchAnchored(
        bytes32 indexed batchId,
        bytes32 indexed stateRoot,
        bytes32 indexed settlementRoot,
        uint256 matchCount,
        uint256 anchoredAt
    );

    constructor(address admin, address matcher) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MATCHER_ROLE, matcher);
    }

    function listMarket(
        string calldata symbol,
        address baseToken,
        address quoteToken
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (bytes32 marketId) {
        marketId = keccak256(abi.encodePacked(symbol, baseToken, quoteToken));
        markets[marketId] = Market({
            symbol: symbol,
            baseToken: baseToken,
            quoteToken: quoteToken,
            active: true
        });

        emit MarketListed(marketId, symbol, baseToken, quoteToken);
    }

    function setMarketStatus(bytes32 marketId, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        markets[marketId].active = active;
        emit MarketStatusChanged(marketId, active);
    }

    function anchorBatch(
        bytes32 batchId,
        bytes32 stateRoot,
        bytes32 settlementRoot,
        uint256 matchCount
    ) external onlyRole(MATCHER_ROLE) {
        emit BatchAnchored(batchId, stateRoot, settlementRoot, matchCount, block.timestamp);
    }
}
