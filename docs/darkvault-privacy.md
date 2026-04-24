# DarkVault and Deposit/Withdrawal Privacy

This document explains how Sinergy's DarkVault works and what privacy it provides for deposit and withdrawal flows. The project has two vault paths:

- `DarkPoolVault`: the original vault with public deposits and withdrawals authorized by an EIP-712 matcher signature.
- `DarkVaultV2`: the ZK vault with note commitments, an on-chain anchored Merkle root, nullifiers, and Groth16 verification for withdrawals.

In the app, `VaultPanel` uses `DarkVaultV2` when `contracts.zkVault` exists in the deployment. If it is not configured, the UI falls back to the legacy `DarkPoolVault` flow.

## Main Components

### Contracts

- `contracts/src/DarkPoolVault.sol`
  - Custodies supported tokens.
  - Accepts deposits through `deposit(token, amount)`.
  - Releases withdrawals through `withdraw(token, amount, nonce, deadline, signature)`.
  - Verifies that the signature comes from the `authorizedSigner`, normally the matcher.
  - Prevents replay with `nonceUsed[msg.sender][nonce]`.

- `contracts/src/DarkVaultV2.sol`
  - Custodies supported tokens for the ZK flow.
  - Accepts deposits through `deposit(token, amount, receiverCommitment)`.
  - Releases withdrawals through `withdraw(token, amount, recipient, root, nullifier, proof)`.
  - Rejects unknown roots through `stateAnchor.isKnownRoot(root)`.
  - Rejects double-spends through `nullifierUsed[nullifier]`.
  - Delegates ZK proof verification to `withdrawalVerifier.verifyWithdrawal(...)`.

- `contracts/src/DarkStateAnchor.sol`
  - Stores the current private root and the history of known roots.
  - Only an account with `MATCHER_ROLE` can call `anchorBatch(...)`.
  - `DarkVaultV2` accepts withdrawals only against already anchored roots.

- `contracts/src/Groth16WithdrawalVerifier.sol`
  - Stores the circuit verifying key.
  - Verifies Groth16 proofs over BN254.
  - Uses these public signals: `root`, `nullifier`, `recipient`, `token`, and `amount`.

### ZK Circuit

The circuit lives in `circuits/withdrawal.circom`. Its public statement is:

- a leaf exists inside the Merkle root `root`;
- the leaf was built as `Poseidon(secret, blinding, token, amount)`;
- the user knows `secret` and `blinding`;
- the withdrawal matches the public `token` and `amount`;
- the `nullifier` is `Poseidon(secret, recipient)`.

The Merkle depth used by the shared code is `20`, defined in `packages/shared/src/zk.ts`.

### Matcher and Private State

The matcher manages internal state in `services/matcher/src/services/state.ts` and vault logic in `services/matcher/src/services/vault.ts`.

The state stores:

- internal balances by user/token;
- pending legacy withdrawals;
- already processed deposits and withdrawals;
- ZK notes in `zkNotes`, including `commitment`, `secret`, `blinding`, status, and pending/spent nullifier.

Important: in the current implementation, the matcher receives and persists each ZK note's `secret` and `blinding` so it can generate withdrawal proofs server-side. This makes the flow functional, but it means privacy against the matcher is not complete. The strongest privacy property here is against external/on-chain observers.

## Legacy Deposit Flow (`DarkPoolVault`)

1. The frontend approves the ERC-20 token for the vault.
2. The user calls `DarkPoolVault.deposit(token, amount)`.
3. The contract transfers tokens from the user to the vault.
4. The contract emits `Deposit(user, token, amount)`.
5. The frontend sends the transaction hash and logs to `POST /vault/sync-deposit`.
6. `VaultService.syncDeposit(...)` validates the event, marks the deposit as processed, and increases the user's internal balance.

This flow does not hide the depositor, token, or amount on-chain. The privacy Sinergy provides in this path happens after the deposit: matching, routing, and order coordination are kept away from a public order book.

