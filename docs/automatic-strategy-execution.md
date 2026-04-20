# Automatic Strategy Execution

This document describes how Sinergy turns a user-approved strategy into a controlled automatic execution flow across the private matcher, the `Sinergy-2` MiniEVM, and Initia L1 liquidity when routing is required.

The goal is simple: users should be able to authorize a strategy once, let the system execute only within deterministic bounds, and later inspect a full execution history with pricing and PnL context.

---

## Overview

Automatic strategy execution in Sinergy is built around four guarantees:

1. **Explicit user approval**: no strategy can execute onchain until the user signs an EIP-712 authorization payload.
2. **Bounded execution**: the matcher can only consume the signed authorization for the exact approved strategy version.
3. **Single-use onchain consumption**: the `StrategyExecutor` contract verifies the signature, checks the nonce, and prevents replay.
4. **Auditable history**: each execution is recorded so the user can review trades, prices, transaction hashes, and current strategy-level PnL.

---

## Authorization Model

Before any automatic execution is allowed, the frontend asks the user to sign a typed EIP-712 approval for a specific saved strategy.

The approval payload binds:

- `owner`: the wallet that authorized execution
- `strategyId`: the exact strategy record being approved
- `strategyHash`: the current strategy content hash
- `nonce`: a per-user replay-protection nonce
- `deadline`: an optional validity window

This approval is then stored by the matcher as the active authorization for that strategy.

### Why the strategy hash matters

Sinergy invalidates previous approvals when the strategy changes. This ensures that a signature created for an old version cannot silently authorize a new or edited strategy.

### Onchain verification

When the matcher decides to execute a qualifying signal, it consumes the approval through `StrategyExecutor` on `Sinergy-2`.

The contract is responsible for:

- reconstructing the EIP-712 digest
- verifying the user signature
- checking the owner nonce
- marking the approval as consumed so it cannot be replayed

The local development deployment currently uses:

- `StrategyExecutor`: `0x3Db7923385663Fd3410db197AE794ce861Cb7D75`

For local environments this address is also recorded in `deployments/local.json`.

---

## Automatic Execution Lifecycle

Once a strategy is approved, the automatic execution path is:

1. The strategy remains in a `saved` state and has an active authorization.
2. The matcher evaluates the strategy rules against the latest market candle and indicator state.
3. If the strategy produces a valid live action, the matcher prepares the execution.
4. The matcher consumes the approval onchain through `StrategyExecutor`.
5. The trade is routed through the appropriate liquidity path.
6. The execution record is stored and surfaced in the frontend history page.

At the moment, live automatic execution is intentionally conservative:

- supported: `long entry`
- supported: `long exit`
- not yet supported: `short` execution with real borrow or margin semantics

If a strategy requires unsupported live behavior, execution is rejected instead of partially approximated.

---

## Liquidity Paths

Sinergy supports two execution destinations.

### 1. Router-enabled markets

For router-enabled pairs such as `cINIT/cUSDC` or `cETH/cUSDC`, the matcher can source external liquidity through the bridge and Initia L1 DEX path.

This flow may include:

- local vault debits
- bridge-out to L1
- L1 DEX swap
- settlement back into the appchain accounting model

This is the path used when deep external liquidity is preferable to private internal matching.

### 2. Dark-pool markets

For non-routeable markets, the matcher places the trade through the private dark-pool path instead.

This path keeps execution local to Sinergy's private matching engine and records the resulting execution state off-chain before settlement anchoring.

---

## Real Testnet Routing Example

The current stack has already been exercised against Initia testnet liquidity.

Example verified L1 transaction:

- `A74324A80B7ED945CFCF302CFCDB579550AFF5F2A2E2C08E7AA9F3A3B9BBEF45`

This transaction was observed on `initiation-2` and completed successfully with `code: 0`. It corresponds to a routed swap that progressed through the asynchronous bridge and L1 execution pipeline before settling back into Sinergy's state model.

This matters because it demonstrates that automatic execution is not limited to local simulation: the routing stack can reach real Initia L1 liquidity when the market requires it.

---

## Frontend History Page

Sinergy now includes a dedicated user history page for strategy execution review.

The history view is designed to answer the main operational questions a user has after enabling automation:

- Which strategy was authorized?
- When was it signed?
- Which market was traded?
- What price was used for each execution?
- What is the current status of each trade?
- Which onchain or L1 transaction hash is associated with the execution?
- What is the running PnL since the strategy authorization became active?

The frontend groups records by strategy and displays both per-trade detail and strategy-level rollups.

### Data shown to the user

Each execution record can include:

- strategy name and identifier
- authorization timestamp
- execution timestamp
- market symbol
- side or action
- execution price
- execution status
- appchain transaction hash when applicable
- L1 transaction hash for routed swaps when available

The strategy summary additionally computes a current PnL estimate from recorded executions and the latest reference market price.

---

## Backend Interfaces

The automatic execution flow is exposed through matcher endpoints:

- `POST /strategy/execution/intent`
- `POST /strategy/execution/approve`
- `GET /strategy/execution/:strategyId`
- `POST /strategy/execution/execute`
- `GET /strategy/execution/history/:ownerAddress`

These endpoints cover the full lifecycle:

- building the signable authorization payload
- saving the signed approval
- checking active approval state
- executing a live approved strategy
- retrieving the user's execution history

---

## Operational Notes

Automatic execution is intentionally versioned and defensive.

- Only `saved` strategies can be authorized or executed.
- Strategy approvals are invalidated when the strategy definition changes.
- Authorization consumption is single-use at the contract level.
- Execution history persists independently from the strategy authoring session.

This gives Sinergy a safer automation model than a broad wallet-level trading approval, because the user is authorizing a narrow, reviewable strategy artifact rather than giving the system unrestricted trading power.

---

## Current Limitations

The current implementation is production-oriented but still evolving.

- Live support is currently limited to long-entry and long-exit strategy actions.
- Dark-pool execution history does not yet expose fill-level realized PnL with the same granularity as routed swap history.
- Testnet environments still require the correct `StrategyExecutor` address to be deployed and configured in `deployments/testnet.json`.

These constraints are deliberate and keep the automatic execution surface conservative while the routing, settlement, and history layers mature.

