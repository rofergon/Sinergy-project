# Sinergy Dark RWA Market

Minimal viable RWA market on the Initia appchain `Sinergy-2` using:

- `Foundry` for EVM contracts
- `Vite + React + InterwovenKit` for wallet UX on Initia
- `viem` for ABI encoding and EVM utilities in the frontend
- `Fastify + viem` for the matcher backend
- `minitiad` for local deployment on `MiniEVM`

## Network Context

- Rollup chain id: `Sinergy-2`
- L1: `initiation-2`
- Gas denom: `GAS`
- EVM RPC: `http://127.0.0.1:8545`
- EVM WS: `ws://127.0.0.1:8546`
- Tendermint RPC: `http://127.0.0.1:26657`
- REST: `http://127.0.0.1:1317`

## Structure

```text
contracts/         Foundry contracts
apps/web/          Vite frontend
services/matcher/  Matching, pricing, and withdrawal-ticket backend
packages/shared/   ABIs, chain config, and shared types
docs/              Architecture and roadmap
deployments/       Deployed local addresses
scripts/           Deployment and export utilities
```

## Included Contracts

- `ConnectedQuoteToken` (`cUSDC`, bridge-backed quote token on the live testnet)
- `RwaShareToken`
- `DarkPoolVault`
- `DarkPoolMarket`

## Locally Deployed Addresses

Current deployment on `Sinergy-2`:

- `Matcher signer`: `0x6eC8AcC95Da5f752eCeAB1c214C1b62080023283`
- `DarkPoolVault`: `0x3fF37bE2C8B8179cBfd97CB1e75fEd91e5e38B19`
- `DarkPoolMarket`: `0xe1d9c4EcC2ba58274733C61Fb25919F0eA902575`
- `cUSDC`: `0x6Ef1eB5AE5C6824F8B6ECA81E2DB193966D95967`
- `tAAPL`: `0xc7bcA502bCeBb25b1CFf139aeD86DE2639a922D7`
- `tBOND`: `0x910a546A1763C38dcf352cfdB6e752b3DBDAb029`
- `tNVDA`: `0xCBA194D6576379CfebA944cB696Be34F20e8a987`

Runtime source of truth:

- [deployments/local.json](/home/sari/Sinergy-project/deployments/local.json)
- Quote-token migration notes: [cusdc-migration.md](/home/sari/Sinergy-project/docs/cusdc-migration.md)

## MVP Flow

1. The user connects a wallet through `InterwovenKit`.
2. The frontend sends MiniEVM `MsgCall` messages for `approve`, `deposit`, and `withdraw`.
3. The frontend decodes EVM logs from the `MsgCall` response and syncs the vault with `matcher-service`.
4. The backend maintains internal balances and a private order book.
5. Orders are matched off-chain with price-band guards.
6. Withdrawals require an EIP-712 ticket signed by the matcher.
7. Matching batches can be anchored in `DarkPoolMarket`.

This flow previously used `walletClient.writeContract(...)` through `wagmi`.
Now wallet UX and transaction submission live in `InterwovenKit`, while the EVM contracts remain unchanged.

## New Crypto Assets for the Hackathon

The matcher already supports a hybrid pricing model:

- RWAs through `Twelve Data`
- Crypto through `Initia Connect Oracle`

It also now exposes a `Private Router` path for crypto swaps:

- instant local fills when protocol inventory is healthy;
- async rebalance jobs when Initia L1 liquidity is needed;
- strict gating so only canonical, bridgeable assets can claim `InitiaDEX`-backed routing.

Current `InitiaDEX`-backed router-enabled markets in this repo:

- `cINIT/cUSDC` -> mapped to the live `INIT/USDC` testnet pool
- `cETH/cUSDC` -> mapped to the live `ETH/USDC` testnet pool

Quote-token note:

- the live testnet now uses bridge-backed `cUSDC`
- `sUSDC` remains legacy-only context for older snapshots and migration notes
- see [cusdc-migration.md](/home/sari/Sinergy-project/docs/cusdc-migration.md)

Current dark-pool-only markets:

- `cBTC/cUSDC`
- `cSOL/cUSDC`
- `tAAPL/cUSDC`
- `tBOND/cUSDC`
- `tNVDA/cUSDC`

Mapped crypto feeds:

- `cBTC -> BTC/USD`
- `cETH -> ETH/USD`
- `cSOL -> SOL/USD`
- `cINIT -> INIT/USD`

The official default endpoint is:

