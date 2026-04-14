import type {
  StrategyDefinition,
  StrategyIndicatorKind,
  StrategyIndicatorOutput,
  StrategyIndicatorParams,
  StrategyOperand,
  StrategyOverlayPane,
  StrategyOverlaySeries,
  StrategyPriceField,
  StrategyRule,
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

type IndicatorParamValue = number | string;

export type IndicatorReference = {
  key: string;
  indicator: StrategyIndicatorKind;
  output: StrategyIndicatorOutput;
  params: Partial<Record<keyof StrategyIndicatorParams, IndicatorParamValue>>;
};

function indicatorKey(
  indicator: StrategyIndicatorKind,
  output: StrategyIndicatorOutput,
  params: Partial<Record<keyof StrategyIndicatorParams, IndicatorParamValue>>
) {
  const normalizedParams = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");

  return `${indicator}:${output}:${normalizedParams}`;
}

function priceSourceValue(candle: StrategyCandle, field: StrategyPriceField) {
  switch (field) {
    case "open":
    case "high":
    case "low":
    case "close":
    case "volume":
      return candle[field];
    case "hl2":
      return (candle.high + candle.low) / 2;
    case "hlc3":
      return (candle.high + candle.low + candle.close) / 3;
    case "ohlc4":
      return (candle.open + candle.high + candle.low + candle.close) / 4;
  }
}

function sourceSeries(candles: StrategyCandle[], field: StrategyPriceField) {
  return candles.map((candle) => priceSourceValue(candle, field));
}

function numericParam(
  params: Partial<Record<keyof StrategyIndicatorParams, IndicatorParamValue>>,
  key: keyof StrategyIndicatorParams,
  fallback: number
) {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sourceParam(
  params: Partial<Record<keyof StrategyIndicatorParams, IndicatorParamValue>>,
  fallback: StrategyPriceField = "close"
) {
  const value = params.source;
  return typeof value === "string" ? (value as StrategyPriceField) : fallback;
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

function atr(candles: StrategyCandle[], period: number) {
  const result: Array<number | null> = Array(candles.length).fill(null);
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) {
      return candle.high - candle.low;
    }

    const previousClose = candles[index - 1]?.close ?? candle.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });

  let previous: number | null = null;
  for (let index = 0; index < trueRanges.length; index += 1) {
    if (index === period - 1) {
      previous = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
      result[index] = previous;
      continue;
    }

    if (index < period - 1 || previous === null) {
      continue;
    }

    previous = ((previous * (period - 1)) + trueRanges[index]) / period;
    result[index] = previous;
  }

  return result;
}

