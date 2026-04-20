import { useEffect, useMemo, useState } from "react";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import type { StrategyTimeframe } from "@sinergy/shared";
import type { Address, Hex } from "viem";
import { api } from "./lib/api";
import { Navbar } from "./components/Navbar";
import { TickerStrip } from "./components/TickerStrip";
import { PortfolioView } from "./components/PortfolioView";
import { BridgeLanding } from "./components/BridgeLanding";
import { LandingPage } from "./components/LandingPage";
import { StrategyExecutionHistoryPage } from "./components/StrategyExecutionHistoryPage";
import { StrategyStudio } from "./components/StrategyStudio";
import { TransactionPopup, useTransactionPopup } from "./components/TransactionPopup";
import { buildBridgeDefaults } from "./initia";
import type { Market, MarketSnapshot, StrategyBacktestBundle, Token } from "./types";
import "./styles.css";

type BridgeStatus = {
  relayer: boolean;
  opinit: boolean;
  ready: boolean;
  checkedAt: string;
  details: string[];
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
    username,
    openConnect,
    openBridge,
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
  const [error, setError] = useState("");
  const [activeView, setActiveView] = useState<"agent" | "portfolio" | "history" | "bridge">("agent");
  const [chartTimeframe, setChartTimeframe] = useState<StrategyTimeframe>("15m");
  const [strategyBacktest, setStrategyBacktest] = useState<StrategyBacktestBundle | null>(null);
  const { popup, showTx, closeTx } = useTransactionPopup();

  const userAddress = address as Address | undefined;
  const tokens: Token[] = useMemo(() => deployment?.tokens ?? [], [deployment]);
  const vaultAddress = (deployment?.contracts?.vault ??
    "0x0000000000000000000000000000000000000000") as Address;
  const zkVaultAddress = deployment?.contracts?.zkVault as Address | undefined;

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
      bridge: BridgeStatus;
    }>("/config");
    const marketList = await api<{ markets: Market[] }>("/markets");
    setDeployment(config.deployment);
    setMarkets(marketList.markets);
    setBridgeStatus(config.bridge);
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
    if (
      strategyBacktest &&
      selectedMarket &&
      strategyBacktest.summary.marketId.toLowerCase() !== selectedMarket.id.toLowerCase()
    ) {
      setStrategyBacktest(null);
    }
  }, [selectedMarket?.id, strategyBacktest?.summary.marketId]);

  useEffect(() => {
    refreshUser().catch((err) =>
      setError(err instanceof Error ? err.message : String(err))
    );
  }, [userAddress]);

  function navigateTo(view: "agent" | "portfolio" | "history" | "bridge") {
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

  function handleBridgeIn() {
    if (!initiaAddress) {
      setError("");
      openConnect();
      return;
    }

    openBridge(buildBridgeDefaults());
  }

  const handleConnect = () => {
    setError("");
    openConnect();
  };

  if (!isConnected) {
    return <LandingPage onConnect={handleConnect} />;
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
        initiaAddress={initiaAddress}
        username={username}
        onConnect={handleConnect}
        onOpenWallet={openWallet}
        onDisconnect={disconnect}
        chainOk={true}
        bridgeReady={bridgeStatus?.ready ?? false}
      />

      {activeView === "agent" && <TickerStrip market={selectedMarket} />}

      {error && <div className="error-bar">{error}</div>}
      {activeView === "agent" && bridgeStatus && !bridgeStatus.ready && (
        <div className="bridge-banner">
          <strong>Bridge degraded.</strong> Router-enabled markets will fall back to async routing or stay unavailable until relayer and OPinit recover.
        </div>
      )}

      {activeView === "bridge" ? (
        <BridgeLanding
          connected={isConnected}
          address={userAddress}
          initiaAddress={initiaAddress}
          username={username}
          onConnect={handleConnect}
          onOpenWallet={openWallet}
          onOpenBridge={handleBridgeIn}
          onGoTrade={() => setActiveView("agent")}
        />
      ) : activeView === "portfolio" ? (
        <PortfolioView
          connected={isConnected}
          address={userAddress}
          initiaAddress={initiaAddress}
          vaultAddress={vaultAddress}
          zkVaultAddress={zkVaultAddress}
          tokens={tokens}
          balances={balances}
          orders={orders}
          markets={marketSnapshots}
          onAfterMutation={refreshUser}
          onCancelOrder={cancelOrder}
          showTx={showTx}
        />
      ) : activeView === "history" ? (
        <StrategyExecutionHistoryPage
          address={userAddress}
          markets={marketSnapshots}
        />
      ) : (
        <StrategyStudio
          address={userAddress}
          markets={marketSnapshots}
          selectedMarketId={selectedMarket?.id}
          timeframe={chartTimeframe}
          onSelectMarket={(marketId) => setSelectedMarketId(marketId as Hex)}
          onTimeframeChange={setChartTimeframe}
          strategyBacktest={strategyBacktest}
          onBacktestResult={setStrategyBacktest}
        />
      )}

      <TransactionPopup data={popup} onClose={closeTx} />
    </>
  );
}

export default function App() {
  return <Dashboard />;
}
