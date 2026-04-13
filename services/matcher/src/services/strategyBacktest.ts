import { randomUUID } from "node:crypto";
import type {
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyChartOverlay,
  StrategyDefinition,
  StrategyExitReason,
  StrategyOverlayMarker
} from "@sinergy/shared";
import {
  buildIndicatorOverlays,
  type StrategyCandle
} from "./indicatorEngine.js";
import {
  buildRuntimeIndicatorSeriesMap,
  evaluateRuntimeCondition,
  runtimeEntryConditionForSide,
  runtimeExitConditionForSide
} from "./strategyRuntime.js";
import { compileEngineToRuntime } from "./strategySourceCompiler.js";
import { compileStrategyToRuntime } from "./strategyRuntime.js";

type Position = {
  side: "long" | "short";
  entryTime: number;
  entryPrice: number;
  quantity: number;
  entryIndex: number;
  entryFee: number;
  entrySlippage: number;
  highestClose: number;
  lowestClose: number;
};

function entryFillPrice(close: number, side: "long" | "short", slippageBps: number) {
  const factor = slippageBps / 10_000;
  return side === "long" ? close * (1 + factor) : close * (1 - factor);
}

function exitFillPrice(close: number, side: "long" | "short", slippageBps: number) {
  const factor = slippageBps / 10_000;
  return side === "long" ? close * (1 - factor) : close * (1 + factor);
}

function calcDrawdownPct(equityCurve: StrategyBacktestSummary["equityCurve"]) {
  let peak = equityCurve[0]?.equity ?? 0;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak <= 0) continue;
    maxDrawdown = Math.max(maxDrawdown, ((peak - point.equity) / peak) * 100);
  }
  return maxDrawdown;
}

function markerForEntry(side: "long" | "short", time: number): StrategyOverlayMarker {
  return {
    id: `entry-${side}-${time}-${randomUUID()}`,
    time,
    position: side === "long" ? "belowBar" : "aboveBar",
    shape: side === "long" ? "arrowUp" : "arrowDown",
    color: side === "long" ? "#0ecb81" : "#f6465d",
    text: side === "long" ? "Buy" : "Short"
  };
}

function markerForExit(side: "long" | "short", reason: StrategyExitReason, time: number): StrategyOverlayMarker {
  return {
    id: `exit-${side}-${time}-${randomUUID()}`,
    time,
    position: side === "long" ? "aboveBar" : "belowBar",
    shape: "circle",
    color: side === "long" ? "#f0b90b" : "#1e9df2",
    text: side === "long" ? `Sell (${reason})` : `Cover (${reason})`
  };
}

