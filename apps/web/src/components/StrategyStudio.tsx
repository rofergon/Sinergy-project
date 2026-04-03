import { useMemo, useState } from "react";
import type { StrategyTimeframe } from "@sinergy/shared";
import type { StrategyBacktestBundle, MarketSnapshot } from "../types";
import { TradingViewChart } from "./TradingViewChart";
import { BottomTabs } from "./BottomTabs";
import { StrategyPanel } from "./StrategyPanel";
import { StrategyAgentPanel } from "./StrategyAgentPanel";

type Props = {
  address?: `0x${string}`;
  markets: MarketSnapshot[];
  selectedMarketId?: `0x${string}`;
  timeframe: StrategyTimeframe;
  onSelectMarket: (marketId: `0x${string}`) => void;
  onTimeframeChange: (timeframe: StrategyTimeframe) => void;
  orders: Array<{
    id: string;
    marketId: `0x${string}`;
    side: "BUY" | "SELL";
    remainingAtomic: string;
    createdAt: string;
    status: string;
  }>;
  onCancelOrder: (orderId: string) => Promise<void>;
  strategyBacktest: StrategyBacktestBundle | null;
  onBacktestResult: (result: StrategyBacktestBundle | null) => void;
  workspaceMode: "manual" | "agentic";
  onWorkspaceModeChange: (mode: "manual" | "agentic") => void;
  onGoTrade: () => void;
};

export function StrategyStudio({
  address,
  markets,
  selectedMarketId,
  timeframe,
  onSelectMarket,
  onTimeframeChange,
  orders,
  onCancelOrder,
  strategyBacktest,
  onBacktestResult,
  workspaceMode,
  onWorkspaceModeChange,
  onGoTrade
}: Props) {
  const [focusStrategyId, setFocusStrategyId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const selectedMarket = useMemo(
    () => markets.find((market) => market.id === selectedMarketId) ?? markets[0],
    [markets, selectedMarketId]
  );

  function reviewStrategy(strategyId: string, bundle: StrategyBacktestBundle | null) {
    setFocusStrategyId(strategyId);
    setRefreshToken((current) => current + 1);
    if (bundle) {
      onBacktestResult(bundle);
    }
    onWorkspaceModeChange("manual");
  }

  return (
    <div className="strategy-studio-page">
      <aside className="strategy-studio-side">
        <div className="strategy-studio-card hero">
          <span className="strategy-studio-kicker">Strategy Studio</span>
          <h1>Build, test, and iterate from one workspace.</h1>
          <p>
            Move between manual rule editing and agent-guided generation without leaving the chart or
            backtest context.
          </p>
        </div>

        <div className="strategy-studio-card">
          <span className="panel-title">Quick Actions</span>
          <div className="strategy-studio-action-list">
            <button type="button" onClick={() => onWorkspaceModeChange("manual")}>
              Open Manual Builder
            </button>
            <button type="button" onClick={() => onWorkspaceModeChange("agentic")}>
              Open Agent Chat
            </button>
            <button type="button" onClick={onGoTrade}>
              Return To Trade
            </button>
          </div>
        </div>

        <div className="strategy-studio-card">
          <span className="panel-title">Current Context</span>
          <div className="strategy-studio-context-grid">
            <div>
              <span>Market</span>
              <strong>{selectedMarket?.symbol ?? "--"}</strong>
            </div>
            <div>
              <span>Timeframe</span>
              <strong>{timeframe}</strong>
            </div>
            <div>
              <span>Mode</span>
              <strong>{workspaceMode === "manual" ? "Manual Builder" : "Agent Workspace"}</strong>
            </div>
            <div>
              <span>Backtest</span>
              <strong>{strategyBacktest ? `${strategyBacktest.summary.tradeCount} trades` : "Not run yet"}</strong>
            </div>
          </div>
        </div>
      </aside>

      <div className="strategy-studio-main">
        <div className="strategy-studio-topbar">
          <div>
            <span className="panel-title">Workspace</span>
            <p>
              Use the manual builder for precise editing, or switch to the agent workspace to describe
              a strategy in natural language.
            </p>
          </div>
          <div className="strategy-studio-mode-tabs">
            <button
              type="button"
              className={`trade-mode-tab ${workspaceMode === "manual" ? "active" : ""}`}
              onClick={() => onWorkspaceModeChange("manual")}
            >
              Manual Builder
            </button>
            <button
              type="button"
              className={`trade-mode-tab ${workspaceMode === "agentic" ? "active" : ""}`}
              onClick={() => onWorkspaceModeChange("agentic")}
            >
              Agent Workspace
            </button>
          </div>
        </div>

        <div className="strategy-studio-grid">
          <div className="strategy-studio-chart-col">
            <TradingViewChart
              market={selectedMarket}
              timeframe={timeframe}
              onTimeframeChange={onTimeframeChange}
              overlay={strategyBacktest?.overlay ?? null}
            />
            <BottomTabs
              address={address}
              market={selectedMarket}
              orders={orders}
              markets={markets}
              onCancelOrder={onCancelOrder}
              backtestSummary={strategyBacktest?.summary ?? null}
              backtestTrades={strategyBacktest?.trades ?? []}
            />
          </div>

          <div className="strategy-studio-workspace-col">
            {workspaceMode === "manual" ? (
              <StrategyPanel
                address={address}
                markets={markets}
                selectedMarketId={selectedMarket?.id}
                timeframe={timeframe}
                onSelectMarket={onSelectMarket}
                onTimeframeChange={onTimeframeChange}
                onBacktestResult={onBacktestResult}
                focusStrategyId={focusStrategyId}
                refreshToken={refreshToken}
              />
            ) : (
              <StrategyAgentPanel
                address={address}
                selectedMarket={selectedMarket}
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
