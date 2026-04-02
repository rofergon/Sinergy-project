# Testnet Runbook

## In Simple Terms

This document explains how to run `Sinergy` on a real testnet without mixing that environment with the local workflow. It is the practical guide for getting contracts, services, and endpoints ready for external testing.

## When To Read This Document

Read this once the overall plan is clear and you want to execute the concrete steps to bring the stack up on testnet.

## What To Remember

- The separation between `local` and `testnet` is an important part of the workflow, not a small detail.
- First configure files and contracts, then bring up services and public endpoints.
- The expected result is a usable testnet from wallet and frontend, not just running services.

## Goal

Run `Sinergy` against an operable testnet rollup without affecting the local workflow.

## 1. Prepare Base Files

1. complete [deployments/testnet.json](../deployments/testnet.json)
2. copy the templates:
   - `cp apps/web/.env.testnet.example apps/web/.env.testnet`
   - `cp apps/bridge/.env.testnet.example apps/bridge/.env.testnet`
   - `cp services/matcher/.env.testnet.example services/matcher/.env.testnet`
3. replace all `TODO_*` values

## 2. Deploy Contracts To The Testnet Rollup

Use the wrapper:

```bash
./scripts/deploy-testnet.sh
```

Minimum variables you should override:

```bash
NETWORK_NAME="Sinergy Testnet"
ROLLUP_CHAIN_ID="TU_ROLLUP_CHAIN_ID"
TENDERMINT_RPC_URL="https://TU_TENDERMINT_RPC"
JSON_RPC_URL="https://TU_JSON_RPC"
WS_URL="wss://TU_EVM_WS"
REST_URL="https://TU_REST"
EVM_CHAIN_ID="TU_CHAIN_ID_NUMERICO"
EVM_CHAIN_ID_HEX="TU_CHAIN_ID_HEX"
EXPLORER_URL="https://TU_EXPLORER"
MATCHER_PRIVATE_KEY="0x..."
./scripts/deploy-testnet.sh
```

This updates:

1. [deployments/testnet.json](../deployments/testnet.json)
2. `services/matcher/.env.testnet`

## 3. Start Services In Testnet

### Matcher

```bash
npm run dev:matcher:testnet
```

### Web

```bash
npm run dev:web:testnet
```

### Bridge

```bash
npm run dev:bridge:testnet
```

## 4. Expose The Stack To The Internet

1. start the base stack:

```bash
./scripts/start-testnet-stack.sh
```

2. start the Nginx proxy in Docker:

```bash
./scripts/public-nginx.sh start
```

That script:

1. builds `web` and `bridge` in `testnet` mode
2. serves those static builds from Nginx
3. reverse-proxies `matcher`, `rpc`, `ws`, `rest`, and `tm`

3. inspect the computed hosts:

```bash
./scripts/public-nginx.sh print-env
```

4. if the machine is behind a router/NAT, forward:
   - `80 -> 192.168.1.14:8080`
   - `443 -> 192.168.1.14:8443`

5. request a certificate once DNS resolves to your public IP:

```bash
LETSENCRYPT_EMAIL=you@example.com ./scripts/request-public-cert.sh
```

6. update your testnet env files to use:
   - `https://app.<root>`
   - `https://bridge.<root>`
   - `https://api.<root>`
   - `https://rpc.<root>`
   - `wss://ws.<root>`
   - `https://rest.<root>`
   - `https://tm.<root>`
   - `https://indexer.<root>`

## 5. Expose Without Opening Router Ports

If you do not want to touch the router, use Cloudflare Tunnel:

```bash
./scripts/cloudflare-tunnel.sh quick
```

This creates a `https://<random>.trycloudflare.com` URL and publishes:

1. app at `/`
2. matcher at `/api`
3. EVM JSON-RPC at `/rpc`
4. Cosmos REST at `/rest`
5. Tendermint RPC at `/tm`
6. indexer path at `/indexer`
7. EVM websocket at `/ws`

Useful commands:

```bash
./scripts/cloudflare-tunnel.sh status
./scripts/cloudflare-tunnel.sh stop
```

If you later want your own domain and stable hostnames in Cloudflare:

```bash
CF_TUNNEL_TOKEN=... ./scripts/cloudflare-tunnel.sh named
```

## 6. Minimum Verification

1. matcher starts with `DEPLOYMENT_FILE=../../deployments/testnet.json`
2. `GET /health` responds
3. `GET /bridge/status` reflects real OPinit/relayer health
4. `web` connects the wallet and resolves the `customChain`
5. `bridge` opens the official flow with the configured defaults

## 7. Exit Criteria

Testnet is considered “operable” when:

1. you can connect a wallet
2. you can deposit into `DarkPoolVault`
3. you can submit orders or swaps
4. matcher can sign withdrawals
5. the frontend no longer depends on `localhost`
6. MetaMask or Coinbase Wallet accept `https://rpc.<root>`
