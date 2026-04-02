export const erc20Abi = [
  {
    type: "function",
    name: "burn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "transferOwnership",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: []
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }]
  }
] as const;

export const darkPoolVaultAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" }
    ],
    outputs: []
  },
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { indexed: true, name: "user", type: "address" },
      { indexed: true, name: "token", type: "address" },
      { indexed: false, name: "amount", type: "uint256" }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      { indexed: true, name: "recipient", type: "address" },
      { indexed: true, name: "token", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "nonce", type: "uint256" }
    ],
    anonymous: false
  }
] as const;

export const darkVaultV2Abi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "receiverCommitment", type: "bytes32" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "proof", type: "bytes" }
    ],
    outputs: []
  },
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { indexed: true, name: "depositor", type: "address" },
      { indexed: true, name: "receiverCommitment", type: "bytes32" },
      { indexed: true, name: "token", type: "address" },
      { indexed: false, name: "amount", type: "uint256" }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      { indexed: true, name: "recipient", type: "address" },
      { indexed: true, name: "token", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "nullifier", type: "bytes32" },
      { indexed: false, name: "root", type: "bytes32" }
    ],
    anonymous: false
  }
] as const;

export const darkPoolMarketAbi = [
  {
    type: "function",
    name: "anchorBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "batchId", type: "bytes32" },
      { name: "stateRoot", type: "bytes32" },
      { name: "settlementRoot", type: "bytes32" },
      { name: "matchCount", type: "uint256" }
    ],
    outputs: []
  }
] as const;

export const darkStateAnchorAbi = [
  {
    type: "function",
    name: "anchorBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "batchId", type: "bytes32" },
      { name: "stateRoot", type: "bytes32" },
      { name: "settlementRoot", type: "bytes32" },
      { name: "matchCount", type: "uint256" }
    ],
    outputs: [{ name: "epoch", type: "uint256" }]
  },
  {
    type: "function",
    name: "isKnownRoot",
    stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "event",
    name: "BatchAnchored",
    inputs: [
      { indexed: true, name: "epoch", type: "uint256" },
      { indexed: true, name: "batchId", type: "bytes32" },
      { indexed: true, name: "stateRoot", type: "bytes32" },
      { indexed: false, name: "settlementRoot", type: "bytes32" },
      { indexed: false, name: "matchCount", type: "uint256" },
      { indexed: false, name: "anchoredAt", type: "uint256" }
    ],
    anonymous: false
  }
] as const;

export const groth16WithdrawalVerifierAbi = [
  {
    type: "function",
    name: "computePublicSignals",
    stateMutability: "pure",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "nullifier", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "uint256[5]" }]
  },
  {
    type: "function",
    name: "setVerifyingKey",
    stateMutability: "nonpayable",
    inputs: [
      { name: "alpha1", type: "uint256[2]" },
      { name: "beta2", type: "uint256[2][2]" },
      { name: "gamma2", type: "uint256[2][2]" },
      { name: "delta2", type: "uint256[2][2]" },
      { name: "ic", type: "uint256[2][6]" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "verifyProof",
    stateMutability: "view",
    inputs: [
      { name: "a", type: "uint256[2]" },
      { name: "b", type: "uint256[2][2]" },
      { name: "c", type: "uint256[2]" },
      { name: "inputSignals", type: "uint256[5]" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
] as const;
