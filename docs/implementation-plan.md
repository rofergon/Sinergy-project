# Implementation Plan

## Objective

Take `Sinergy` from a local environment on `Sinergy-2` to an **operable testnet** on `initiation-2`, keeping the local environment as the development path and not yet relying on `whitelist` to operate the rollup.

## Realistic Scope

### Included in this phase

1. launch the EVM rollup on testnet with `weave`
2. run `executor`, `challenger`, and relayer
3. deploy contracts on the real rollup
4. connect frontend and matcher to public rollup endpoints
5. operate deposits, orders, withdrawals, and router on testnet

### Not included in this phase

1. `VIP`
2. official whitelist
3. promise that the public bridge will list `Sinergy-2` as an official destination

## Phase 0: Operational Preparation

### Deliverables

1. `weave` installed and verified
2. Gas Station created and funded
3. minimum inventory of accounts, mnemonics, and endpoints documented

### Tasks

1. run `weave init`
2. run `weave gas-station setup`
3. fund Gas Station with `INIT` testnet
4. if using Celestia, also fund with `TIA`
5. save in an internal document:
   - rollup chain id
   - RPC, REST, JSON-RPC, WS
   - operator address
   - Gas Station address

### Risks

1. not separating operation accounts from development accounts
2. losing control of which mnemonic feeds bots and relayer

## Phase 1: Launch `Sinergy-2` on Testnet

### Deliverables

1. `MiniEVM` rollup running on `initiation-2`
2. public endpoints or at least accessible from your apps
3. `weave rollup launch` artifacts saved

### Tasks

1. run `weave rollup launch`
2. choose final configuration:
   - VM: `evm`
   - final rollup chain id
   - gas denom
   - DA layer
3. validate that the rollup responds via:
   - Tendermint RPC
   - REST
   - JSON-RPC
   - WebSocket

### Exit Criteria

1. you can query blocks
2. you can send a simple transaction to the rollup
3. you have endpoints that don't depend on `127.0.0.1`

## Phase 2: Raise Cross-Chain Infrastructure

### Deliverables

1. `executor` running
2. `challenger` running
3. relayer running
4. known health endpoints

### Tasks

1. run `weave opinit init`
2. start:
   - `weave opinit start executor`
   - `weave opinit start challenger`
3. run `weave relayer init`
4. start the real relayer
5. save health check URLs for:
   - OPinit
   - relayer

### Exit Criteria

1. the matcher can query real bridge health
2. the router can distinguish healthy vs degraded infrastructure

## Phase 3: Separate `local` and `testnet` in the Repo

### Deliverables

1. isolated local configuration
2. isolated testnet configuration
3. deploy scripts parametrizable by environment

### Changes per file

#### [scripts/deploy-local.sh](../scripts/deploy-local.sh)

1. stop always writing to `deployments/local.json`
2. extract parameters:
   - `ENV_NAME`
   - `DEPLOYMENT_FILE`
   - `ROLLUP_NAME`
   - `ROLLUP_CHAIN_ID`
   - `L1_CHAIN_ID`
   - `JSON_RPC_URL`
   - `WS_URL`
   - `TENDERMINT_RPC_URL`
   - `REST_URL`
3. rename or split:
   - option A: convert to `scripts/deploy-rollup.sh`
   - option B: keep `deploy-local.sh` and create `deploy-testnet.sh`

#### [scripts/add-crypto-assets.sh](../scripts/add-crypto-assets.sh)

1. stop assuming `deployments/local.json`
2. accept `DEPLOYMENT_FILE`
3. accept real rollup endpoints

#### [deployments/local.json](../deployments/local.json)

1. keep it only for local development

#### `deployments/testnet.json`

1. create this file
2. save:
   - testnet network metadata
   - contract addresses
   - token catalog
   - operator

#### [packages/shared/src/chain.ts](../packages/shared/src/chain.ts)

1. stop exporting a single hardcoded local chain
2. move to a factory or two exports:
   - `SINERGY_LOCAL_CHAIN`
   - `SINERGY_TESTNET_CHAIN`
3. move `rpcUrls` and explorer to deployment-dependent config

### Exit Criteria

1. you can run local and testnet without overwriting files
2. the repo stops structurally depending on `127.0.0.1`

## Phase 4: Deploy Contracts on Testnet

### Deliverables

1. `MockUSDC`, `RwaShareToken`, `DarkPoolVault`, `DarkPoolMarket` deployed on testnet
2. markets listed
3. addresses persisted in `deployments/testnet.json`

### Tasks

1. compile Foundry
2. deploy contracts with `minitiad tx evm create`
3. execute setup:
   - `setSupportedToken`
   - `listMarket`
4. export ABIs if contracts changed

### Changes per file

#### [contracts/src/DarkPoolVault.sol](../contracts/src/DarkPoolVault.sol)

1. check if the current matcher signer will remain the production testnet signer
2. keep constructor compatible with parameterized deployment

#### [contracts/src/DarkPoolMarket.sol](../contracts/src/DarkPoolMarket.sol)

