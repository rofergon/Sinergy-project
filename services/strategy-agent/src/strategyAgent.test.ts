import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFallbackJsonLoop } from "./services/fallbackRuntime.js";
import { StrategyAgentService } from "./services/strategyAgent.js";

test("fallback loop executes tool actions and collects artifacts", async () => {
  const trace: any[] = [];
  const responses = [
    {
      content:
        '{"type":"tool","goal_state":"have a strategy draft","tool":"create_strategy_draft","input":{"name":"EMA draft"},"reason":"Need a draft first","expected_artifact":"strategy draft","stop_condition":"a draft exists"}'
    },
    {
      content:
        '{"type":"tool","goal_state":"have backtest results","tool":"run_strategy_backtest","input":{},"reason":"Need to test it","expected_artifact":"backtest summary","stop_condition":"summary exists"}'
    },
    {
      content:
        '{"type":"final","goal_state":"complete","message":"Done","artifacts":{"strategyId":"11111111-1111-4111-8111-111111111111","runId":"22222222-2222-4222-8222-222222222222"},"expected_artifact":"final answer","stop_condition":"response sent"}'
    }
  ];

  const result = await runFallbackJsonLoop({
    model: {
      invoke: async () => responses.shift() ?? { content: '{"type":"final","message":"Done"}' }
    } as any,
    goal: "Create and test a strategy",
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    maxSteps: 4,
    trace,
    invokeTool: async (tool, input) => {
      if (tool === "create_strategy_draft") {
        return {
          strategy: {
            id: "11111111-1111-4111-8111-111111111111",
            ...input
          }
        };
      }

      if (tool === "run_strategy_backtest") {
        return {
          summary: {
            runId: "22222222-2222-4222-8222-222222222222",
            tradeCount: 4
          }
        };
      }

      return {};
    }
  });

  assert.equal(result.finalMessage, "Done");
  assert.equal(result.artifacts.strategyId, "11111111-1111-4111-8111-111111111111");
  assert.equal(result.artifacts.runId, "22222222-2222-4222-8222-222222222222");
  assert.equal(trace.length, 2);
  assert.equal(trace[1]?.input?.strategyId, "11111111-1111-4111-8111-111111111111");
  assert.equal(result.metrics.toolCalls, 2);
  assert.equal(result.metrics.successfulToolCalls, 2);
});

test("fallback loop aborts repeated stalled tool calls", async () => {
  const trace: any[] = [];
  const responses = [
    {
      content:
        '{"type":"tool","goal_state":"inspect capabilities","tool":"list_strategy_capabilities","input":{},"reason":"Need capabilities","expected_artifact":"capabilities","stop_condition":"capabilities loaded"}'
    },
    {
      content:
        '{"type":"tool","goal_state":"inspect capabilities","tool":"list_strategy_capabilities","input":{},"reason":"Need capabilities again","expected_artifact":"capabilities","stop_condition":"capabilities loaded"}'
    },
    {
      content:
        '{"type":"tool","goal_state":"inspect capabilities","tool":"list_strategy_capabilities","input":{},"reason":"Still need capabilities","expected_artifact":"capabilities","stop_condition":"capabilities loaded"}'
    }
  ];

  const result = await runFallbackJsonLoop({
    model: {
      invoke: async () => responses.shift() ?? { content: '{"type":"final","message":"Stopped"}' }
    } as any,
    goal: "Inspect strategy capabilities",
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    maxSteps: 4,
    trace,
    invokeTool: async () => ({})
  });

  assert.match(result.warnings.join("\n"), /Aborted repeated tool call/);
  assert.equal(result.metrics.loopsAborted, 1);
  assert.equal(trace.length, 2);
});

