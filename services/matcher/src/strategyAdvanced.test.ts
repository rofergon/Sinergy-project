import test from "node:test";
import assert from "node:assert/strict";
import type { HexString, StrategyDefinition } from "@sinergy/shared";
import { buildIndicatorSeriesMap, resolveOperandValue, type StrategyCandle } from "./services/indicatorEngine.js";
import { runStrategyBacktest } from "./services/strategyBacktest.js";
import { buildStrategyCapabilities, createEmptyStrategyDraft } from "./services/strategyCatalog.js";
import {
  buildRuntimeIndicatorSeriesMap,
  compileStrategyToRuntime,
  evaluateRuntimeCondition,
  evaluateRuntimeValue
} from "./services/strategyRuntime.js";
import { compileAstToRuntime, parsePineLikeStrategy } from "./services/strategySourceCompiler.js";
import { validateStrategyDefinition } from "./services/strategyValidation.js";

const OWNER = "0x00000000000000000000000000000000000000c3" as HexString;
const MARKET = "0x0000000000000000000000000000000000000000000000000000000000000111" as HexString;

function makeStrategy(name: string): StrategyDefinition {
  return createEmptyStrategyDraft(`strategy-${name}`, OWNER, MARKET, name);
}

const SAMPLE_CANDLES: StrategyCandle[] = [
  { ts: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 },
  { ts: 2, open: 11, high: 13, low: 10, close: 12, volume: 110 },
  { ts: 3, open: 12, high: 14, low: 11, close: 13, volume: 120 },
  { ts: 4, open: 13, high: 15, low: 12, close: 14, volume: 130 },
  { ts: 5, open: 14, high: 16, low: 13, close: 15, volume: 140 },
  { ts: 6, open: 15, high: 17, low: 14, close: 16, volume: 150 }
];

test("strategy capabilities expose advanced price sources, operators and indicators", () => {
  const capabilities = buildStrategyCapabilities();

  assert.equal(capabilities.priceFields.includes("hl2"), true);
  assert.equal(capabilities.priceFields.includes("hlc3"), true);
  assert.equal(capabilities.priceFields.includes("ohlc4"), true);
  assert.equal(capabilities.operators.includes("=="), true);
  assert.equal(capabilities.operators.includes("!="), true);
  assert.equal(capabilities.indicatorCatalog.some((indicator) => indicator.kind === "atr"), true);
  assert.equal(capabilities.indicatorCatalog.some((indicator) => indicator.kind === "roc"), true);
  assert.equal(capabilities.indicatorCatalog.some((indicator) => indicator.kind === "stoch"), true);

  const ema = capabilities.indicatorCatalog.find((indicator) => indicator.kind === "ema");
  assert.equal(ema?.params.some((param) => param.name === "source" && param.type === "source"), true);
});

test("validation rejects barsAgo values beyond the supported lookback", () => {
  const strategy = makeStrategy("bars-ago-validation");
  strategy.enabledSides = ["long"];
  strategy.entryRules.long = [
    {
      id: "entry-1",
      rules: [
        {
          id: "rule-1",
          left: { type: "price_field", field: "close", barsAgo: 401 },
          operator: ">",
          right: { type: "constant", value: 0 }
        }
      ]
    }
  ];
  strategy.entryRules.short = [];
  strategy.exitRules.long = [];
  strategy.exitRules.short = [];
  strategy.riskRules = {};

  const validation = validateStrategyDefinition(strategy, new Set([MARKET.toLowerCase()]));

  assert.equal(validation.ok, false);
  assert.equal(validation.issues.some((issue) => issue.code === "bars_ago_above_limit"), true);
});

test("indicator engine resolves derived price sources and historical offsets", () => {
  const strategy = makeStrategy("historical-offsets");
  strategy.enabledSides = ["long"];
  strategy.entryRules.long = [
    {
      id: "entry-1",
      rules: [
        {
          id: "rule-1",
          left: {
            type: "indicator_output",
            indicator: "ema",
            output: "value",
            params: { period: 2, source: "hl2" }
          },
          operator: ">",
          right: { type: "constant", value: 0 }
        }
      ]
    }
  ];
  strategy.entryRules.short = [];
  strategy.exitRules.long = [];
  strategy.exitRules.short = [];
  strategy.riskRules = {};

  const seriesMap = buildIndicatorSeriesMap(SAMPLE_CANDLES, strategy);

  assert.equal(
    resolveOperandValue(
      { type: "price_field", field: "hlc3", barsAgo: 1 },
      SAMPLE_CANDLES,
      seriesMap,
      4
    ),
    13.666666666666666
  );
  assert.equal(
    resolveOperandValue(
      {
        type: "indicator_output",
        indicator: "ema",
        output: "value",
        params: { period: 2, source: "hl2" },
        barsAgo: 1
      },
      SAMPLE_CANDLES,
      seriesMap,
      5
    ),
    14
  );
});

