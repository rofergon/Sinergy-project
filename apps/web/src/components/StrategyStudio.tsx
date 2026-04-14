import { useMemo, useState } from "react";
import type { StrategyTimeframe } from "@sinergy/shared";
import { fetchBacktestBundle } from "../lib/api";
import type { ChartViewport, StrategyBacktestBundle, MarketSnapshot } from "../types";
import { TradingViewChart } from "./TradingViewChart";
import { StrategyPanel } from "./StrategyPanel";
import { StrategyAgentPanel } from "./StrategyAgentPanel";

type Props = {
  address?: `0x${string}`;
  markets: MarketSnapshot[];
  selectedMarketId?: `0x${string}`;
  timeframe: StrategyTimeframe;
  onSelectMarket: (marketId: `0x${string}`) => void;
  onTimeframeChange: (timeframe: StrategyTimeframe) => void;
  strategyBacktest: StrategyBacktestBundle | null;
  onBacktestResult: (result: StrategyBacktestBundle | null) => void;
};

export function StrategyStudio({
  address,
  markets,
  selectedMarketId,
  timeframe,
  onSelectMarket,
  onTimeframeChange,
  strategyBacktest,
  onBacktestResult,
}: Props) {
  const [focusStrategyId, setFocusStrategyId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [viewport, setViewport] = useState<ChartViewport | null>(null);
  const [manualBuilderOpen, setManualBuilderOpen] = useState(false);

  const selectedMarket = useMemo(
    () => markets.find((market) => market.id === selectedMarketId) ?? markets[0],
    [markets, selectedMarketId]
  );

  async function reviewStrategy(
    strategyId: string,
    bundle: StrategyBacktestBundle | null,
    runId?: string
  ) {
    setFocusStrategyId(strategyId);
    setRefreshToken((current) => current + 1);
    if (bundle) {
      onBacktestResult(bundle);
    } else if (address && runId) {
      try {
        const restoredBundle = await fetchBacktestBundle(address, runId);
        onBacktestResult(restoredBundle);
      } catch {
        onBacktestResult(null);
      }
    }
    setManualBuilderOpen(true);
  }

  return (
    <div className="strategy-studio-page">
      <div className="strategy-studio-main">
        <div className="strategy-studio-topbar">
          <div className="strategy-studio-toolbar-copy">
            <span className="panel-title">Agent Workspace</span>
            <div className="strategy-studio-toolbar-meta">
              <span>{selectedMarket?.symbol ?? "--"}</span>
              <span>{timeframe}</span>
              <span>{manualBuilderOpen ? "Strategy Editor" : "Agent Workspace"}</span>
              <span>{strategyBacktest ? `${strategyBacktest.summary.tradeCount} trades` : "No backtest yet"}</span>
            </div>
          </div>
          <div className="strategy-studio-toolbar-actions">
            <button
              type="button"
              className="strategy-studio-secondary-link"
              onClick={() => setManualBuilderOpen((current) => !current)}
            >
              {manualBuilderOpen ? "Back to agent" : "Edit strategy"}
            </button>
          </div>
        </div>

        <div className={`strategy-studio-grid ${manualBuilderOpen ? "manual-open" : "agent-primary"}`}>
          <div className="strategy-studio-chart-col">
            <TradingViewChart
              market={selectedMarket}
              timeframe={timeframe}
              onTimeframeChange={onTimeframeChange}
              overlay={strategyBacktest?.overlay ?? null}
              onVisibleBarsChange={setViewport}
            />
          </div>

          <div className="strategy-studio-workspace-col">
            {manualBuilderOpen ? (
              <div className="strategy-studio-secondary-panel">
                <div className="strategy-studio-secondary-banner">
                  <div>
                    <strong>Strategy Editor</strong>
                    <p>
                      Edit the key parameters of your strategy: indicators, risk, and rules.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="strategy-studio-secondary-link"
                    onClick={() => setManualBuilderOpen(false)}
                  >
                    Back to agent
                  </button>
                </div>
                <StrategyPanel
                  address={address}
                  markets={markets}
                  selectedMarketId={selectedMarket?.id}
                  timeframe={timeframe}
                  viewport={viewport}
                  onSelectMarket={onSelectMarket}
                  onTimeframeChange={onTimeframeChange}
                  onBacktestResult={onBacktestResult}
                  focusStrategyId={focusStrategyId}
                  refreshToken={refreshToken}
                />
              </div>
            ) : (
              <StrategyAgentPanel
                address={address}
                selectedMarket={selectedMarket}
                selectedTimeframe={timeframe}
                viewport={viewport}
                onBacktestResult={onBacktestResult}
                onTimeframeChange={onTimeframeChange}
                onReviewStrategy={reviewStrategy}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
