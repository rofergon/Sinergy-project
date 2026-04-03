import { useState } from "react";
import type { StrategyBacktestSummary, StrategyBacktestTrade } from "@sinergy/shared";
import { formatUnits } from "viem";
import { TradeHistory } from "./TradeHistory";
import { BacktestResults } from "./BacktestResults";

type MarketSnapshot = {
  id: `0x${string}`;
  symbol: string;
  referencePrice: string;
  series: number[];
  baseToken: { decimals: number };
};

type Order = {
  id: string;
  marketId: `0x${string}`;
  side: "BUY" | "SELL";
  remainingAtomic: string;
  createdAt: string;
  status: string;
};

type Props = {
  address?: `0x${string}`;
  market?: MarketSnapshot;
  orders: Order[];
  markets: MarketSnapshot[];
  onCancelOrder: (orderId: string) => Promise<void>;
  backtestSummary?: StrategyBacktestSummary | null;
  backtestTrades?: StrategyBacktestTrade[];
};

export function BottomTabs({
  address,
  market,
  orders,
  markets,
  onCancelOrder,
  backtestSummary = null,
  backtestTrades = []
}: Props) {
  const [activeTab, setActiveTab] = useState<"trades" | "open" | "history" | "backtest">("trades");
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  async function handleCancel(orderId: string) {
    if (!address) {
      setStatus("Connect wallet to cancel orders.");
      return;
    }

    setCancellingId(orderId);
    setStatus("");
    try {
      await onCancelOrder(orderId);
      setStatus("Order cancelled. Funds returned to available balance.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setCancellingId(null);
    }
  }

  const openOrders = orders.filter((o) => o.status === "OPEN" || o.status === "PARTIAL");

  return (
    <div className="bottom-panel">
      <div className="bottom-tabs-bar">
        <button
          className={`bottom-tab ${activeTab === "open" ? "active" : ""}`}
          onClick={() => setActiveTab("open")}
        >
          Open Orders ({openOrders.length})
        </button>
        <button
          className={`bottom-tab ${activeTab === "trades" ? "active" : ""}`}
          onClick={() => setActiveTab("trades")}
        >
          Trade History
        </button>
        <button
          className={`bottom-tab ${activeTab === "history" ? "active" : ""}`}
          onClick={() => setActiveTab("history")}
        >
          Order History
        </button>
        <button
          className={`bottom-tab ${activeTab === "backtest" ? "active" : ""}`}
          onClick={() => setActiveTab("backtest")}
        >
          Backtest
        </button>
      </div>

      <div className="bottom-tab-content">
        {activeTab === "trades" && <TradeHistory market={market} />}
        {activeTab === "backtest" && (
          <BacktestResults summary={backtestSummary} trades={backtestTrades} />
        )}

        {activeTab === "open" && (
          <>
            <div className="orders-table-header">
              <span>Pair</span>
              <span>Side</span>
              <span>Size</span>
              <span>Remaining</span>
              <span>Time</span>
              <span>Status</span>
              <span>Action</span>
            </div>
            {openOrders.length === 0 ? (
              <div className="no-orders-msg">No open orders</div>
            ) : (
              openOrders.map((order) => {
                  const m = markets.find((item) => item.id === order.marketId);
                  const dec = m?.baseToken.decimals ?? 18;
                  return (
                    <div className="order-row" key={order.id}>
                      <span>{m?.symbol ?? order.marketId.slice(0, 10)}</span>
                      <span className={`order-side ${order.side === "BUY" ? "buy" : "sell"}`}>
                        {order.side}
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                        {formatUnits(BigInt(order.remainingAtomic), dec)}
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                        {formatUnits(BigInt(order.remainingAtomic), dec)}
                      </span>
                      <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                        {new Date(order.createdAt).toLocaleTimeString()}
                      </span>
                      <span className={`order-status ${order.status.toLowerCase()}`}>
                        {order.status}
                      </span>
                      <button
                        className="order-action-btn"
                        disabled={!address || cancellingId === order.id}
                        onClick={() => void handleCancel(order.id)}
                      >
                        {cancellingId === order.id ? "Cancelling..." : "Cancel"}
                      </button>
                    </div>
                  );
                })
            )}
            {status && <div className="table-status-msg">{status}</div>}
          </>
        )}

        {activeTab === "history" && (
          <>
            <div className="orders-table-header">
              <span>Pair</span>
              <span>Side</span>
              <span>Size</span>
              <span>Remaining</span>
              <span>Time</span>
              <span>Status</span>
              <span>Action</span>
            </div>
            {orders.length === 0 ? (
              <div className="no-orders-msg">No order history</div>
            ) : (
              orders.map((order) => {
                const m = markets.find((item) => item.id === order.marketId);
                const dec = m?.baseToken.decimals ?? 18;
                return (
                  <div className="order-row" key={order.id}>
                    <span>{m?.symbol ?? order.marketId.slice(0, 10)}</span>
                    <span className={`order-side ${order.side === "BUY" ? "buy" : "sell"}`}>
                      {order.side}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {formatUnits(BigInt(order.remainingAtomic), dec)}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {formatUnits(BigInt(order.remainingAtomic), dec)}
                    </span>
                    <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                      {new Date(order.createdAt).toLocaleTimeString()}
                    </span>
                    <span className={`order-status ${order.status.toLowerCase()}`}>
                      {order.status}
                    </span>
                    <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>
                      {order.status === "OPEN" || order.status === "PARTIAL" ? "Active" : "Closed"}
                    </span>
                  </div>
                );
              })
            )}
          </>
        )}
      </div>
    </div>
  );
}
