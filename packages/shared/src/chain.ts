import type { Chain } from "viem";

export type DeploymentNativeCurrency = {
  name: string;
  symbol: string;
  decimals: number;
};

export type DeploymentNetwork = {
  name: string;
  chainId: number;
  chainIdHex: string;
  rollupChainId: string;
  l1ChainId: string;
  gasDenom: string;
  rpcUrl: string;
  wsUrl: string;
  tendermintRpc: string;
  restUrl: string;
  explorerUrl?: string;
  nativeCurrency?: DeploymentNativeCurrency;
};

export type DeploymentToken = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  kind: "quote" | "rwa" | "crypto";
  bridge?: {
    sourceChainId?: string;
    sourceDenom: string;
    sourceSymbol: string;
    sourceDecimals: number;
    destinationDenom: string;
  };
};

export type SinergyDeployment = {
  network: DeploymentNetwork;
  contracts: {
    vault: `0x${string}`;
    market: `0x${string}`;
    quoteToken: `0x${string}`;
    zkVault?: `0x${string}`;
    stateAnchor?: `0x${string}`;
    withdrawalVerifier?: `0x${string}`;
  };
  tokens: DeploymentToken[];
};

export type LocalDeployment = SinergyDeployment;

export function resolveNativeCurrency(network: DeploymentNetwork): DeploymentNativeCurrency {
  return (
    network.nativeCurrency ?? {
      name: network.gasDenom === "GAS" ? "Gas" : network.gasDenom,
      symbol: network.gasDenom,
      decimals: 18,
    }
  );
}

export function createSinergyChain(
  deploymentOrNetwork: Pick<SinergyDeployment, "network"> | DeploymentNetwork
): Chain {
  const network =
    "network" in deploymentOrNetwork ? deploymentOrNetwork.network : deploymentOrNetwork;
  const nativeCurrency = resolveNativeCurrency(network);
  const explorerUrl = network.explorerUrl ?? network.rpcUrl;

  return {
    id: network.chainId,
    name: network.name,
    nativeCurrency,
    rpcUrls: {
      default: {
        http: [network.rpcUrl],
        webSocket: [network.wsUrl],
      },
      public: {
        http: [network.rpcUrl],
        webSocket: [network.wsUrl],
      },
    },
    blockExplorers: {
      default: {
        name: network.name,
        url: explorerUrl,
      },
    },
    testnet: network.l1ChainId !== "initiation-1",
  };
}

export const SINERGY_LOCAL_CHAIN = createSinergyChain({
  name: "Sinergy Local",
  chainId: 1716124615666775,
  chainIdHex: "0x618ce661b6c57",
  rollupChainId: "Sinergy-2",
  l1ChainId: "initiation-2",
  gasDenom: "GAS",
  rpcUrl: "http://127.0.0.1:8545",
  wsUrl: "ws://127.0.0.1:8546",
  tendermintRpc: "http://127.0.0.1:26657",
  restUrl: "http://127.0.0.1:1317",
  explorerUrl: "http://127.0.0.1:8545",
  nativeCurrency: {
    name: "Gas",
    symbol: "GAS",
    decimals: 18,
  },
});
