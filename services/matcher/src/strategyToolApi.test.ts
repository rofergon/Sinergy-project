import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HexString } from "@sinergy/shared";
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
