import type {
  StrategyIdeaKind,
  StrategyMarketAnalysis,
  StrategyMarketLevel,
  StrategyMarketRegime,
  StrategySideBias,
  StrategyTimeframe,
  StrategyTimeframeAnalysis,
  StrategyTrendBias
} from "@sinergy/shared";
import type { StrategyCandle } from "./indicatorEngine.js";

const ANALYSIS_TIMEFRAMES: StrategyTimeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

type LevelCluster = {
  totalPrice: number;
  touches: number;
  latestIndex: number;
};

type TimeframeComputation = StrategyTimeframeAnalysis & {
  supportLevels: StrategyMarketLevel[];
  resistanceLevels: StrategyMarketLevel[];
};

function round(value: number, decimals = 4) {
  return Number(value.toFixed(decimals));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function ema(values: number[], period: number) {
  if (values.length === 0) return [];
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return result;

  const k = 2 / (period + 1);
  let previous = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = previous;

  for (let index = period; index < values.length; index += 1) {
    previous = values[index] * k + previous * (1 - k);
    result[index] = previous;
  }

  return result;
}

function averageTrueRangePct(candles: StrategyCandle[], period = 14) {
  if (candles.length < 2) return 0;
  const window = candles.slice(-Math.max(period + 1, 2));
  const ranges: number[] = [];

  for (let index = 1; index < window.length; index += 1) {
    const candle = window[index];
    const previousClose = window[index - 1].close;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
    ranges.push(trueRange);
  }

  const latestClose = window[window.length - 1]?.close ?? 0;
  if (latestClose <= 0 || ranges.length === 0) return 0;
  return (ranges.reduce((sum, value) => sum + value, 0) / ranges.length / latestClose) * 100;
}

function chooseEmaPair(timeframe: StrategyTimeframe, regime: StrategyMarketRegime) {
  if (regime === "range" || regime === "high_noise") {
    switch (timeframe) {
      case "1m":
        return { fastPeriod: 8, slowPeriod: 21 };
      case "5m":
        return { fastPeriod: 9, slowPeriod: 21 };
      case "15m":
        return { fastPeriod: 12, slowPeriod: 34 };
      case "1h":
      case "4h":
      case "1d":
        return { fastPeriod: 21, slowPeriod: 55 };
    }
  }

  switch (timeframe) {
    case "1m":
      return { fastPeriod: 5, slowPeriod: 13 };
    case "5m":
      return { fastPeriod: 7, slowPeriod: 21 };
    case "15m":
      return { fastPeriod: 9, slowPeriod: 21 };
    case "1h":
      return { fastPeriod: 12, slowPeriod: 34 };
    case "4h":
    case "1d":
      return { fastPeriod: 21, slowPeriod: 55 };
  }
}

function detectLevels(
  candles: StrategyCandle[],
  kind: "support" | "resistance",
  currentPrice: number,
  atrPct: number,
  timeframe: StrategyTimeframe
) {
  if (candles.length < 7 || currentPrice <= 0) return [] as StrategyMarketLevel[];

  const recent = candles.slice(-Math.min(candles.length, 140));
  const clusters: LevelCluster[] = [];
  const pivotWindow = 2;
  const tolerance = currentPrice * (Math.max(atrPct * 0.6, 0.35) / 100);

  for (let index = pivotWindow; index < recent.length - pivotWindow; index += 1) {
    const candle = recent[index];
    const neighborhood = recent.slice(index - pivotWindow, index + pivotWindow + 1);
    const isPivot =
      kind === "support"
        ? neighborhood.every((entry) => candle.low <= entry.low)
        : neighborhood.every((entry) => candle.high >= entry.high);

    if (!isPivot) continue;

    const price = kind === "support" ? candle.low : candle.high;
    const existing = clusters.find((cluster) => Math.abs(cluster.totalPrice / cluster.touches - price) <= tolerance);
    if (existing) {
      existing.totalPrice += price;
      existing.touches += 1;
      existing.latestIndex = index;
    } else {
      clusters.push({
        totalPrice: price,
        touches: 1,
        latestIndex: index
      });
    }
  }

  return clusters
    .map((cluster) => {
      const price = cluster.totalPrice / cluster.touches;
      return {
        kind,
        price: round(price, 4),
        distancePct: round(Math.abs((price - currentPrice) / currentPrice) * 100, 3),
        touches: cluster.touches,
        strength: round(clamp(cluster.touches / 4 + (cluster.latestIndex / recent.length) * 0.3, 0, 1), 3),
        sourceTimeframe: timeframe
      } satisfies StrategyMarketLevel;
    })
    .filter((level) => (kind === "support" ? level.price <= currentPrice : level.price >= currentPrice))
    .sort((left, right) => {
      if (right.touches !== left.touches) return right.touches - left.touches;
      if (right.strength !== left.strength) return right.strength - left.strength;
      return left.distancePct - right.distancePct;
    })
    .slice(0, 3);
}

function determineTrendBias(
  latestClose: number,
  changePct: number,
  fastEma: number | null,
  slowEma: number | null
) {
  const emaSpreadPct =
    fastEma !== null && slowEma !== null && latestClose > 0
      ? ((fastEma - slowEma) / latestClose) * 100
      : 0;

  if (emaSpreadPct > 0.18 || changePct > 0.8) return { trendBias: "bullish" as const, emaSpreadPct };
  if (emaSpreadPct < -0.18 || changePct < -0.8) return { trendBias: "bearish" as const, emaSpreadPct };
  return { trendBias: "sideways" as const, emaSpreadPct };
}

function determineRegime(input: {
  atrPct: number;
  trendBias: StrategyTrendBias;
  trendStrength: number;
  breakoutRoomUpPct?: number;
  breakoutRoomDownPct?: number;
}) {
  if (input.atrPct >= 3.8) return "high_noise" as const;

  const nearResistance =
    input.breakoutRoomUpPct !== undefined && input.breakoutRoomUpPct <= Math.max(input.atrPct * 1.5, 0.8);
  const nearSupport =
    input.breakoutRoomDownPct !== undefined && input.breakoutRoomDownPct <= Math.max(input.atrPct * 1.5, 0.8);

  if (input.trendStrength >= 0.58 && input.trendBias !== "sideways") {
    if (
      (input.trendBias === "bullish" && nearResistance) ||
      (input.trendBias === "bearish" && nearSupport)
    ) {
      return "breakout_ready" as const;
    }
    return "trend" as const;
  }

  if (nearResistance || nearSupport) return "breakout_ready" as const;
  return "range" as const;
}

function determineStrategyKinds(regime: StrategyMarketRegime) {
  switch (regime) {
    case "trend":
      return ["ema", "range-breakout"] satisfies StrategyIdeaKind[];
    case "breakout_ready":
      return ["range-breakout", "ema"] satisfies StrategyIdeaKind[];
    case "high_noise":
      return ["bollinger-reversion", "rsi-mean-reversion"] satisfies StrategyIdeaKind[];
    case "range":
      return ["rsi-mean-reversion", "bollinger-reversion"] satisfies StrategyIdeaKind[];
  }
}

function formatRationale(input: {
  timeframe: StrategyTimeframe;
  trendBias: StrategyTrendBias;
  regime: StrategyMarketRegime;
  atrPct: number;
  support?: number;
  resistance?: number;
}) {
  const supportText = input.support ? ` support near ${round(input.support, 2)}` : "";
  const resistanceText = input.resistance ? ` resistance near ${round(input.resistance, 2)}` : "";
  return `${input.timeframe} shows ${input.trendBias} conditions with ${input.regime.replace(/_/g, " ")} structure, ATR ${round(input.atrPct, 2)}%.${supportText}${resistanceText}`.trim();
}

function timeframePreferenceBonus(timeframe: StrategyTimeframe) {
  switch (timeframe) {
    case "1m":
      return -10;
    case "5m":
      return 1;
    case "15m":
      return 8;
    case "1h":
      return 6;
    case "4h":
      return 3;
    case "1d":
      return -2;
  }
}

function analyzeTimeframe(timeframe: StrategyTimeframe, candles: StrategyCandle[]): TimeframeComputation | null {
  if (candles.length < 20) return null;

  const closes = candles.map((candle) => candle.close);
  const latestClose = closes[closes.length - 1] ?? 0;
  if (latestClose <= 0) return null;

  const atrPct = averageTrueRangePct(candles);
  const window = candles.slice(-Math.min(candles.length, 60));
  const windowHigh = Math.max(...window.map((candle) => candle.high));
  const windowLow = Math.min(...window.map((candle) => candle.low));
  const windowRangePct = ((windowHigh - windowLow) / latestClose) * 100;
  const baselineClose = window[0]?.close ?? latestClose;
  const changePct = baselineClose > 0 ? ((latestClose - baselineClose) / baselineClose) * 100 : 0;

  const emaFastSeries = ema(closes, 9);
  const emaSlowSeries = ema(closes, 21);
  const latestFast = emaFastSeries[emaFastSeries.length - 1] ?? null;
  const latestSlow = emaSlowSeries[emaSlowSeries.length - 1] ?? null;
  const { trendBias, emaSpreadPct } = determineTrendBias(latestClose, changePct, latestFast, latestSlow);

  const supportLevels = detectLevels(candles, "support", latestClose, atrPct, timeframe);
  const resistanceLevels = detectLevels(candles, "resistance", latestClose, atrPct, timeframe);
  const nearestSupport = supportLevels.map((level) => level.price).sort((a, b) => b - a)[0];
  const nearestResistance = resistanceLevels.map((level) => level.price).sort((a, b) => a - b)[0];
  const breakoutRoomUpPct =
    nearestResistance !== undefined ? ((nearestResistance - latestClose) / latestClose) * 100 : undefined;
  const breakoutRoomDownPct =
    nearestSupport !== undefined ? ((latestClose - nearestSupport) / latestClose) * 100 : undefined;

  const trendStrength = clamp(Math.abs(emaSpreadPct) * 2.6 + Math.abs(changePct) / 5, 0, 1);
  const marketRegime = determineRegime({
    atrPct,
    trendBias,
    trendStrength,
    breakoutRoomUpPct,
    breakoutRoomDownPct
  });
  const preferredKinds = determineStrategyKinds(marketRegime);
  const emaPreferred = preferredKinds[0] === "ema" || preferredKinds[1] === "ema";
  const emaPair = chooseEmaPair(timeframe, marketRegime);
  const sideBias: StrategySideBias =
    trendBias === "bullish" && trendStrength >= 0.58
      ? "long_only"
      : trendBias === "bearish" && trendStrength >= 0.58
        ? "short_only"
        : "both";

  let suitabilityScore = 46;
  suitabilityScore += timeframePreferenceBonus(timeframe);
  suitabilityScore += atrPct >= 0.25 && atrPct <= 2.5 ? 18 : atrPct < 0.25 ? -8 : 7;
  suitabilityScore += Math.min(trendStrength * 18, 18);
  suitabilityScore += supportLevels.length > 0 ? 4 : 0;
  suitabilityScore += resistanceLevels.length > 0 ? 4 : 0;
  suitabilityScore += marketRegime === "high_noise" ? -18 : 0;
  suitabilityScore += candles.length < 80 ? -10 : 0;
  suitabilityScore = clamp(suitabilityScore, 1, 100);

  return {
    timeframe,
    candleCount: candles.length,
    latestClose: round(latestClose, 4),
    atrPct: round(atrPct, 3),
    windowRangePct: round(windowRangePct, 3),
    trendBias,
    trendStrength: round(trendStrength, 3),
    marketRegime,
    nearestSupport: nearestSupport !== undefined ? round(nearestSupport, 4) : undefined,
    nearestResistance: nearestResistance !== undefined ? round(nearestResistance, 4) : undefined,
    breakoutRoomUpPct: breakoutRoomUpPct !== undefined ? round(Math.max(breakoutRoomUpPct, 0), 3) : undefined,
    breakoutRoomDownPct: breakoutRoomDownPct !== undefined ? round(Math.max(breakoutRoomDownPct, 0), 3) : undefined,
    suitabilityScore: round(suitabilityScore, 2),
    emaSuggestion: {
      fastPeriod: emaPair.fastPeriod,
      slowPeriod: emaPair.slowPeriod,
      preferred: emaPreferred,
      sideBias
    },
    rationale: formatRationale({
      timeframe,
      trendBias,
      regime: marketRegime,
      atrPct,
      support: nearestSupport,
      resistance: nearestResistance
    }),
    supportLevels,
    resistanceLevels
  };
}

export function analyzeMarketContext(input: {
  marketId: `0x${string}`;
  candlesByTimeframe: Record<StrategyTimeframe, StrategyCandle[]>;
}) {
  const computations = ANALYSIS_TIMEFRAMES
    .map((timeframe) => analyzeTimeframe(timeframe, input.candlesByTimeframe[timeframe] ?? []))
    .filter(Boolean) as TimeframeComputation[];

  if (computations.length === 0) {
    throw new Error("Not enough candle data to analyze market context.");
  }

  computations.sort((left, right) => right.suitabilityScore - left.suitabilityScore);
  const recommended = computations[0];
  const recommendedStrategyKinds = determineStrategyKinds(recommended.marketRegime);
  const sideText =
    recommended.emaSuggestion.sideBias === "long_only"
      ? "bias long entries"
      : recommended.emaSuggestion.sideBias === "short_only"
        ? "bias short entries"
        : "allow both sides";

  const analysis: StrategyMarketAnalysis = {
    marketId: input.marketId,
    generatedAt: new Date().toISOString(),
    latestPrice: recommended.latestClose,
    overallRegime: recommended.marketRegime,
    recommendedTimeframe: recommended.timeframe,
    recommendedStrategyKinds,
    supportLevels: recommended.supportLevels,
    resistanceLevels: recommended.resistanceLevels,
    emaSuggestion: {
      timeframe: recommended.timeframe,
      fastPeriod: recommended.emaSuggestion.fastPeriod,
      slowPeriod: recommended.emaSuggestion.slowPeriod,
      preferred: recommended.emaSuggestion.preferred,
      sideBias: recommended.emaSuggestion.sideBias,
      rationale: `Use ${recommended.emaSuggestion.fastPeriod}/${recommended.emaSuggestion.slowPeriod} on ${recommended.timeframe}; ${sideText} because ${recommended.rationale.toLowerCase()}.`
    },
    timeframes: computations.map(({ supportLevels: _supportLevels, resistanceLevels: _resistanceLevels, ...rest }) => rest),
    summary: `${recommended.timeframe} is the strongest fit right now. Regime: ${recommended.marketRegime.replace(/_/g, " ")}, trend: ${recommended.trendBias}, ATR ${round(recommended.atrPct, 2)}%. Preferred styles: ${recommendedStrategyKinds.join(", ")}.`
  };

  return analysis;
}
