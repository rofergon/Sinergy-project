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

function isRealExecution(record: StrategyExecutionRecord) {
  return record.action !== "no_action";
}

function isMonitorEvent(record: StrategyExecutionRecord) {
  return record.action === "no_action";
}

type ExecutionTradeRow = {
  id: string;
  side: "long" | "short";
  entry?: StrategyExecutionRecord;
  exit?: StrategyExecutionRecord;
  sortAt: string;
};

function buildExecutionTradeRows(records: StrategyExecutionRecord[]) {
  const sorted = [...records].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const rows: ExecutionTradeRow[] = [];
  let openLong: StrategyExecutionRecord | undefined;
  let openShort: StrategyExecutionRecord | undefined;

  for (const record of sorted) {
    if (record.signal === "long_entry") {
      if (openLong) {
        rows.push({
          id: `trade-${openLong.id}`,
          side: "long",
          entry: openLong,
          sortAt: openLong.createdAt
        });
      }
      openLong = record;
      continue;
    }

    if (record.signal === "long_exit") {
      rows.push({
        id: `trade-${openLong?.id ?? record.id}-${record.id}`,
        side: "long",
        entry: openLong,
        exit: record,
        sortAt: record.createdAt
      });
      openLong = undefined;
      continue;
    }

    if (record.signal === "short_entry") {
      if (openShort) {
        rows.push({
          id: `trade-${openShort.id}`,
          side: "short",
          entry: openShort,
          sortAt: openShort.createdAt
        });
      }
      openShort = record;
      continue;
    }

    if (record.signal === "short_exit") {
      rows.push({
        id: `trade-${openShort?.id ?? record.id}-${record.id}`,
        side: "short",
        entry: openShort,
        exit: record,
        sortAt: record.createdAt
      });
      openShort = undefined;
    }
  }

  if (openLong) {
    rows.push({
      id: `trade-${openLong.id}`,
      side: "long",
      entry: openLong,
      sortAt: openLong.createdAt
    });
  }

  if (openShort) {
    rows.push({
      id: `trade-${openShort.id}`,
      side: "short",
      entry: openShort,
      sortAt: openShort.createdAt
    });
  }

  return rows.sort((left, right) => Date.parse(right.sortAt) - Date.parse(left.sortAt));
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

function formatLegSummary(markets: MarketSnapshot[], trade: StrategyExecutionRecord) {
  const amountIn = atomicToDisplay(markets, trade, trade.amountInAtomic, trade.fromToken);
  const amountOut = atomicToDisplay(markets, trade, trade.actualOutAtomic ?? trade.quotedOutAtomic, trade.toToken);
  const fromSymbol = resolveTokenSymbol(markets, trade.marketId, trade.fromToken);
  const toSymbol = resolveTokenSymbol(markets, trade.marketId, trade.toToken);
  return `${amountIn} ${fromSymbol} -> ${amountOut} ${toSymbol}`;
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
  const realTradeCount = useMemo(() => trades.filter(isRealExecution).length, [trades]);
  const monitorEventCount = useMemo(() => trades.filter(isMonitorEvent).length, [trades]);

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
            <span>Real trades</span>
            <strong>{realTradeCount}</strong>
          </div>
          <div className="portfolio-stat-card">
            <span>Monitor events</span>
            <strong>{monitorEventCount}</strong>
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
              {strategies.map((strategy) => {
                const strategyRecords = groupedTrades.get(strategy.strategyId) ?? [];
                const executionRows = strategyRecords.filter(isRealExecution);
                const tradeRows = buildExecutionTradeRows(executionRows);
                const monitorRows = strategyRecords.filter(isMonitorEvent);
                const lastRealTradeAt = tradeRows[0]?.exit?.createdAt ?? tradeRows[0]?.entry?.createdAt;

                return (
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
                        <strong>{lastRealTradeAt ? new Date(lastRealTradeAt).toLocaleString() : "--"}</strong>
                      </div>
                      <div>
                        <span>Trades</span>
                        <strong>{tradeRows.length}</strong>
                      </div>
                      <div>
                        <span>Monitor log</span>
                        <strong>{monitorRows.length}</strong>
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
                      <div className="portfolio-section-head">
                        <h2>Real executions</h2>
                        <span>{tradeRows.length} trades</span>
                      </div>
                      {tradeRows.length === 0 ? (
                        <div className="portfolio-empty">No real trades have been executed for this strategy yet.</div>
                      ) : (
                        <>
                          <div className="strategy-history-trade-header">
                            <span>Trade</span>
                            <span>Entry</span>
                            <span>Exit</span>
                            <span>Entry Price</span>
                            <span>Exit Price</span>
                            <span>Status</span>
                          </div>
                          {tradeRows.map((tradeRow) => {
                            const tradeStatus = tradeRow.exit?.status ?? tradeRow.entry?.status ?? "open";

                            return (
                              <div className="strategy-history-trade-row" key={tradeRow.id}>
                                <span className="strategy-history-trade-kind">
                                  {tradeRow.side === "long" ? "Long" : "Short"}
                                </span>
                                <span className="strategy-history-trade-cell">
                                  {tradeRow.entry ? (
                                    <>
                                      <strong>{new Date(tradeRow.entry.createdAt).toLocaleString()}</strong>
                                      <small>{formatLegSummary(markets, tradeRow.entry)}</small>
                                    </>
                                  ) : (
                                    <small>--</small>
                                  )}
                                </span>
                                <span className="strategy-history-trade-cell">
                                  {tradeRow.exit ? (
                                    <>
                                      <strong>{new Date(tradeRow.exit.createdAt).toLocaleString()}</strong>
                                      <small>{formatLegSummary(markets, tradeRow.exit)}</small>
                                      <small className="strategy-history-txhash">
                                        {tradeRow.exit.l1TxHash
                                          ? `${tradeRow.exit.l1TxHash.slice(0, 10)}...${tradeRow.exit.l1TxHash.slice(-6)}`
                                          : "--"}
                                      </small>
                                    </>
                                  ) : (
                                    <small>Position still open</small>
                                  )}
                                </span>
                                <span>{fmtNumber(tradeRow.entry?.executionPrice, 6)}</span>
                                <span>{fmtNumber(tradeRow.exit?.executionPrice, 6)}</span>
                                <span className={`order-status ${tradeStatusClass(tradeStatus)}`}>
                                  {tradeStatus}
                                </span>
                              </div>
                            );
                          })}
                        </>
                      )}
                    </div>

                    <div className="strategy-history-trades-table">
                      <div className="portfolio-section-head">
                        <h2>Execution legs</h2>
                        <span>{executionRows.length} rows</span>
                      </div>
                      {executionRows.length === 0 ? (
                        <div className="portfolio-empty">No execution legs were recorded for this strategy.</div>
                      ) : (
                        <>
                          <div className="orders-table-header">
                            <span>Time</span>
                            <span>Signal</span>
                            <span>Action</span>
                            <span>In</span>
                            <span>Out</span>
                            <span>Price</span>
                            <span>Status</span>
                          </div>
                          {executionRows.map((trade) => (
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
                            </div>
                          ))}
                        </>
                      )}
                    </div>

                    <div className="strategy-history-trades-table">
                      <div className="portfolio-section-head">
                        <h2>Monitor log</h2>
                        <span>{monitorRows.length} events</span>
                      </div>
                      {monitorRows.length === 0 ? (
                        <div className="portfolio-empty">No monitoring-only events were recorded for this strategy.</div>
                      ) : (
                        <>
                          <div className="orders-table-header">
                            <span>Time</span>
                            <span>Signal</span>
                            <span>Decision</span>
                            <span>Reason</span>
                            <span>Status</span>
                            <span>Action</span>
                            <span></span>
                            <span></span>
                          </div>
                          {monitorRows.map((trade) => (
                            <div className="order-row" key={trade.id}>
                              <span>{new Date(trade.createdAt).toLocaleString()}</span>
                              <span>{trade.signal.replace(/_/g, " ")}</span>
                              <span>{trade.action.replace(/_/g, " ")}</span>
                              <span>{trade.reason ?? "--"}</span>
                              <span className={`order-status ${tradeStatusClass(trade.status)}`}>
                                {trade.status}
                              </span>
                              <span>Monitor</span>
                              <span>--</span>
                              <span>--</span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
