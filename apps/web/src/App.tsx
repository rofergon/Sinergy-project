import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  WagmiProvider,
  createConfig,
  http,
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient
} from "wagmi";
import { coinbaseWallet, injected, metaMask } from "wagmi/connectors";
import type { Address } from "viem";
import { formatUnits } from "viem";
import { SINERGY_LOCAL_CHAIN } from "@sinergy/shared";
import { api, API_BASE } from "./lib/api";
import { VaultPanel } from "./components/VaultPanel";
import { BalancesPanel } from "./components/BalancesPanel";
import { OrderPanel } from "./components/OrderPanel";
import "./styles.css";

const queryClient = new QueryClient();

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
};

function runtimeRpcUrl() {
  if (typeof window === "undefined") {
    return SINERGY_LOCAL_CHAIN.rpcUrls.default.http[0];
  }

  const host = window.location.hostname;
  if (!host || host === "localhost" || host === "127.0.0.1") {
    return "http://127.0.0.1:8545";
  }

  return `http://${host}:8545`;
}

const SINERGY_WALLET_CHAIN = {
  ...SINERGY_LOCAL_CHAIN,
  rpcUrls: {
    default: {
      http: [runtimeRpcUrl()]
    },
    public: {
      http: [runtimeRpcUrl()]
    }
  }
} as const;

const wagmiConfig = createConfig({
  chains: [SINERGY_WALLET_CHAIN],
  connectors: [
    metaMask(),
    coinbaseWallet({
      appName: "Sinergy Dark RWA Market"
    }),
    injected()
  ],
  transports: {
    [SINERGY_WALLET_CHAIN.id]: http(SINERGY_WALLET_CHAIN.rpcUrls.default.http[0])
  }
});

type Token = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  kind: "quote" | "rwa";
};

type Market = {
  id: `0x${string}`;
  symbol: string;
  baseToken: Token;
  quoteToken: Token;
  referencePrice: string;
};

function shorten(address?: string) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function walletLabel(name: string) {
  if (name.toLowerCase().includes("meta")) return "MetaMask";
  if (name.toLowerCase().includes("coinbase")) return "Base Wallet";
  return name;
}

function chainIdHex() {
  return `0x${SINERGY_WALLET_CHAIN.id.toString(16)}`;
}

async function addOrSwitchSinergyNetwork(provider: EthereumProvider) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex() }]
    });
    return;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? Number(error.code) : undefined;
    if (code !== 4902 && code !== -32603) {
      throw error;
    }
  }

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: chainIdHex(),
        chainName: SINERGY_WALLET_CHAIN.name,
        nativeCurrency: SINERGY_WALLET_CHAIN.nativeCurrency,
        rpcUrls: [SINERGY_WALLET_CHAIN.rpcUrls.default.http[0]]
      }
    ]
  });
}

