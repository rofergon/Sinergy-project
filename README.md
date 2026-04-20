# Sinergy

Sinergy is an agent-powered private trading appchain built natively on Initia.

It transforms natural-language trading intents into validated, secure executions. By combining an AI strategy agent, privacy-preserving infrastructure, and native Initia liquidity routing, Sinergy offers a seamless, next-generation DeFi experience tailored for the Initia ecosystem.

At its core, Sinergy is about making advanced trading feel simple without forcing users to expose their full intent on public rails. Instead of broadcasting strategy logic, order flow, and execution decisions to an open orderbook, Sinergy keeps sensitive trading coordination inside a private execution layer while still anchoring custody and settlement guarantees on `Sinergy-2`.

## How It Works

![Sinergy agentic strategy flow](docs/AgentFlow.png)

1. **Natural Language Input**: Users connect their wallet via `InterwovenKit` and describe their trading strategy in plain language.
2. **Contextual Awareness**: The agent input layer automatically builds the necessary prompt payload with real-time market and timeframe context.
3. **AI Strategy Generation**: The AI agent interprets the request, drafts the strategy constraints, and orchestrates necessary trading tools.
4. **Validation & Backtesting**: The system strictly validates rules and runs historical backtesting to ensure the strategy behaves as intended *before* any capital is deployed.
5. **Private Settlement**: Approved execution state is anchored securely and privately on our `Sinergy-2` MiniEVM rollup.
6. **Smart Routing**: When needed, the private matcher can seamlessly source deep liquidity from `InitiaDEX` and the broader Initia L1 (`initiation-2`).

## Why Privacy Matters in Sinergy

Most on-chain trading systems leak valuable information before a trade is fully complete: user intent, order timing, portfolio positioning, and routing behavior can all become visible to external observers. Sinergy is designed to reduce that leakage.

Our privacy model keeps:

- **Order flow private** so user strategies are not posted to a public on-chain orderbook.
- **Execution coordination private** so matching and routing logic happen away from public mempool-style observation.
- **Settlement verifiable** by anchoring the resulting state and custody flows on `Sinergy-2`.
- **Liquidity composable** by routing to `InitiaDEX` and `Initia L1` only when external liquidity is actually needed.

This gives users a better default trading experience: less strategy leakage, less signaling to the market, and a stronger path toward confidential DeFi execution on Initia.

## Why We Built This for the Initiate Hackathon

Sinergy was designed from the ground up to showcase the unique capabilities of the Initia network. Rather than porting a generic EVM application, we built an **appchain-native product** that deeply integrates Initia primitives to support privacy-first trading UX:

- **InterwovenKit** for a fluid, Initia-native wallet connection and signing UX.
- **MiniEVM** on `Sinergy-2` customized for private trading execution.
- **Connected Assets** seamlessly utilizing `cINIT`, `cUSDC`, `cETH`, `cBTC`, and `cSOL`.
- **OPinit Bridge** infrastructure for robust cross-chain interoperability.
- **Native Interoperability** via direct liquidity routing through `InitiaDEX`.

Sinergy also natively surfaces Initia usernames for connected wallets. When a wallet has a registered username on `initiation-2`, the app displays `<name>.init`, falling back to the shortened address if not.

## Core Architecture Components

- **Agent Layer**: Translates natural-language strategy intent into an executable plan, complete with validation and repair loops.
- **Dark Vault**: Secures user funds within the settlement flow while minimizing the on-chain footprint and exposure of trading intent.
- **Private Matcher & Router**: Handles private balances, executes local fills, and arbitrates external liquidity routing.
- **Bridge-Backed Assets**: Natively operates using Initia-connected bridging standards.

## Live Testnet Snapshot

- **Rollup**: `Sinergy-2`
- **L1**: `initiation-2`
- **Connected assets**: `cINIT`, `cUSDC`, `cETH`, `cBTC`, `cSOL`
- **Router-enabled markets**: `cINIT/cUSDC`, `cETH/cUSDC`
- **Dark-pool markets**: `cBTC/cUSDC`, `cSOL/cUSDC`, `tAAPL/cUSDC`, `tBOND/cUSDC`, `tNVDA/cUSDC`
- **Runtime deployment file**: [deployments/testnet.json](/Sinergy-project/deployments/testnet.json)

---

## Local Development & Evaluation Guide

For judges and developers evaluating Sinergy locally, follow these steps to run the environment.

### Fast Demo Startup

If the machine already has the rollup configured, the fastest way to bring the public demo back after a reboot is:

```bash
./scripts/start-testnet-stack.sh
./scripts/public-nginx.sh start
./scripts/cloudflare-tunnel.sh quick
```

Useful health checks:

```bash
./scripts/start-testnet-stack.sh status
./scripts/public-nginx.sh status
./scripts/cloudflare-tunnel.sh status
```

