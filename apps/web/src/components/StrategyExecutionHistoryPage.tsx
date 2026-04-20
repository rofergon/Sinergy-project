import { useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { fetchStrategyExecutionHistory } from "../lib/api";
import type { MarketSnapshot, StrategyExecutionRecord, StrategyExecutionStrategySummary } from "../types";

type Props = {
  address?: `0x${string}`;
  markets: MarketSnapshot[];
};

function fmtNumber(value?: number, digits = 2) {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(digits);
}

function strategyStatusLabel(status: StrategyExecutionStrategySummary["status"]) {
  switch (status) {
    case "active":
      return "Active";
    case "pending":
      return "Pending";
    default:
      return "Idle";
  }
}

function tradeStatusClass(status: string) {
  if (status === "completed") return "buy";
  if (status === "failed") return "sell";
  return "";
}

function resolveTokenSymbol(markets: MarketSnapshot[], marketId: `0x${string}`, token?: `0x${string}`) {
  if (!token) return "--";
  const market = markets.find((entry) => entry.id === marketId);
  if (!market) return token.slice(0, 10);
  if (market.baseToken.address.toLowerCase() === token.toLowerCase()) return market.baseToken.symbol;
  if (market.quoteToken.address.toLowerCase() === token.toLowerCase()) return market.quoteToken.symbol;
  return token.slice(0, 10);
}

function atomicToDisplay(
  markets: MarketSnapshot[],
  trade: StrategyExecutionRecord,
  atomic?: string,
  token?: `0x${string}`
) {
  if (!atomic || !token) return "--";
  const market = markets.find((entry) => entry.id === trade.marketId);
  if (!market) return atomic;
  const decimals =
    market.baseToken.address.toLowerCase() === token.toLowerCase()
      ? market.baseToken.decimals
      : market.quoteToken.decimals;
  return formatUnits(BigInt(atomic), decimals);
}

export function StrategyExecutionHistoryPage({ address, markets }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [strategies, setStrategies] = useState<StrategyExecutionStrategySummary[]>([]);
  const [trades, setTrades] = useState<StrategyExecutionRecord[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!address) {
        setStrategies([]);
        setTrades([]);
        return;
      }

      setBusy(true);
      setError("");
      try {
        const result = await fetchStrategyExecutionHistory(address);
        if (!cancelled) {
          setStrategies(result.strategies);
          setTrades(result.trades);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
        }
      }
    }

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [address]);

  const groupedTrades = useMemo(() => {
    const next = new Map<string, StrategyExecutionRecord[]>();
    for (const trade of trades) {
      const bucket = next.get(trade.strategyId) ?? [];
      bucket.push(trade);
      next.set(trade.strategyId, bucket);
    }
    return next;
  }, [trades]);

  return (
    <div className="strategy-history-page">
      <div className="portfolio-hero">
        <div>
          <div className="portfolio-kicker">Strategy History</div>
          <h1>Authorized strategy execution log</h1>
          <p>
            Review signed strategy runs, execution prices, bridge-backed trades, and current PnL per strategy.
          </p>
        </div>
        <div className="portfolio-summary-grid">
          <div className="portfolio-stat-card">
            <span>Tracked strategies</span>
            <strong>{strategies.length}</strong>
          </div>
          <div className="portfolio-stat-card">
            <span>Total trades</span>
            <strong>{trades.length}</strong>
          </div>
          <div className="portfolio-stat-card">
            <span>Refreshing</span>
            <strong>{busy ? "Yes" : "Live"}</strong>
          </div>
        </div>
      </div>

      {error && <div className="error-bar">{error}</div>}

      <div className="strategy-history-layout">
        <section className="portfolio-section">
          <div className="portfolio-section-head">
            <h2>Strategies</h2>
            <span>{strategies.length} tracked</span>
          </div>
          {strategies.length === 0 ? (
            <div className="portfolio-empty">No strategy execution history for this wallet yet.</div>
          ) : (
            <div className="strategy-history-strategy-list">
              {strategies.map((strategy) => (
                <div key={strategy.strategyId} className="strategy-history-strategy-card">
                  <div className="strategy-history-strategy-head">
                    <div>
                      <strong>{strategy.strategyName}</strong>
                      <p>{strategy.marketSymbol}</p>
                    </div>
                    <span className={`order-status ${strategy.status}`}>
                      {strategyStatusLabel(strategy.status)}
                    </span>
                  </div>
                  <div className="strategy-history-strategy-grid">
                    <div>
                      <span>Started</span>
                      <strong>{new Date(strategy.startedAt).toLocaleString()}</strong>
                    </div>
                    <div>
                      <span>Last trade</span>
                      <strong>{strategy.lastTradeAt ? new Date(strategy.lastTradeAt).toLocaleString() : "--"}</strong>
                    </div>
                    <div>
                      <span>Trades</span>
                      <strong>{strategy.tradesCount}</strong>
                    </div>
                    <div>
                      <span>Position</span>
                      <strong>{strategy.currentPositionBase}</strong>
                    </div>
                    <div>
                      <span>Current price</span>
                      <strong>{fmtNumber(strategy.currentPrice, 4)}</strong>
                    </div>
                    <div>
                      <span>PnL now</span>
                      <strong className={strategy.currentPnlQuote !== undefined && strategy.currentPnlQuote < 0 ? "order-side sell" : "order-side buy"}>
                        {fmtNumber(strategy.currentPnlQuote, 4)}
                      </strong>
                    </div>
                  </div>

                  <div className="strategy-history-trades-table">
                    <div className="orders-table-header">
                      <span>Time</span>
                      <span>Signal</span>
                      <span>Action</span>
                      <span>In</span>
                      <span>Out</span>
                      <span>Price</span>
                      <span>Status</span>
                      <span>L1 Tx</span>
                    </div>
                    {(groupedTrades.get(strategy.strategyId) ?? []).map((trade) => (
                      <div className="order-row" key={trade.id}>
                        <span>{new Date(trade.createdAt).toLocaleString()}</span>
                        <span>{trade.signal.replace(/_/g, " ")}</span>
                        <span>{trade.action.replace(/_/g, " ")}</span>
                        <span>
                          {atomicToDisplay(markets, trade, trade.amountInAtomic, trade.fromToken)}{" "}
                          {resolveTokenSymbol(markets, trade.marketId, trade.fromToken)}
                        </span>
                        <span>
                          {atomicToDisplay(markets, trade, trade.actualOutAtomic ?? trade.quotedOutAtomic, trade.toToken)}{" "}
                          {resolveTokenSymbol(markets, trade.marketId, trade.toToken)}
                        </span>
                        <span>{fmtNumber(trade.executionPrice, 6)}</span>
                        <span className={`order-status ${tradeStatusClass(trade.status)}`}>
                          {trade.status}
                        </span>
                        <span className="strategy-history-txhash">
                          {trade.l1TxHash ? `${trade.l1TxHash.slice(0, 10)}...${trade.l1TxHash.slice(-6)}` : "--"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