1. validate matcher role for remote operation

#### [scripts/export-abis.mjs](../scripts/export-abis.mjs)

1. use it as a fixed step after deploy if contracts change

### Exit Criteria

1. you can deposit and withdraw on testnet rollup
2. markets exist on-chain

## Phase 5: Adapt Matcher to Testnet

### Deliverables

1. matcher reading `deployments/testnet.json`
2. real OPinit and relayer health
3. router with realistic L1 inventory and integration

### Changes per file

#### [services/matcher/.env.example](../services/matcher/.env.example)

1. keep it as a neutral example
2. create real variants:
   - `.env.local`
   - `.env.testnet`

#### [services/matcher/src/config/env.ts](../services/matcher/src/config/env.ts)

1. make sure all critical URLs can come via env
2. check if it's worth hardening required variables for testnet

#### [services/matcher/src/index.ts](../services/matcher/src/index.ts)

1. run with `DEPLOYMENT_FILE=../../deployments/testnet.json`
2. validate that `BridgeHealthService` uses real health URLs
3. validate that `L_ROUTER_HOME` and key config don't depend on a specific local machine

#### [services/matcher/src/services/bridgeHealth.ts](../services/matcher/src/services/bridgeHealth.ts)

1. keep autodiscovery as fallback
2. prioritize explicit URLs on testnet

#### [services/matcher/src/services/initiaDex.ts](../services/matcher/src/services/initiaDex.ts)

1. test the real L1 signer
2. check signer funding for swaps and rebalances

### Exit Criteria

1. the matcher can start clean on testnet
2. `/bridge/status` reflects real infrastructure
3. the router doesn't offer instant fills if infrastructure isn't healthy

## Phase 6: Adapt Frontend and Bridge App

### Deliverables

1. `apps/web` connected to testnet
2. `apps/bridge` connected to testnet
3. UX without `localhost` dependency

### Changes per file

#### [apps/web/src/initia.ts](../apps/web/src/initia.ts)

1. already supports env overrides
2. need to populate:
   - `VITE_TENDERMINT_RPC_URL`
   - `VITE_REST_URL`
   - `VITE_INDEXER_URL`
   - `VITE_JSON_RPC_URL`
   - `VITE_EVM_WS_URL`
3. check if `deployment.network.name` should reflect testnet name, not "Sinergy Local"

#### [apps/bridge/src/initia.ts](../apps/bridge/src/initia.ts)

1. same adaptation as `apps/web`
2. keep `openBridge` with source defaults, not with promise of official destination

#### [apps/web/src/App.tsx](../apps/web/src/App.tsx)

1. validate `bridge degraded` banners
2. confirm copy and states reflect real testnet

#### [apps/bridge/src/App.tsx](../apps/bridge/src/App.tsx)

1. review final bridge copy for testnet
2. if real source isn't `uinit`, change env and onboarding message

### Exit Criteria

1. wallet connects
2. bridge app opens official flow
3. exchange operates against testnet rollup

## Phase 7: Observability and Operation

### Deliverables

1. minimum runbook
2. health check list
3. restart procedure

### Tasks

1. document processes:
   - rollup node
   - executor
   - challenger
   - relayer
   - matcher
   - web
   - bridge
2. define startup and recovery checklist
3. document minimum operational balances for:
   - Gas Station
   - matcher signer
   - L1 router signer

## Phase 8: Registration and Whitelist

### Deliverables

1. entry in `initia-registry`
2. contact with Initia team if seeking whitelist on testnet

### Tasks

1. register the rollup in `initia-registry`
2. prepare public project metadata
3. if seeking VIP integration or more official support, contact Initia

### Note

This phase doesn't block an **operable testnet**, but it does block part of the more official public ecosystem integration.

## Recommended Execution Order

1. launch testnet rollup with `weave`
2. raise bots and relayer
3. separate `local`/`testnet` config in the repo
4. deploy contracts to testnet
5. raise matcher on testnet
6. raise frontend and bridge with real endpoints
7. test complete flow
8. register the rollup
9. request whitelist if needed

## Definition of Done

The migration to **operable testnet** is considered complete when:

1. `Sinergy-2` responds via RPC, REST, JSON-RPC, and WS
2. contracts and markets are deployed on the testnet rollup
3. `apps/web` and `apps/bridge` work without depending on localhost
4. the matcher operates with `deployments/testnet.json`
5. the router correctly distinguishes bridge/OPinit/relayer health
6. you can demo:
   - wallet connection
   - official bridge as entry to the ecosystem
   - deposit in vault
   - order or swap
   - signed withdrawal

## Recommended Next Iteration in Code

1. create `deployments/testnet.json`
2. refactor [scripts/deploy-local.sh](../scripts/deploy-local.sh) to a deploy parametrizable by environment
3. refactor [packages/shared/src/chain.ts](../packages/shared/src/chain.ts) to support local and testnet
4. create `.env.testnet` for matcher and frontends
5. document the real commands for `weave`, `opinit`, and relayer in an operational runbook
