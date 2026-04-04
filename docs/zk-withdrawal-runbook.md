# ZK Withdrawal Runbook

## In Simple Terms

This runbook shows the step-by-step ZK vault flow now used in the repo: create a private deposit note, anchor the resulting Merkle root, and generate a `Groth16` withdrawal proof that the contract can verify without publishing the note secrets.

## When To Read This Document

Read this only if you are working with the ZK withdrawal flow or if you need to validate that the proof pipeline already works end to end.

## What To Remember

- Deposits and withdrawals now share the same note model: `Poseidon(secret, blinding, token, amount)`.
- The matcher maintains the private Merkle tree and generates withdrawal proofs dynamically from real stored notes.
- The contract verifies minimal public data; the private note is not published.
- The manual scripts in this document are still useful for setup, debugging, and validation, but they are no longer the primary runtime path.

## Objective

Run and validate the real `Groth16` withdrawal pipeline for `DarkVaultV2`.

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

## Runtime Flow In The App

The current app flow is:

1. the frontend creates `secret` and `blinding` locally for a ZK deposit;
2. it computes the deposit commitment from the same leaf used by the circuit;
3. `DarkVaultV2.deposit(...)` emits that commitment on-chain;
4. the matcher validates the note payload during deposit sync, stores it in its private note set, rebuilds the Merkle tree, and anchors the latest root through `DarkStateAnchor`;
5. on withdrawal, the matcher selects the exact matching unspent note, builds the Merkle proof, runs `snarkjs groth16 fullProve(...)`, and returns `root + nullifier + proof`;
6. the frontend submits `DarkVaultV2.withdraw(token, amount, recipient, root, nullifier, proof)`.

This means the runtime path is now dynamic. The old static `proof-package.json` flow is only a fallback/debug tool.

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

The local deployment helper also expects this file to exist at:

- `.tmp/zk/withdrawal/vkey-calldata.json`

## 4. Optional: Prepare Withdrawal Witness Input Manually

```bash
node scripts/zk/prepare-withdrawal-input.mjs note.json
```

Use this only when you want to inspect or debug the witness pipeline outside the matcher. In normal app usage, the matcher builds this input dynamically from the stored note and Merkle path.

## 5. Optional: Generate the Proof Manually

```bash
bash scripts/zk/generate-withdrawal-proof.sh
```

## 6. Optional: Export the Withdrawal Package

```bash
node scripts/zk/export-withdrawal-proof-package.mjs
```

The output can be sent directly to:

- `DarkVaultV2.withdraw(token, amount, recipient, root, nullifier, proof)`

Again, this is mainly for debugging and validation. The runtime matcher now returns the same shape from `POST /vault/zk-withdrawal-package`.

## Matcher Runtime Requirements

For the live ZK flow, the matcher needs:

- `ZK_WITHDRAWAL_WASM_FILE`
  defaults to `.tmp/zk/withdrawal/withdrawal_js/withdrawal.wasm`
- `ZK_WITHDRAWAL_ZKEY_FILE`
  defaults to `.tmp/zk/withdrawal/withdrawal_final.zkey`

Optional fallback:

- `ZK_WITHDRAWAL_PACKAGE_FILE`
  only used as a dev fallback if no exact live note is available

The deployment file should also expose:

- `contracts.zkVault`
- `contracts.stateAnchor`
- `contracts.withdrawalVerifier`

## Current Status In This Repo

Implemented:

- on-chain vault and anchor
- on-chain Groth16 verifier
- shared TS note, Merkle, and proof helpers
- circuit source
- scripts for witness, proof, and verifying key preparation
- local circuit compilation through `npx circom2`
- frontend note generation and persistence for ZK deposits
- matcher-side private note indexing and Merkle root reconstruction
- on-chain root anchoring through `DarkStateAnchor`
- dynamic runtime proof generation from real notes and Merkle paths
- dev `ptau`, `zkey`, `verification_key.json`, witness, proof, and proof package generation
