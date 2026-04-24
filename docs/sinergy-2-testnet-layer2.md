# Sinergy-2 Testnet Layer 2

This document explains how the Sinergy Layer 2 testnet is created, configured,
deployed, and operated in this repository.

## Summary

`Sinergy-2` is a MiniEVM Initia rollup running as a testnet Layer 2 on top of
Initia testnet L1 `initiation-2`. The app uses the rollup for private trading
settlement, EVM contract execution, bridged asset accounting, and InterwovenKit
wallet flows.

The canonical runtime deployment file for the live testnet is:

- `deployments/testnet.json`

The local Weave/Minitia runtime artifact that records how the rollup was
created is:

- `~/.minitia/artifacts/config.json`


## Chain Configuration

The active testnet deployment is configured with these values:

| Field | Value |
| --- | --- |
| Network name | `Sinergy Testnet` |
| VM | MiniEVM |
| Rollup chain ID | `Sinergy-2` |
| L1 chain ID | `initiation-2` |
| EVM chain ID | `1716124615666775` |
| EVM chain ID hex | `0x618ce661b6c57` |
| Native gas denom | `GAS` |
| Native currency decimals | `18` |
| OPinit bridge ID | `1735` |

The local Weave artifact also records:

| Field | Value |
| --- | --- |
| L1 RPC | `https://rpc.testnet.initia.xyz:443` |
| L1 gas prices | `0.015uinit` |
| L2 moniker | `operator` |
| Block max bytes | `22020096` |
| Block max gas | `100000000` |
| Output submission interval | `1m0s` |
| Output finalization period | `168h0m0s` |
| Output submission start height | `1` |
| Batch submission target | `INITIA` |
| Oracle | enabled |

The local genesis file confirms `chain_id: "Sinergy-2"` and includes the EVM,
OP child, oracle, IBC, transfer, fee, marketmap, and Initia-specific app modules.

## Public and Local Endpoints

`deployments/testnet.json` points the testnet app to LAN-hosted endpoints:

| Endpoint | URL |
| --- | --- |
| EVM JSON-RPC | `http://192.168.1.14:8545` |
| EVM WebSocket | `ws://192.168.1.14:8546` |
| Tendermint RPC | `http://192.168.1.14:26657` |
| REST | `http://192.168.1.14:1317` |
| Explorer | `https://scan.testnet.initia.xyz` |
| Explorer tx template | `https://scan.testnet.initia.xyz/initiation-2/txs/{txHash}` |

The repo also defines the local default endpoints in `packages/shared/src/chain.ts`:

| Endpoint | URL |
| --- | --- |
| EVM JSON-RPC | `http://127.0.0.1:8545` |
| EVM WebSocket | `ws://127.0.0.1:8546` |
| Tendermint RPC | `http://127.0.0.1:26657` |
| REST | `http://127.0.0.1:1317` |

For public demos, `scripts/public-nginx.sh` builds the web and bridge apps and
serves them behind an Nginx container. It exposes these public host roles:

- `app`: web app
- `bridge`: bridge app
- `api`: matcher API on port `8787`
- `rpc`: EVM JSON-RPC on port `8545`
- `ws`: EVM WebSocket on port `8546`
- `rest`: rollup REST on port `1317`
- `tm`: Tendermint RPC on port `26657`
- `indexer`: currently proxied to rollup REST on port `1317`

For temporary internet access, `scripts/cloudflare-tunnel.sh quick` starts a
Cloudflare quick tunnel to the local Nginx origin.

## OPinit Bridge

The rollup is connected to Initia L1 through OPinit with bridge ID `1735`.

Runtime components:

- L1: `initiation-2`
- L2: `Sinergy-2`
- Relayer container: `weave-relayer`
- Executor service: `opinitd.executor.service`
- Rollup service: `minitiad.service`

The stack scripts use Weave to start or restart these components:

```bash
weave rollup start --detach
weave opinit restart executor || weave opinit start executor --detach
weave relayer start --detach
```

The matcher can enforce bridge health using:

- `RELAYER_HEALTH_URL`
- `OPINIT_HEALTH_URL`
- `OPINIT_BRIDGE_ID`
- `BRIDGE_REQUIRE_RELAYER=true`