## ZK Deposit Flow (`DarkVaultV2`)

1. The frontend creates a local note with:
   - random `secret`;
   - random `blinding`;
   - `commitment = Poseidon(secret, blinding, token, amount)`.
2. The frontend approves the ERC-20 token for the `zkVault`.
3. The user calls `DarkVaultV2.deposit(token, amount, receiverCommitment)`.
4. The contract transfers tokens to the vault and emits `Deposit(depositor, receiverCommitment, token, amount)`.
5. The frontend syncs the deposit through `POST /vault/sync-deposit`, sending the prepared ZK note.
6. The matcher recomputes the commitment and verifies that:
   - it matches the submitted note;
   - it matches the on-chain event's `receiverCommitment`.
7. The matcher adds the note to `zkNotes`, computes the new Merkle root, and anchors it through `DarkStateAnchor.anchorBatch(...)`.
8. The frontend also stores a local copy of the note in `localStorage` under `sinergy.zk-notes.v1`.

On-chain visible data in the ZK deposit:

- depositor address;
- token;
- amount;
- note commitment.

Data not revealed on-chain:

- `secret`;
- `blinding`;
- the future Merkle path used to spend the note.

The commitment decouples the future withdrawal authorization from the deposit transaction identity, but the deposit itself still reveals token, amount, and depositor.

## Legacy Withdrawal Flow (`DarkPoolVault`)

1. The frontend requests `POST /vault/withdrawal-quote`.
2. The matcher validates that the user has enough internal balance.
3. The matcher signs an EIP-712 `Withdrawal(recipient, token, amount, nonce, deadline)` message.
4. While the withdrawal is pending, the matcher moves the amount from `balances` to `locked`.
5. The user calls `DarkPoolVault.withdraw(...)` with the signature.
6. The contract validates:
   - supported token;
   - active deadline;
   - unused nonce;
   - signature from the `authorizedSigner`.
7. The contract transfers tokens to the user and emits `Withdraw(recipient, token, amount, nonce)`.
8. The frontend syncs through `POST /vault/sync-withdrawal`.
9. The matcher releases the lock and marks the withdrawal as processed.

This flow is not ZK: recipient, token, amount, and nonce are public.

## ZK Withdrawal Flow (`DarkVaultV2`)

1. The frontend requests `POST /vault/zk-withdrawal-package` with user, token, and atomic amount.
2. The matcher checks that the available internal balance covers the amount.
3. `ZkProofService.prepareWithdrawalPackage(...)` looks for an exact note in `zkNotes`:
   - same user;
   - same token;
   - same amount;
   - `unspent` status.
4. The note is marked as `pending` for a 5-minute window.
5. The matcher computes:
   - `nullifier = Poseidon(secret, recipient)`;
   - the note's Merkle path;
   - the current Merkle root.
6. The matcher checks that the root is known by `DarkStateAnchor`.
7. The matcher generates a Groth16 proof with `snarkjs`.
8. The endpoint returns `root`, `nullifier`, `recipient`, `token`, `amountAtomic`, and `proof`.
9. The user calls `DarkVaultV2.withdraw(token, amount, recipient, root, nullifier, proof)`.
10. The contract validates:
    - supported token;
    - known root;
    - unused nullifier;
    - valid ZK proof.
11. The contract sets `nullifierUsed[nullifier] = true`, transfers tokens to the recipient, and emits `Withdraw(recipient, token, amount, nullifier, root)`.
12. The frontend syncs the withdrawal through `POST /vault/sync-withdrawal`.
13. The matcher deducts the internal balance, marks the note as `spent`, and stores the `spentNullifier`.
14. The frontend tries to mark the local note copy as spent using the nullifier.

## What ZK Privacy Protects

The ZK withdrawal proves the right to withdraw without revealing the note secrets or the exact leaf position inside the Merkle tree.

