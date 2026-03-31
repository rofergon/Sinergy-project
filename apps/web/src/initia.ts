import deployment from "../../../deployments/local.json";
import { SINERGY_LOCAL_CHAIN } from "@sinergy/shared";

function runtimeHost() {
  if (typeof window === "undefined") {
    return "127.0.0.1";
  }

  const host = window.location.hostname;
  if (!host || host === "localhost" || host === "127.0.0.1") {
    return "127.0.0.1";
  }

  return host;
}

function runtimeHttpUrl(port: number) {
  return `http://${runtimeHost()}:${port}`;
}

function runtimeWsUrl(port: number) {
  return `ws://${runtimeHost()}:${port}`;
}

export const SINERGY_ROLLUP_CHAIN_ID = deployment.network.rollupChainId;

export function buildInterwovenCustomChain() {
  return {
    chain_id: deployment.network.rollupChainId,
    chain_name: deployment.network.name,
    pretty_name: deployment.network.name,
    network_type: "testnet" as const,
    bech32_prefix: "init",
    apis: {
      rpc: [{ address: runtimeHttpUrl(26657) }],
      rest: [{ address: runtimeHttpUrl(1317) }],
      indexer: [{ address: runtimeHttpUrl(8080) }],
      "json-rpc": [{ address: runtimeHttpUrl(8545) }],
      websocket: [{ address: runtimeWsUrl(8546) }],
    },
    fees: {
      fee_tokens: [
        {
          denom: deployment.network.gasDenom,
          fixed_min_gas_price: 0,
          low_gas_price: 0,
          average_gas_price: 0,
          high_gas_price: 0,
        },
      ],
    },
    staking: {
      staking_tokens: [{ denom: deployment.network.gasDenom }],
    },
    native_assets: [
      {
        denom: deployment.network.gasDenom,
        name: SINERGY_LOCAL_CHAIN.nativeCurrency.name,
        symbol: SINERGY_LOCAL_CHAIN.nativeCurrency.symbol,
        decimals: SINERGY_LOCAL_CHAIN.nativeCurrency.decimals,
      },
    ],
    metadata: {
      is_l1: false,
      minitia: {
        type: "minievm",
      },
    },
  };
}
