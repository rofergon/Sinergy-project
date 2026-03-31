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
  useWalletClient,
} from "wagmi";
import { coinbaseWallet, injected, metaMask } from "wagmi/connectors";
import type { Address, Hex } from "viem";
import { formatUnits } from "viem";
import { SINERGY_LOCAL_CHAIN } from "@sinergy/shared";
import { api, API_BASE } from "./lib/api";
import { Navbar } from "./components/Navbar";
import { TickerStrip } from "./components/TickerStrip";
import { TradingViewChart } from "./components/TradingViewChart";
import { OrderBook } from "./components/OrderBook";
import { BottomTabs } from "./components/BottomTabs";
import { OrderPanel } from "./components/OrderPanel";
import { VaultPanel } from "./components/VaultPanel";
import { BalancesPanel } from "./components/BalancesPanel";
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
    default: { http: [runtimeRpcUrl()] },
    public: { http: [runtimeRpcUrl()] },
  },
} as const;

const wagmiConfig = createConfig({
  chains: [SINERGY_WALLET_CHAIN],
  connectors: [
    metaMask(),
    coinbaseWallet({ appName: "Sinergy DEX" }),
    injected(),
  ],
  transports: {
    [SINERGY_WALLET_CHAIN.id]: http(SINERGY_WALLET_CHAIN.rpcUrls.default.http[0]),
  },
});

type Token = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  kind: "quote" | "rwa" | "crypto";
};

type Market = {
  id: Hex;
  symbol: string;
  baseToken: Token;
  quoteToken: Token;
  referencePrice: string;
  series?: number[];
};

type MarketSnapshot = Market & {
  series: number[];
  changePct: number;
  trend: "up" | "down";
  volumeLabel: string;
};

function chainIdHex() {
  return `0x${SINERGY_WALLET_CHAIN.id.toString(16)}`;
}

function buildSeries(key: string, anchor: number) {
  let seed = Array.from(key).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  let current = anchor * (0.955 + (seed % 8) / 100);

  return Array.from({ length: 28 }, (_, index) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    const noise = ((seed % 1000) / 1000 - 0.5) * anchor * 0.015;
    const momentum = Math.sin(index / 4.2) * anchor * 0.004;
    current = Math.max(anchor * 0.82, current + noise + momentum);
    return Number(current.toFixed(2));
  });
}

async function addOrSwitchSinergyNetwork(provider: EthereumProvider) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex() }],
    });
    return;
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? Number(error.code)
        : undefined;
    if (code !== 4902 && code !== -32603) throw error;
  }

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: chainIdHex(),
        chainName: SINERGY_WALLET_CHAIN.name,
        nativeCurrency: SINERGY_WALLET_CHAIN.nativeCurrency,
        rpcUrls: [SINERGY_WALLET_CHAIN.rpcUrls.default.http[0]],
      },
    ],
  });
}

function walletLabel(name: string) {
  if (name.toLowerCase().includes("meta")) return "MetaMask";
  if (name.toLowerCase().includes("coinbase")) return "Coinbase";
  return name;
}

