# Asset Architecture: Bridge-Backed Connected Assets (cUSDC)

Sinergy utilizes a bridge-backed quote token model, aligning perfectly with the Initia ecosystem's standard for connected assets. This architectural decision ensures that liquidity deployed inside the `Sinergy-2` private rollup remains fully fungible and interoperable with the broader Cosmos and EVM landscapes connected via `initiation-2`.

This document details the transition from mock local liquidity to fully functional Initia bridging logic.

---

## The Strategic Shift to `cUSDC`

Early prototypes of Sinergy utilized `sUSDC` (Sinergy Mock USD), a locally deployed ERC20 token isolated to the rollup. While sufficient for testing internal matchmaking, it compromised the goal of true cross-chain appchain integration.

To solve this, Sinergy implemented the **Connected-Asset Model**, officially deprecating `sUSDC` in favor of **`cUSDC` (Connected USD Coin)**. 

### Benefits of the Connected-Asset Integration:
1.  **Product Clarity**: `cUSDC` provides users with standardized, predictable pricing and bridging semantics mirroring Initia's core `cINIT` token.
2.  **Cross-Chain Interoperability**: `cUSDC` natively plugs into the Sinergy private router, allowing direct routing into the `InitiaDEX` for real liquidity.
3.  **Unified Bridge UI**: Simplifies the frontend bridging experience, standardizing claim/redeem flows across all connected assets (`cINIT`, `cUSDC`, `cETH`, `cSOL`, `cBTC`).

---

## Technical Implementation & API Readiness

Integrating bridge-backed assets required extending the `matcher-service` and shared package metadata to handle multichain verifications.

*   **`packages/shared/src/chain.ts`**: The `DeploymentToken` standard was rewritten to encapsulate cross-chain `bridge` metadata (L1 to L2 denom mapping).
*   **`services/matcher/src/services/bridgeClaims.ts`**: Implemented a generic, robust claim/redeem state machine capable of discovering mapped L2 denoms securely on Sinergy.
*   **Bridge REST API Engine**: The matcher exposes standardized endpoints for any connected asset:
    *   `GET /bridge/assets`
    *   `GET /bridge/claimable/:tokenSymbol/:initiaAddress`
    *   `POST /bridge/claim` *(Securely bridges OPinit assets to the MiniEVM Vault)*
    *   `POST /bridge/redeem`

---

## Validated Markets on Sinergy-2

The shift to `cUSDC` guarantees that Sinergy's market pairs reflect real, routeable liquidity. The current testnet defaults feature these deeply backed pairs:

*   **Crypto / Majors**:
    *   `cINIT / cUSDC`
    *   `cETH / cUSDC`
    *   `cBTC / cUSDC`
    *   `cSOL / cUSDC`
*   **Tokenized Real World Assets (RWAs)**:
    *   `tAAPL / cUSDC`
    *   `tBOND / cUSDC`
    *   `tNVDA / cUSDC`

---

## Operational Migration Record

For transparency and infrastructure auditing, the cutover from legacy mock testing to the active bridge-backed environment was achieved via the following on-chain actions:

1.  **Smart Contract Deployment**: Deployed the `ConnectedQuoteToken` standard contract natively as `cUSDC`.
2.  **Vault Whitelisting**: Whitelisted `cUSDC` within the Zero-Knowledge `DarkPoolVault` to guarantee security.
3.  **Market Realignment**: Relaunched the base pairing curve across the Sinergy matcher infrastructure against `*/cUSDC`.
4.  **OPinit Mapping Discovery**: Queried the `Sinergy-2` relayer nodes to identify the deterministic bridged `USDC` denomination on the rollup and linked it securely in the infrastructure's central `deployments/testnet.json`.

This successful migration ensures Sinergy is operating a production-like asset pipeline suitable for mainnet evaluation.
