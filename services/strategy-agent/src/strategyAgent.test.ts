import test from "node:test";
import assert from "node:assert/strict";
import { runFallbackJsonLoop } from "./services/fallbackRuntime.js";

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