export function runStrategyBacktest(
  strategy: StrategyDefinition,
  candles: StrategyCandle[]
): {
  summary: StrategyBacktestSummary;
  trades: StrategyBacktestTrade[];
  overlay: StrategyChartOverlay;
} {
  const runtime = strategy.engine
    ? compileEngineToRuntime(strategy, strategy.engine)
    : compileStrategyToRuntime(strategy);
  const seriesMap = buildRuntimeIndicatorSeriesMap(candles, runtime);
  const overlayIndicators = buildIndicatorOverlays(candles, strategy, seriesMap);
  const markers: StrategyOverlayMarker[] = [];
  const trades: StrategyBacktestTrade[] = [];

  let realizedEquity = strategy.costModel.startingEquity;
  let grossPnlTotal = 0;
  let feeTotal = 0;
  let slippageTotal = 0;
  let position: Position | null = null;
  let barsWithExposure = 0;

  const equityCurve: StrategyBacktestSummary["equityCurve"] = candles.map((candle) => ({
    time: candle.ts,
    equity: strategy.costModel.startingEquity
  }));

  const closePosition = (index: number, reason: StrategyExitReason) => {
    if (!position) return;
    const candle = candles[index];
    const fillPrice = exitFillPrice(candle.close, position.side, strategy.costModel.slippageBps);
    const notional = fillPrice * position.quantity;
    const exitFee = (notional * strategy.costModel.feeBps) / 10_000;
    const exitSlippage = Math.abs(candle.close - fillPrice) * position.quantity;
    const grossPnl =
      position.side === "long"
        ? (fillPrice - position.entryPrice) * position.quantity
        : (position.entryPrice - fillPrice) * position.quantity;
    const netPnl = grossPnl - position.entryFee - exitFee;

    realizedEquity += grossPnl - exitFee;
    grossPnlTotal += grossPnl;
    feeTotal += position.entryFee + exitFee;
    slippageTotal += position.entrySlippage + exitSlippage;

    trades.push({
      id: randomUUID(),
      strategyId: strategy.id,
      runId: "",
      side: position.side,
      entryTime: position.entryTime,
      entryPrice: Number(position.entryPrice.toFixed(8)),
      exitTime: candle.ts,
      exitPrice: Number(fillPrice.toFixed(8)),
      quantity: Number(position.quantity.toFixed(8)),
      grossPnl: Number(grossPnl.toFixed(8)),
      netPnl: Number(netPnl.toFixed(8)),
      feesPaid: Number((position.entryFee + exitFee).toFixed(8)),
      slippagePaid: Number((position.entrySlippage + exitSlippage).toFixed(8)),
      exitReason: reason,
      barsHeld: index - position.entryIndex
    });
    markers.push(markerForExit(position.side, reason, candle.ts));
    position = null;
  };

  const openPosition = (index: number, side: "long" | "short") => {
    const candle = candles[index];
    const currentEquity = realizedEquity;
    const desiredNotional =
      strategy.sizing.mode === "percent_of_equity"
        ? currentEquity * (strategy.sizing.value / 100)
        : strategy.sizing.value;
    const notional = Math.min(Math.max(desiredNotional, 0), currentEquity);
    if (notional <= 0) return;

    const fillPrice = entryFillPrice(candle.close, side, strategy.costModel.slippageBps);
    const quantity = notional / fillPrice;
    const entryFee = (notional * strategy.costModel.feeBps) / 10_000;
    const entrySlippage = Math.abs(fillPrice - candle.close) * quantity;

    realizedEquity -= entryFee;
    feeTotal += entryFee;
    slippageTotal += entrySlippage;
    position = {
      side,
      entryTime: candle.ts,
      entryPrice: fillPrice,
      quantity,
      entryIndex: index,
      entryFee,
      entrySlippage,
      highestClose: candle.close,
      lowestClose: candle.close
    };
    markers.push(markerForEntry(side, candle.ts));
  };

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];

    const longEntry = strategy.enabledSides.includes("long")
      ? evaluateRuntimeCondition(runtimeEntryConditionForSide(runtime, "long"), candles, seriesMap, index)
      : false;
    const shortEntry = strategy.enabledSides.includes("short")
      ? evaluateRuntimeCondition(runtimeEntryConditionForSide(runtime, "short"), candles, seriesMap, index)
      : false;

    if (position) {
      const currentPosition = position as Position;
      currentPosition.highestClose = Math.max(currentPosition.highestClose, candle.close);
      currentPosition.lowestClose = Math.min(currentPosition.lowestClose, candle.close);

      let exitReason: StrategyExitReason | null = null;
      if (currentPosition.side === "long") {
        const stopLoss = strategy.riskRules.stopLossPct
          ? currentPosition.entryPrice * (1 - strategy.riskRules.stopLossPct / 100)
          : null;
        const takeProfit = strategy.riskRules.takeProfitPct
          ? currentPosition.entryPrice * (1 + strategy.riskRules.takeProfitPct / 100)
          : null;
        const trailing = strategy.riskRules.trailingStopPct
          ? currentPosition.highestClose * (1 - strategy.riskRules.trailingStopPct / 100)
          : null;

        if (stopLoss !== null && candle.close <= stopLoss) exitReason = "stop_loss";
        else if (takeProfit !== null && candle.close >= takeProfit) exitReason = "take_profit";
        else if (trailing !== null && candle.close <= trailing) exitReason = "trailing_stop";
        else if (
          strategy.riskRules.maxBarsInTrade !== undefined &&
          index - currentPosition.entryIndex >= strategy.riskRules.maxBarsInTrade
        ) {
          exitReason = "max_bars";
        } else if (evaluateRuntimeCondition(runtimeExitConditionForSide(runtime, "long"), candles, seriesMap, index)) {
          exitReason = "rule";
        } else if (shortEntry) {
          exitReason = "reverse";
        }
      } else {
        const stopLoss = strategy.riskRules.stopLossPct
          ? currentPosition.entryPrice * (1 + strategy.riskRules.stopLossPct / 100)
          : null;
        const takeProfit = strategy.riskRules.takeProfitPct
          ? currentPosition.entryPrice * (1 - strategy.riskRules.takeProfitPct / 100)
          : null;
        const trailing = strategy.riskRules.trailingStopPct
          ? currentPosition.lowestClose * (1 + strategy.riskRules.trailingStopPct / 100)
          : null;

        if (stopLoss !== null && candle.close >= stopLoss) exitReason = "stop_loss";
        else if (takeProfit !== null && candle.close <= takeProfit) exitReason = "take_profit";
        else if (trailing !== null && candle.close >= trailing) exitReason = "trailing_stop";
        else if (
          strategy.riskRules.maxBarsInTrade !== undefined &&
          index - currentPosition.entryIndex >= strategy.riskRules.maxBarsInTrade
        ) {
          exitReason = "max_bars";
        } else if (evaluateRuntimeCondition(runtimeExitConditionForSide(runtime, "short"), candles, seriesMap, index)) {
          exitReason = "rule";
        } else if (longEntry) {
          exitReason = "reverse";
        }
      }

      if (exitReason) {
        const priorSide = currentPosition.side;
        closePosition(index, exitReason);
        if (exitReason === "reverse") {
          openPosition(index, priorSide === "long" ? "short" : "long");
        }
      }
    } else if (longEntry !== shortEntry) {
      openPosition(index, longEntry ? "long" : "short");
    }

    let equity = realizedEquity;
    if (position) {
      const currentPosition = position as Position;
      const unrealized =
        currentPosition.side === "long"
          ? (candle.close - currentPosition.entryPrice) * currentPosition.quantity
          : (currentPosition.entryPrice - candle.close) * currentPosition.quantity;
      equity += unrealized;
      barsWithExposure += 1;
    }
    equityCurve[index] = {
      time: candle.ts,
      equity: Number(equity.toFixed(8))
    };
  }

  if (position) {
    closePosition(candles.length - 1, "rule");
    equityCurve[equityCurve.length - 1] = {
      time: candles[candles.length - 1].ts,
      equity: Number(realizedEquity.toFixed(8))
    };
  }

  const endingEquity = equityCurve[equityCurve.length - 1]?.equity ?? realizedEquity;
  const profitableTrades = trades.filter((trade) => trade.netPnl > 0);
  const losingTrades = trades.filter((trade) => trade.netPnl < 0);
  const avgTradeNetPnl = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length : 0;
  const avgWinningTradeNetPnl =
    profitableTrades.length > 0
      ? profitableTrades.reduce((sum, trade) => sum + trade.netPnl, 0) / profitableTrades.length
      : 0;
  const avgLosingTradeNetPnl =
    losingTrades.length > 0
      ? losingTrades.reduce((sum, trade) => sum + trade.netPnl, 0) / losingTrades.length
      : 0;
  const avgBarsHeld = trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.barsHeld, 0) / trades.length : 0;
  const profitFactor =
    losingTrades.length === 0
      ? profitableTrades.length > 0
        ? 999
        : 0
      : profitableTrades.reduce((sum, trade) => sum + trade.netPnl, 0) /
        Math.abs(losingTrades.reduce((sum, trade) => sum + trade.netPnl, 0));

  const runId = randomUUID();
  const summary: StrategyBacktestSummary = {
    runId,
    strategyId: strategy.id,
    marketId: strategy.marketId,
    timeframe: strategy.timeframe,
    candleCount: candles.length,
    startingEquity: strategy.costModel.startingEquity,
    endingEquity: Number(endingEquity.toFixed(8)),
    netPnl: Number((endingEquity - strategy.costModel.startingEquity).toFixed(8)),
    netPnlPct: Number(
      ((((endingEquity - strategy.costModel.startingEquity) / strategy.costModel.startingEquity) * 100) || 0).toFixed(4)
    ),
    grossPnl: Number(grossPnlTotal.toFixed(8)),
    feesPaid: Number(feeTotal.toFixed(8)),
    slippagePaid: Number(slippageTotal.toFixed(8)),
    winRate: Number(((profitableTrades.length / Math.max(trades.length, 1)) * 100).toFixed(4)),
    maxDrawdownPct: Number(calcDrawdownPct(equityCurve).toFixed(4)),
    profitFactor: Number(profitFactor.toFixed(4)),
    tradeCount: trades.length,
    longTradeCount: trades.filter((trade) => trade.side === "long").length,
    shortTradeCount: trades.filter((trade) => trade.side === "short").length,
    avgTradeNetPnl: Number(avgTradeNetPnl.toFixed(8)),
    avgWinningTradeNetPnl: Number(avgWinningTradeNetPnl.toFixed(8)),
    avgLosingTradeNetPnl: Number(avgLosingTradeNetPnl.toFixed(8)),
    avgBarsHeld: Number(avgBarsHeld.toFixed(4)),
    expectancy: Number(avgTradeNetPnl.toFixed(8)),
    exposurePct: Number(((barsWithExposure / Math.max(candles.length, 1)) * 100).toFixed(4)),
    createdAt: new Date().toISOString(),
    equityCurve
  };

  const overlay: StrategyChartOverlay = {
    runId,
    strategyId: strategy.id,
    marketId: strategy.marketId,
    timeframe: strategy.timeframe,
    indicators: overlayIndicators,
    markers
  };

  return {
    summary,
    trades: trades.map((trade) => ({ ...trade, runId })),
    overlay
  };
}
