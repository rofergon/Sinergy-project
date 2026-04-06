# Sinergy-2 Appchain Deployment & Hosting Runbook

This runbook outlines the operational criteria for deploying the Sinergy stack against a live testnet environment. It provides step-by-step instructions for smart contract deployment, service bootstrapping, and exposing internal appchain endpoints to public users securely without disrupting localized workflows.

---

## 1. Environment Preparation

Before deploying the contracts or starting the services, establish the baseline environment configuration for the testnet target.

1. **Deployment Ledger**: Complete the registry parameters in `deployments/testnet.json`.
2. **Environment Synchronization**: Generate the target `.env` configurations from provided templates:
   ```bash
   cp apps/web/.env.testnet.example apps/web/.env.testnet
   cp apps/bridge/.env.testnet.example apps/bridge/.env.testnet
   cp services/matcher/.env.testnet.example services/matcher/.env.testnet
   ```
3. **Variable Injection**: Replace all `TODO_*` placeholder variables with verifiable operational values (e.g., specific L1 bridge IDs, EVM chain IDs).

---

## 2. Smart Contract Rollout

Deploy the foundational `ZKVault` and `DarkPoolMarket` contracts onto the testnet rollup using the deterministic deployment wrapper:

```bash
./scripts/deploy-testnet.sh
```

**Required Runtime Overrides:**
To ensure accurate topology routing, supply the following parameters to the script:
```bash
NETWORK_NAME="Sinergy Testnet"
ROLLUP_CHAIN_ID="Sinergy-2"
TENDERMINT_RPC_URL="https://rpc..."
JSON_RPC_URL="https://evm-rpc..."
WS_URL="wss://evm-ws..."
REST_URL="https://rest..."
EVM_CHAIN_ID="<NUMERIC_ID>"
EVM_CHAIN_ID_HEX="<HEX_ID>"
EXPLORER_URL="https://explorer..."
MATCHER_PRIVATE_KEY="0x..."
./scripts/deploy-testnet.sh
```

*Note: Execution will automatically sync state outputs back into `deployments/testnet.json` and `services/matcher/.env.testnet`.*

---

## 3. Core Service Bootstrap

Initiate the primary services running against the testnet variables. It is recommended to run these inside detached sessions (`tmux`, `screen`, or systemd) if persisting the demo environment.

**Matcher Service:**
```bash
npm run dev:matcher:testnet
```

**Next.js Frontend:**
```bash
npm run dev:web:testnet
```

**OPinit Bridge Interface:**
```bash
npm run dev:bridge:testnet
```

---

## 4. Public Ingress & Reverse Proxy (Nginx)

To provide access to judges or users without sharing direct port strings, Sinergy utilizes an NGinx reverse proxy container to unify all endpoints.

**Initialization:**
1. Start the underlying operational stack:
   ```bash
   ./scripts/start-testnet-stack.sh
   ```
2. Spawn the Nginx Edge gateway:
   ```bash
   ./scripts/public-nginx.sh start
   ```

**Routing Behavior:**
The Nginx layer builds the static clients (web, bridge) in testnet mode and strictly reverse-proxies the backend capabilities:
- Frontend static hosting
- Matcher API
- JSON-RPC and EVM WebSockets
- Cosmos REST and Tendermint RPC

**DNS & SSL Automation:**
Once DNS A-records are propagated to your server's ingress IP, generate zero-downtime Let's Encrypt certificates:
```bash
LETSENCRYPT_EMAIL=you@example.com ./scripts/request-public-cert.sh
```

Ensure your `.env.testnet` files point to the secure domains: `https://app.<root>`, `https://api.<root>`, `wss://ws.<root>`, etc.

---

## 5. Zero-Trust Tunneling (Cloudflare)

If port forwarding (`80`/`443`) is impossible due to NATs, firewalls, or lack of static IP ranges, use the bundled Cloudflare Tunnel integration.

**Ephemeral Public Gateway:**
```bash
./scripts/cloudflare-tunnel.sh quick
```
This generates a temporary `https://<random>.trycloudflare.com` edge endpoint, orchestrating:
1. `/*` -> App Frontend
2. `/api` -> Matcher
3. `/rpc` -> EVM JSON-RPC
4. `/rest` -> Cosmos REST
5. `/tm` -> Tendermint RPC
6. `/ws` -> EVM WebSocket

**Persistent Edge Access:**
For a stable domain configuration on Cloudflare:
```bash
CF_TUNNEL_TOKEN=... ./scripts/cloudflare-tunnel.sh named
```

**Tunnel Operations:**
```bash
./scripts/cloudflare-tunnel.sh status
./scripts/cloudflare-tunnel.sh stop
```

---

## 6. End-to-End Validation Criteria

The testnet node is considered fully functional and ready for judges/end-users when:

1. **Environment State**: The matcher boots gracefully using the anchor file `DEPLOYMENT_FILE=../../deployments/testnet.json`.
2. **Network Liveness**: `GET /health` requests yield sequential successes.
3. **Cross-Chain Discovery**: `GET /bridge/status` actively reflects healthy synchronization with the OPinit relayer index.
4. **Wallet Integrity**: EVM wallets smoothly auto-add the `Sinergy Testnet` via the exposed JSON-RPC edge without internal `localhost` dependencies.
5. **Private Settlement**: ZKVault deposits, order matchings, and withdrawal signature flows complete instantaneously on the frontend without blocking errors.
