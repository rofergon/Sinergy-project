import { useState } from "react";
import { formatUnits } from "viem";
import type { TxPopupData } from "./TransactionPopup";

type Token = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  kind: "quote" | "rwa" | "crypto";
};

type Order = {
  id: string;
  marketId: `0x${string}`;
  side: "BUY" | "SELL";
  remainingAtomic: string;
  status: "OPEN" | "PARTIAL" | "FILLED" | "CANCELLED";
  createdAt: string;
};

type Market = {
  id: `0x${string}`;
  symbol: string;
  baseToken: Token;
};

type Props = {
  connected: boolean;
  address?: `0x${string}`;
  initiaAddress?: string;
  vaultAddress: `0x${string}`;
  zkVaultAddress?: `0x${string}`;
  tokens: Token[];
  balances: {
    available: Record<string, string>;
    locked: Record<string, string>;
  } | null;
  orders: Order[];
  markets: Market[];
  onAfterMutation: () => Promise<void>;
  onCancelOrder: (orderId: string) => Promise<void>;
  showTx: (data: TxPopupData) => void;
};

function tokenAmount(
  bucket: Record<string, string> | undefined,
  token: Token
) {
  const atomic = bucket?.[token.address.toLowerCase()] ?? "0";
  return Number(formatUnits(BigInt(atomic), token.decimals));
}

function fmt(value: number, decimals = 4) {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(value >= 1 ? 2 : decimals);
}

export function PortfolioView({
  address,
  tokens,
  balances,
  orders,
  markets,
  onCancelOrder,
}: Props) {
  const activeOrders = orders.filter((order) => order.status === "OPEN" || order.status === "PARTIAL");
  const pendingBuys = activeOrders.filter((order) => order.side === "BUY");
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const nonZeroTokens = [...tokens].sort((a, b) => {
    const aTotal = tokenAmount(balances?.available, a) + tokenAmount(balances?.locked, a);
    const bTotal = tokenAmount(balances?.available, b) + tokenAmount(balances?.locked, b);
    return Number(bTotal > aTotal) - Number(bTotal < aTotal);
  });

  const availableTokensCount = tokens.filter((token) => tokenAmount(balances?.available, token) > 0).length;
  const lockedTokensCount = tokens.filter((token) => tokenAmount(balances?.locked, token) > 0).length;

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

  return (
    <div className="portfolio-page">
      <div className="portfolio-hero">
        <div>
          <div className="portfolio-kicker">Portfolio</div>
          <h1>Positions and vault activity</h1>
          <p>
            Track available balances, locked funds and open orders in one place.
          </p>
        </div>
        <div className="portfolio-summary-grid">
          <div className="portfolio-stat-card">
            <span>Available tokens</span>
            <strong>{availableTokensCount}</strong>
          </div>
          <div className="portfolio-stat-card">
            <span>Locked tokens</span>
            <strong>{lockedTokensCount}</strong>
          </div>
          <div className="portfolio-stat-card">
            <span>Open orders</span>
            <strong>{activeOrders.length}</strong>
          </div>
        </div>
      </div>

      {pendingBuys.length > 0 && (
        <div className="portfolio-callout">
          <strong>Pending buys waiting for a match</strong>
          <p>
            Your purchase is not settled yet. The quote token stays locked until a sell order matches or the order is cancelled.
          </p>
        </div>
      )}

      <div className="portfolio-layout">
        <div className="portfolio-main">
          <section className="portfolio-section">
            <div className="portfolio-section-head">
              <h2>Open orders</h2>
              <span>{activeOrders.length} active</span>
            </div>

            {activeOrders.length === 0 ? (
              <div className="portfolio-empty">No open orders right now.</div>
            ) : (
              <div className="portfolio-orders-table">
                <div className="portfolio-orders-header">
                  <span>Pair</span>
                  <span>Side</span>
                  <span>Remaining</span>
                  <span>Status</span>
                  <span>Time</span>
                  <span>Action</span>
                </div>
                {activeOrders.map((order) => {
                  const market = markets.find((item) => item.id === order.marketId);
                  const decimals = market?.baseToken.decimals ?? 18;
                  return (
                    <div className="portfolio-orders-row" key={order.id}>
                      <span>{market?.symbol ?? order.marketId.slice(0, 10)}</span>
                      <span className={`order-side ${order.side === "BUY" ? "buy" : "sell"}`}>
                        {order.side}
                      </span>
                      <span>{fmt(Number(formatUnits(BigInt(order.remainingAtomic), decimals)))}</span>
                      <span className={`order-status ${order.status.toLowerCase()}`}>
                        {order.status}
                      </span>
                      <span>{new Date(order.createdAt).toLocaleTimeString()}</span>
                      <button
                        className="order-action-btn"
                        disabled={!address || cancellingId === order.id}
                        onClick={() => void handleCancel(order.id)}
                      >
                        {cancellingId === order.id ? "Cancelling..." : "Cancel"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {status && <div className="table-status-msg">{status}</div>}
          </section>

          <section className="portfolio-section">
            <div className="portfolio-section-head">
              <h2>Balance breakdown</h2>
              <span>Available and locked</span>
            </div>
            <div className="portfolio-balance-list">
              {nonZeroTokens.map((token) => {
                const available = tokenAmount(balances?.available, token);
                const locked = tokenAmount(balances?.locked, token);
                return (
                  <div className="portfolio-balance-row" key={token.address}>
                    <div>
                      <strong>{token.symbol}</strong>
                      <p>{token.name}</p>
                    </div>
                    <div className="portfolio-balance-values">
                      <span>Available {fmt(available)}</span>
                      <span>Locked {fmt(locked)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

      </div>
    </div>
  );
}
