# cUSDC Migration

## En pocas palabras

Este documento explica por que el proyecto deja atras `sUSDC` y pasa a `cUSDC`. El cambio no es solo de nombre: busca que el activo quote se entienda mejor, se alinee con el modelo de activos conectados y prepare mejor el puente con el ecosistema Initia.

## Cuando leer este documento

Leelo si estas revisando activos, mercados, configuracion del matcher o despliegues donde el cambio de `sUSDC` a `cUSDC` pueda afectar contratos, UI o inventarios.

## Que debes recordar

- `cUSDC` expresa mejor el modelo de activo conectado que `sUSDC`.
- La migracion afecta nombre, configuracion, mercados y balances internos.
- Este cambio ya se refleja en la testnet activa del proyecto.

This document tracks the migration away from the legacy local quote token `sUSDC` toward a bridge-backed quote token model based on `cUSDC`.

## Why This Migration Exists

The migration started because the legacy live testnet used:

- `sUSDC`
- `Sinergy Mock USD`
- a local ERC20 quote token that was connected to Initia DEX routing only through matcher-side canonical mapping

That works technically, but it is confusing from a product perspective because users can read `USDC` semantics into a token that is still deployed as a local mock asset.

The goal of the migration is:

1. Replace `sUSDC` with `cUSDC`
2. Make the quote asset naming consistent with the connected-asset model
3. Prepare the bridge-backed claim/redeem flow so `cUSDC` can behave like `cINIT`

## What Has Already Been Prepared

The repo is now ready for multiple bridge-backed assets, not only `cINIT`.

Main changes:

- [packages/shared/src/chain.ts](../packages/shared/src/chain.ts)
  `DeploymentToken` now supports `bridge` metadata.
- [services/matcher/src/services/bridgeClaims.ts](../services/matcher/src/services/bridgeClaims.ts)
  Claim and redeem logic is generic and can support future bridge-backed tokens such as `cUSDC`.
- [services/matcher/src/index.ts](../services/matcher/src/index.ts)
  Added generic bridge endpoints:
  - `GET /bridge/assets`
  - `GET /bridge/claimable/:tokenSymbol/:initiaAddress`
  - `POST /bridge/claim`
  - `POST /bridge/redeem`
- [apps/web/src/components/BridgeLanding.tsx](../apps/web/src/components/BridgeLanding.tsx)
  The bridge UI is now structured to support multiple bridge-backed assets.

## Local Deployment Defaults For The Next Deployment

The next local deployment now defaults to:

- quote token name: `Connected USD Coin`
- quote token symbol: `cUSDC`

Relevant scripts:

- [scripts/deploy-local.sh](../scripts/deploy-local.sh)
- [scripts/add-crypto-assets.sh](../scripts/add-crypto-assets.sh)

That means the next fresh local deployment will list markets like:

- `cINIT/cUSDC`
- `cETH/cUSDC`
- `cBTC/cUSDC`
- `cSOL/cUSDC`
- `tAAPL/cUSDC`

instead of `*/sUSDC`.

## Current Live Status

The running testnet is now switched to `cUSDC`.

Completed live steps:

1. Deployed `ConnectedQuoteToken` as `cUSDC`
2. Added `cUSDC` to the vault supported token set
3. Listed `*/cUSDC` markets on-chain
4. Transferred `cUSDC` ownership to the matcher signer
5. Discovered the bridged `USDC` denom on Sinergy and added it to [deployments/testnet.json](../deployments/testnet.json)
6. Switched matcher runtime config to `cUSDC`
7. Migrated matcher state from legacy `sUSDC` balances to `cUSDC`

## Real On-Chain Migration Checklist

Completed on the current testnet:

1. Deploy a new `cUSDC` ERC20 on Sinergy
2. Transfer `cUSDC` ownership to the matcher signer
3. Add `cUSDC` as the vault quote token
4. List new markets:
   - `cINIT/cUSDC`
   - `cETH/cUSDC`
   - `cBTC/cUSDC`
   - `cSOL/cUSDC`
   - `tAAPL/cUSDC`
   - `tBOND/cUSDC`
   - `tNVDA/cUSDC`
5. Update deployment metadata with the new quote token address
6. Add `bridge` metadata for `cUSDC` once the bridged L2 denom is known
7. Update matcher runtime config:
   - `ROUTER_CANONICAL_ASSETS_JSON`
   - `ROUTER_MARKETS_JSON`
   - `ROUTER_BOOTSTRAP_INVENTORY_JSON`
8. Migrate or discard legacy `sUSDC` balances depending on the rollout strategy

## Recommended Rollout

For future environments, keep using the same order:

1. Deploy `cUSDC`
2. Add the token to the vault and markets
3. Discover and record the bridged L2 `USDC` denom
4. Switch matcher runtime config
5. Migrate internal balances before restarting the matcher
6. Refresh the frontends and public Nginx build

That keeps the UI and the on-chain/runtime state in sync during the cutover.
