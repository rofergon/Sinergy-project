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

test("creation fast path auto-runs backtest for new strategies even when prompt does not mention it", async () => {
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

  const strategyId = "12121212-1212-4212-8212-121212121212";
  const runId = "34343434-3434-4434-8434-343434343434";

  (service as any).invokePlanningModel = async () => ({
    content: JSON.stringify({
      analysis: "Simple EMA strategy.",
      mode: "create_engine",
      name: "Basic EMA",
      engineHint: {
        kind: "ema",
        params: { fast: 9, slow: 21 }
      },
      strategyPatch: {
        timeframe: "15m",
        enabledSides: ["long"]
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
            emaSuggestion: { fastPeriod: 9, slowPeriod: 21 },
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
            signalsPresent: ["longEntry", "longExit"],
            enabledSides: input.enabledSides ?? ["long"],
            timeframe: input.timeframe ?? "15m",
            indicatorRefs: [],
            warnings: []
          }
        };
      case "create_strategy_draft":
        return {
          strategy: {
            id: strategyId,
            ownerAddress: input.ownerAddress,
            marketId: input.marketId,
            name: input.name,
            timeframe: "15m",
            enabledSides: ["long"],
            entryRules: { long: [], short: [] },
            exitRules: { long: [], short: [] },
            sizing: { mode: "percent_of_equity", value: 25 },
            riskRules: { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 1, maxBarsInTrade: 40 },
            costModel: { feeBps: 10, slippageBps: 5, startingEquity: 10_000 },
            status: "draft",
            schemaVersion: "1.0.0",
            createdAt: "2026-04-14T00:00:00.000Z",
            updatedAt: "2026-04-14T00:00:00.000Z",
            engine: input.engine
          }
        };
      case "update_strategy_draft":
        return { strategy: input.strategy };
      case "validate_strategy_draft":
        return { validation: { ok: true, issues: [] } };
      case "run_strategy_backtest":
        return {
          summary: {
            runId,
            netPnl: 7.5,
            winRate: 60,
            tradeCount: 5,
            maxDrawdownPct: 2.1,
            profitFactor: 1.5
          },
          trades: [],
          overlay: { indicators: [], markers: [] }
        };
      default:
        throw new Error(`Unexpected tool: ${tool}`);
    }
  };

  const result = await service.run({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    goal: "Crea una estrategia de ema basica pero eficiente",
    preferredTimeframe: "15m",
    mode: "run"
  });

  assert.equal(result.artifacts.strategyId, strategyId);
  assert.equal(result.artifacts.runId, runId);
  assert.notEqual(result.toolTrace.findIndex((entry) => entry.tool === "run_strategy_backtest"), -1);
});

test("optimization fast path recompiles engine-backed strategies", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "strategy-agent-test-"));
  const service = new StrategyAgentService({
    matcherUrl: "http://localhost:3999",
    sessionDbFile: join(tempDir, "sessions.sqlite"),
    modelBaseUrl: "http://localhost:3998",
    modelName: "test-model",
    modelApiKey: "test-key",
    modelTimeoutMs: 2_000,
    maxSteps: 8,
    toolcallRetries: 0,
    forceFallbackJson: true
  });

  const strategyId = "33333333-3333-4333-8333-333333333333";

  (service as any).invokePlanningModel = async () => ({
    content: JSON.stringify({
      analysis: "Tune EMA params.",
      candidates: [
        {
          label: "ema-opt",
          params: { fast: 6, slow: 18, timeframe: "15m" }
        }
      ]
    })
  });

  let lastUpdated: Record<string, unknown> | undefined;
  (service as any).matcherTransport = async (tool: string, input: Record<string, unknown>) => {
    switch (tool) {
      case "get_strategy":
        return {
          strategy: {
            id: strategyId,
            ownerAddress: input.ownerAddress,
            marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
            name: "EMA Engine Base",
            timeframe: "15m",
            enabledSides: ["long", "short"],
            entryRules: { long: [], short: [] },
            exitRules: { long: [], short: [] },
            sizing: { mode: "percent_of_equity", value: 25 },
            riskRules: { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 1, maxBarsInTrade: 40 },
            costModel: { feeBps: 10, slippageBps: 5, startingEquity: 10_000 },
            status: "draft",
            schemaVersion: "1.0.0",
            createdAt: "2026-04-14T00:00:00.000Z",
            updatedAt: "2026-04-14T00:00:00.000Z",
            engine: {
              version: "2",
              sourceType: "pine_like_v0",
              script: "fast = ta.ema(close, 9)\nslow = ta.ema(close, 21)\nlongEntry = ta.crossover(fast, slow)\nlongExit = ta.crossunder(fast, slow)"
            }
          }
        };
      case "analyze_market_context":
        return {
          analysis: {
            recommendedTimeframe: "15m",
            recommendedStrategyKinds: ["ema"],
            emaSuggestion: { fastPeriod: 6, slowPeriod: 18 },
            overallRegime: "trending"
          }
        };
      case "run_strategy_backtest":
        return {
          summary: { netPnl: 9, tradeCount: 4, winRate: 50, maxDrawdownPct: 3, profitFactor: 1.2 },
          trades: [],
          overlay: { entries: [], exits: [], indicators: [] }
        };
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
      case "update_strategy_draft":
        lastUpdated = input.strategy as Record<string, unknown>;
        return { strategy: input.strategy };
      case "validate_strategy_draft":
        return { validation: { ok: true, issues: [] } };
      default:
        return { capabilities: {} };
    }
  };

  const result = await service.run({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    strategyId,
    goal: "Optimiza la estrategia para mejor PnL",
    preferredTimeframe: "15m",
    mode: "run"
  });

  const compileIndex = result.toolTrace.findIndex((entry) => entry.tool === "compile_strategy_source");
  assert.notEqual(compileIndex, -1);
  assert.equal((lastUpdated?.engine as { sourceType?: string } | undefined)?.sourceType, "pine_like_v0");
  assert.match(String((lastUpdated?.engine as { script?: string } | undefined)?.script ?? ""), /ta\.ema\(close, 6\)/);
});

