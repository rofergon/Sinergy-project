# Sinergy

Private trading on an Initia appchain, with bridge-backed assets and on-demand liquidity from InitiaDEX.

Sinergy is a MiniEVM rollup on `initiation-2` designed for a hackathon-grade demo of what feels native to the Initia stack:

- bridge assets from Initia L1 into an appchain;
- turn them into connected assets like `cINIT` and `cUSDC`;
- deposit them into a private vault;
- trade privately inside the rollup;
- route larger trades to real InitiaDEX liquidity when local inventory is not enough.

## Why This Matters

Most trading apps choose one of two paths:

- great UX inside the appchain, but fake or isolated liquidity;
- real liquidity on L1, but poor cross-chain UX for the user.

Sinergy combines both:

- private execution and app-specific UX on `Sinergy-2`;
- bridge-aware assets aligned with Initia;
- optional routing into live `InitiaDEX` liquidity on `initiation-2`.

That is the core hackathon story:

**an Initia-native private market that can pull real L1 liquidity into an appchain trading experience.**

## Why It Fits Initia

Sinergy is intentionally built around Initia primitives:

- `InterwovenKit` for wallet and signing UX;
- Initia usernames (`.init`) surfaced through InterwovenKit for connected-wallet identity;
- `MiniEVM` for EVM app logic on an Initia rollup;
- `OPinit` executor and relayer infrastructure for cross-chain operation;
- bridge-backed connected assets like `cINIT` and `cUSDC`;
- live routing to `InitiaDEX` testnet pools for selected markets.

This is not a generic EVM app re-skinned for Initia. The bridge, wallet flow, routing model, and asset model are all shaped around the Initia network.

## Demo Flow

The strongest demo path is:

1. Bridge `INIT` or `USDC` from `initiation-2` into `Sinergy-2`.
2. Claim the connected appchain assets:
   - `INIT -> cINIT`
   - `USDC -> cUSDC`
3. Deposit into the `Dark Vault`.
4. Trade privately in Sinergy.
5. Choose route mode:
   - `Local` for instant fills from Sinergy inventory
   - `DEX-routed` for trades backed by real `InitiaDEX` liquidity
6. Withdraw the resulting assets back to the wallet.
7. Redeem bridge-backed balances when needed.

Examples:

- `cUSDC -> cINIT`
- `cUSDC -> cETH`
- `cINIT -> cUSDC`

### General Flow Diagram

![Sinergy general flow](docs/Sinergy_general_flow.png)

## Standout Components

### 1. `Bridge to Sinergy`

The frontend does not depend on the public bridge UI listing the rollup. It includes a direct `Bridge to Sinergy` flow built with `InterwovenKit`, so the demo remains usable even if the public bridge directory is incomplete.

Sinergy uses the Initia bridge stack in two ways:

- Official `Interwoven Bridge` modal through `openBridge(...)` for the standard Initia bridge UX.
- Direct `OPinit` deposit flow for a faster rollup-specific path into `Sinergy-2`.

Where this is implemented:

- Exchange app official bridge entry: [apps/web/src/App.tsx](/home/sari/Sinergy-project/apps/web/src/App.tsx)
- Exchange bridge landing and direct deposit UI: [apps/web/src/components/BridgeLanding.tsx](/home/sari/Sinergy-project/apps/web/src/components/BridgeLanding.tsx)
- Dedicated bridge app: [apps/bridge/src/App.tsx](/home/sari/Sinergy-project/apps/bridge/src/App.tsx)
- Shared bridge defaults and source asset config: [apps/web/src/initia.ts](/home/sari/Sinergy-project/apps/web/src/initia.ts) and [apps/bridge/src/initia.ts](/home/sari/Sinergy-project/apps/bridge/src/initia.ts)
- Claim and redeem backend routes: [services/matcher/src/index.ts](/home/sari/Sinergy-project/services/matcher/src/index.ts)

What each part is used for:

- `openBridge(buildBridgeDefaults())`
  Opens the standard Interwoven bridge modal with the configured source chain and denom so the user starts from the correct Initia route.
