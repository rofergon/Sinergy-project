# Sinergy Documentation

This folder explains the project from several angles. The goal of this guide is to help you know where to start without opening every file first.

## If you want a quick understanding of the project

- Read [onboarding-hackathon.md](/home/sari/Sinergy-project/docs/onboarding-hackathon.md). It is the best high-level overview of the product, problem, and value proposition.
- Then read [architecture.md](/home/sari/Sinergy-project/docs/architecture.md). It summarizes how the contracts, backend, and frontend fit together.

## If you want to understand the privacy side

- Read [privacy-architecture.md](/home/sari/Sinergy-project/docs/privacy-architecture.md) to understand what privacy exists today and what the target is.
- Read [privacy-engine-design.md](/home/sari/Sinergy-project/docs/privacy-engine-design.md) if you need the more technical version of that evolution.
- Read [zk-withdrawal-runbook.md](/home/sari/Sinergy-project/docs/zk-withdrawal-runbook.md) if you are going to run real ZK withdrawal tests.

## If you want to operate the network or the testnet environment

- Read [implementation-plan.md](/home/sari/Sinergy-project/docs/implementation-plan.md) for the overall work plan.
- Read [testnet-runbook.md](/home/sari/Sinergy-project/docs/testnet-runbook.md) to bring the stack up on testnet.
- Read [network-startup.md](/home/sari/Sinergy-project/docs/network-startup.md) for day-to-day operational startup.

## If you want to understand integrations or specific changes

- Read [initia-dex-liquidity-routing.md](/home/sari/Sinergy-project/docs/initia-dex-liquidity-routing.md) to understand when an operation uses local liquidity and when it routes to Initia DEX.
- Read [cusdc-migration.md](/home/sari/Sinergy-project/docs/cusdc-migration.md) to understand the migration from `sUSDC` to `cUSDC`.

## Recommended reading by profile

- Product or demo: [onboarding-hackathon.md](/home/sari/Sinergy-project/docs/onboarding-hackathon.md), [architecture.md](/home/sari/Sinergy-project/docs/architecture.md)
- Backend or smart contracts: [architecture.md](/home/sari/Sinergy-project/docs/architecture.md), [privacy-architecture.md](/home/sari/Sinergy-project/docs/privacy-architecture.md), [privacy-engine-design.md](/home/sari/Sinergy-project/docs/privacy-engine-design.md)
- DevOps or testnet: [implementation-plan.md](/home/sari/Sinergy-project/docs/implementation-plan.md), [testnet-runbook.md](/home/sari/Sinergy-project/docs/testnet-runbook.md), [network-startup.md](/home/sari/Sinergy-project/docs/network-startup.md)

## Project idea in simple language

Sinergy aims to make trading crypto and tokenized assets less publicly exposed on-chain. To do that:

- funds are held on-chain;
- orders and matching live off-chain;
- the web interface connects the user to that flow;
- `Initia L1` provides external liquidity when local inventory is not enough.

In other words, the chain is used for what must be verifiable, and the rest is kept as private and practical as possible.
