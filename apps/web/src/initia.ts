import localDeployment from "../../../deployments/local.json";
import testnetDeployment from "../../../deployments/testnet.json";
import {
  createSinergyChain,
  resolveNativeCurrency,
  type SinergyDeployment,
  buildPublicSubdomainHost,
  isDirectHost,
  isTryCloudflareHostname,
} from "@sinergy/shared";

const deploymentEnv = import.meta.env.VITE_DEPLOYMENT_ENV === "testnet" ? "testnet" : "local";

const deployments = {
  local: localDeployment as SinergyDeployment,
  testnet: testnetDeployment as SinergyDeployment,
};

export const deployment = deployments[deploymentEnv];
export const SINERGY_EVM_CHAIN = createSinergyChain(deployment);

function runtimeHost(subdomain?: string) {
  if (typeof window === "undefined") {
    return "127.0.0.1";
  }

  const host = window.location.hostname;
  if (!host || host === "localhost" || host === "127.0.0.1") {
    return "127.0.0.1";
  }

  return subdomain ? buildPublicSubdomainHost(host, subdomain) : host;
}

function runtimeHttpProtocol() {
  if (typeof window === "undefined") {
    return "http";
  }

  return window.location.protocol === "https:" ? "https" : "http";
}

function runtimeWsProtocol() {
  if (typeof window === "undefined") {
    return "ws";
  }

  return window.location.protocol === "https:" ? "wss" : "ws";
}

function runtimeHttpUrl(port: number, subdomain?: string) {
  if (typeof window !== "undefined" && isTryCloudflareHostname(window.location.hostname)) {
    switch (port) {
      case 26657:
        return `${window.location.origin}/tm`;
      case 1317:
        return `${window.location.origin}/rest`;
      case 8080:
        return `${window.location.origin}/indexer`;
      case 8545:
        return `${window.location.origin}/rpc`;
      default:
        return `${window.location.origin}`;
    }
  }

  const host = runtimeHost(subdomain);
  if (isDirectHost(host)) {
    return `${runtimeHttpProtocol()}://${host}:${port}`;
  }

  return `${runtimeHttpProtocol()}://${host}`;
}

function runtimeWsUrl(port: number, subdomain?: string) {
  if (typeof window !== "undefined" && isTryCloudflareHostname(window.location.hostname)) {
    return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;
  }

  const host = runtimeHost(subdomain);
  if (isDirectHost(host)) {
    return `${runtimeWsProtocol()}://${host}:${port}`;
  }

  return `${runtimeWsProtocol()}://${host}`;
}

export const SINERGY_ROLLUP_CHAIN_ID = deployment.network.rollupChainId;
export const SINERGY_BRIDGE_ID = BigInt(import.meta.env.VITE_SINERGY_BRIDGE_ID ?? "1735");
export const SINERGY_BRIDGE_ASSETS = deployment.tokens
  .filter((token) => token.bridge)
  .map((token) => ({
    tokenSymbol: token.symbol,
    tokenName: token.name,
    sourceChainId:
      token.bridge?.sourceChainId ??
      import.meta.env.VITE_BRIDGE_SRC_CHAIN_ID ??
      deployment.network.l1ChainId,
    sourceDenom: token.bridge?.sourceDenom ?? import.meta.env.VITE_BRIDGE_SRC_DENOM ?? "uinit",
    sourceSymbol: token.bridge?.sourceSymbol ?? token.symbol,
    sourceDecimals: token.bridge?.sourceDecimals ?? 6,
    destinationDenom:
      token.bridge?.destinationDenom ??
      import.meta.env.VITE_SINERGY_BRIDGE_DST_DENOM ??
      "l2/7835b9ce5f65720a12cd653306cfe00afb93dcf1b73e69eb5eeddc568fc455cf",
  }));
export const DEFAULT_SINERGY_BRIDGE_ASSET =
  SINERGY_BRIDGE_ASSETS.find((asset) => asset.tokenSymbol === "cINIT") ?? SINERGY_BRIDGE_ASSETS[0];
export const SINERGY_BRIDGE_SOURCE_CHAIN_ID =
  DEFAULT_SINERGY_BRIDGE_ASSET?.sourceChainId ?? deployment.network.l1ChainId;
export const SINERGY_BRIDGE_SOURCE_DENOM =
  DEFAULT_SINERGY_BRIDGE_ASSET?.sourceDenom ?? "uinit";
export const SINERGY_BRIDGE_DESTINATION_DENOM =
  DEFAULT_SINERGY_BRIDGE_ASSET?.destinationDenom ??
  "l2/7835b9ce5f65720a12cd653306cfe00afb93dcf1b73e69eb5eeddc568fc455cf";

export function buildBridgeDefaults() {
  return {
    srcChainId: SINERGY_BRIDGE_SOURCE_CHAIN_ID,
    srcDenom: SINERGY_BRIDGE_SOURCE_DENOM,
  };
}

export function resolveBridgeAsset(tokenSymbol?: string) {
  return (
    SINERGY_BRIDGE_ASSETS.find((asset) => asset.tokenSymbol === tokenSymbol) ??
    DEFAULT_SINERGY_BRIDGE_ASSET
  );
}

export function buildInterwovenCustomChain() {
  const nativeCurrency = resolveNativeCurrency(deployment.network);

  return {
    chain_id: deployment.network.rollupChainId,
    chain_name: deployment.network.name,
    pretty_name: deployment.network.name,
    network_type: "testnet" as const,
    bech32_prefix: "init",
    apis: {
      rpc: [{ address: import.meta.env.VITE_TENDERMINT_RPC_URL ?? runtimeHttpUrl(26657, "tm") }],
      rest: [{ address: import.meta.env.VITE_REST_URL ?? runtimeHttpUrl(1317, "rest") }],
      indexer: [{ address: import.meta.env.VITE_INDEXER_URL ?? runtimeHttpUrl(8080, "indexer") }],
      "json-rpc": [{ address: import.meta.env.VITE_JSON_RPC_URL ?? runtimeHttpUrl(8545, "rpc") }],
      websocket: [{ address: import.meta.env.VITE_EVM_WS_URL ?? runtimeWsUrl(8546, "ws") }],
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
        name: nativeCurrency.name,
        symbol: nativeCurrency.symbol,
        decimals: nativeCurrency.decimals,
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

export function resolveRollupRestUrl() {
  return import.meta.env.VITE_REST_URL ?? runtimeHttpUrl(1317, "rest");
}