- Direct `MsgInitiateTokenDeposit`
  Sends the OPinit bridge deposit directly from the app when we want a smoother Sinergy-specific deposit flow without relying on destination discovery in the public bridge UI.
- `claim`
  Converts bridged balance that arrived on the Initia address into the connected EVM-side asset used by Sinergy, such as `cINIT` or `cUSDC`.
- `redeem`
  Burns the connected asset and reopens the corresponding bridged balance on Sinergy so the user can move back through the bridge-native path.

### 2. Bridge-Backed Assets

Sinergy exposes connected assets that are meaningful in the Initia context:

- `cINIT`
- `cUSDC`
- `cETH`
- `cBTC`
- `cSOL`

`cINIT` and `cUSDC` are especially important because they anchor the cross-chain story:

- bridge on L1;
- claim on Sinergy;
- trade in the appchain;
- optionally redeem back toward the bridged representation.

### 3. `Dark Vault`

Users deposit into a private settlement layer instead of exposing their intent on-chain. This makes the visible footprint minimal while the matcher handles balances, tickets, and settlement logic off-chain.

The vault UI now supports Initia `Auto-sign / Session UX` on `Sinergy-2` for `/minievm.evm.v1.MsgCall`, so repeated vault actions can skip repeated wallet popups after the user grants permission once.

When the deployment exposes the ZK stack, the vault flow now supports a real proof-backed path:

- the web app creates a private note locally using `secret` and `blinding`;
- the deposit commitment is derived from the same `Poseidon(secret, blinding, token, amount)` leaf used by the circuit;
- the matcher stores the note in its private Merkle tree and anchors the resulting root on-chain;
- withdrawals request a dynamically generated `Groth16` proof from the current committed state instead of relying on a fixed proof package.

### 4. `Private Router`

The router has two personalities:

- `Local`: use Sinergy inventory for instant fills
- `DEX-routed`: escalate to real `InitiaDEX` liquidity on L1

That makes the app feel fast for small trades and still relevant for larger ones.

### 5. `InitiaDEX` Liquidity Pull

This is the most hackathon-worthy mechanism in the repo:

- the user stays inside Sinergy;
- the matcher can execute the rebalance against `InitiaDEX` on `initiation-2`;
- the result is settled back into the Sinergy trading flow.

In simple terms:

`user -> Sinergy -> matcher -> InitiaDEX L1 -> matcher -> Sinergy`

## Private Engine Flow

![Sinergy private engine flow](docs/Sinergy_private_engine_flow.png)

## Main Architecture

- `apps/web`
  Main trading app, vault UX, and embedded bridge landing with official `Interwoven Bridge` entry plus direct OPinit deposit flow.
- `apps/bridge`
  Dedicated bridge app for official bridge access, direct deposit to `Sinergy-2`, and claim/redeem of connected assets.
- `services/matcher`
  Private balances, routing, DEX execution, proof-backed ZK withdrawals, and bridge claim/redeem APIs.
- `contracts`
  `DarkPoolVault`, `DarkPoolMarket`, connected tokens, and market contracts.
- `packages/shared`
  Shared ABIs, chain config, and deployment metadata.
- `scripts`
  Rollup startup, public exposure, deployment, and runtime helpers.

## Live Testnet Snapshot

- Rollup: `Sinergy-2`
- L1: `initiation-2`
- Quote token: `cUSDC`
- Connected INIT token: `cINIT`
- Runtime deployment file: [deployments/testnet.json](/home/sari/Sinergy-project/deployments/testnet.json)
- Auto-sign scope: enabled for vault `MsgCall` flows on `Sinergy-2`; bridge deposits on `initiation-2` still use manual confirmation
- Username UX: connected wallets show `.init` when available, with Initia address fallback

Current router-enabled markets:

- `cINIT/cUSDC`
- `cETH/cUSDC`

Current dark-pool markets:

- `cBTC/cUSDC`
- `cSOL/cUSDC`
- `tAAPL/cUSDC`
- `tBOND/cUSDC`
- `tNVDA/cUSDC`

## Fast Demo Startup

