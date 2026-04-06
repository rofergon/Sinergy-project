# Sinergy System Architecture

This document provides a high-level technical overview of the Sinergy appchain. It details how the AI strategy agent, the private execution environment, zero-knowledge (ZK) settlement, and Initia routing interact to form a cohesive, privacy-preserving trading platform.

## High-Level Objective

Sinergy transforms natural-language trading intents into verifiable, private executions. Users can securely deposit funds into the `Sinergy-2` MiniEVM rollup, express trading strategies to an AI agent, have their orders executed privately or routed externally upon validation, and withdraw assets using ZK proofs—minimizing their on-chain trading footprint.

---

## Core System Components

The Sinergy architecture is divided into the **Appchain/Rollup Layer**, the **Off-chain Services (Agent & Matcher)**, and the **Client Layer**.

### 1. The Strategy Agent (`strategy-agent`)
The intelligence layer of Sinergy. Instead of burdening the user with complex trading interfaces, this service acts as the orchestration brain.
*   **Natural Language Processing**: Translates plain-English descriptions into structured constraints (e.g., specific entry prices, stop losses, time-weighted executions).
*   **Contextual Awareness**: Injects real-time market data, technical indicators, and user portfolio states into its reasoning core.
*   **Validation & Backtesting**: Simulates the generated strategy against historical or real-time mock data to validate correctness before any state is transmitted to the matcher.
*   **Intent Generation**: Outputs a cryptographic payload describing the explicit bounds of the allowed execution, signed by the user's session key.

### 2. Private Matcher & Router (`matcher`)
The execution engine that runs off-chain for maximum privacy and performance, settling selectively on the appchain.
*   **Dark Pool Operations**: Maintains an internal, encrypted state of deposits, open orders, and balance updates. It executes price-time matching privately for local liquidity (e.g., Sinergy-native RWAs or internal bridge assets).
*   **InitiaDEX Routing**: If an AI strategy requires liquidity beyond the dark pool, the router seamlessly taps into `initiation-2` L1 liquidity via InitiaDEX, performing optimal routing while still masking the user's origin intent where possible.
*   **State Anchoring**: Periodically calculates a Merkle root of the internal execution state and commits it to the `Sinergy-2` rollup, allowing mathematically verified off-chain progression.

### 3. Sinergy-2 MiniEVM Rollup (On-chain)
The Initia-native execution layer ensuring secure asset custody and state verification.
*   **`ZKVault`**: The primary smart contract custodying user assets (like bridged `cUSDC`, `cINIT`, `cSOL`). Deposits are recorded here, but local balance changes from trading remain off-chain until withdrawal.
*   **`StateAnchor`**: Receives batch hashes (`stateRoot`, `settlementRoot`) from the matcher. This acts as the source of truth for the latest valid off-chain ledger state.
*   **`WithdrawalVerifier`**: A crucial privacy component. Users withdraw their funds by generating a Zero-Knowledge proof (Groth16/Plonk) on the client side, proving they own unspent balances in the established Merkle state. The `WithdrawalVerifier` validates this proof on-chain without revealing the exact trade history that led to the balance.

### 4. Client & UI Layer (`web`)
A privacy-first trading terminal.
*   **Initia Integration**: Native integration with `InterwovenKit`, enabling seamless connections to Initia infrastructure and EVM-compatible wallets.
*   **Agent Interaction Interface**: A dedicated UI panel to communicate with the Strategy Agent, visualize backtesting metrics, and approve AI-generated intents via EIP-712 signatures.
*   **ZK Proof Generation**: Built-in WASM circuits that calculate the complex mathematics for ZK withdrawals locally in the browser, keeping sensitive data strictly on the user's device.

---

## The Request Lifecycle (End-to-End)

1.  **Fund Custody**: The user bridges assets (e.g., OPinit) and deposits `cUSDC` into the `ZKVault` on `Sinergy-2`.
2.  **Intent Formulation**: The user types a strategy: "Buy $100 of cBTC when it dips 5%."
3.  **Agent Orchestration**: 
      * The `strategy-agent` parses the request.
      * Retrieves current `cBTC` prices from Initia oracles.
      * Formulates a structured limit order or a time-delayed trigger constraint.
      * Returns a transaction payload for user approval.
4.  **Authorization**: The user reviews the AI's deterministic plan in the UI and securely signs the EIP-712 payload.
5.  **Execution & Routing**: 
      * The `matcher` queues the order.
      * It first attempts to cross the order privately within the internal dark pool.
      * If liquidity is shallow, the `router` component formulates exactly the needed swap transaction against `InitiaDEX` to fulfill the AI's parameter bounds.
6.  **State Commitment**: The matcher bundles the execution details and anchors the new `stateRoot` onto the `StateAnchor` contract without publishing the individual trades.
7.  **Private Withdrawal**: To exit, the user requests their balance from the UI. The browser generates a ZK proof against the latest `stateRoot` and submits it to the `WithdrawalVerifier`. Funds are unlocked from the `ZKVault`.

---

## Trust Model & Future Work

Sinergy relies on separating **private execution** from **public settlement**. The current system provides robust privacy against public blockchain observers, as the exact orderbook and individual trade pathways are not written sequentially into block data.

### Next Evolution (Phase 2)
To move towards complete trust-minimization (preventing even the matcher operator from front-running):
-   Migrate the matcher engine to a Trusted Execution Environment (TEE).
-   Deploy homomorphic encryption overlays for the AI Agent input state.
-   Replace EIP-712 signed tickets with pure client-side ZK-VM execution paths.
