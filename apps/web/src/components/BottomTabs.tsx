import { useState } from "react";
import { formatUnits } from "viem";
import { TradeHistory } from "./TradeHistory";

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
  market?: MarketSnapshot;
  orders: Order[];
  markets: MarketSnapshot[];
};

export function BottomTabs({ market, orders, markets }: Props) {
  const [activeTab, setActiveTab] = useState<"trades" | "open" | "history">("trades");

  return (
    <div className="bottom-panel">
      <div className="bottom-tabs-bar">
        <button
          className={`bottom-tab ${activeTab === "open" ? "active" : ""}`}
          onClick={() => setActiveTab("open")}
        >
          Open Orders ({orders.filter((o) => o.status === "OPEN" || o.status === "PARTIAL").length})
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
      </div>

      <div className="bottom-tab-content">
        {activeTab === "trades" && <TradeHistory market={market} />}

        {activeTab === "open" && (
          <>
            <div className="orders-table-header">
              <span>Pair</span>
              <span>Side</span>
              <span>Size</span>
              <span>Remaining</span>
              <span>Time</span>
              <span>Status</span>
            </div>
            {orders.filter((o) => o.status === "OPEN" || o.status === "PARTIAL").length === 0 ? (
              <div className="no-orders-msg">No open orders</div>
            ) : (
              orders
                .filter((o) => o.status === "OPEN" || o.status === "PARTIAL")
                .map((order) => {
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
                    </div>
                  );
                })
            )}
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