/* ═══════════════════════════════════════════════════════
   Dashboard
   ═══════════════════════════════════════════════════════ */
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
  const [selectedMarketId, setSelectedMarketId] = useState<Hex | undefined>();
  const [balances, setBalances] = useState<{
    available: Record<string, string>;
    locked: Record<string, string>;
  } | null>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [error, setError] = useState("");

  const tokens: Token[] = useMemo(() => deployment?.tokens ?? [], [deployment]);
  const vaultAddress = (deployment?.contracts?.vault ??
    "0x0000000000000000000000000000000000000000") as Address;

  const displayedConnectors = useMemo(() => {
    const preferred = connectors.filter((c) => {
      const name = c.name.toLowerCase();
      return name.includes("meta") || name.includes("coinbase") || name.includes("injected");
    });
    return preferred.length > 0 ? preferred : connectors;
  }, [connectors]);

  const marketSnapshots = useMemo<MarketSnapshot[]>(() => {
    return markets.map((market) => {
      const anchor = Number(market.referencePrice);
      const series =
        market.series && market.series.length > 1
          ? market.series
          : buildSeries(market.id, anchor);
      const first = series[0] ?? anchor;
      const last = series[series.length - 1] ?? anchor;
      const changePct = ((last - first) / first) * 100;

      return {
        ...market,
        series,
        changePct,
        trend: changePct >= 0 ? "up" : "down",
        volumeLabel: `${(Math.abs(changePct) * 2.7 + 1.4).toFixed(2)}k`,
      };
    });
  }, [markets]);

  const selectedMarket = useMemo(
    () => marketSnapshots.find((m) => m.id === selectedMarketId) ?? marketSnapshots[0],
    [marketSnapshots, selectedMarketId]
  );

  const chainOk = chainId === SINERGY_WALLET_CHAIN.id;

  /* ── Data fetching ─────────────────────────────────── */
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
    const [balResult, orderResult] = await Promise.all([
      api<{ available: Record<string, string>; locked: Record<string, string> }>(
        `/balances/${address}`
      ),
      api<{ orders: any[] }>(`/orders/${address}`),
    ]);
    setBalances(balResult);
    setOrders(orderResult.orders);
  }

  useEffect(() => {
    refreshConfig().catch((err) =>
      setError(err instanceof Error ? err.message : String(err))
    );

    const timer = window.setInterval(() => {
      refreshConfig().catch((err) =>
        setError(err instanceof Error ? err.message : String(err))
      );
    }, 60_000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedMarketId && marketSnapshots[0]) {
      setSelectedMarketId(marketSnapshots[0].id);
    }
  }, [marketSnapshots, selectedMarketId]);

  useEffect(() => {
    refreshUser().catch((err) =>
      setError(err instanceof Error ? err.message : String(err))
    );
  }, [address]);

  useEffect(() => {
    if (!isConnected || !switchChainAsync) return;
    if (chainOk) return;

    switchChainAsync({ chainId: SINERGY_WALLET_CHAIN.id }).catch(() => {
      setError(
        `Switch to Sinergy Local. RPC: ${SINERGY_WALLET_CHAIN.rpcUrls.default.http[0]}`
      );
    });
  }, [chainId, isConnected, switchChainAsync]);

  /* ── Wallet connect ────────────────────────────────── */
  async function connectWallet(connectorId: string) {
    const connector = connectors.find((c) => c.id === connectorId);
    if (!connector) {
      setError("Connector not found.");
      return;
    }
    setError("");
    try {
      const provider = (connector as any).getProvider
        ? await (connector as any).getProvider()
        : undefined;
      if (provider) await addOrSwitchSinergyNetwork(provider);
      await connectAsync({ connector, chainId: SINERGY_WALLET_CHAIN.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Connect failed: ${msg}`);
    }
  }

  /* ── Render ────────────────────────────────────────── */
  return (
    <>
      <Navbar
        markets={marketSnapshots}
        selectedMarketId={selectedMarket?.id}
        onSelectMarket={setSelectedMarketId}
        isConnected={isConnected}
        address={address}
        connectors={displayedConnectors.map((c) => ({
          id: c.id,
          name: walletLabel(c.name),
        }))}
        isPending={isPending}
        onConnect={connectWallet}
        onDisconnect={() => disconnect()}
        chainOk={chainOk}
      />

      <TickerStrip market={selectedMarket} />

      {error && <div className="error-bar">{error}</div>}

      <div className="dex-grid">
        {/* Left: Order Book */}
        <div className="dex-col-left">
          <OrderBook market={selectedMarket} />
        </div>

        {/* Center: Chart + Bottom Tabs */}
        <div className="dex-col-center">
          <TradingViewChart market={selectedMarket} />
          <BottomTabs
            market={selectedMarket}
            orders={orders}
            markets={marketSnapshots}
          />
        </div>

        {/* Right: Trade Ticket + Vault + Balances */}
        <div className="dex-col-right">
          <OrderPanel
            connected={isConnected}
            address={address}
            markets={marketSnapshots}
            selectedMarketId={selectedMarket?.id}
            onSelectMarket={setSelectedMarketId}
            onSubmit={async (input) => {
              await api("/orders", {
                method: "POST",
                body: JSON.stringify(input),
              });
              await refreshUser();
            }}
          />

          <VaultPanel
            connected={isConnected}
            address={address}
            walletClient={walletClient}
            publicClient={publicClient}
            vaultAddress={vaultAddress}
            tokens={tokens}
            onAfterMutation={refreshUser}
          />

          <BalancesPanel tokens={tokens} balances={balances} />
        </div>
      </div>
    </>
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
