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

- `MockUSDC`
- `RwaShareToken`
- `DarkPoolVault`
- `DarkPoolMarket`

## Locally Deployed Addresses

Current deployment on `Sinergy-2`:

- `Matcher signer`: `0x6eC8AcC95Da5f752eCeAB1c214C1b62080023283`
- `DarkPoolVault`: `0x3fF37bE2C8B8179cBfd97CB1e75fEd91e5e38B19`
- `DarkPoolMarket`: `0xe1d9c4EcC2ba58274733C61Fb25919F0eA902575`
- `sUSDC`: `0xA0cf839E30789cBB13292B80727103105D971872`
- `tAAPL`: `0xc7bcA502bCeBb25b1CFf139aeD86DE2639a922D7`
- `tBOND`: `0x910a546A1763C38dcf352cfdB6e752b3DBDAb029`
- `tNVDA`: `0xCBA194D6576379CfebA944cB696Be34F20e8a987`

Runtime source of truth:

- [deployments/local.json](/home/sari/Sinergy-project/deployments/local.json)

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

Mapped crypto feeds:

- `cBTC -> BTC/USD`
- `cETH -> ETH/USD`
- `cSOL -> SOL/USD`
- `cINIT -> INIT/USD`

The official default endpoint is:

- `INITIA_CONNECT_REST_URL=https://rest.testnet.initia.xyz`

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

Frontend notes:

- The wallet modal and session now use `InterwovenKit`.
- The frontend resolves the matcher URL automatically:
  - it uses `VITE_MATCHER_URL` if you define it
  - otherwise it uses the same hostname you used to open the web app, with port `8787`
- This helps when you are accessing the app through SSH, VS Code Ports, or remote forwarding and do not want to hardcode `127.0.0.1`.

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
- If you update `deployments/local.json`, restart both backend and frontend so the addresses reload.