- `INITIA_CONNECT_REST_URL=https://rest.testnet.initia.xyz`

Bridge note:

- the official `InterwovenKit` bridge can be opened from this repo, but Initia's own hackathon docs note that local appchains may not appear in the public bridge UI because only registered chain IDs are resolved there
- this repo now pre-fills bridge defaults with `VITE_BRIDGE_SRC_CHAIN_ID` and `VITE_BRIDGE_SRC_DENOM` and falls back to `initiation-2` / `uinit`
- for local demos, treat the bridge as the official ecosystem entry point and the local rollup deposit as a separate step unless your chain is registered

## Quick Start

### 1. Install JS Dependencies

```bash
npm install
```

### 2. Compile Contracts

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts
forge build
```

### 3. Deploy to `Sinergy-2`

```bash
chmod +x scripts/deploy-local.sh
./scripts/deploy-local.sh
```

This updates:

- `deployments/local.json`
- `services/matcher/.env`

If you run the deploy again, these addresses may change.

### 4. Start the Backend

Configure `services/matcher/.env` with a Twelve Data API key if you want live real-world prices:

```bash
cp services/matcher/.env.example services/matcher/.env
```

Relevant variables:

- `TWELVE_DATA_API_KEY`: provider API key
- `COINGECKO_DEMO_API_KEY`: demo key for crypto historical backfill
- `T_BOND_PROXY_SYMBOL=TLT`: ETF proxy for `tBOND` (`TLT` or `IEF`)
- `PRICE_POLL_INTERVAL_MS=60000`: refresh every 1 minute
- `PRICE_DB_FILE=./data/prices.sqlite`: local SQLite database on Linux
- `INITIA_CONNECT_REST_URL=https://rest.testnet.initia.xyz`: Connect source for crypto
- `L1_REST_URL=https://rest.testnet.initia.xyz`: Initia L1 REST for router quotes and swaps
- `RELAYER_HEALTH_URL`: optional relayer health endpoint; not required for the current OPinit-based local route mode
- `OPINIT_HEALTH_URL`: optional override for OPinit health checks; if omitted, the matcher autodetects `opinitd` from `~/.opinit/executor.json` and uses `/status`
- `ROUTER_CANONICAL_ASSETS_JSON`: local symbol -> canonical L1 metadata mapping
- `ROUTER_MARKETS_JSON`: local market symbol -> InitiaDEX pair denom/object mapping
- `ROUTER_BOOTSTRAP_INVENTORY_JSON`: local hot inventory bootstrap for instant fills

The checked-in `.env.example` already includes a working local/testnet starter mapping for:

- `cINIT/cUSDC`
- `cETH/cUSDC`

Fallback behavior:

- If `Twelve Data` fails or runs out of credits, the matcher keeps the fallback prices already seeded in SQLite so the markets can still resolve pairs.
- If you already ran backfill before, `services/matcher/data/prices.sqlite` remains a valid source even if the external provider fails during startup.

Current MVP mapping:

- `tAAPL -> AAPL`
- `tNVDA -> NVDA`
- `tBOND -> TLT` by default
- `cBTC -> BTC/USD` live from Initia Connect, historical from CoinGecko
- `cETH -> ETH/USD` live from Initia Connect, historical from CoinGecko
- `cSOL -> SOL/USD` live from Initia Connect, historical from CoinGecko
- `cINIT -> INIT/USD` live from Initia Connect, historical from CoinGecko

If you want to preload 2 months of real historical data before startup:

```bash
BACKFILL_DAYS=60 npm run backfill:prices
```

You can also control the window size:

```bash
BACKFILL_DAYS=60 BACKFILL_CHUNK_DAYS=7 npm run backfill:prices
```

This populates `services/matcher/data/prices.sqlite` with real historical data, and then the matcher keeps filling in the present by polling.

Historical data notes:

- RWAs (`tAAPL`, `tNVDA`, `tBOND`) use `Twelve Data` with `1min` granularity
- Crypto (`cBTC`, `cETH`, `cSOL`, `cINIT`) use `CoinGecko Demo` for bootstrap historical data and `Initia Connect` for live data
- Crypto backfill is not pure `1min`; CoinGecko returns coarser granularity on long ranges, and the matcher persists it into the same SQLite database

Then start the matcher:

```bash
npm run dev:matcher
```

If `tsx watch` has trouble in your remote environment, you can start a single-run process with:

```bash
npm run start -w @sinergy/matcher
```

### 5. Start the Frontend