test("creation fast path compiles engine-backed source before drafting", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "strategy-agent-test-"));
  const service = new StrategyAgentService({
    matcherUrl: "http://localhost:3999",
    sessionDbFile: join(tempDir, "sessions.sqlite"),
    modelBaseUrl: "http://localhost:3998",
    modelName: "test-model",
    modelApiKey: "test-key",
    modelTimeoutMs: 2_000,
    maxSteps: 6,
    toolcallRetries: 0,
    forceFallbackJson: true
  });

  const strategyId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  let currentStrategy: Record<string, unknown> | undefined;

  (service as any).invokePlanningModel = async () => ({
    content: JSON.stringify({
      analysis: "Trend regime supports an EMA crossover engine.",
      mode: "create_engine",
      name: "EMA Agent Engine",
      engineHint: {
        kind: "ema",
        params: { fast: 8, slow: 21 }
      },
      strategyPatch: {
        timeframe: "15m",
        enabledSides: ["long", "short"],
        riskRules: {
          stopLossPct: 2,
          takeProfitPct: 4,
          trailingStopPct: 1,
          maxBarsInTrade: 40
        }
      }
    })
  });

  (service as any).matcherTransport = async (tool: string, input: Record<string, unknown>) => {
    switch (tool) {
      case "list_strategy_capabilities":
        return { capabilities: {} };
      case "analyze_market_context":
        return {
          analysis: {
            recommendedTimeframe: "15m",
            recommendedStrategyKinds: ["ema"],
            emaSuggestion: { fastPeriod: 8, slowPeriod: 21 },
            overallRegime: "trending"
          }
        };
      case "list_strategy_templates":
        return { templates: [] };
      case "compile_strategy_source":
        return {
          engine: input.engine,
          preview: {
            sourceType: "pine_like_v0",
            bindingCount: 2,
            signalsPresent: ["longEntry", "longExit", "shortEntry", "shortExit"],
            enabledSides: input.enabledSides ?? ["long", "short"],
            timeframe: input.timeframe ?? "15m",
            indicatorRefs: [],
            warnings: []
          }
        };
      case "create_strategy_draft":
        currentStrategy = {
          id: strategyId,
          ownerAddress: input.ownerAddress,
          marketId: input.marketId,
          name: input.name,
          timeframe: "15m",
          enabledSides: ["long", "short"],
          entryRules: { long: [], short: [] },
          exitRules: { long: [], short: [] },
          sizing: { mode: "percent_of_equity", value: 25 },
          riskRules: { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 1, maxBarsInTrade: 40 },
          costModel: { feeBps: 10, slippageBps: 5, startingEquity: 10_000 },
          status: "draft",
          schemaVersion: "1.0.0",
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:00.000Z",
          engine: input.engine
        };
        return { strategy: currentStrategy };
      case "update_strategy_draft":
        currentStrategy = input.strategy as Record<string, unknown>;
        return { strategy: currentStrategy };
      case "validate_strategy_draft":
        return { validation: { ok: true, issues: [] } };
      case "run_strategy_backtest":
        return {
          summary: {
            runId,
            netPnl: 12.5,
            winRate: 50,
            tradeCount: 6,
            maxDrawdownPct: 3.1,
            profitFactor: 1.4
          },
          trades: [],
          overlay: { entries: [], exits: [], indicators: [] }
        };
      default:
        throw new Error(`Unexpected tool: ${tool}`);
    }
  };

  const result = await service.run({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    goal: "Crea una estrategia EMA crossover y haz backtest",
    preferredTimeframe: "15m",
    mode: "run"
  });

  const compileIndex = result.toolTrace.findIndex((entry) => entry.tool === "compile_strategy_source");
  const createIndex = result.toolTrace.findIndex((entry) => entry.tool === "create_strategy_draft");
  assert.notEqual(compileIndex, -1);
  assert.notEqual(createIndex, -1);
  assert.ok(compileIndex < createIndex);

  const createEntry = result.toolTrace.find((entry) => entry.tool === "create_strategy_draft");
  assert.equal((createEntry?.input.engine as { sourceType?: string } | undefined)?.sourceType, "pine_like_v0");
  assert.match(String((createEntry?.input.engine as { script?: string } | undefined)?.script ?? ""), /fast = ta\.ema\(close, 8\)/);
  assert.equal(result.artifacts.strategyId, strategyId);
  assert.equal(result.artifacts.runId, runId);
});
