import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HexString } from "@sinergy/shared";
import { privateKeyToAccount } from "viem/accounts";
import type { ResolvedMarket, ResolvedToken } from "./types.js";
import { StrategyService } from "./services/strategyService.js";
import { StrategyToolApi } from "./services/strategyToolApi.js";
import { StrategyToolError } from "./services/strategyToolSecurity.js";

function makeToken(symbol: string, address: HexString): ResolvedToken {
  return {
    symbol,
    name: symbol,
    address,
    decimals: 6,
    kind: symbol === "cUSDC" ? "quote" : "crypto"
  };
}

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "sinergy-strategy-test-"));
  const base = makeToken("cINIT", "0x00000000000000000000000000000000000000a1");
  const quote = makeToken("cUSDC", "0x00000000000000000000000000000000000000b2");
  const market: ResolvedMarket = {
    id: "0x0000000000000000000000000000000000000000000000000000000000000111",
    symbol: "cINIT/cUSDC",
    baseToken: base,
    quoteToken: quote,
    routeable: false,
    routePolicy: "dark-pool-only"
  };
  const strategyService = new StrategyService({
    dbFile: join(root, "strategies.sqlite"),
    markets: [market],
    chainId: 1716124615666775,
    strategyExecutorAddress: "0x0000000000000000000000000000000000000e11",
    priceService: {
      getCandles: (_symbol: string, _timeframe?: string, limit = 200) => {
        if (limit <= 5) {
          return [
            { ts: 1, open: 10, high: 10.5, low: 9.8, close: 10, volume: 10 },
            { ts: 2, open: 10, high: 11.2, low: 9.9, close: 11, volume: 12 },
            { ts: 3, open: 11, high: 12.3, low: 10.8, close: 12, volume: 14 },
            { ts: 4, open: 12, high: 13.5, low: 11.8, close: 13, volume: 13 },
            { ts: 5, open: 13, high: 12.9, low: 11.8, close: 12, volume: 11 }
          ];
        }

        return Array.from({ length: Math.min(limit, 90) }, (_, index) => {
          const basePrice = 10 + index * 0.18 + Math.sin(index / 6) * 0.4;
          const close = Number(basePrice.toFixed(4));
          const open = Number((close - 0.08).toFixed(4));
          const high = Number((close + 0.22).toFixed(4));
          const low = Number((close - 0.24).toFixed(4));
          return {
            ts: index + 1,
            open,
            high,
            low,
            close,
            volume: 10 + (index % 7)
          };
        });
      }
    } as any
  });

  return {
    root,
    market,
    service: strategyService,
    api: new StrategyToolApi(strategyService),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("strategy tool API can create, validate, save and backtest a draft", async () => {
  const harness = makeHarness();
  const ownerAddress = "0x00000000000000000000000000000000000000c3" as HexString;

  try {
    const draftResult = await harness.api.execute("create_strategy_draft", {
      ownerAddress,
      marketId: harness.market.id
    }) as { strategy: import("@sinergy/shared").StrategyDefinition };
    const draft = draftResult.strategy;

    draft.enabledSides = ["long"];
    draft.entryRules.long = [
      {
        id: "entry-1",
        rules: [
          {
            id: "entry-rule-1",
            left: { type: "price_field", field: "close" },
            operator: ">",
            right: { type: "constant", value: 10 }
          }
        ]
      }
    ];
    draft.entryRules.short = [];
    draft.exitRules.long = [
      {
        id: "exit-1",
        rules: [
          {
            id: "exit-rule-1",
            left: { type: "price_field", field: "close" },
            operator: ">=",
            right: { type: "constant", value: 12 }
          }
        ]
      }
    ];
    draft.exitRules.short = [];
    draft.costModel.startingEquity = 1000;
    draft.costModel.feeBps = 0;
    draft.costModel.slippageBps = 0;
    draft.riskRules = {};

    const updated = await harness.api.execute("update_strategy_draft", {
      ownerAddress,
      strategy: draft
    }) as { strategy: import("@sinergy/shared").StrategyDefinition };
    assert.equal(updated.strategy.status, "draft");

    const validation = await harness.api.execute("validate_strategy_draft", {
      ownerAddress,
      strategyId: draft.id
    }) as { validation: import("@sinergy/shared").StrategyValidationResult };
    assert.equal(validation.validation.ok, true);

    const saved = await harness.api.execute("save_strategy", {
      ownerAddress,
      strategyId: draft.id
    }) as {
      strategy: import("@sinergy/shared").StrategyDefinition;
      validation: import("@sinergy/shared").StrategyValidationResult;
    };
    assert.equal(saved.validation.ok, true);
    assert.equal(saved.strategy.status, "saved");

    const run = await harness.api.execute("run_strategy_backtest", {
      ownerAddress,
      strategyId: draft.id,
      bars: 5
    }) as {
      summary: import("@sinergy/shared").StrategyBacktestSummary;
      trades: import("@sinergy/shared").StrategyBacktestTrade[];
      overlay: import("@sinergy/shared").StrategyChartOverlay;
    };
    assert.equal(run.summary.tradeCount, 2);
    assert.equal(run.trades.length, 2);
    assert.equal(run.overlay.markers.length >= 2, true);
    assert.equal(run.trades[0].exitReason, "rule");

    const summary = await harness.api.execute("get_backtest_summary", {
      ownerAddress,
      runId: run.summary.runId
    }) as { summary: import("@sinergy/shared").StrategyBacktestSummary };
    assert.equal(summary.summary.tradeCount, 2);

    const trades = await harness.api.execute("get_backtest_trades", {
      ownerAddress,
      runId: run.summary.runId
    }) as { trades: import("@sinergy/shared").StrategyBacktestTrade[] };
    assert.equal(trades.trades.length, 2);

    const overlay = await harness.api.execute("get_backtest_chart_overlay", {
      ownerAddress,
      runId: run.summary.runId
    }) as { overlay: import("@sinergy/shared").StrategyChartOverlay };
    assert.equal(overlay.overlay.runId, run.summary.runId);
  } finally {
    harness.cleanup();
  }
});

test("strategy tool API can delete a strategy and its derived artifacts", async () => {
  const harness = makeHarness();
  const ownerAddress = "0x00000000000000000000000000000000000000c4" as HexString;

  try {
    const draftResult = await harness.api.execute("create_strategy_draft", {
      ownerAddress,
      marketId: harness.market.id
    }) as { strategy: import("@sinergy/shared").StrategyDefinition };
    const draft = draftResult.strategy;

    draft.enabledSides = ["long"];
    draft.entryRules.long = [
      {
        id: "entry-1",
        rules: [
          {
            id: "entry-rule-1",
            left: { type: "price_field", field: "close" },
            operator: ">",
            right: { type: "constant", value: 10 }
          }
        ]
      }
    ];
    draft.exitRules.long = [
      {
        id: "exit-1",
        rules: [
          {
            id: "exit-rule-1",
            left: { type: "price_field", field: "close" },
            operator: ">=",
            right: { type: "constant", value: 12 }
          }
        ]
      }
    ];
    draft.entryRules.short = [];
    draft.exitRules.short = [];
    draft.costModel.startingEquity = 1000;
    draft.costModel.feeBps = 0;
    draft.costModel.slippageBps = 0;
    draft.riskRules = {};

    await harness.api.execute("update_strategy_draft", {
      ownerAddress,
      strategy: draft
    });

    await harness.api.execute("save_strategy", {
      ownerAddress,
      strategyId: draft.id
    });

    const backtest = await harness.api.execute("run_strategy_backtest", {
      ownerAddress,
      strategyId: draft.id,
      bars: 5
    }) as { summary: import("@sinergy/shared").StrategyBacktestSummary };

    const deleted = await harness.api.execute("delete_strategy", {
      ownerAddress,
      strategyId: draft.id
    }) as { strategyId: string; deleted: true };

    assert.equal(deleted.deleted, true);
    assert.equal(deleted.strategyId, draft.id);

    const strategies = await harness.api.execute("list_user_strategies", {
      ownerAddress
    }) as { strategies: import("@sinergy/shared").StrategyDefinition[] };
    assert.equal(strategies.strategies.length, 0);

    assert.throws(
      () => harness.service.getBacktestSummary({
        ownerAddress,
        runId: backtest.summary.runId
      }),
      () => true
    );
  } finally {
    harness.cleanup();
  }
});

test("strategy execution approvals can be created, signed, stored, and invalidated after strategy edits", async () => {
  const harness = makeHarness();
  const ownerPk = "0x00000000000000000000000000000000000000000000000000000000000000c3";
  const ownerAccount = privateKeyToAccount(ownerPk);
  const ownerAddress = ownerAccount.address as HexString;

  try {
    const created = await harness.api.execute("create_strategy_draft", {
      ownerAddress,
      marketId: harness.market.id,
      name: "Execution Ready Strategy"
    }) as { strategy: import("@sinergy/shared").StrategyDefinition };

    const preparedStrategy = {
      ...created.strategy,
      enabledSides: ["long"] as const,
      entryRules: {
        long: [
          {
            id: "entry-1",
            rules: [
              {
                id: "entry-rule-1",
                left: { type: "price_field", field: "close" as const },
                operator: ">" as const,
                right: { type: "constant", value: 10 }
              }
            ]
          }
        ],
        short: []
      },
      exitRules: {
        long: [
          {
            id: "exit-1",
            rules: [
              {
                id: "exit-rule-1",
                left: { type: "price_field", field: "close" as const },
                operator: ">=" as const,
                right: { type: "constant", value: 12 }
              }
            ]
          }
        ],
        short: []
      },
      costModel: {
        ...created.strategy.costModel,
        startingEquity: 1000,
        feeBps: 0,
        slippageBps: 0
      },
      riskRules: {}
    };

    await harness.api.execute("update_strategy_draft", {
      ownerAddress,
      strategy: preparedStrategy
    });

    const saved = await harness.api.execute("save_strategy", {
      ownerAddress,
      strategyId: created.strategy.id
    }) as {
      strategy: import("@sinergy/shared").StrategyDefinition;
      validation: import("@sinergy/shared").StrategyValidationResult;
    };
    assert.equal(saved.validation.ok, true);

    const intent = harness.service.createExecutionIntent({
      ownerAddress,
      strategyId: created.strategy.id
    });

    const signature = await ownerAccount.signTypedData({
      domain: intent.domain,
      types: intent.types,
      primaryType: intent.primaryType,
      message: {
        owner: intent.message.owner,
        strategyIdHash: intent.message.strategyIdHash,
        strategyHash: intent.message.strategyHash,
        marketId: intent.message.marketId,
        maxSlippageBps: BigInt(intent.message.maxSlippageBps),
        nonce: BigInt(intent.message.nonce),
        deadline: BigInt(intent.message.deadline)
      }
    });

    const approval = await harness.service.saveExecutionApproval({
      ownerAddress,
      strategyId: created.strategy.id,
      message: intent.message,
      signature
    });

    assert.equal(approval.strategyId, created.strategy.id);
    assert.equal(approval.status, "active");

    const fetched = harness.service.getExecutionApproval(created.strategy.id, ownerAddress);
    assert.equal(fetched.signature, signature);

    const updated = await harness.api.execute("update_strategy_draft", {
      ownerAddress,
      strategy: {
        ...saved.strategy,
        name: "Execution Ready Strategy v2"
      }
    }) as { strategy: import("@sinergy/shared").StrategyDefinition };
    assert.equal(updated.strategy.name, "Execution Ready Strategy v2");

    assert.throws(
      () => harness.service.getExecutionApproval(created.strategy.id, ownerAddress),
      (error: unknown) =>
        error instanceof StrategyToolError &&
        (error.code === "strategy_approval_not_found" || error.code === "stale_strategy_approval")
    );
  } finally {
    harness.cleanup();
  }
});

test("capabilities and templates are exposed for agents", async () => {
  const harness = makeHarness();
  const ownerAddress = "0x00000000000000000000000000000000000000c3" as HexString;

  try {
    const capabilities = await harness.api.execute("list_strategy_capabilities", {
      ownerAddress
    }) as { capabilities: import("@sinergy/shared").StrategyCapabilities };
    assert.equal(capabilities.capabilities.indicatorCatalog.length > 0, true);
    assert.equal(capabilities.capabilities.timeframes.includes("15m"), true);

    const templates = await harness.api.execute("list_strategy_templates", {
      ownerAddress,
      marketId: harness.market.id
    }) as { templates: import("@sinergy/shared").StrategyTemplate[] };
    assert.equal(templates.templates.length >= 4, true);

    const cloned = await harness.api.execute("clone_strategy_template", {
      ownerAddress,
      marketId: harness.market.id,
      templateId: templates.templates[0].id
    }) as { strategy: import("@sinergy/shared").StrategyDefinition };
    assert.equal(cloned.strategy.ownerAddress, ownerAddress);
    assert.equal(cloned.strategy.marketId, harness.market.id);
  } finally {
    harness.cleanup();
  }
});

test("RSI strategies expose oscillator overlays and threshold guide lines", async () => {
  const harness = makeHarness();
  const ownerAddress = "0x00000000000000000000000000000000000000c3" as HexString;

  try {
    const cloned = await harness.api.execute("clone_strategy_template", {
      ownerAddress,
      marketId: harness.market.id,
      templateId: "rsi-mean-reversion"
    }) as { strategy: import("@sinergy/shared").StrategyDefinition };

    const saved = await harness.api.execute("save_strategy", {
      ownerAddress,
      strategyId: cloned.strategy.id
    }) as {
      strategy: import("@sinergy/shared").StrategyDefinition;
      validation: import("@sinergy/shared").StrategyValidationResult;
    };

    assert.equal(saved.validation.ok, true);

    const run = await harness.api.execute("run_strategy_backtest", {
      ownerAddress,
      strategyId: cloned.strategy.id,
      bars: 90
    }) as {
      overlay: import("@sinergy/shared").StrategyChartOverlay;
    };

    assert.equal(
      run.overlay.indicators.some((indicator) => indicator.label.startsWith("RSI value")),
      true
    );
    assert.equal(
      run.overlay.indicators.some(
        (indicator) => indicator.pane === "oscillator" && indicator.label === "RSI level 30"
      ),
      true
    );
    assert.equal(
      run.overlay.indicators.some(
        (indicator) => indicator.pane === "oscillator" && indicator.label === "RSI level 55"
      ),
      true
    );
  } finally {
    harness.cleanup();
  }
});

test("engine-backed EMA plus RSI strategies expose runtime RSI overlays", async () => {
  const harness = makeHarness();
  const ownerAddress = "0x00000000000000000000000000000000000000c4" as HexString;
  const script = `
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
rsiValue = ta.rsi(close, 14)
longEntry = ta.crossover(fast, slow) and rsiValue >= 55
longExit = ta.crossunder(fast, slow) or rsiValue <= 45
`;

  try {
    const compiled = await harness.api.execute("compile_strategy_source", {
      ownerAddress,
      marketId: harness.market.id,
      name: "EMA RSI Hybrid",
      timeframe: "15m",
      enabledSides: ["long"],
      engine: {
        version: "2",
        sourceType: "pine_like_v0",
        script
      }
    }) as import("@sinergy/shared").StrategySourceCompilation;

    const created = await harness.api.execute("create_strategy_draft", {
      ownerAddress,
      marketId: harness.market.id,
      name: "EMA RSI Hybrid",
      engine: compiled.engine
    }) as { strategy: import("@sinergy/shared").StrategyDefinition };

    const updated = await harness.api.execute("update_strategy_draft", {
      ownerAddress,
      strategy: {
        ...created.strategy,
        timeframe: "15m",
        enabledSides: ["long"],
        engine: compiled.engine
      }
    }) as { strategy: import("@sinergy/shared").StrategyDefinition };

    const run = await harness.api.execute("run_strategy_backtest", {
      ownerAddress,
      strategyId: updated.strategy.id,
      bars: 90
    }) as {
      overlay: import("@sinergy/shared").StrategyChartOverlay;
    };

    assert.equal(
      run.overlay.indicators.some((indicator) => indicator.pane === "oscillator" && indicator.label.startsWith("RSI value")),
      true
    );
  } finally {
    harness.cleanup();
  }
});

test("pine-like source can be compiled, saved as a draft, validated, and backtested through the tool API", async () => {
  const harness = makeHarness();
  const ownerAddress = "0x00000000000000000000000000000000000000c3" as HexString;
  const script = `
fast = ta.ema(close, 3)
slow = ta.sma(close, 5)
longEntry = ta.crossover(fast, slow) or close > fast
longExit = ta.crossunder(close, fast)
`;

  try {
    const compiled = await harness.api.execute("compile_strategy_source", {
      ownerAddress,
      marketId: harness.market.id,
      name: "Pine Compiler Preview",
      engine: {
        version: "2",
        sourceType: "pine_like_v0",
        script
      }
    }) as import("@sinergy/shared").StrategySourceCompilation;

    assert.equal(compiled.engine.sourceType, "pine_like_v0");
    assert.equal(compiled.preview.bindingCount, 2);
    assert.equal(compiled.preview.signalsPresent.includes("longEntry"), true);
    assert.equal(compiled.preview.indicatorRefs.some((ref) => ref.indicator === "ema"), true);

    const created = await harness.api.execute("create_strategy_draft", {
      ownerAddress,
      marketId: harness.market.id,
      name: "Pine Draft",
      engine: compiled.engine
    }) as { strategy: import("@sinergy/shared").StrategyDefinition };

    assert.equal(created.strategy.engine?.sourceType, "pine_like_v0");

    const validation = await harness.api.execute("validate_strategy_draft", {
      ownerAddress,
      strategyId: created.strategy.id
    }) as { validation: import("@sinergy/shared").StrategyValidationResult };

    assert.equal(validation.validation.ok, true);

    const run = await harness.api.execute("run_strategy_backtest", {
      ownerAddress,
      strategyId: created.strategy.id,
      bars: 20
    }) as {
      summary: import("@sinergy/shared").StrategyBacktestSummary;
      trades: import("@sinergy/shared").StrategyBacktestTrade[];
    };

    assert.equal(run.summary.tradeCount >= 0, true);
    assert.equal(Array.isArray(run.trades), true);
  } finally {
    harness.cleanup();
  }
});

test("market analysis exposes timeframe, regime, and support resistance hints", async () => {
  const harness = makeHarness();
  const ownerAddress = "0x00000000000000000000000000000000000000c3" as HexString;

  try {
    const analysis = await harness.api.execute("analyze_market_context", {
      ownerAddress,
      marketId: harness.market.id
    }) as { analysis: import("@sinergy/shared").StrategyMarketAnalysis };

    assert.equal(typeof analysis.analysis.recommendedTimeframe, "string");
    assert.equal(analysis.analysis.timeframes.length >= 3, true);
    assert.equal(analysis.analysis.recommendedStrategyKinds.length > 0, true);
    assert.equal(typeof analysis.analysis.emaSuggestion.fastPeriod, "number");
    assert.equal(typeof analysis.analysis.summary, "string");
  } finally {
    harness.cleanup();
  }
});

test("validation rejects identical long and short entry rules that would deadlock execution", async () => {
  const harness = makeHarness();
  const ownerAddress = "0x00000000000000000000000000000000000000c3" as HexString;

  try {
    const draftResult = await harness.api.execute("create_strategy_draft", {
      ownerAddress,
      marketId: harness.market.id
    }) as { strategy: import("@sinergy/shared").StrategyDefinition };
    const draft = draftResult.strategy;

    draft.enabledSides = ["long", "short"];
    draft.entryRules.long = [
      {
        id: "entry-long-1",
        rules: [
          {
            id: "entry-long-rule-1",
            left: { type: "indicator_output", indicator: "ema", output: "value", params: { period: 9 } },
            operator: "crosses_above",
            right: { type: "indicator_output", indicator: "ema", output: "value", params: { period: 21 } }
          }
        ]
      }
    ];
    draft.entryRules.short = [
      {
        id: "entry-short-1",
        rules: [
          {
            id: "entry-short-rule-1",
            left: { type: "indicator_output", indicator: "ema", output: "value", params: { period: 9 } },
            operator: "crosses_above",
            right: { type: "indicator_output", indicator: "ema", output: "value", params: { period: 21 } }
          }
        ]
      }
    ];

    await harness.api.execute("update_strategy_draft", {
      ownerAddress,
      strategy: draft
    });

    const validation = await harness.api.execute("validate_strategy_draft", {
      ownerAddress,
      strategyId: draft.id
    }) as { validation: import("@sinergy/shared").StrategyValidationResult };

    assert.equal(validation.validation.ok, false);
    assert.equal(
      validation.validation.issues.some((issue) => issue.code === "ambiguous_dual_side_entries"),
      true
    );
  } finally {
    harness.cleanup();
  }
});

test("strategy tool API rejects invalid owner addresses and oversized backtests with structured errors", async () => {
  const harness = makeHarness();
  const ownerAddress = "0x00000000000000000000000000000000000000c3" as HexString;

  try {
    await assert.rejects(
      () =>
        harness.api.execute("list_user_strategies", {
          ownerAddress: "0x1234"
        }),
      (error: unknown) =>
        error instanceof StrategyToolError && error.code === "invalid_tool_input"
    );

    const created = (await harness.api.execute("create_strategy_draft", {
      ownerAddress,
      marketId: harness.market.id,
      name: "Valid Draft"
    })) as { strategy: import("@sinergy/shared").StrategyDefinition };

    await assert.rejects(
      () =>
        harness.api.execute("run_strategy_backtest", {
          ownerAddress,
          strategyId: created.strategy.id,
          bars: 500_000
        }),
      (error: unknown) =>
        error instanceof StrategyToolError &&
        (error.code === "invalid_tool_input" || error.code === "invalid_backtest_bars")
    );
  } finally {
    harness.cleanup();
  }
});
