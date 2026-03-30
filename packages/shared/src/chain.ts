export const SINERGY_LOCAL_CHAIN = {
  id: 1716124615666775,
  name: "Sinergy Local",
  nativeCurrency: {
    name: "Gas",
    symbol: "GAS",
    decimals: 18
  },
  rpcUrls: {
    default: {
      http: ["http://127.0.0.1:8545"],
      webSocket: ["ws://127.0.0.1:8546"]
    },
    public: {
      http: ["http://127.0.0.1:8545"],
      webSocket: ["ws://127.0.0.1:8546"]
    }
  },
  blockExplorers: {
    default: {
      name: "Local",
      url: "http://127.0.0.1:8545"
    }
  },
  testnet: true
} as const;

export type DeploymentToken = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  kind: "quote" | "rwa";
};

export type LocalDeployment = {
  network: {
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
  };
  contracts: {
    vault: `0x${string}`;
    market: `0x${string}`;
    quoteToken: `0x${string}`;
  };
  tokens: DeploymentToken[];
};

