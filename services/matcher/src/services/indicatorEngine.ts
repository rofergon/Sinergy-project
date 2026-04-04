import type {
  StrategyDefinition,
  StrategyIndicatorKind,
  StrategyIndicatorOutput,
  StrategyOperand,
  StrategyOverlayPane,
  StrategyOverlaySeries,
  StrategyRuleGroup
} from "@sinergy/shared";

export type StrategyCandle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type IndicatorSeriesMap = Map<string, Array<number | null>>;

type IndicatorReference = {
  key: string;
  indicator: StrategyIndicatorKind;
  output: StrategyIndicatorOutput;
  params: Record<string, number>;
};

function indicatorKey(
  indicator: StrategyIndicatorKind,
  output: StrategyIndicatorOutput,
  params: Record<string, number>
) {
  const normalizedParams = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");

  return `${indicator}:${output}:${normalizedParams}`;
}

function sma(values: number[], period: number) {
  const result: Array<number | null> = Array(values.length).fill(null);
  let rolling = 0;

  for (let index = 0; index < values.length; index += 1) {
    rolling += values[index];
    if (index >= period) {
      rolling -= values[index - period];
    }
    if (index >= period - 1) {
      result[index] = rolling / period;
    }
  }

  return result;
}

function ema(values: number[], period: number) {
  const result: Array<number | null> = Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let previous: number | null = null;

  for (let index = 0; index < values.length; index += 1) {
    if (index === period - 1) {
      const initial = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
      previous = initial;
      result[index] = initial;
      continue;
    }
    if (index < period - 1 || previous === null) {
      continue;
    }
    previous = values[index] * k + previous * (1 - k);
    result[index] = previous;
  }

  return result;
}