```bash
npm run dev:web
```

For the testnet frontend path:

```bash
cp apps/web/.env.testnet.example apps/web/.env.testnet
cp apps/bridge/.env.testnet.example apps/bridge/.env.testnet
npm run dev:web:testnet
npm run dev:bridge:testnet
```

Frontend notes:

- The wallet modal and session now use `InterwovenKit`.
- The right rail now contains both the private dark-pool ticket and a dedicated `Private Router` panel.
- Markets are labeled as `Router-enabled` or `Dark-pool only`.
- `InitiaDEX`-backed routing only activates when canonical asset mappings are configured and the bridge health check is green.
- In the current local setup, the bridge check is considered healthy when `opinitd` is healthy; relayer health is treated as optional unless you explicitly wire a relayer-dependent route mode.
- The frontend resolves the matcher URL automatically:
  - it uses `VITE_MATCHER_URL` if you define it
  - otherwise it uses the same hostname you used to open the web app, with port `8787`
- This helps when you are accessing the app through SSH, VS Code Ports, or remote forwarding and do not want to hardcode `127.0.0.1`.
- If you access the frontend through HTTPS forwarding or custom hostnames, you can also override rollup endpoints with:
  - `VITE_TENDERMINT_RPC_URL`
  - `VITE_REST_URL`
  - `VITE_INDEXER_URL`
  - `VITE_JSON_RPC_URL`
  - `VITE_EVM_WS_URL`
- To switch the apps from `local` to `testnet`, set `VITE_DEPLOYMENT_ENV=testnet`.

### Testnet Matcher

```bash
cp services/matcher/.env.testnet.example services/matcher/.env.testnet
npm run dev:matcher:testnet
```

### Testnet Stack Bootstrap

Once the machine has the rollup, executor, relayer, matcher, and optional frontends configured,
you can restore the whole stack after a reboot with:

```bash
./scripts/start-testnet-stack.sh
```

For the full public demo flow on this machine, run these three commands in order:

```bash
./scripts/start-testnet-stack.sh
./scripts/public-nginx.sh start
./scripts/cloudflare-tunnel.sh quick
```

What each one does:

- `start-testnet-stack.sh`: restores rollup, executor, relayer, matcher, `web`, and `bridge`
- `public-nginx.sh start`: builds the testnet frontends and serves the public HTTP layer locally
- `cloudflare-tunnel.sh quick`: exposes that local public layer through a temporary `trycloudflare.com` HTTPS URL

After that, check the current public URL with:

```bash
./scripts/cloudflare-tunnel.sh status
```

Useful variants:

```bash
./scripts/start-testnet-stack.sh status
START_FRONTENDS=0 ./scripts/start-testnet-stack.sh
```

This script:

- ensures the rollup is running
- ensures the OPinit executor is running
- ensures the relayer container is running
- starts the matcher if it is down
- starts the `web` and `bridge` dev servers unless `START_FRONTENDS=0`

Logs and pid files for the non-systemd services live under:

- `.tmp/testnet-runtime/`

### Public Internet Access With Nginx

This repo now includes a Dockerized Nginx reverse proxy so you can expose the stack without
installing Nginx on the host:

```bash
./scripts/public-nginx.sh start
```

Useful commands:

```bash
./scripts/public-nginx.sh status
./scripts/public-nginx.sh print-env
./scripts/public-nginx.sh stop
```

Behavior:

- defaults to `sslip.io` based on the machine public IP if you do not set `PUBLIC_ROOT_DOMAIN`
- builds `@sinergy/web` and `@sinergy/bridge` in `testnet` mode and serves them as static sites
- exposes subdomains for:
  - `app`
  - `bridge`
  - `api`
  - `rpc`
  - `ws`
  - `rest`
  - `tm`
  - `indexer`
- runs as Docker container `sinergy-public-nginx`
- proxies live backend endpoints for `api`, `rpc`, `ws`, `rest`, `tm`, and `indexer`
- uses HTTP mode until a certificate exists, then switches to HTTPS automatically

Common override:

```bash
PUBLIC_ROOT_DOMAIN=sinergy.example.com ./scripts/public-nginx.sh start
```

To request a Let's Encrypt certificate after DNS and port forwarding are ready:

```bash
LETSENCRYPT_EMAIL=you@example.com ./scripts/request-public-cert.sh
```

Notes:

- on this machine Docker is running rootless, so the proxy listens locally on `8080` and `8443` by default
- if the machine sits behind a router/NAT, forward:
  - external `80` -> `192.168.1.14:8080`
  - external `443` -> `192.168.1.14:8443`