test("optimization fast path normalizes ast_v2 engines", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "strategy-agent-test-"));
  const service = new StrategyAgentService({
    matcherUrl: "http://localhost:3999",
    sessionDbFile: join(tempDir, "sessions.sqlite"),
    modelBaseUrl: "http://localhost:3998",
    modelName: "test-model",
    modelApiKey: "test-key",
    modelTimeoutMs: 2_000,
    maxSteps: 8,
    toolcallRetries: 0,
    forceFallbackJson: true
  });

  const strategyId = "44444444-4444-4444-8444-444444444444";
  let lastUpdated: Record<string, unknown> | undefined;

  (service as any).invokePlanningModel = async () => ({
    content: JSON.stringify({
      analysis: "Adjust timeframe.",
      candidates: [
        {
          label: "tf-only",
          params: { timeframe: "1h" }
        }
      ]
    })
  });

  (service as any).matcherTransport = async (tool: string, input: Record<string, unknown>) => {
    switch (tool) {
      case "get_strategy":
        return {
          strategy: {
            id: strategyId,
            ownerAddress: input.ownerAddress,
            marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
            name: "AST Strategy",
            timeframe: "15m",
            enabledSides: ["long"],
            entryRules: { long: [], short: [] },
            exitRules: { long: [], short: [] },
            sizing: { mode: "percent_of_equity", value: 25 },
            riskRules: { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 1, maxBarsInTrade: 40 },
            costModel: { feeBps: 10, slippageBps: 5, startingEquity: 10_000 },
            status: "draft",
            schemaVersion: "1.0.0",
            createdAt: "2026-04-14T00:00:00.000Z",
            updatedAt: "2026-04-14T00:00:00.000Z",
            engine: {
              version: "2",
              sourceType: "ast_v2",
              ast: {
                timeframe: "15m",
                enabledSides: ["long"],
                bindings: [],
                signals: {}
              }
            }
          }
        };
      case "analyze_market_context":
        return {
          analysis: {
            recommendedTimeframe: "1h",
            recommendedStrategyKinds: ["ema"],
            emaSuggestion: { fastPeriod: 9, slowPeriod: 21 },
            overallRegime: "trending"
          }
        };
      case "compile_strategy_source":
        return {
          engine: input.engine,
          preview: {
            sourceType: "ast_v2",
            bindingCount: 0,
            signalsPresent: [],
            enabledSides: input.enabledSides ?? ["long"],
            timeframe: input.timeframe ?? "15m",
            indicatorRefs: [],
            warnings: []
          }
        };
      case "update_strategy_draft":
        lastUpdated = input.strategy as Record<string, unknown>;
        return { strategy: input.strategy };
      case "validate_strategy_draft":
        return { validation: { ok: true, issues: [] } };
      case "run_strategy_backtest":
        return {
          summary: { netPnl: 2, tradeCount: 1, winRate: 100, maxDrawdownPct: 0.1, profitFactor: 2 },
          trades: [],
          overlay: { entries: [], exits: [], indicators: [] }
        };
      default:
        return { capabilities: {} };
    }
  };

  const result = await service.run({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    strategyId,
    goal: "Optimiza la estrategia para mejorar el timeframe",
    preferredTimeframe: "1h",
    mode: "run"
  });

  const compileIndex = result.toolTrace.findIndex((entry) => entry.tool === "compile_strategy_source");
  assert.notEqual(compileIndex, -1);
  const updatedEngine = (lastUpdated?.engine as { sourceType?: string; ast?: { timeframe?: string } } | undefined);
  assert.equal(updatedEngine?.sourceType, "ast_v2");
  assert.equal(updatedEngine?.ast?.timeframe, "1h");
});

