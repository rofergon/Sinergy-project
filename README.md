# Sinergy

Sinergy is an agent-powered private trading appchain on Initia.

For the hackathon, the core story is simple: a user describes a trading strategy in natural language, the Sinergy agent prepares and validates that strategy, and execution settles on `Sinergy-2` with optional access to real `InitiaDEX` liquidity.

## Hackathon Pitch

**Sinergy turns natural-language trading intent into validated execution on Initia.**

What makes it stand out:

- an AI strategy agent is part of the product, not just an extra chatbot;
- strategy ideas can be interpreted, checked, repaired, and backtested before settlement;
- execution happens on an Initia-native `MiniEVM` rollup;
- the app can use local private inventory or route to `InitiaDEX` liquidity when needed;
- wallet, bridge, and settlement flow are designed around Initia primitives.

## Agent Flow

![Sinergy agentic strategy flow](docs/AgentFlow.png)

The flow shown above is the strongest way to explain Sinergy in a demo:

1. The user connects a wallet and describes a strategy in plain language.
2. The agent input layer builds the prompt payload with market and timeframe context.
3. The AI strategy agent interprets the request, drafts the strategy, and orchestrates tools.
4. The system validates rules and runs backtesting before anything is deployed.
5. Approved execution state is anchored on `Sinergy-2`.
6. If needed, liquidity can be sourced from `InitiaDEX` and the broader Initia L1.

## Why It Is Strong For A Hackathon

- it has a clear user story: "say the strategy, validate it, execute it";
- it combines AI, trading, privacy, and appchain infrastructure in one product;
- it is easy to demo visually with one diagram and one end-to-end flow;
- it uses real Initia components instead of a generic EVM stack.

## Why It Fits Initia

Sinergy is built around Initia-native pieces:

- `InterwovenKit` for wallet connection and signing UX;
- `MiniEVM` on `Sinergy-2` for appchain execution;
- connected assets like `cINIT` and `cUSDC`;
- `OPinit` bridge infrastructure;
- optional liquidity access through `InitiaDEX` on `initiation-2`.

This makes the product feel like an Initia app first, not a generic app ported onto Initia later.

## Demo Path

For a short competition demo, the cleanest storyline is:

1. Connect the wallet with `InterwovenKit`.
2. Show the user entering a strategy request in natural language.
3. Explain how the agent adds market context, rules, and validation steps.
4. Show the backtest and verification stage.
5. Show settlement on `Sinergy-2`.
6. Highlight that larger execution can optionally route into `InitiaDEX`.

## Product Components

- `Agent layer`
  Turns natural-language strategy intent into an executable plan with validation and repair loops.
- `Dark Vault`
  Keeps funds in the settlement flow while reducing on-chain exposure of trading intent.
- `Private matcher/router`
  Handles private balances, local fills, and optional external liquidity routing.
- `Bridge-backed assets`
  Uses Initia-connected assets like `cINIT`, `cUSDC`, `cETH`, `cBTC`, and `cSOL`.

## Live Testnet Snapshot

- Rollup: `Sinergy-2`
- L1: `initiation-2`
- Connected assets: `cINIT`, `cUSDC`, `cETH`, `cBTC`, `cSOL`
- Router-enabled markets: `cINIT/cUSDC`, `cETH/cUSDC`
- Dark-pool markets: `cBTC/cUSDC`, `cSOL/cUSDC`, `tAAPL/cUSDC`, `tBOND/cUSDC`, `tNVDA/cUSDC`
- Runtime deployment file: [deployments/testnet.json](/home/sari/Sinergy-project/deployments/testnet.json)

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
