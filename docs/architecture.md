# Sinergy Dark RWA Market

## En pocas palabras

Este documento explica la forma mas simple de entender `Sinergy`: los fondos viven en contratos, pero las ordenes y el matching no se publican en cadena. Eso permite una experiencia mas privada que un DEX totalmente publico sin perder control sobre depositos y retiros.

## Cuando leer este documento

Leelo si quieres una vista general del sistema antes de entrar en detalles de privacidad, testnet o ZK.

## Que debes recordar

- `Sinergy` no pone el libro de ordenes en cadena.
- Los contratos guardan fondos y validan salidas; el backend opera la logica de mercado.
- La privacidad actual viene sobre todo de separar ejecucion privada y settlement publico.

## Objective

Build an RWA market on `Sinergy-2` where buyers and sellers can:

- deposit liquidity into a shared vault;
- negotiate orders without publishing them on-chain;
- execute matching off-chain;
- withdraw positions from the vault via signed tickets;
- reduce the on-chain visible footprint to deposits, withdrawals, and periodic state anchors.

## Translation of `ssl` to Initia

The reference project `furqaannabi/ssl` relies on three pieces we cannot use directly in `Sinergy-2`:

1. `Chainlink CRE` for confidential matching in TEE.
2. `Chainlink ACE / World ID` for compliance enforcement.
3. `Convergence Vault` for private settlement already solved by third parties.

In this MVP we replace them as follows:

| SSL | Sinergy MVP |
|---|---|
| CRE TEE | own `matcher-service` |
| Confidential HTTP / Chainlink oracle | own `price service` with mock/manual/http adapters |
| Convergence vault | `DarkPoolVault` |
| ACE / World ID | decoupled compliance layer in backend |
| Shield settlement outside our control | internal off-chain settlement + signed withdrawals |

## Components

### 1. `DarkPoolVault` on-chain

Custody contract for `USDC` and RWA tokens.

- receives ERC20 deposits;
- emits `Deposit` and `Withdraw` events;
- does not expose order book or matchings;
- only allows withdrawals with EIP-712 signed permissions from the authorized backend.

This makes on-chain visible activity minimal:

- `approve + deposit`
- `withdraw`
- periodic order book state anchors

### 2. `DarkPoolMarket` on-chain

Lightweight control contract that:

- registers listed markets;
- stores batches anchored by the matcher (`stateRoot`, `settlementRoot`);
- allows auditing snapshots without revealing each order.

### 3. `matcher-service`

TypeScript backend responsible for:

- maintaining internal balances per user and token;
- synchronizing deposits from the vault;
- validating available balances;
- storing limit orders;
- executing price-time matching;
- applying slippage guards with a reference price;
- signing withdrawal tickets for the frontend.

### 4. `web`

Vite + React + wagmi/viem frontend for:

- connecting an EVM wallet;
- approving and depositing into the vault;
- synchronizing internal balances;
- sending private orders to the backend;
- requesting withdrawal tickets and executing `withdraw`.

## What privacy we achieve in this first cut

### Yes

- the order book and trading intent do not live on-chain;
- other participants do not see open orders;
- internal matching rebalances are not published on-chain;
- visible settlement is concentrated in the vault and batch hashes.

### Not yet

- the backend operator can see orders in plaintext;
- no TEE or zk to hide logic from the operator;
- no strong compliance in contract;
- no full stealth withdrawals yet.

## Trust model

This MVP prioritizes build speed over total cryptographic privacy.

Current trust assumptions:

1. The user trusts the `matcher-service` to maintain the internal order book.
2. The user trusts the backend signer to authorize correct withdrawals.
3. The contract limits damage because it only moves funds through explicit deposits and signed tickets.

## Recommended evolution

### Phase 2

- client -> backend encryption with ECIES;
- SQL persistence + full auditing;
- separate processes for matcher, risk, and oracle;
- Merkle snapshot of the internal ledger;
- compliance via allowlists, KYC, or attestations.

### Phase 3

- private settlement with stealth addresses;
- per-user balance proofs;
- matcher execution in TEE or confidential environment;
- zk proofs for settlement batches.
