# Sinergy Documentation Directory

Welcome to the technical documentation for **Sinergy**, an agent-powered private trading appchain built natively on Initia. 

This directory contains deep-dive architectural references, operational runbooks, and cryptographic design documents. It is intended to help developers, node operators, and hackathon judges quickly navigate the Sinergy technical stack.

---

## 🗺️ Documentation Index

### 1. System Overview & Architecture
If you want to understand what Sinergy is and how its microservices and on-chain components interact:

*   **[Main Sinergy README](../README.md)**: Start here for the high-level hackathon pitch, user flow, and feature list.
*   **[onboarding-hackathon.md](onboarding-hackathon.md)**: A detailed product onboarding guide analyzing the problem space and our specific value proposition.
*   **[architecture.md](architecture.md)**: The core system overview detailing how the AI Strategy Agent, Private Matcher, and the `Sinergy-2` MiniEVM integrate.

### 2. Integration & Liquidity
Understanding how Sinergy connects with the broader Initia ecosystem:

*   **[initia-dex-liquidity-routing.md](initia-dex-liquidity-routing.md)**: Explains the hybrid liquidity model, detailing when trades execute via local private inventory vs. when the AI routes them externally through InitiaDEX on L1.
*   **[cusdc-migration.md](cusdc-migration.md)**: An architectural record detailing the migration to Initia's bridge-backed connected assets (`cUSDC`, `cINIT`, `cSOL`).

### 3. ZK Privacy Engine
For cryptography engineers looking at the private execution and zero-knowledge pathways:

*   **[privacy-architecture.md](privacy-architecture.md)**: Explains current privacy features (off-chain matching, on-chain obfuscation) and the trust model.
*   **[privacy-engine-design.md](privacy-engine-design.md)**: The longer-term cryptographic evolution path targeting full stealth and TEE integration.
*   **[zk-withdrawal-runbook.md](zk-withdrawal-runbook.md)**: Instructions for compiling circuits and interacting with the active Groth16/Plonk ZKVault withdrawal flow.

### 4. Operations, Testnet, & Deployment
For node operators and developers evaluating infrastructure health:

*   **[network-startup.md](network-startup.md)**: Operational guide for bootstrapping the `Sinergy-2` local environment and OPinit bridge bots.
*   **[testnet-runbook.md](testnet-runbook.md)**: Instructions for deploying contracts to a live testnet, setting up reverse proxies (Nginx), and securing edge domains via Cloudflare tunneling.

---

## 🚀 Sinergy's Core Design Philosophy

Sinergy aims to revolutionize trading by making complex market operations accessible through AI, while preventing intent leakage and MEV (Miner Extractable Value) on-chain.

To achieve this, the system splits responsibility:
1.  **AI Orchestration**: Natural-language commands are transformed into signed trading intents by the Strategy Agent.
2.  **Private Execution**: Order matching and balancing live within an off-chain secure enclave / matcher.
3.  **Verifiable Custody**: Initia L1 provides deep liquidity, while the `Sinergy-2` rollup guarantees secure asset custody through Zero-Knowledge settlement.

The blockchain handles what **must** be verifiable, while the execution layer ensures operations remain **private, intelligent, and practical**.
