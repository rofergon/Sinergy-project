import { useEffect, useMemo, useState } from "react";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import type { Address, Hex } from "viem";
import { api } from "./lib/api";
import { Navbar } from "./components/Navbar";
import { TickerStrip } from "./components/TickerStrip";
import { TradingViewChart } from "./components/TradingViewChart";
import { OrderBook } from "./components/OrderBook";
import { BottomTabs } from "./components/BottomTabs";
import { OrderPanel } from "./components/OrderPanel";
import { SwapPanel } from "./components/SwapPanel";
import { VaultPanel } from "./components/VaultPanel";
import { BalancesPanel } from "./components/BalancesPanel";
import { PortfolioView } from "./components/PortfolioView";
import "./styles.css";

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
  routeable: boolean;
  routePolicy: "router-enabled" | "dark-pool-only";
};

type BridgeStatus = {
  relayer: boolean;
  opinit: boolean;
  ready: boolean;
  checkedAt: string;
  details: string[];
};

type InventoryPosition = {
  symbol: string;
  tokenAddress: Address;
  amountAtomic: string;
  minAtomic: string;
  targetAtomic: string;
  maxAtomic: string;
  routeable: boolean;
};

type MarketSnapshot = Market & {
  series: number[];
  changePct: number;
  trend: "up" | "down";
  volumeLabel: string;
};

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

function Dashboard() {
  const {
    address,
    initiaAddress,
    isConnected,
    openConnect,
    openWallet,
    disconnect,
  } = useInterwovenKit();

  const [deployment, setDeployment] = useState<any | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [selectedMarketId, setSelectedMarketId] = useState<Hex | undefined>();
  const [balances, setBalances] = useState<{
    available: Record<string, string>;
    locked: Record<string, string>;
  } | null>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [inventory, setInventory] = useState<InventoryPosition[]>([]);
  const [error, setError] = useState("");
  const [activeView, setActiveView] = useState<"trade" | "markets" | "portfolio">("trade");

  const userAddress = address as Address | undefined;
  const tokens: Token[] = useMemo(() => deployment?.tokens ?? [], [deployment]);
  const vaultAddress = (deployment?.contracts?.vault ??
    "0x0000000000000000000000000000000000000000") as Address;

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

  async function refreshConfig() {
    const config = await api<{
      deployment: any;
      markets: Market[];
      bridge: BridgeStatus;
      inventory: InventoryPosition[];
    }>("/config");
    const marketList = await api<{ markets: Market[] }>("/markets");
    setDeployment(config.deployment);
    setMarkets(marketList.markets);
    setBridgeStatus(config.bridge);
    setInventory(config.inventory);
  }

  async function refreshUser() {
    if (!userAddress) {
      setBalances(null);
      setOrders([]);
      return;
    }

    const [balResult, orderResult] = await Promise.all([
      api<{ available: Record<string, string>; locked: Record<string, string> }>(
        `/balances/${userAddress}`
      ),
      api<{ orders: any[] }>(`/orders/${userAddress}`),
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
  }, [userAddress]);

  function navigateTo(view: "trade" | "markets" | "portfolio") {
    setActiveView(view);
  }

  async function cancelOrder(orderId: string) {
    if (!userAddress) {
      throw new Error("Connect wallet to cancel orders.");
    }

    await api(`/orders/${orderId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ userAddress }),
    });
    await refreshUser();
  }

  return (
    <>
      <Navbar
        markets={marketSnapshots}
        selectedMarketId={selectedMarket?.id}
        onSelectMarket={setSelectedMarketId}
        activeView={activeView}
        onNavigate={navigateTo}
        isConnected={isConnected}
        address={userAddress}
        onConnect={() => {
          setError("");
          openConnect();
        }}
        onOpenWallet={openWallet}
        onDisconnect={disconnect}
        chainOk={true}
        bridgeReady={bridgeStatus?.ready ?? false}
      />

      {activeView !== "portfolio" && <TickerStrip market={selectedMarket} />}

      {error && <div className="error-bar">{error}</div>}
      {activeView !== "portfolio" && bridgeStatus && !bridgeStatus.ready && (
        <div className="bridge-banner">
          <strong>Bridge degraded.</strong> Router-enabled markets will fall back to async routing or stay unavailable until relayer and OPinit recover.
        </div>
      )}

      {activeView === "portfolio" ? (
        <PortfolioView
          connected={isConnected}
          address={userAddress}
          initiaAddress={initiaAddress}
          vaultAddress={vaultAddress}
          tokens={tokens}
          balances={balances}
          orders={orders}
          markets={marketSnapshots}
          onAfterMutation={refreshUser}
          onCancelOrder={cancelOrder}
        />
      ) : (
        <div className="dex-grid">
          <div className="dex-col-left">
            <OrderBook market={selectedMarket} />
          </div>

          <div className="dex-col-center">
            <TradingViewChart market={selectedMarket} />
            <BottomTabs
              address={userAddress}
              market={selectedMarket}
              orders={orders}
              markets={marketSnapshots}
              onCancelOrder={cancelOrder}
            />
          </div>

          <div className="dex-col-right">
            <OrderPanel
              connected={isConnected}
              address={userAddress}
              markets={marketSnapshots}
              balances={balances}
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

            <SwapPanel
              connected={isConnected}
              address={userAddress}
              selectedMarket={selectedMarket}
              bridgeStatus={bridgeStatus}
              inventory={inventory}
              onAfterMutation={refreshUser}
            />

            <VaultPanel
              connected={isConnected}
              address={userAddress}
              initiaAddress={initiaAddress}
              vaultAddress={vaultAddress}
              tokens={tokens}
              onAfterMutation={refreshUser}
            />

            <BalancesPanel tokens={tokens} balances={balances} />
          </div>
        </div>
      )}
    </>
  );
}

export default function App() {
  return <Dashboard />;
}