If the machine already has the rollup configured, the fastest way to bring the public demo back after a reboot is:

```bash
./scripts/start-testnet-stack.sh
./scripts/public-nginx.sh start
./scripts/cloudflare-tunnel.sh quick
```

Useful checks:

```bash
./scripts/start-testnet-stack.sh status
./scripts/public-nginx.sh status
./scripts/cloudflare-tunnel.sh status
```

What these commands do:

- `start-testnet-stack.sh`
  Restores rollup, executor, relayer, matcher, and frontends.
- `public-nginx.sh start`
  Serves the public app, bridge, API, RPC, and related endpoints.
- `cloudflare-tunnel.sh quick`
  Exposes the stack to the internet without opening router ports.

## Local Development

Install dependencies:

```bash
npm install
```

Start the main web app:

```bash
npm run dev:web
```

Start the dedicated matcher:

```bash
npm run dev:matcher
```

If you want to exercise the ZK withdrawal path locally, compile and prepare the circuit artifacts first:

```bash
npm run zk:compile:withdrawal
npm run zk:setup:withdrawal -- /path/to/powersOfTau.ptau
node scripts/zk/export-withdrawal-vkey-calldata.mjs > .tmp/zk/withdrawal/vkey-calldata.json
```

Then deploy or configure the ZK stack so `deployments/local.json` contains:

- `contracts.zkVault`
- `contracts.stateAnchor`
- `contracts.withdrawalVerifier`

The matcher now expects the compiled circuit files at `.tmp/zk/withdrawal/withdrawal_js/withdrawal.wasm` and `.tmp/zk/withdrawal/withdrawal_final.zkey` unless overridden with:

- `ZK_WITHDRAWAL_WASM_FILE`
- `ZK_WITHDRAWAL_ZKEY_FILE`

For testnet-oriented frontend configs:

```bash
cp apps/web/.env.testnet.example apps/web/.env.testnet
cp apps/bridge/.env.testnet.example apps/bridge/.env.testnet
npm run dev:web:testnet
npm run dev:bridge:testnet
```

In the trading app, users can enable auto-sign from the `Dark Vault` panel. The current setup only grants `MsgCall` permission on `Sinergy-2`, which covers vault interactions while keeping the L1 bridge flow explicitly confirmed.

Sinergy also surfaces Initia usernames for the connected wallet. When a wallet has a registered username on `initiation-2`, the app shows `<name>.init`; otherwise it falls back to the shortened Initia address.

## What Makes The Demo Memorable

- It is an appchain-native product, not just an EVM frontend.
- It uses Initia wallets and bridge semantics, not a generic wallet abstraction.
- It demonstrates connected assets inside a rollup.
- It shows private trading UX on the appchain.
- It can route selected trades to live `InitiaDEX` liquidity.
- It tells a clear story for why appchains on Initia can feel better than isolated rollups or plain L1-only apps.

## Docs

- Architecture: [docs/architecture.md](/home/sari/Sinergy-project/docs/architecture.md)
- Network startup: [docs/network-startup.md](/home/sari/Sinergy-project/docs/network-startup.md)
- Testnet runbook: [docs/testnet-runbook.md](/home/sari/Sinergy-project/docs/testnet-runbook.md)
- InitiaDEX routing: [docs/initia-dex-liquidity-routing.md](/home/sari/Sinergy-project/docs/initia-dex-liquidity-routing.md)
- cUSDC migration: [docs/cusdc-migration.md](/home/sari/Sinergy-project/docs/cusdc-migration.md)
- Implementation plan: [docs/implementation-plan.md](/home/sari/Sinergy-project/docs/implementation-plan.md)

## Current Trust Model

This repo is optimized for a strong hackathon demo and an operable testnet, not for final trust minimization.

Today:

- matching and routing logic live in the matcher;
- some settlement logic is off-chain;
- the private router is operational, but not fully trustless end-to-end;
- the product already proves the UX and architecture thesis.

That is enough to demonstrate the main idea:

**Sinergy can bring private trading UX and real Initia liquidity together inside one appchain product.**
