// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockUSDC is ERC20, Ownable {
    uint8 private constant TOKEN_DECIMALS = 6;

    constructor(address initialOwner) ERC20("Sinergy Mock USD", "sUSDC") Ownable(initialOwner) {
        _mint(initialOwner, 10_000_000 * 10 ** TOKEN_DECIMALS);
    }

    function decimals() public pure override returns (uint8) {
        return TOKEN_DECIMALS;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

