// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ConnectedQuoteToken is ERC20, Ownable {
    uint8 private constant TOKEN_DECIMALS = 6;

    constructor(
        string memory tokenName,
        string memory tokenSymbol,
        address initialOwner,
        uint256 initialSupply
    ) ERC20(tokenName, tokenSymbol) Ownable(initialOwner) {
        _mint(initialOwner, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return TOKEN_DECIMALS;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}