To on-chain observers, the contract only sees:

- a known Merkle root;
- a nullifier;
- recipient;
- token;
- amount;
- proof.

It does not see:

- `secret`;
- `blinding`;
- Merkle path;
- note index inside the tree;
- which specific commitment is being spent.

The nullifier prevents double withdrawal without revealing the original commitment. Because `nullifier = Poseidon(secret, recipient)`, the same secret cannot be spent twice to the same recipient without producing the same nullifier.

## Current Privacy Limits

The current privacy model is not absolute. These are the important limits of the implemented design:

- The ZK deposit reveals depositor, token, amount, and commitment.
- The ZK withdrawal reveals recipient, token, amount, root, and nullifier.
- The matcher knows `secret` and `blinding` because the frontend sends them to `/vault/sync-deposit`.
- The matcher generates the withdrawal proof, so it can internally link note, user, deposit, and withdrawal.
- Note selection requires an exact amount. If a user deposits `100` and withdraws `40`, the service does not split the note or create change; it will look for an exact `40` note.
- Unique amounts or tight deposit/withdrawal timing can make external correlation easier.
- Browser notes are stored in `localStorage`; this helps UX, but it is not secure secret storage.
- The contract verifies solvency through tokens held in the vault, but internal accounting and note selection depend on the matcher.

## Security Guarantees

- Custody: deposited tokens stay in the on-chain vault.
- Asset allowlist: both vaults restrict operations to `supportedTokens`.
- Legacy anti-replay: `DarkPoolVault` uses per-user nonce and deadline.
- ZK anti-double-spend: `DarkVaultV2` uses `nullifierUsed`.
- Valid roots: `DarkVaultV2` only accepts proofs against roots known by `DarkStateAnchor`.
- Cryptographic verification: `Groth16WithdrawalVerifier` validates that the proof matches the withdrawal public signals.
- Sync idempotency: the matcher stores `processedDeposits` and `processedWithdrawals`.
- Pending withdrawal cancellation: if broadcast fails before publishing, the frontend calls cancellation endpoints to release locks or pending notes.

## Related Endpoints

- `POST /vault/sync-deposit`
  - Syncs legacy and ZK deposits from logs.
  - In ZK mode, it also receives the note with `commitment`, `secret`, and `blinding`.

- `POST /vault/withdrawal-quote`
  - Builds an EIP-712 signature for legacy withdrawal.

- `POST /vault/zk-withdrawal-package`
  - Selects an exact ZK note, generates nullifier, Merkle path, and Groth16 proof.

- `POST /vault/sync-withdrawal`
  - Syncs legacy and ZK withdrawals after on-chain confirmation.

- `POST /vault/cancel-withdrawal`
  - Cancels a pending legacy withdrawal if it has not been broadcast yet.

- `POST /vault/cancel-zk-withdrawal`
  - Returns a `pending` ZK note to `unspent` if withdrawal fails before broadcast.

## Reference Files

- `contracts/src/DarkPoolVault.sol`
- `contracts/src/DarkVaultV2.sol`
- `contracts/src/DarkStateAnchor.sol`
- `contracts/src/Groth16WithdrawalVerifier.sol`
- `circuits/withdrawal.circom`
- `packages/shared/src/zk.ts`
- `services/matcher/src/services/vault.ts`
- `services/matcher/src/services/zkProofs.ts`
- `services/matcher/src/services/zkState.ts`
- `services/matcher/src/services/state.ts`
- `apps/web/src/components/VaultPanel.tsx`
- `apps/web/src/lib/zkNotes.ts`

## Recommended Improvements

To strengthen real privacy against the matcher, the natural next step is to move proof generation to the client. In that model, the matcher would only need to anchor roots and verify availability, but it would not receive `secret` or `blinding`.

It would also be useful to implement note change or fixed denominations. That would reduce the need for exact-amount withdrawals and make it harder to correlate deposits and withdrawals through unique values.
