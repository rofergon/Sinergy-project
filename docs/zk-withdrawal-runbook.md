# ZK Withdrawal Runbook

## Objective

Run the first real `Groth16` withdrawal pipeline for `DarkVaultV2`.

This runbook assumes:

- [DarkVaultV2.sol](../contracts/src/DarkVaultV2.sol) is deployed
- [DarkStateAnchor.sol](../contracts/src/DarkStateAnchor.sol) is deployed
- [Groth16WithdrawalVerifier.sol](../contracts/src/Groth16WithdrawalVerifier.sol) is deployed
- the withdrawal circuit source exists at [circuits/withdrawal.circom](../circuits/withdrawal.circom)

## Public Inputs

The verifier expects 5 public inputs in this exact order:

1. `root`
2. `nullifier`
3. `recipient`
4. `token`
5. `amount`

The note stays private. The withdrawal claim proves:

- the note exists in the committed Merkle root;
- the note binds to `token` and `amount`;
- the claimant knows the note secret;
- the nullifier is derived from `secret` and `recipient`.

## Tooling

Required:

- `snarkjs`
- `node`

Installed in this repo:

- `circom2`
- `snarkjs`
- `circomlib`
- `circomlibjs`

## 1. Compile the Circuit

```bash
bash scripts/zk/compile-withdrawal-circuit.sh
```

## 2. Prepare Groth16 Setup

```bash
bash scripts/zk/setup-withdrawal-groth16.sh /path/to/powersOfTau.ptau
```

## 3. Export Verifying Key for the Contract

```bash
node scripts/zk/export-withdrawal-vkey-calldata.mjs
```

Use the JSON output as the argument object for:

- `Groth16WithdrawalVerifier.setVerifyingKey(...)`

## 4. Prepare Withdrawal Witness Input

```bash
node scripts/zk/prepare-withdrawal-input.mjs note.json
```

## 5. Generate the Proof

```bash
bash scripts/zk/generate-withdrawal-proof.sh
```

## 6. Export the Withdrawal Package

```bash
node scripts/zk/export-withdrawal-proof-package.mjs
```

The output can be sent directly to:

- `DarkVaultV2.withdraw(token, amount, recipient, root, nullifier, proof)`

## Current Status In This Repo

Implemented:

- on-chain vault and anchor
- on-chain Groth16 verifier
- shared TS proof encoder
- circuit source
- scripts for witness, proof, and verifying key preparation
- local circuit compilation through `npx circom2`
- dev `ptau`, `zkey`, `verification_key.json`, witness, proof, and proof package generation