function Dashboard() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: SINERGY_WALLET_CHAIN.id });
  const { data: walletClient } = useWalletClient({ chainId: SINERGY_WALLET_CHAIN.id });

  const [deployment, setDeployment] = useState<any | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [balances, setBalances] = useState<{
    available: Record<string, string>;
    locked: Record<string, string>;
  } | null>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [error, setError] = useState("");

  const tokens: Token[] = useMemo(() => deployment?.tokens ?? [], [deployment]);
  const vaultAddress = (deployment?.contracts?.vault ??
    "0x0000000000000000000000000000000000000000") as Address;
  const quoteToken = tokens.find((token) => token.kind === "quote");
  const displayedConnectors = useMemo(() => {
    const preferred = connectors.filter((connector) => {
      const name = connector.name.toLowerCase();
      return name.includes("meta") || name.includes("coinbase") || name.includes("injected");
    });

    return preferred.length > 0 ? preferred : connectors;
  }, [connectors]);

  async function refreshConfig() {
    const config = await api<{ deployment: any; markets: Market[] }>("/config");
    const marketList = await api<{ markets: Market[] }>("/markets");
    setDeployment(config.deployment);
    setMarkets(marketList.markets);
  }

  async function refreshUser() {
    if (!address) {
      setBalances(null);
      setOrders([]);
      return;
    }

    const [balanceResult, orderResult] = await Promise.all([
      api<{ available: Record<string, string>; locked: Record<string, string> }>(`/balances/${address}`),
      api<{ orders: any[] }>(`/orders/${address}`)
    ]);

    setBalances(balanceResult);
    setOrders(orderResult.orders);
  }

  useEffect(() => {
    refreshConfig().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refreshUser().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [address]);

  useEffect(() => {
    if (!isConnected || !switchChainAsync) return;
    if (chainId === SINERGY_WALLET_CHAIN.id) return;

    switchChainAsync({ chainId: SINERGY_WALLET_CHAIN.id }).catch(() => {
      setError(
        `Wallet connected, but it did not switch to Sinergy Local automatically. RPC sugerido: ${SINERGY_WALLET_CHAIN.rpcUrls.default.http[0]}`
      );
    });
  }, [chainId, isConnected, switchChainAsync]);

  async function connectWallet(connectorId: string) {
    const connector = connectors.find((item) => item.id === connectorId);
    if (!connector) {
      setError("No se encontró el conector de wallet.");
      return;
    }

    setError("");

    try {
      const provider = (connector as { getProvider?: () => Promise<EthereumProvider> }).getProvider
        ? await (connector as { getProvider: () => Promise<EthereumProvider> }).getProvider()
        : undefined;

      if (provider) {
        await addOrSwitchSinergyNetwork(provider);
      }

      await connectAsync({
        connector,
        chainId: SINERGY_WALLET_CHAIN.id
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        `No se pudo conectar ${walletLabel(connector.name)}. Intenta agregar la red con chain id hex ${chainIdHex()} y RPC ${SINERGY_WALLET_CHAIN.rpcUrls.default.http[0]}. Detalle: ${message}`
      );
    }
  }

  return (
    <div className="shell">
      <div className="hero">
        <div>
          <p className="eyebrow">Sinergy-2 / MiniEVM</p>
          <h1>Dark RWA market</h1>
          <p className="hero-copy">
            Private order flow, pooled settlement and matcher-signed withdrawals on your local Initia appchain.
          </p>
        </div>

        <div className="hero-actions">
          <div className="badge">API {API_BASE}</div>
          {!isConnected ? (
            <div className="wallet-stack">
              {displayedConnectors.map((connector) => (
                <button
                  className="primary"
                  key={connector.id}
                  onClick={() => connectWallet(connector.id)}
                  disabled={isPending}
                >
                  {isPending ? "Connecting..." : `Connect ${walletLabel(connector.name)}`}
                </button>
              ))}
            </div>
          ) : (
            <div className="wallet-stack">
              <button className="secondary" onClick={() => disconnect()}>
                {shorten(address)}
              </button>
              <span className="muted inline-note">
                {chainId === SINERGY_WALLET_CHAIN.id
                  ? "Connected to Sinergy Local"
                  : `Connected to chain ${chainId}`}
              </span>
            </div>
          )}
        </div>
      </div>

      {error ? <p className="error-banner">{error}</p> : null}

      <div className="layout">
        <div className="left-column">
          <VaultPanel
            connected={isConnected}
            address={address}
            walletClient={walletClient}
            publicClient={publicClient}
            vaultAddress={vaultAddress}
            tokens={tokens}
            onAfterMutation={refreshUser}
          />

          <OrderPanel
            connected={isConnected}
            address={address}
            markets={markets}
            onSubmit={async (input) => {
              await api("/orders", {
                method: "POST",
                body: JSON.stringify(input)
              });
              await refreshUser();
            }}
          />
        </div>

        <div className="right-column">
          <BalancesPanel tokens={tokens} balances={balances} />

          <section className="panel">
            <div className="panel-header">
              <p className="eyebrow">Listed Markets</p>
              <h2>Reference board</h2>
            </div>

            <div className="balance-grid">
              {markets.map((market) => (
                <article className="market-card" key={market.id}>
                  <p className="symbol">{market.symbol}</p>
                  <p className="price">{market.referencePrice} {quoteToken?.symbol}</p>
                  <small>{market.baseToken.address}</small>
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <p className="eyebrow">Orders</p>
              <h2>My matcher ledger</h2>
            </div>

            <div className="order-list">
              {orders.length === 0 ? (
                <p className="muted">Connect a wallet and place your first order.</p>
              ) : (
                orders.map((order) => {
                  const market = markets.find((item) => item.id === order.marketId);
                  const decimals = market?.baseToken.decimals ?? 18;

                  return (
                    <article className="order-card" key={order.id}>
                      <div>
                        <p className="symbol">
                          {order.side} {market?.symbol ?? order.marketId}
                        </p>
                        <p className="muted">{order.status}</p>
                      </div>
                      <div className="value-group">
                        <span>{formatUnits(BigInt(order.remainingAtomic), decimals)}</span>
                        <small>remaining</small>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
