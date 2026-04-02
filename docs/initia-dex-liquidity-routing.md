# Initia DEX Liquidity Routing

## En pocas palabras

Este documento explica cuando una operacion se resuelve con inventario local dentro de `Sinergy` y cuando necesita apoyarse en liquidez externa de `Initia DEX`. La clave es que, aunque la liquidez venga de L1, para el usuario la operacion sigue sintiendose como un flujo dentro de `Sinergy`.

## Cuando leer este documento

Leelo si quieres entender el router, la diferencia entre rutas `local` y `dex`, o el impacto operativo de depender de liquidez externa.

## Que debes recordar

- `Sinergy` intenta llenar primero con inventario local cuando eso tiene sentido.
- Si no alcanza, el matcher puede reequilibrar usando `Initia DEX`.
- Para el usuario, la experiencia sigue siendo la de operar dentro de `Sinergy`, aunque por detras haya una ruta externa.

This document explains how Sinergy can source liquidity from Initia L1 for a private trade instead of filling only from the matcher's local inventory.

## Overview

Sinergy supports two execution paths inside the private router:

1. `instant_local`
   The trade is filled immediately from Sinergy's local inventory on the rollup.
2. `async_rebalance_required`
   The trade is accepted on Sinergy first, then the matcher rebalances against Initia L1 liquidity through Initia DEX.

The UI now exposes three route preferences:

1. `Auto`
   Prefer local inventory when available. Fall back to Initia DEX routing when local fill is not suitable.
2. `Local`
   Only use local inventory. If the trade cannot be satisfied locally, execution is blocked.
3. `DEX-routed`
   Force the trade to settle through the Initia DEX rebalance path even if local inventory is available.

## What Happens In A DEX-Routed Trade

For a routeable market such as `cINIT/cUSDC`, the matcher follows this sequence:

1. The user deposits assets into the vault on Sinergy.
2. The user requests a quote from the private router.
3. The matcher simulates the equivalent swap on Initia L1 using `dex swap_script`.
4. The router returns a quote with `executionPath = dex`.
5. When the user executes, the swap job is created on Sinergy and user inventory is reserved.
6. The rebalance worker performs the real swap on Initia L1.
7. The returned output amount is read from the `SwapEvent` on the L1 transaction.
8. The matcher settles the result back into the Sinergy vault balances.

From the user's point of view, the trade still starts and ends on Sinergy. The external liquidity source is Initia DEX on L1.

## Components Involved

Main files:

- [SwapPanel.tsx](../apps/web/src/components/SwapPanel.tsx)
- [router.ts](../services/matcher/src/services/router.ts)
- [rebalanceWorker.ts](../services/matcher/src/services/rebalanceWorker.ts)
- [initiaDex.ts](../services/matcher/src/services/initiaDex.ts)
- [inventory.ts](../services/matcher/src/services/inventory.ts)

Responsibilities:

- `SwapPanel.tsx`
  Sends the selected route preference: `auto`, `local`, or `dex`.
- `router.ts`
  Chooses the quote mode and execution path.
- `rebalanceWorker.ts`
  Runs async rebalance jobs.
- `initiaDex.ts`
  Executes the real Initia DEX swap on L1 and extracts the actual returned amount from the transaction events.
- `inventory.ts`
  Settles the real output back into Sinergy inventory and user balances.

## Quote Decision Logic

The router checks:

1. Whether the market is routeable.
2. Whether bridge and OPinit health are acceptable.
3. Whether matcher inventory on Sinergy is enough for an immediate fill.
4. Whether the trade size is below the configured local notional limit.

Decision summary:

1. `Auto`
   Uses `instant_local` when local inventory is healthy. Otherwise routes through Initia DEX.
2. `Local`
   Uses `instant_local` only. If local inventory is not enough, the quote is marked unavailable for execution.
3. `DEX-routed`
   Always uses the async rebalance path through Initia DEX.

## L1 DEX Execution Details

The matcher uses the Initia CLI path for the live DEX swap.

Current working pattern:

1. Pass typed CLI arguments:
   `object:<pair_object>`
   `object:<metadata_object>`
   `u64:<offer_amount>`
   `option<u64>:null`
2. Broadcast the L1 swap transaction.
3. Poll the tx endpoint:
   `/cosmos/tx/v1beta1/txs/<hash>`
4. Read `return_amount` from the `SwapEvent`.

This is important because the live pool path did not behave correctly with the previous `raw_base64` argument approach.

## Operational Requirements

For DEX-routed trades to work, the matcher's L1 signer must have:

1. Enough gas in `uinit`
2. Enough L1 inventory in the source asset

Relevant env and runtime inputs:

- `L1_ROUTER_KEY_NAME`
- `L1_ROUTER_HOME`
- `L1_RPC_URL`
- `L1_REST_URL`
- `ROUTER_CANONICAL_ASSETS_JSON`
- `ROUTER_MARKETS_JSON`

If the signer runs out of `uinit`, the async route can quote correctly but execution will fail during the L1 swap stage.

## What The User Sees

In the trade panel:

1. `Route source`
   Selected preference: `Auto`, `Local`, or `DEX-routed`
2. `Execution path`
   The route the matcher plans to use: `local`, `dex`, or `unavailable`
3. `Route mode`
   The underlying mode returned by the backend:
   `instant_local` or `async_rebalance_required`

Interpretation:

1. `local`
   Sinergy can fill immediately from local inventory.
2. `dex`
   The trade will use Initia DEX liquidity through the async rebalance path.
3. `unavailable`
   The user explicitly requested `Local`, but the trade cannot be satisfied locally.

## Current Limitation

The user-facing trade starts and finishes on Sinergy, but the async path is still operationally dependent on matcher-controlled L1 balances and signer gas. It is not a trustless user-owned cross-chain execution path yet.

That means the flow is already useful for:

1. Demonstrating liquidity sourcing from Initia DEX
2. Executing private trades backed by L1 liquidity
3. Operating a hybrid inventory model

But it should still be described as matcher-operated routing rather than fully user-sovereign bridging for every leg.