- wallets usually reject remote `http://` RPC URLs, so `https://rpc.<domain>` is the goal for MetaMask/Coinbase Wallet
- `sslip.io` is convenient for testnet because `app.<PUBLIC_IP>.sslip.io` style hostnames resolve automatically
- once HTTPS is live, update:
  - [deployments/testnet.json](/home/sari/Sinergy-project/deployments/testnet.json)
  - `apps/web/.env.testnet`
  - `apps/bridge/.env.testnet`
  - `services/matcher/.env.testnet`
  to use the public subdomains instead of raw LAN ports

### Cloudflare Tunnel Without Router Changes

If you do not want to open ports in the router, you can expose the stack with Cloudflare Tunnel:

```bash
./scripts/cloudflare-tunnel.sh quick
```

This starts an account-less `trycloudflare.com` tunnel to the local Nginx layer and prints:

- app root
- `/api`
- `/rpc`
- `/rest`
- `/tm`
- `/indexer`
- `/ws`

Useful commands:

```bash
./scripts/cloudflare-tunnel.sh status
./scripts/cloudflare-tunnel.sh stop
```

Notes:

- quick tunnels are convenient for demos and hackathon testing
- Cloudflare itself warns they do not have uptime guarantees
- the frontend auto-detects `*.trycloudflare.com` and routes matcher/RPC/REST/TM calls through same-origin paths
- for a stable production-style setup, prefer a named tunnel with your own Cloudflare zone:

```bash
CF_TUNNEL_TOKEN=... ./scripts/cloudflare-tunnel.sh named
```
you can bring everything up after a reboot with a single command:

```bash
./scripts/start-testnet-stack.sh
```

What it does:

- starts the rollup service
- starts the OPinit executor
- ensures the relayer is running
- starts the matcher
- starts `web`
- starts `bridge`

Useful variants:

```bash
./scripts/start-testnet-stack.sh status
START_FRONTENDS=0 ./scripts/start-testnet-stack.sh
```

Notes:

- the script is idempotent, so rerunning it does not intentionally duplicate already-running services
- runtime logs and pid files for app-level processes are stored under `.tmp/testnet-runtime/`
- `rollup`, `executor`, and `relayer` are checked through their existing service/container managers, while `matcher`, `web`, and `bridge` are started only if their ports are not already listening

### Testnet Deploy Wrapper

Use the wrapper once your rollup endpoints are known:

```bash
./scripts/deploy-testnet.sh
```

### 6. Add Crypto Assets to an Existing Deployment

If you do not want a full redeploy and only want to add the new crypto assets to your current local chain:

```bash
./scripts/add-crypto-assets.sh
```

This deploys:

- `cBTC`
- `cETH`
- `cSOL`
- `cINIT`

and updates [deployments/local.json](/home/sari/Sinergy-project/deployments/local.json) so the matcher and frontend can see them as new markets.

## Internal Documentation

- Architecture: [docs/architecture.md](/home/sari/Sinergy-project/docs/architecture.md)
- Detailed plan: [docs/implementation-plan.md](/home/sari/Sinergy-project/docs/implementation-plan.md)

## Important Notes

- This first cut provides privacy from on-chain observers and other traders, but not from the backend operator.
- The order book, matching engine, and internal ledger live off-chain.
- Real prices are ingested from the internet into the matcher, stored in `services/matcher/data/prices.sqlite`, and the frontend consumes candles from the local backend.
- Crypto assets connected to Initia Oracle build local history from the moment the matcher starts sampling them; `Connect` is not being used here as a historical backfill provider.
- Wallet connection is handled through `InterwovenKit` on the local chain `Sinergy-2`.
- For `MsgCall` transactions on MiniEVM, the frontend uses the Initia `bech32` address as `sender`, and the EVM hex address for contracts and balances.
- The private router quotes against live InitiaDEX testnet pools for `cINIT/cUSDC` and `cETH/cUSDC`, but instant fills still come from local protocol inventory first.
- Router math scales between local `18`-decimal MiniEVM assets (`cINIT`, `cETH`) and `6`-decimal Initia L1 denoms (`uinit`, `ueth`, `uusdc`) before quoting or rebalancing.
- If you update `deployments/local.json`, restart both backend and frontend so the addresses reload.
- If you update `services/matcher/.env`, restart the matcher so router market mappings and inventory bootstrap are reloaded.
