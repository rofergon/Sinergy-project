import {
  STRATEGY_API_VERSION,
  STRATEGY_CAPABILITIES_VERSION,
  STRATEGY_SCHEMA_VERSION,
  type HexString,
  type StrategyCapabilities,
  type StrategyDefinition,
  type StrategyEnabledSide,
  type StrategyIndicatorKind,
  type StrategyIndicatorOutput,
  type StrategyRuleGroup,
  type StrategyTemplate,
  type StrategyTimeframe
} from "@sinergy/shared";

export const STRATEGY_DEFAULTS = {
  backtestBars: 250,
  maxRuleGroupsPerSide: 5,
  maxRulesPerGroup: 8,
  maxIndicatorLookback: 400
} as const;

export const STRATEGY_TIMEFRAMES: StrategyTimeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export function emptyRuleGroup(id: string): StrategyRuleGroup {
  return { id, rules: [] };
}

function emptyDefinition(
  id: string,
  ownerAddress: HexString,
  marketId: HexString,
  name: string
): StrategyDefinition {
  const now = new Date().toISOString();
  return {
    id,
    ownerAddress,
    name,
    marketId,
    timeframe: "15m",
    enabledSides: ["long", "short"],
    entryRules: {
      long: [emptyRuleGroup(`${id}-entry-long-1`)],
      short: [emptyRuleGroup(`${id}-entry-short-1`)]
    },
    exitRules: {
      long: [emptyRuleGroup(`${id}-exit-long-1`)],
      short: [emptyRuleGroup(`${id}-exit-short-1`)]
    },
    sizing: {
      mode: "percent_of_equity",
      value: 25
    },
    riskRules: {
      stopLossPct: 2,
      takeProfitPct: 4,
      trailingStopPct: 1,
      maxBarsInTrade: 40
    },
    costModel: {
      feeBps: 10,
      slippageBps: 5,
      startingEquity: 10_000
    },
    status: "draft",
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now
  };
}

function operandPrice(field: "open" | "high" | "low" | "close" | "volume") {
  return { type: "price_field", field } as const;
}

function operandIndicator(
  indicator: StrategyIndicatorKind,
  output: StrategyIndicatorOutput,
  params: Record<string, number>
) {
  return {
    type: "indicator_output",
    indicator,
    output,
    params
  } as const;
}

function operandConstant(value: number) {
  return {
    type: "constant",
    value
  } as const;
}

export function buildStrategyCapabilities(): StrategyCapabilities {
  return {
    apiVersion: STRATEGY_API_VERSION,
    strategySchemaVersion: STRATEGY_SCHEMA_VERSION,
    capabilitiesVersion: STRATEGY_CAPABILITIES_VERSION,
    timeframes: [...STRATEGY_TIMEFRAMES],
    operators: [">", ">=", "<", "<=", "crosses_above", "crosses_below"],
    priceFields: ["open", "high", "low", "close", "volume"],
    supportedSides: ["long", "short"],
    indicatorCatalog: [
      {
        kind: "sma",
        label: "Simple Moving Average",
        outputs: ["value"],
        params: [
          { name: "period", label: "Period", type: "integer", required: true, defaultValue: 20, min: 1, max: 400 }
        ]
      },
      {
        kind: "ema",
        label: "Exponential Moving Average",
        outputs: ["value"],
        params: [
          { name: "period", label: "Period", type: "integer", required: true, defaultValue: 20, min: 1, max: 400 }
        ]
      },
      {
        kind: "rsi",
        label: "Relative Strength Index",
        outputs: ["value"],
        params: [
          { name: "period", label: "Period", type: "integer", required: true, defaultValue: 14, min: 1, max: 200 }
        ]
      },
      {
        kind: "macd",
        label: "MACD",
        outputs: ["line", "signal", "histogram"],
        params: [
          { name: "fastPeriod", label: "Fast", type: "integer", required: true, defaultValue: 12, min: 1, max: 200 },
          { name: "slowPeriod", label: "Slow", type: "integer", required: true, defaultValue: 26, min: 1, max: 200 },
          { name: "signalPeriod", label: "Signal", type: "integer", required: true, defaultValue: 9, min: 1, max: 200 }
        ]
      },
      {
        kind: "bollinger",
        label: "Bollinger Bands",
        outputs: ["upper", "middle", "lower"],
        params: [
          { name: "period", label: "Period", type: "integer", required: true, defaultValue: 20, min: 1, max: 200 },
          { name: "stdDev", label: "Std Dev", type: "number", required: true, defaultValue: 2, min: 0.1, max: 10 }
        ]
      },
      {
        kind: "vwap",
        label: "VWAP",
        outputs: ["value"],
        params: []
      },
      {
        kind: "rolling_high",
        label: "Rolling High",
        outputs: ["value"],
        params: [
          { name: "lookback", label: "Lookback", type: "integer", required: true, defaultValue: 20, min: 1, max: 400 }
        ]
      },
      {
        kind: "rolling_low",
        label: "Rolling Low",
        outputs: ["value"],
        params: [
          { name: "lookback", label: "Lookback", type: "integer", required: true, defaultValue: 20, min: 1, max: 400 }
        ]
      },
      {
        kind: "candle_body_pct",
        label: "Candle Body %",
        outputs: ["value"],
        params: []
      },
      {
        kind: "candle_direction",
        label: "Candle Direction",
        outputs: ["direction"],
        params: []
      }
    ],
    sizingModes: [
      { mode: "percent_of_equity", label: "Percent of equity", defaultValue: 25 },
      { mode: "fixed_quote_notional", label: "Fixed quote notional", defaultValue: 1000 }
    ],
    riskRules: [
      { key: "stopLossPct", label: "Stop Loss %", min: 0, max: 100 },
      { key: "takeProfitPct", label: "Take Profit %", min: 0, max: 200 },
      { key: "trailingStopPct", label: "Trailing Stop %", min: 0, max: 100 },
      { key: "maxBarsInTrade", label: "Max Bars In Trade", min: 1, max: 10_000 }
    ],
    defaults: { ...STRATEGY_DEFAULTS }
  };
}

