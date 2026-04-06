# InitiaDEX Liquidity Routing

Sinergy is designed as a hybrid liquidity environment. While it operates a high-performance **private dark pool** on the `Sinergy-2` rollup, it maintains a seamless bridge to external liquidity on the `initiation-2` L1. 

This document outlines the architecture and execution flow that enables the Sinergy private router to tap into **InitiaDEX** when local inventory is insufficient, ensuring high liquidity availability without compromising the user's unified appchain experience.

---

## Routing Architecture

Sinergy supports two primary execution paths within its private router logic. Both paths can be triggered dynamically by the Strategy Agent or manually by the user.

1. **`instant_local` (Dark Pool Fill)**
   The trade is filled immediately against Sinergy's local, private inventory on the `Sinergy-2` rollup. This path provides the highest privacy and lowest latency.
2. **`async_rebalance_required` (InitiaDEX Route)**
   The trade is accepted by the Sinergy Matcher, but execution is fulfilled by routing the matching requirements against Initia L1 liquidity through InitiaDEX. The settlement is still anchored back to the user's `Sinergy-2` account.

### Route Preferences
Users and autonomous agents can dictate how liquidity is sourced:
*   **Auto**: The optimal default. Prefers local inventory when available and healthy, but falls back to InitiaDEX routing to guarantee execution if the local pool lacks depth.
*   **Local**: Strictly utilizes the private dark pool. If the trade exceeds local capacity, execution is securely blocked rather than exposing the intent externally.
*   **DEX-routed**: Forces the trade to settle through the InitiaDEX path, useful for massive sizes or specific arb-rebalancing needs.

---

## Execution Lifecycle: DEX-Routed Trade

When a trade is routed through InitiaDEX (e.g., a `cINIT/cUSDC` pair), the matcher safely orchestrates cross-chain execution:

1. **Intent Submission**: The user or AI Agent submits an intent requiring external liquidity.
2. **Quoting**: The matcher simulates the equivalent swap directly on Initia L1 to lock in the expected return, generating a strict `dex` execution quote.
3. **Reservation**: Upon approval, the swap job is queued on `Sinergy-2`, and the user's local inventory is reserved.
4. **L1 Rebalancing**: The `rebalanceWorker` performs the actual swap on Initia L1 via InitiaDEX.
5. **Event Verification**: The router listens for the `SwapEvent` on the L1 transaction to extract the *exact* returned amount.
6. **Local Settlement**: The matcher securely credits the user's internal Sinergy vault balance with the L1 extraction, finalizing the transaction.

From the user's perspective, the operation completes entirely within Sinergy's unified interface.

---

## Technical Component Breakdown

The routing logic relies on specific microservices within the Sinergy backend:

- **`router.ts`**: The brain of the quoting engine. Analyzes the market, bridge health, and local inventory limits to classify trades as `instant_local` or `async_rebalance_required`.
- **`rebalanceWorker.ts`**: An asynchronous worker dedicated to processing queued cross-chain L1 routing jobs reliably.
- **`initiaDex.ts`**: The execution hook. It constructs, signs, and executes the real Initia DEX swap on L1 and parses the deterministic output from the transaction logs securely.
- **`inventory.ts`**: The reconciliation layer that settles real L1 output back into the encrypted Sinergy inventory arrays.

---

## Initia L1 Interaction Details

To perform the live DEX swap predictably, the matcher relies on typed Initia CLI transaction paths, bypassing raw unstable payloads:

1. **Transaction Construction**:
   Constructs the swap with precise types:
   *   `object:<pair_object>`
   *   `object:<metadata_object>`
   *   `u64:<offer_amount>`
   *   `option<u64>:null`
2. **Broadcast & Listen**: Broadcasts the L1 swap.
3. **Verification**: Polls `/cosmos/tx/v1beta1/txs/<hash>`.
4. **Extraction**: Securely reads `return_amount` from the `SwapEvent`.

### Operational Dependencies
For DEX-routed trades to function continuously on testnet or mainnet, the matcher's L1 signer account requires:
*   Sufficient `uinit` for gas execution on L1.
*   Baseline L1 inventory in the routing source assets.

Configuration variables actively managing this context:
`L1_ROUTER_KEY_NAME`, `L1_ROUTER_HOME`, `L1_RPC_URL`, `L1_REST_URL`, `ROUTER_CANONICAL_ASSETS_JSON`, `ROUTER_MARKETS_JSON`.

---

## Trust Assumptions & Evolution

Currently, Sinergy’s InitiaDEX routing demonstrates a highly effective **hybrid inventory model** that brings deep L1 liquidity directly into an appchain environment with minimal friction.

In Phase 1, the asynchronous path is matcher-operated to ensure flawless UX and speed. Next-generation iterations will focus on converting these asynchronous legs into fully user-sovereign, trustless cross-chain ZK execution pathways.