test("capability questions return help text instead of creating a strategy", async () => {
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

  let toolCalls = 0;
  (service as any).matcherTransport = async () => {
    toolCalls += 1;
    return {};
  };

  const result = await service.run({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    goal: "que puedes hacer",
    preferredTimeframe: "15m",
    mode: "run"
  });

  assert.equal(result.usedTools.length, 0);
  assert.equal(result.toolTrace.length, 0);
  assert.equal(toolCalls, 0);
  assert.match(result.finalMessage, /crear, modificar, validar/i);
});

test("modification fast path updates the active EMA strategy in place when adding an RSI filter", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "strategy-agent-test-"));
  const service = new StrategyAgentService({
    matcherUrl: "http://localhost:3999",
    sessionDbFile: join(tempDir, "sessions.sqlite"),
    modelBaseUrl: "http://localhost:3998",
    modelName: "test-model",
    modelApiKey: "test-key",
    modelTimeoutMs: 2_000,
    maxSteps: 8,
    toolcallRetries: 0,
    forceFallbackJson: true
  });

  const strategyId = "55555555-5555-4555-8555-555555555555";
  let lastUpdated: Record<string, unknown> | undefined;
  const toolsCalled: string[] = [];

  (service as any).matcherTransport = async (tool: string, input: Record<string, unknown>) => {
    toolsCalled.push(tool);
    switch (tool) {
      case "get_strategy":
        return {
          strategy: {
            id: strategyId,
            ownerAddress: input.ownerAddress,
            marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
            name: "EMA Base Long Only",
            timeframe: "15m",
            enabledSides: ["long"],
            entryRules: { long: [], short: [] },
            exitRules: { long: [], short: [] },
            sizing: { mode: "percent_of_equity", value: 25 },
            riskRules: { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 1, maxBarsInTrade: 40 },
            costModel: { feeBps: 10, slippageBps: 5, startingEquity: 10_000 },
            status: "draft",
            schemaVersion: "1.0.0",
            createdAt: "2026-04-14T00:00:00.000Z",
            updatedAt: "2026-04-14T00:00:00.000Z",
            engine: {
              version: "2",
              sourceType: "pine_like_v0",
              script: "fast = ta.ema(close, 9)\nslow = ta.ema(close, 21)\nlongEntry = ta.crossover(fast, slow)\nlongExit = ta.crossunder(fast, slow)"
            }
          }
        };
      case "analyze_market_context":
        return {
          analysis: {
            recommendedTimeframe: "15m",
            recommendedStrategyKinds: ["ema"],
            emaSuggestion: { fastPeriod: 9, slowPeriod: 21 },
            overallRegime: "trending"
          }
        };
      case "compile_strategy_source":
        return {
          engine: input.engine,
          preview: {
            sourceType: "pine_like_v0",
            bindingCount: 3,
            signalsPresent: ["longEntry", "longExit"],
            enabledSides: input.enabledSides ?? ["long"],
            timeframe: input.timeframe ?? "15m",
            indicatorRefs: [
              { indicator: "ema" },
              { indicator: "rsi" }
            ],
            warnings: []
          }
        };
      case "update_strategy_draft":
        lastUpdated = input.strategy as Record<string, unknown>;
        return { strategy: input.strategy };
      case "validate_strategy_draft":
        return { validation: { ok: true, issues: [] } };
      case "run_strategy_backtest":
        return {
          summary: { netPnl: 3, tradeCount: 2, winRate: 50, maxDrawdownPct: 1.2, profitFactor: 1.1, runId: "66666666-6666-4666-8666-666666666666" },
          trades: [],
          overlay: { indicators: [], markers: [] }
        };
      default:
        return { capabilities: {} };
    }
  };

  const result = await service.run({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    strategyId,
    goal: "puedes agregarle RSI para filtrar un poco",
    preferredTimeframe: "15m",
    mode: "run"
  });

  assert.equal(result.artifacts.strategyId, strategyId);
  assert.equal(toolsCalled.includes("create_strategy_draft"), false);
  assert.equal(toolsCalled.includes("get_strategy"), true);
  assert.equal((lastUpdated?.id as string | undefined) ?? "", strategyId);
  assert.deepEqual(lastUpdated?.enabledSides, ["long"]);
  assert.match(String((lastUpdated?.engine as { script?: string } | undefined)?.script ?? ""), /ta\.rsi\(close,\s*14\)/);
});