test("backtest summaries include expectancy-style metrics and equality operators work", () => {
  const strategy = makeStrategy("summary-metrics");
  strategy.enabledSides = ["long"];
  strategy.entryRules.long = [
    {
      id: "entry-1",
      rules: [
        {
          id: "entry-rule-1",
          left: { type: "indicator_output", indicator: "candle_direction", output: "direction" },
          operator: "==",
          right: { type: "constant", value: 1 }
        }
      ]
    }
  ];
  strategy.entryRules.short = [];
  strategy.exitRules.long = [
    {
      id: "exit-1",
      rules: [
        {
          id: "exit-rule-1",
          left: { type: "indicator_output", indicator: "candle_direction", output: "direction" },
          operator: "==",
          right: { type: "constant", value: -1 }
        }
      ]
    }
  ];
  strategy.exitRules.short = [];
  strategy.riskRules = {};
  strategy.costModel.feeBps = 0;
  strategy.costModel.slippageBps = 0;
  strategy.costModel.startingEquity = 1_000;

  const run = runStrategyBacktest(strategy, [
    { ts: 1, open: 10, high: 10.1, low: 9.9, close: 10, volume: 10 },
    { ts: 2, open: 10, high: 11.1, low: 9.9, close: 11, volume: 12 },
    { ts: 3, open: 11, high: 12.2, low: 10.8, close: 12, volume: 13 },
    { ts: 4, open: 12, high: 12.1, low: 10.9, close: 11, volume: 14 }
  ]);

  assert.equal(run.summary.tradeCount, 1);
  assert.equal(run.summary.avgBarsHeld, 2);
  assert.equal(run.summary.avgTradeNetPnl, run.trades[0]?.netPnl ?? 0);
  assert.equal(run.summary.expectancy, run.trades[0]?.netPnl ?? 0);
  assert.equal(run.summary.exposurePct > 0, true);
});

test("backtest ignores configured fees and slippage in pnl calculations", () => {
  const strategy = makeStrategy("ignores-cost-model");
  strategy.enabledSides = ["long"];
  strategy.entryRules.long = [
    {
      id: "entry-1",
      rules: [
        {
          id: "entry-rule-1",
          left: { type: "price_field", field: "close" },
          operator: ">",
          right: { type: "constant", value: 10.5 }
        }
      ]
    }
  ];
  strategy.entryRules.short = [];
  strategy.exitRules.long = [
    {
      id: "exit-1",
      rules: [
        {
          id: "exit-rule-1",
          left: { type: "price_field", field: "close" },
          operator: "<",
          right: { type: "constant", value: 11.5 }
        }
      ]
    }
  ];
  strategy.exitRules.short = [];
  strategy.riskRules = {};
  strategy.costModel.feeBps = 250;
  strategy.costModel.slippageBps = 300;
  strategy.costModel.startingEquity = 1_000;

  const run = runStrategyBacktest(strategy, [
    { ts: 1, open: 10, high: 10.1, low: 9.9, close: 10, volume: 10 },
    { ts: 2, open: 10, high: 11.1, low: 9.9, close: 11, volume: 12 },
    { ts: 3, open: 11, high: 12.2, low: 10.8, close: 12, volume: 13 },
    { ts: 4, open: 12, high: 12.1, low: 10.9, close: 11, volume: 14 }
  ]);

  assert.equal(run.trades.length, 1);
  assert.equal(run.trades[0]?.entryPrice, 11);
  assert.equal(run.trades[0]?.exitPrice, 11);
  assert.equal(run.trades[0]?.feesPaid, 0);
  assert.equal(run.trades[0]?.slippagePaid, 0);
  assert.equal(run.trades[0]?.netPnl, 0);
  assert.equal(run.summary.feesPaid, 0);
  assert.equal(run.summary.slippagePaid, 0);
  assert.equal(run.summary.netPnl, 0);
  assert.equal(run.summary.endingEquity, 1_000);
});

test("runtime compiler adapts legacy rule groups into reusable condition expressions", () => {
  const strategy = makeStrategy("runtime-adapter");
  strategy.enabledSides = ["long"];
  strategy.entryRules.long = [
    {
      id: "entry-1",
      rules: [
        {
          id: "rule-1",
          left: { type: "price_field", field: "close" },
          operator: ">",
          right: {
            type: "indicator_output",
            indicator: "ema",
            output: "value",
            params: { period: 2 }
          }
        }
      ]
    },
    {
      id: "entry-2",
      rules: [
        {
          id: "rule-2",
          left: { type: "price_field", field: "hl2", barsAgo: 1 },
          operator: ">=",
          right: { type: "constant", value: 10.5 }
        }
      ]
    }
  ];
  strategy.entryRules.short = [];
  strategy.exitRules.long = [];
  strategy.exitRules.short = [];
  strategy.riskRules = {};

  const runtime = compileStrategyToRuntime(strategy);
  const runtimeSeries = buildRuntimeIndicatorSeriesMap(SAMPLE_CANDLES, runtime);

  assert.equal(runtime.entry.long?.type, "logical");
  assert.equal(
    evaluateRuntimeCondition(runtime.entry.long!, SAMPLE_CANDLES, runtimeSeries, 3),
    true
  );
  assert.equal(
    evaluateRuntimeValue(
      {
        type: "math",
        operator: "-",
        left: { type: "operand", operand: { type: "price_field", field: "ohlc4" } },
        right: { type: "operand", operand: { type: "price_field", field: "hl2" } }
      },
      SAMPLE_CANDLES,
      runtimeSeries,
      2
    ),
    0
  );
});

test("pine-like parser builds AST v2 that compiles into runtime conditions with bindings", () => {
  const ast = parsePineLikeStrategy(`
fast = ta.ema(close, 2)
slow = ta.sma(close, 3)
longEntry = ta.crossover(fast, slow) or close > slow
longExit = ta.crossunder(close, fast)
`);
  const strategy = makeStrategy("pine-ast");
  strategy.enabledSides = ["long"];
  strategy.riskRules = {};

  const runtime = compileAstToRuntime(strategy, ast);
  const runtimeSeries = buildRuntimeIndicatorSeriesMap(SAMPLE_CANDLES, runtime);

  assert.equal(ast.bindings.length, 2);
  assert.equal(runtime.entry.long?.type, "logical");
  assert.equal(runtime.exit.long?.type, "comparison");
  assert.equal(
    evaluateRuntimeCondition(runtime.entry.long!, SAMPLE_CANDLES, runtimeSeries, 4),
    true
  );
});