## Deployed Contracts

The live testnet deployment records these EVM contracts:

| Contract | Address |
| --- | --- |
| `DarkPoolVault` | `0x3fF37bE2C8B8179cBfd97CB1e75fEd91e5e38B19` |
| `DarkPoolMarket` | `0xe1d9c4EcC2ba58274733C61Fb25919F0eA902575` |
| `ConnectedQuoteToken` / cUSDC | `0x6Ef1eB5AE5C6824F8B6ECA81E2DB193966D95967` |
| `StrategyExecutor` | `0x0000000000000000000000000000000000000000` |

The submission metadata in `.initia/submission.json` identifies the primary
deployed address as the vault:

```json
{
  "rollup_chain_id": "Sinergy-2",
  "vm": "evm",
  "deployed_address": "0x3fF37bE2C8B8179cBfd97CB1e75fEd91e5e38B19",
  "native_feature": "interwoven-bridge"
}
```

## Assets

The testnet deployment configures these rollup assets:

| Symbol | Name | Kind | Decimals | Address |
| --- | --- | --- | --- | --- |
| `cBTC` | Connected Bitcoin | crypto | 18 | `0x42f1F334493f23B40294D4827eB36704bCdd2229` |
| `cETH` | Connected Ether | crypto | 18 | `0x76Ada1d256D45806EF736B0F3CDb15c90188AFe6` |
| `cUSDC` | Connected USD Coin | quote | 6 | `0x6Ef1eB5AE5C6824F8B6ECA81E2DB193966D95967` |
| `cINIT` | Connected Initia | crypto | 18 | `0x308B830b96998E9080616C504C7562473E2d85df` |
| `cSOL` | Connected Solana | crypto | 18 | `0x84cE03F22F07E5F8813b0629c110E06D9BBBA142` |
| `tAAPL` | Tokenized Apple | rwa | 18 | `0xc7bcA502bCeBb25b1CFf139aeD86DE2639a922D7` |
| `tBOND` | Tokenized Treasury Bond | rwa | 18 | `0x910a546A1763C38dcf352cfdB6e752b3DBDAb029` |
| `tNVDA` | Tokenized Nvidia | rwa | 18 | `0xCBA194D6576379CfebA944cB696Be34F20e8a987` |

Bridge-backed assets in the deployment:

| Rollup asset | L1 source chain | L1 denom | L1 symbol | Destination denom |
| --- | --- | --- | --- | --- |
| `cUSDC` | `initiation-2` | `uusdc` | `USDC` | `l2/57a38da2740f206b92f5d853951f2072982ee11aa8aeeefdab63aa6550a51bb2` |
| `cINIT` | `initiation-2` | `uinit` | `INIT` | `l2/7835b9ce5f65720a12cd653306cfe00afb93dcf1b73e69eb5eeddc568fc455cf` |

## Contract Deployment Flow

`scripts/deploy-testnet.sh` is a thin testnet wrapper around
`scripts/deploy-local.sh`. It sets testnet defaults and then executes the shared
deployment script.

The deployment script performs the following sequence:

1. Resolve network values, deployment output path, signer key names, and rollup
   endpoints.
2. Build Solidity contracts with Foundry:

   ```bash
   forge build
   ```

3. Derive the matcher EVM address from `MATCHER_PRIVATE_KEY`.
4. Resolve the gas station Bech32 address from the local `minitiad` keyring.
5. Fund the matcher signer on `Sinergy-2` with native `GAS`.
6. Extract bytecode from Foundry artifacts.
7. Deploy contracts using MiniEVM:

   ```bash
   minitiad tx evm create <bytecode-file> \
     --input <constructor-calldata> \
     --from gas-station \
     --keyring-backend test \
     --chain-id Sinergy-2 \
     --node <tendermint-rpc> \
     --gas 5000000 \
     --broadcast-mode sync \
     --yes
   ```

8. Resolve each deployed contract address from the `contract_created` event.
9. Configure `DarkPoolVault` supported tokens.
10. Configure `DarkPoolMarket` markets.
11. Transfer ownership of connected/quote assets to the matcher signer.
12. Write the deployment JSON file.
13. Write the matcher environment file.

