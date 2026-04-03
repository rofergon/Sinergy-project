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
      <div className="strategy-studio-main">
        <div className="strategy-studio-topbar">
          <div className="strategy-studio-toolbar-copy">
            <span className="panel-title">Strategy Workspace</span>
            <div className="strategy-studio-toolbar-meta">
              <span>{selectedMarket?.symbol ?? "--"}</span>
              <span>{timeframe}</span>
              <span>{workspaceMode === "manual" ? "Manual Builder" : "Agent Workspace"}</span>
              <span>{strategyBacktest ? `${strategyBacktest.summary.tradeCount} trades` : "No backtest yet"}</span>
            </div>
          </div>
          <div className="strategy-studio-toolbar-actions">
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
            <button type="button" className="strategy-studio-trade-btn" onClick={onGoTrade}>
              Return To Trade
            </button>
          </div>
        </div>

        <div className={`strategy-studio-grid ${workspaceMode === "agentic" ? "agentic-mode" : ""}`}>
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
