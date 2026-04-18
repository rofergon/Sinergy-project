import type { StrategyBacktestSummary, StrategyBacktestTrade } from "@sinergy/shared";

type Props = {
  summary: StrategyBacktestSummary | null;
  trades: StrategyBacktestTrade[];
};

function formatMetric(value: number, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

export function BacktestSummaryGrid({ summary }: { summary: StrategyBacktestSummary }) {
  return (
    <div className="backtest-metric-grid">
      <div className="backtest-metric-card">
        <span>Net PnL</span>
        <strong className={summary.netPnl >= 0 ? "up" : "down"}>
          {formatMetric(summary.netPnl)} ({formatMetric(summary.netPnlPct)}%)
        </strong>
      </div>
      <div className="backtest-metric-card">
        <span>Win Rate</span>
        <strong>{formatMetric(summary.winRate)}%</strong>
      </div>
      <div className="backtest-metric-card">
        <span>Max Drawdown</span>
        <strong>{formatMetric(summary.maxDrawdownPct)}%</strong>
      </div>
      <div className="backtest-metric-card">
        <span>Profit Factor</span>
        <strong>{formatMetric(summary.profitFactor, 3)}</strong>
      </div>
      <div className="backtest-metric-card">
        <span>Trades</span>
        <strong>{summary.tradeCount}</strong>
      </div>
      <div className="backtest-metric-card">
        <span>Avg Trade / Expectancy</span>
        <strong>
          {formatMetric(summary.avgTradeNetPnl)} / {formatMetric(summary.expectancy)}
        </strong>
      </div>
      <div className="backtest-metric-card">
        <span>Exposure / Avg Bars</span>
        <strong>
          {formatMetric(summary.exposurePct)}% / {formatMetric(summary.avgBarsHeld)}
        </strong>
      </div>
      <div className="backtest-metric-card">
        <span>Fees / Slippage</span>
        <strong>
          {formatMetric(summary.feesPaid)} / {formatMetric(summary.slippagePaid)}
        </strong>
      </div>
    </div>
  );
}

export function BacktestResults({ summary, trades }: Props) {
  if (!summary) {
    return <div className="no-orders-msg">Run a strategy backtest to see metrics and trades.</div>;
  }

  return (
    <div className="backtest-results">
      <BacktestSummaryGrid summary={summary} />

      <div className="orders-table-header">
        <span>Side</span>
        <span>Entry</span>
        <span>Exit</span>
        <span>Qty</span>
        <span>Net PnL</span>
        <span>Reason</span>
        <span>Bars</span>
      </div>

      {trades.length === 0 ? (
        <div className="no-orders-msg">No closed trades in this run.</div>
      ) : (
        trades.map((trade) => (
          <div className="order-row" key={trade.id}>
            <span className={`order-side ${trade.side === "long" ? "buy" : "sell"}`}>
              {trade.side.toUpperCase()}
            </span>
            <span>{formatMetric(trade.entryPrice, 4)}</span>
            <span>{formatMetric(trade.exitPrice, 4)}</span>
            <span>{formatMetric(trade.quantity, 4)}</span>
            <span className={trade.netPnl >= 0 ? "trade-price buy" : "trade-price sell"}>
              {formatMetric(trade.netPnl, 4)}
            </span>
            <span>{trade.exitReason}</span>
            <span>{trade.barsHeld}</span>
          </div>
        ))
      )}
    </div>
  );
}
