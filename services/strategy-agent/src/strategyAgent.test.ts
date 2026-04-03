import test from "node:test";
import assert from "node:assert/strict";
import { runFallbackJsonLoop } from "./services/fallbackRuntime.js";

test("fallback loop executes tool actions and collects artifacts", async () => {
  const trace: any[] = [];
  const responses = [
    {
      content:
        '{"type":"tool","tool":"create_strategy_draft","input":{"name":"EMA draft"},"reason":"Need a draft first"}'
    },
    {
      content:
        '{"type":"tool","tool":"run_strategy_backtest","input":{},"reason":"Need to test it"}'
    },
    {
      content:
        '{"type":"final","message":"Done","artifacts":{"strategyId":"11111111-1111-4111-8111-111111111111","runId":"22222222-2222-4222-8222-222222222222"}}'
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
      trace.push({
        step: trace.length + 1,
        tool,
        input,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      });
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
});
