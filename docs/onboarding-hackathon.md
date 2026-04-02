# Sinergy: Hackathon Onboarding

## Quick Summary

This document is the best entry point for understanding `Sinergy` without jumping into technical details first. If someone is new to the project and needs to quickly grasp the idea, the problem, and the value proposition, they should start here.

## What To Remember Before Reading

- `Sinergy` combines practical privacy, appchain UX, and RWA/crypto trading.
- The MVP already works with a hybrid architecture across contracts, matcher, and frontend.
- For a demo or pitch, this document is more useful than the deeper architecture docs.

## 1. What Sinergy Is

**Sinergy** is a private market for tokenized assets and crypto built on Initia's `Sinergy-2` appchain.

The project combines:

- an **on-chain vault** to custody funds;
- an **off-chain matcher** to maintain private orders and execute matching;
- a **web interface** for deposits, trading, and withdrawals;
- a **hybrid router** that uses local inventory and, when needed, liquidity connected to `InitiaDEX`.

In short: **Sinergy lets users trade tokenized assets and crypto with less on-chain exposure, a better user experience, and an architecture ready to evolve toward stronger privacy.**

## 2. The Problem It Solves

Today, many on-chain markets suffer from three major frictions:

1. **Orders are publicly exposed**, which reveals trading intent, size, and price.
2. **Tokenized real-world assets and crypto liquidity usually live in separate flows**, which fragments the user experience.
3. **Getting into an appchain and moving funds across layers is still complex**, especially for users coming from EVM.

Sinergy addresses this with a very clear MVP approach:

- orders are handled **off-chain**;
- the chain only sees **deposits, withdrawals, and state anchors**;
- the system supports both **RWAs** and **crypto**;
- onboarding uses **InterwovenKit** and a dedicated bridge flow to reduce friction.

## 3. Who It Helps

### Traders

- they get more privacy than in a fully public DEX;
- they can trade without exposing all their intentions to the market;
- they get a unified experience for crypto and tokenized assets.

### Teams tokenizing real-world assets

- they get a market base that looks more like a private venue;
- they can list tokenized assets without depending on a fully public order book;
- they get an architecture compatible with future compliance layers.

### The Initia ecosystem

- it demonstrates a real use case for `MiniEVM`, `InterwovenKit`, and connectivity with `InitiaDEX`;
- it adds infrastructure focused on private markets and RWAs;
- it creates a bridge between appchain UX, trading, and hybrid liquidity.

## 4. Value Proposition

Sinergy's value proposition for the hackathon is:

**"A private market for RWAs and crypto on Initia, where critical settlement lives on-chain, while trading intent and matching stay off-chain."**

This is compelling because it combines:

- **real utility**: trading and settlement;
- **better UX**: wallet + bridge onboarding;
- **defensible architecture**: separate vault, matcher, and market layers;
- **product vision**: it starts as a functional MVP and scales toward stronger privacy and compliance.

## 5. What The Current MVP Includes

The MVP already implements the main components:

### Smart contracts

- `DarkPoolVault`: holds deposits and allows withdrawals with `EIP-712` signed tickets.
- `DarkPoolMarket`: registers markets and anchors batches (`stateRoot`, `settlementRoot`).
- `MockUSDC`: mock stablecoin for the local environment.
- `RwaShareToken`: base token used to represent listed assets.

### Backend

- internal ledger by user and token;
- deposit synchronization from the vault;
- private order book;
- price-time matching;
- price-band validations;
- withdrawal ticket signing;
- hybrid pricing for RWAs and crypto with Initia oracles and custom adapters;
- private router with local fills and asynchronous rebalance when external liquidity is needed.

### Frontend

- wallet connection with `InterwovenKit`;
- deposits and withdrawals;
- market and price visualization;
- private order submission;
- panel for `Private Router`-style routes;
- separation between `Router-enabled` and `Dark-pool only` markets.

### Bridge onboarding

- a dedicated app to start the wallet session;
- opening the official bridge from `InterwovenKit` with a configurable source chain;
- a clear transition from the bridge into the exchange.

## 6. Differentiating Features

### Practical privacy from the MVP

Sinergy does not publish the order book on-chain. That reduces visibility for outside observers and better protects trading intent.

### Hybrid architecture

It does not try to put all logic into contracts. It uses on-chain components for custody and safe withdrawal, and off-chain components for matching and fast operation.

### Mix of RWAs and crypto

The system already supports both worlds:

- RWAs such as `tAAPL`, `tBOND`, `tNVDA`;
- crypto such as `cBTC`, `cETH`, `cSOL`, `cINIT`.

### Real integration with Initia

The project already uses native ecosystem pieces:

- `MiniEVM`
- `InterwovenKit`
- `Initia Connect`
- `InitiaDEX` for selected enabled markets

Important for the demo:

- Initia's official documentation makes clear that the public bridge UI does not always handle unregistered local appchains;
- because of that, in a local environment it is better to present the bridge as the entry point into the ecosystem and the deposit into `Sinergy-2` as the next step in the flow;
- if the rollup becomes registered or is deployed in a supported public environment, that jump can look like a more continuous experience.

### Oracle and pricing layer

Sinergy combines Initia ecosystem infrastructure with its own pricing layer inside the matcher.

For crypto, it uses **`Initia Connect Oracle`** as the live price source for:

- `cBTC -> BTC/USD`
- `cETH -> ETH/USD`
- `cSOL -> SOL/USD`
- `cINIT -> INIT/USD`

In addition, the project implements a **custom price service** that:

- unifies data sources so the matcher works with a single interface;
- uses `Twelve Data` for RWAs such as `tAAPL`, `tNVDA`, and `tBOND`;
- uses `CoinGecko` for historical crypto bootstrap data;
- stores history and fallback data in `SQLite` for operational resilience;
- allows the system to keep operating even if one external source temporarily fails.

This matters for the hackathon because it shows not only integration with Initia, but also the ability to build stronger market infrastructure around that base.

### Clear evolution path

The design already leaves room for the next stage:

- order encryption;
- Merkle snapshots;
- decoupled compliance;
- TEE or ZK for more confidential settlement.

## 7. Markets Supported In The Current State

### Markets with routing connected to `InitiaDEX`

- `cINIT/cUSDC`
- `cETH/cUSDC`

### Dark-pool-only markets

- `cBTC/cUSDC`
- `cSOL/cUSDC`
- `tAAPL/cUSDC`
- `tBOND/cUSDC`
- `tNVDA/cUSDC`

## 8. How The User Flow Works

1. The user connects their wallet with `InterwovenKit`.
2. If they need funds, they go through the bridge flow.
3. They deposit assets into `DarkPoolVault`.
4. The frontend synchronizes state with the `matcher-service`.
5. The user submits private orders.
6. The matcher executes matching off-chain.
7. The user can withdraw with a backend-signed ticket.
8. The protocol can anchor batches in `DarkPoolMarket`.

## 9. Why This Project Can Compete Well In A Hackathon

Sinergy has several strong points for judges:

- **it solves a real problem**: privacy and UX in tokenized-asset markets;
- **it shows technical integration with the Initia ecosystem**;
- **it has full architecture**, not just a screen or an isolated contract;
- **it is demoable**: wallet, deposit, trade, router, withdrawal;
- **it has roadmap vision**, without overselling what is not implemented yet.

To keep the pitch honest:

- in local environments, it is better not to promise that the public bridge will always list `Sinergy-2` as a direct destination;
- it does make sense to show that the experience is already prepared to open the official bridge, receive liquidity from the ecosystem, and continue into the exchange.

## 10. Current MVP Limitations

It is important to present it honestly:

- the backend operator can still see the orders;
- there is no TEE or ZK in this version;
- strong compliance is not on-chain yet;
- part of pricing still depends on external providers and adapters even though there is already an internal aggregation layer.

This does not weaken the project; on the contrary, it shows a sensible build strategy:

**functionality and adoption first, then deeper cryptographic privacy.**

## 11. Short Project Intro

> Sinergy is a private market for RWAs and crypto built on Initia. We use an on-chain vault for custody and safe withdrawals, while the order book and matching live off-chain to reduce public exposure. The MVP already supports wallet onboarding, deposits, private orders, hybrid pricing with `Initia Connect Oracle` and a custom price service, signed withdrawals, and a clear path toward stronger privacy, compliance, and confidential settlement.

## 12. 30-Second Pitch

**Sinergy turns Initia into a base layer for private markets in tokenized assets. Instead of exposing every order on-chain, we move matching off-chain and leave only custody, withdrawals, and state anchoring on the appchain. We combine `Initia Connect Oracle` for crypto with our own pricing layer for RWAs and historical data, which improves privacy, adds operational resilience, and enables a real flow for RWAs and crypto inside the Initia ecosystem.**

## 13. Project Stack

- `Foundry` for EVM contracts
- `Vite + React` for the frontend
- `InterwovenKit` for wallet UX
- `Fastify + TypeScript` for the backend matcher
- `viem` for EVM utilities
- `MiniEVM` / `minitiad` for local deployment

## 14. How To Read The Repo

- `contracts/`: protocol contracts
- `apps/web/`: main trading interface
- `apps/bridge/`: onboarding and bridge
- `services/matcher/`: matching, pricing, and withdrawal tickets
- `packages/shared/`: ABIs, chain configuration, and shared types
- `docs/`: architecture, planning, and product information

## 15. Conclusion

Sinergy is not only a hackathon idea: it already has a functional base, a clear narrative, and a concrete market need. Its value comes from connecting **practical privacy**, **tokenized assets**, **hybrid liquidity**, and **UX on Initia** into a single experience.