The deployment script writes temporary bytecode files into `.tmp/deploy`.
Those files are generated artifacts and should not be committed.

## Runtime Services

The testnet stack is started with:

```bash
./scripts/start-testnet-stack.sh
```

It starts or verifies:

| Component | Runtime |
| --- | --- |
| Rollup node | `minitiad.service` via `weave rollup start --detach` |
| OPinit executor | `opinitd.executor.service` via Weave |
| Relayer | Docker container `weave-relayer` |
| Matcher API | user systemd service `sinergy-matcher.service` |
| Strategy agent | background process on port `8790` |
| Web app | Vite dev server on port `5173` |
| Bridge app | Vite dev server on port `5174` |

Useful commands:

```bash
./scripts/start-testnet-stack.sh status
./scripts/restart-testnet-stack.sh
./scripts/restart-testnet-stack.sh stop
./scripts/restart-testnet-stack.sh start
./scripts/restart-testnet-stack.sh status
```

The matcher service is generated as a user-level systemd unit. It runs from
`services/matcher` and loads `.env.testnet` before executing:

```bash
node --import tsx src/index.ts
```

## Frontend Integration

Both `apps/web` and `apps/bridge` load `deployments/testnet.json` when:

```bash
VITE_DEPLOYMENT_ENV=testnet
```

The shared chain helper converts the deployment into a Wagmi/Viem EVM chain:

- chain ID: `1716124615666775`
- RPC: `deployment.network.rpcUrl`
- WebSocket: `deployment.network.wsUrl`
- native currency: `GAS`

The Initia wallet integration builds an InterwovenKit custom chain with:

- `chain_id: "Sinergy-2"`
- `network_type: "testnet"`
- `bech32_prefix: "init"`
- `metadata.minitia.type: "minievm"`
- REST, Tendermint RPC, EVM JSON-RPC, EVM WebSocket, and indexer API entries

The provider setup uses:

1. `WagmiProvider`
2. `QueryClientProvider`
3. `InterwovenKitProvider`

It spreads the Initia `TESTNET` preset and passes both:

```tsx
customChain={customChain}
customChains={[customChain]}
```

Auto-sign is enabled only for MiniEVM `MsgCall` on `Sinergy-2`:

```tsx
enableAutoSign={{
  [SINERGY_ROLLUP_CHAIN_ID]: ["/minievm.evm.v1.MsgCall"],
}}
```

Bridge defaults are derived from bridge-backed token metadata. By default, the
frontend bridges from `initiation-2` using `uinit` unless the selected asset
overrides that source denom.

## Environment Files

Frontend testnet example files:

- `apps/web/.env.testnet.example`
- `apps/bridge/.env.testnet.example`

These define public URLs for:

- matcher API
- Tendermint RPC
- REST
- indexer
- EVM JSON-RPC
- EVM WebSocket
- bridge source chain and denom

Matcher testnet example:

- `services/matcher/.env.testnet.example`

The matcher requires a private EVM signer in `MATCHER_PRIVATE_KEY`. Keep the
real `.env.testnet` private and never commit it.

## Public Demo Deployment

A typical public testnet demo startup is:

```bash
./scripts/start-testnet-stack.sh
./scripts/public-nginx.sh start
./scripts/cloudflare-tunnel.sh quick
```

`public-nginx.sh` can also serve a stable domain if `PUBLIC_ROOT_DOMAIN` and
host overrides are provided. Without a domain, it can derive an `sslip.io` root
domain from the machine public IP.

Health/status commands:

```bash
./scripts/start-testnet-stack.sh status
./scripts/public-nginx.sh status
./scripts/cloudflare-tunnel.sh status
```

## Operational Notes

- The rollup runtime is Weave-managed.
- The L2 app home is under `~/.minitia`.
- The rollup exposes REST on `1317`, Tendermint RPC on `26657`, EVM JSON-RPC on
  `8545`, and EVM WebSocket on `8546`.
- The matcher API runs on `8787`.
- Public reverse proxying is containerized with Nginx.
- Temporary public exposure is containerized with Cloudflare Tunnel.
- The repo stores deployment addresses in JSON, not in source constants.
- Local Weave artifacts and matcher `.env` files contain secrets and must stay
  outside version control.