What these commands do:
- `start-testnet-stack.sh`: Restores the rollup, executor, relayer, matcher, and frontends.
- `public-nginx.sh start`: Serves the public app, bridge, API, RPC, and related endpoints.
- `cloudflare-tunnel.sh quick`: Exposes the stack to the internet without opening router ports.


# Restart all services (stop + start)
./scripts/restart-testnet-stack.sh

# Stop all services
./scripts/restart-testnet-stack.sh stop

# Start all services
./scripts/restart-testnet-stack.sh start

# Check status
./scripts/restart-testnet-stack.sh status

### Manual Setup & Source Build

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

Start the strategy agent:

```bash
npm run dev:strategy-agent
```

#### Strategy Agent Configuration

The Strategy Agent uses OpenAI's GPT-5.4-nano model by default. To configure it:

1. Copy the example environment file:
```bash
cp services/strategy-agent/.env.example services/strategy-agent/.env
```

2. Add your OpenAI API key to `services/strategy-agent/.env`:
```bash
AGENT_MODEL_API_KEY=sk-your-openai-api-key-here
```

3. Configure the reasoning effort for GPT-5.4-nano:
```bash
AGENT_MODEL_REASONING_EFFORT=low
```

Available reasoning levels:
- `none`: No reasoning, fastest and cheapest
- `low`: Minimal reasoning (recommended for gpt-5.4-nano)
- `medium`: Balanced reasoning (default)
- `high`: More thorough reasoning
- `xhigh`: Maximum reasoning depth

The agent supports any OpenAI-compatible API endpoint and model.

#### ZK Architecture Support

If you want to exercise the ZK withdrawal path locally, compile and prepare the circuit artifacts first:

```bash
npm run zk:compile:withdrawal
npm run zk:setup:withdrawal -- /path/to/powersOfTau.ptau
node scripts/zk/export-withdrawal-vkey-calldata.mjs > .tmp/zk/withdrawal/vkey-calldata.json
```

The source for this proof system lives in [`circuits/`](circuits), currently with [`circuits/withdrawal.circom`](circuits/withdrawal.circom) as the main withdrawal circuit. This file defines the private statement proven during a withdrawal: a note exists in the committed Merkle tree, it matches the requested `token` and `amount`, the prover knows the note secret, and the derived `nullifier` prevents double withdrawal. In practice, this directory is the cryptographic source of truth for the Groth16 withdrawal flow used by the matcher and verified on-chain by `DarkVaultV2`.

Then deploy or configure the ZK stack so `deployments/local.json` contains:
- `contracts.zkVault`
- `contracts.stateAnchor`
- `contracts.withdrawalVerifier`

The matcher expects the compiled circuit files at `.tmp/zk/withdrawal/withdrawal_js/withdrawal.wasm` and `.tmp/zk/withdrawal/withdrawal_final.zkey` unless overridden with `ZK_WITHDRAWAL_WASM_FILE` and `ZK_WITHDRAWAL_ZKEY_FILE`.

#### Local Strategy Execution Contract

The local `StrategyExecutor` contract used for onchain strategy approval consumption is currently deployed at:

- `0x3Db7923385663Fd3410db197AE794ce861Cb7D75`

This address is also recorded in [deployments/local.json](deployments/local.json) under `contracts.strategyExecutor`.

To redeploy just this contract without resetting the rest of the local stack:

```bash
./scripts/deploy-strategy-executor.sh
```

#### Testnet Configuration

For testnet-oriented frontend configurations:

```bash
cp apps/web/.env.testnet.example apps/web/.env.testnet
cp apps/bridge/.env.testnet.example apps/bridge/.env.testnet
npm run dev:web:testnet
npm run dev:bridge:testnet
```

Users can enable auto-sign from the **Dark Vault** panel. The current setup strictly grants `MsgCall` permission on `Sinergy-2`, covering vault interactions while keeping the L1 bridge flow explicitly user-confirmed for safety.

## Documentation Reference

Dive deeper into Sinergy's technical design:
- **Architecture**: [docs/architecture.md](docs/architecture.md)
- **Automatic Strategy Execution**: [docs/automatic-strategy-execution.md](docs/automatic-strategy-execution.md)
- **Network Startup**: [docs/network-startup.md](docs/network-startup.md)
- **Recent Price Patch**: [docs/price-patch-runbook.md](docs/price-patch-runbook.md)
- **Testnet Runbook**: [docs/testnet-runbook.md](docs/testnet-runbook.md)
- **InitiaDEX Routing**: [docs/initia-dex-liquidity-routing.md](docs/initia-dex-liquidity-routing.md)
- **cUSDC Migration**: [docs/cusdc-migration.md](docs/cusdc-migration.md)
- **Implementation Plan**: [docs/implementation-plan.md](docs/implementation-plan.md)