function roc(values: number[], period: number) {
  return values.map((value, index) => {
    if (index < period) return null;
    const previous = values[index - period];
    if (previous === 0) return null;
    return ((value - previous) / previous) * 100;
  });
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

function stochastic(
  candles: StrategyCandle[],
  period: number,
  smoothK: number,
  smoothD: number
) {
  const rawK = candles.map((candle, index) => {
    if (index < period - 1) return null;
    const window = candles.slice(index - period + 1, index + 1);
    const highestHigh = Math.max(...window.map((entry) => entry.high));
    const lowestLow = Math.min(...window.map((entry) => entry.low));
    if (highestHigh === lowestLow) return 0;
    return ((candle.close - lowestLow) / (highestHigh - lowestLow)) * 100;
  });

  const smoothedKInput = rawK.map((value) => value ?? 0);
  const k = sma(smoothedKInput, smoothK).map((value, index) => (rawK[index] === null ? null : value));
  const d = sma(
    k.map((value) => value ?? 0),
    smoothD
  ).map((value, index) => (k[index] === null ? null : value));

  return { k, d };
}

function buildIndicatorValues(
  candles: StrategyCandle[],
  indicator: StrategyIndicatorKind,
  output: StrategyIndicatorOutput,
  params: Partial<Record<keyof StrategyIndicatorParams, IndicatorParamValue>>
) {
  const source = sourceParam(params);
  const sourceValues = sourceSeries(candles, source);
  const closes = sourceSeries(candles, "close");
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const volumes = candles.map((candle) => candle.volume);

  switch (indicator) {
    case "sma":
      return sma(sourceValues, numericParam(params, "period", 20));
    case "ema":
      return ema(sourceValues, numericParam(params, "period", 20));
    case "rsi":
      return rsi(sourceValues, numericParam(params, "period", 14));
    case "macd": {
      const fast = ema(sourceValues, numericParam(params, "fastPeriod", 12));
      const slow = ema(sourceValues, numericParam(params, "slowPeriod", 26));
      const macdLine = sourceValues.map((_, index) =>
        fast[index] !== null && slow[index] !== null ? fast[index]! - slow[index]! : null
      );
      const signalInput = macdLine.map((value) => value ?? 0);
      const signal = ema(signalInput, numericParam(params, "signalPeriod", 9)).map((value, index) =>
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
      const period = numericParam(params, "period", 20);
      const middle = sma(sourceValues, period);
      const stdDev = numericParam(params, "stdDev", 2);
      const upper: Array<number | null> = Array(sourceValues.length).fill(null);
      const lower: Array<number | null> = Array(sourceValues.length).fill(null);
      for (let index = period - 1; index < sourceValues.length; index += 1) {
        const window = sourceValues.slice(index - period + 1, index + 1);
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
    case "atr":
      return atr(candles, numericParam(params, "period", 14));
    case "roc":
      return roc(sourceValues, numericParam(params, "period", 9));
    case "stoch": {
      const values = stochastic(
        candles,
        numericParam(params, "period", 14),
        numericParam(params, "smoothK", 3),
        numericParam(params, "smoothD", 3)
      );
      return output === "d" ? values.d : values.k;
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
      return rollingHigh(highs, numericParam(params, "lookback", 20));
    case "rolling_low":
      return rollingLow(lows, numericParam(params, "lookback", 20));
    case "candle_body_pct":
      return candles.map((candle) => {
        if (candle.open === 0) return 0;
        return (Math.abs(candle.close - candle.open) / candle.open) * 100;
      });
    case "candle_direction":
      return candles.map((candle) => (candle.close > candle.open ? 1 : candle.close < candle.open ? -1 : 0));
  }
}

export function collectIndicatorReferenceFromOperand(
  operand: StrategyOperand,
  refs: Map<string, IndicatorReference>
) {
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
      collectIndicatorReferenceFromOperand(rule.left, refs);
      collectIndicatorReferenceFromOperand(rule.right, refs);
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
  return buildIndicatorSeriesMapFromRefs(candles, collectIndicatorReferences(strategy));
}

export function buildIndicatorSeriesMapFromRefs(
  candles: StrategyCandle[],
  refs: IndicatorReference[]
): IndicatorSeriesMap {
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
    atr: "#ef4444",
    roc: "#10b981",
    stoch: "#8b5cf6",
    vwap: "#14b8a6",
    rolling_high: "#f97316",
    rolling_low: "#22c55e",
    candle_body_pct: "#f43f5e",
    candle_direction: "#94a3b8"
  } as const;
  return palette[ref.indicator];
}

function paneForIndicator(indicator: StrategyIndicatorKind): StrategyOverlayPane {
  switch (indicator) {
    case "rsi":
    case "macd":
    case "atr":
    case "roc":
    case "stoch":
    case "candle_body_pct":
    case "candle_direction":
      return "oscillator";
    default:
      return "price";
  }
}

function indicatorPane(ref: IndicatorReference): StrategyOverlayPane {
  return paneForIndicator(ref.indicator);
}

function buildConstantOverlayKey(indicator: StrategyIndicatorKind, value: number) {
  return `constant:${indicator}:${value}`;
}

function buildConstantOverlayLabel(indicator: StrategyIndicatorKind, value: number) {
  return `${indicator.toUpperCase()} level ${value}`;
}

function buildConstantOverlayColor(indicator: StrategyIndicatorKind, value: number) {
  if (indicator === "rsi" || indicator === "stoch") {
    if (value >= 70) return "#f6465d";
    if (value <= 30) return "#0ecb81";
  }
  return "#94a3b8";
}

function isOscillatorIndicatorOperand(
  operand: StrategyOperand
): operand is Extract<StrategyOperand, { type: "indicator_output" }> {
  return operand.type === "indicator_output" && paneForIndicator(operand.indicator) === "oscillator";
}

function ruleConstantOverlay(
  candles: StrategyCandle[],
  rule: StrategyRule
): StrategyOverlaySeries | null {
  if (isOscillatorIndicatorOperand(rule.left) && rule.right.type === "constant") {
    const value = rule.right.value;
    if (!Number.isFinite(value)) return null;
    return {
      id: buildConstantOverlayKey(rule.left.indicator, value),
      label: buildConstantOverlayLabel(rule.left.indicator, value),
      color: buildConstantOverlayColor(rule.left.indicator, value),
      seriesType: "line",
      pane: "oscillator",
      values: candles.map((candle) => ({ time: candle.ts, value }))
    };
  }

  if (isOscillatorIndicatorOperand(rule.right) && rule.left.type === "constant") {
    const value = rule.left.value;
    if (!Number.isFinite(value)) return null;
    return {
      id: buildConstantOverlayKey(rule.right.indicator, value),
      label: buildConstantOverlayLabel(rule.right.indicator, value),
      color: buildConstantOverlayColor(rule.right.indicator, value),
      seriesType: "line",
      pane: "oscillator",
      values: candles.map((candle) => ({ time: candle.ts, value }))
    };
  }

  return null;
}

function collectConstantOverlaysFromGroups(
  candles: StrategyCandle[],
  groups: StrategyRuleGroup[],
  overlays: Map<string, StrategyOverlaySeries>
) {
  for (const group of groups) {
    for (const rule of group.rules) {
      const overlay = ruleConstantOverlay(candles, rule);
      if (overlay) {
        overlays.set(overlay.id, overlay);
      }
    }
  }
}

function buildConstantOverlays(candles: StrategyCandle[], strategy: StrategyDefinition): StrategyOverlaySeries[] {
  const overlays = new Map<string, StrategyOverlaySeries>();
  collectConstantOverlaysFromGroups(candles, strategy.entryRules.long, overlays);
  collectConstantOverlaysFromGroups(candles, strategy.entryRules.short, overlays);
  collectConstantOverlaysFromGroups(candles, strategy.exitRules.long, overlays);
  collectConstantOverlaysFromGroups(candles, strategy.exitRules.short, overlays);
  return [...overlays.values()];
}

export function buildIndicatorOverlays(
  candles: StrategyCandle[],
  strategy: StrategyDefinition,
  seriesMap: IndicatorSeriesMap,
  refsOverride?: IndicatorReference[]
): StrategyOverlaySeries[] {
  const refs = refsOverride ?? collectIndicatorReferences(strategy);
  const indicatorOverlays: StrategyOverlaySeries[] = refs.map((ref) => ({
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
  return [...indicatorOverlays, ...buildConstantOverlays(candles, strategy)];
}

export function resolveOperandValue(
  operand: StrategyOperand,
  candles: StrategyCandle[],
  seriesMap: IndicatorSeriesMap,
  index: number
) {
  const targetIndex =
    operand.type === "constant" ? index : index - Math.max(0, operand.barsAgo ?? 0);
  if (targetIndex < 0) return null;
  if (operand.type === "constant") return operand.value;
  if (operand.type === "price_field") {
    const candle = candles[targetIndex];
    return candle ? priceSourceValue(candle, operand.field) : null;
  }
  const key = indicatorKey(operand.indicator, operand.output, operand.params ?? {});
  return seriesMap.get(key)?.[targetIndex] ?? null;
}