function rsi(values: number[], period: number) {
  const result: Array<number | null> = Array(values.length).fill(null);
  let gains = 0;
  let losses = 0;

  for (let index = 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    if (index <= period) {
      gains += gain;
      losses += loss;
      if (index === period) {
        const avgGain = gains / period;
        const avgLoss = losses / period;
        result[index] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
      continue;
    }

    gains = (gains * (period - 1) + gain) / period;
    losses = (losses * (period - 1) + loss) / period;
    result[index] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  }

  return result;
}

function rollingHigh(values: number[], lookback: number) {
  return values.map((_, index) => {
    if (index < lookback - 1) return null;
    return Math.max(...values.slice(index - lookback + 1, index + 1));
  });
}

function rollingLow(values: number[], lookback: number) {
  return values.map((_, index) => {
    if (index < lookback - 1) return null;
    return Math.min(...values.slice(index - lookback + 1, index + 1));
  });
}

function buildIndicatorValues(
  candles: StrategyCandle[],
  indicator: StrategyIndicatorKind,
  output: StrategyIndicatorOutput,
  params: Record<string, number>
) {
  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const volumes = candles.map((candle) => candle.volume);

  switch (indicator) {
    case "sma":
      return sma(closes, params.period ?? 20);
    case "ema":
      return ema(closes, params.period ?? 20);
    case "rsi":
      return rsi(closes, params.period ?? 14);
    case "macd": {
      const fast = ema(closes, params.fastPeriod ?? 12);
      const slow = ema(closes, params.slowPeriod ?? 26);
      const macdLine = closes.map((_, index) =>
        fast[index] !== null && slow[index] !== null ? fast[index]! - slow[index]! : null
      );
      const signalInput = macdLine.map((value) => value ?? 0);
      const signal = ema(signalInput, params.signalPeriod ?? 9).map((value, index) =>
        macdLine[index] === null ? null : value
      );
      if (output === "signal") return signal;
      if (output === "histogram") {
        return macdLine.map((value, index) =>
          value !== null && signal[index] !== null ? value - signal[index]! : null
        );
      }
      return macdLine;
    }
    case "bollinger": {
      const period = params.period ?? 20;
      const middle = sma(closes, period);
      const stdDev = params.stdDev ?? 2;
      const upper: Array<number | null> = Array(closes.length).fill(null);
      const lower: Array<number | null> = Array(closes.length).fill(null);
      for (let index = period - 1; index < closes.length; index += 1) {
        const window = closes.slice(index - period + 1, index + 1);
        const mean = middle[index] ?? 0;
        const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
        const deviation = Math.sqrt(variance) * stdDev;
        upper[index] = mean + deviation;
        lower[index] = mean - deviation;
      }
      if (output === "upper") return upper;
      if (output === "lower") return lower;
      return middle;
    }
    case "vwap": {
      let cumulativePV = 0;
      let cumulativeVolume = 0;
      return closes.map((close, index) => {
        const typicalPrice = (highs[index] + lows[index] + close) / 3;
        cumulativePV += typicalPrice * volumes[index];
        cumulativeVolume += volumes[index];
        if (cumulativeVolume === 0) return null;
        return cumulativePV / cumulativeVolume;
      });
    }
    case "rolling_high":
      return rollingHigh(highs, params.lookback ?? 20);
    case "rolling_low":
      return rollingLow(lows, params.lookback ?? 20);
    case "candle_body_pct":
      return candles.map((candle) => {
        if (candle.open === 0) return 0;
        return (Math.abs(candle.close - candle.open) / candle.open) * 100;
      });
    case "candle_direction":
      return candles.map((candle) => (candle.close > candle.open ? 1 : candle.close < candle.open ? -1 : 0));
  }
}

function collectFromOperand(operand: StrategyOperand, refs: Map<string, IndicatorReference>) {
  if (operand.type !== "indicator_output") return;
  const params = { ...(operand.params ?? {}) };
  const key = indicatorKey(operand.indicator, operand.output, params);
  refs.set(key, {
    key,
    indicator: operand.indicator,
    output: operand.output,
    params
  });
}

function collectFromGroups(groups: StrategyRuleGroup[], refs: Map<string, IndicatorReference>) {
  for (const group of groups) {
    for (const rule of group.rules) {
      collectFromOperand(rule.left, refs);
      collectFromOperand(rule.right, refs);
    }
  }
}

export function collectIndicatorReferences(strategy: StrategyDefinition) {
  const refs = new Map<string, IndicatorReference>();
  collectFromGroups(strategy.entryRules.long, refs);
  collectFromGroups(strategy.entryRules.short, refs);
  collectFromGroups(strategy.exitRules.long, refs);
  collectFromGroups(strategy.exitRules.short, refs);
  return [...refs.values()];
}

export function buildIndicatorSeriesMap(
  candles: StrategyCandle[],
  strategy: StrategyDefinition
): IndicatorSeriesMap {
  const refs = collectIndicatorReferences(strategy);
  const series = new Map<string, Array<number | null>>();

  for (const ref of refs) {
    series.set(ref.key, buildIndicatorValues(candles, ref.indicator, ref.output, ref.params));
  }

  return series;
}

function indicatorLabel(ref: IndicatorReference) {
  const params = Object.entries(ref.params)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return `${ref.indicator.toUpperCase()} ${ref.output}${params ? ` (${params})` : ""}`;
}

function indicatorColor(ref: IndicatorReference) {
  const palette = {
    sma: "#f0b90b",
    ema: "#1e9df2",
    rsi: "#ff8c42",
    macd: "#6cc3d5",
    bollinger: "#c084fc",
    vwap: "#14b8a6",
    rolling_high: "#f97316",
    rolling_low: "#22c55e",
    candle_body_pct: "#f43f5e",
    candle_direction: "#94a3b8"
  } as const;
  return palette[ref.indicator];
}

function indicatorPane(ref: IndicatorReference): StrategyOverlayPane {
  switch (ref.indicator) {
    case "rsi":
    case "macd":
    case "candle_body_pct":
    case "candle_direction":
      return "oscillator";
    default:
      return "price";
  }
}

export function buildIndicatorOverlays(
  candles: StrategyCandle[],
  strategy: StrategyDefinition,
  seriesMap: IndicatorSeriesMap
): StrategyOverlaySeries[] {
  const refs = collectIndicatorReferences(strategy);
  return refs.map((ref) => ({
    id: ref.key,
    label: indicatorLabel(ref),
    color: indicatorColor(ref),
    seriesType: "line",
    pane: indicatorPane(ref),
    values: candles.flatMap((candle, index) => {
      const value = seriesMap.get(ref.key)?.[index];
      return value === null || value === undefined ? [] : [{ time: candle.ts, value }];
    })
  }));
}

export function resolveOperandValue(
  operand: StrategyOperand,
  candles: StrategyCandle[],
  seriesMap: IndicatorSeriesMap,
  index: number
) {
  if (operand.type === "constant") return operand.value;
  if (operand.type === "price_field") {
    return candles[index]?.[operand.field] ?? null;
  }
  const key = indicatorKey(operand.indicator, operand.output, operand.params ?? {});
  return seriesMap.get(key)?.[index] ?? null;
}