export function buildStrategyTemplates(
  ownerAddress: HexString,
  marketId: HexString
): StrategyTemplate[] {
  const longOnly: StrategyEnabledSide[] = ["long"];
  const bothSides: StrategyEnabledSide[] = ["long", "short"];

  const ema = emptyDefinition("template-ema-crossover", ownerAddress, marketId, "EMA Crossover");
  ema.enabledSides = bothSides;
  ema.entryRules.long[0].rules.push({
    id: "ema-long-entry-1",
    left: operandIndicator("ema", "value", { period: 9 }),
    operator: "crosses_above",
    right: operandIndicator("ema", "value", { period: 21 })
  });
  ema.entryRules.short[0].rules.push({
    id: "ema-short-entry-1",
    left: operandIndicator("ema", "value", { period: 9 }),
    operator: "crosses_below",
    right: operandIndicator("ema", "value", { period: 21 })
  });
  ema.exitRules.long[0].rules.push({
    id: "ema-long-exit-1",
    left: operandIndicator("ema", "value", { period: 9 }),
    operator: "crosses_below",
    right: operandIndicator("ema", "value", { period: 21 })
  });
  ema.exitRules.short[0].rules.push({
    id: "ema-short-exit-1",
    left: operandIndicator("ema", "value", { period: 9 }),
    operator: "crosses_above",
    right: operandIndicator("ema", "value", { period: 21 })
  });

  const rsi = emptyDefinition("template-rsi-reversion", ownerAddress, marketId, "RSI Mean Reversion");
  rsi.enabledSides = longOnly;
  rsi.entryRules.short = [];
  rsi.exitRules.short = [];
  rsi.entryRules.long[0].rules.push({
    id: "rsi-long-entry-1",
    left: operandIndicator("rsi", "value", { period: 14 }),
    operator: "<=",
    right: operandConstant(30)
  });
  rsi.exitRules.long[0].rules.push({
    id: "rsi-long-exit-1",
    left: operandIndicator("rsi", "value", { period: 14 }),
    operator: ">=",
    right: operandConstant(55)
  });

  const breakout = emptyDefinition("template-range-breakout", ownerAddress, marketId, "Range Breakout");
  breakout.enabledSides = bothSides;
  breakout.entryRules.long[0].rules.push({
    id: "breakout-long-entry-1",
    left: operandPrice("close"),
    operator: "crosses_above",
    right: operandIndicator("rolling_high", "value", { lookback: 20 })
  });
  breakout.entryRules.short[0].rules.push({
    id: "breakout-short-entry-1",
    left: operandPrice("close"),
    operator: "crosses_below",
    right: operandIndicator("rolling_low", "value", { lookback: 20 })
  });
  breakout.exitRules.long[0].rules.push({
    id: "breakout-long-exit-1",
    left: operandPrice("close"),
    operator: "<=",
    right: operandIndicator("ema", "value", { period: 10 })
  });
  breakout.exitRules.short[0].rules.push({
    id: "breakout-short-exit-1",
    left: operandPrice("close"),
    operator: ">=",
    right: operandIndicator("ema", "value", { period: 10 })
  });

  const bollinger = emptyDefinition("template-bollinger-reversion", ownerAddress, marketId, "Bollinger Reversion");
  bollinger.enabledSides = longOnly;
  bollinger.entryRules.short = [];
  bollinger.exitRules.short = [];
  bollinger.entryRules.long[0].rules.push({
    id: "bollinger-long-entry-1",
    left: operandPrice("close"),
    operator: "<=",
    right: operandIndicator("bollinger", "lower", { period: 20, stdDev: 2 })
  });
  bollinger.exitRules.long[0].rules.push({
    id: "bollinger-long-exit-1",
    left: operandPrice("close"),
    operator: ">=",
    right: operandIndicator("bollinger", "middle", { period: 20, stdDev: 2 })
  });

  return [
    {
      id: "ema-crossover",
      name: ema.name,
      description: "Cruce rápido/lento para capturar momentum en largos y cortos.",
      strategy: ema
    },
    {
      id: "rsi-mean-reversion",
      name: rsi.name,
      description: "Entrada por sobreventa y salida en normalización de RSI.",
      strategy: rsi
    },
    {
      id: "range-breakout",
      name: breakout.name,
      description: "Ruptura de máximos y mínimos rolling con salida por EMA.",
      strategy: breakout
    },
    {
      id: "bollinger-reversion",
      name: bollinger.name,
      description: "Reversión contra la banda inferior y salida en media.",
      strategy: bollinger
    }
  ];
}

export function createEmptyStrategyDraft(
  id: string,
  ownerAddress: HexString,
  marketId: HexString,
  name = "New Strategy Draft"
): StrategyDefinition {
  return emptyDefinition(id, ownerAddress, marketId, name);
}
