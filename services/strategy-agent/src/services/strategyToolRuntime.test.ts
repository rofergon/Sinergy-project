import test from "node:test";
import assert from "node:assert/strict";
import { createStrategyToolRuntime } from "./strategyToolRuntime.js";

test("tracked LangChain tools inject context and append trace entries", async () => {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const runtime = createStrategyToolRuntime({
    transport: (async (tool: string, input: Record<string, unknown>) => {
      calls.push({
        tool,
        input
      });

      if (tool === "create_strategy_draft") {
        return {
          strategy: {
            id: "11111111-1111-4111-8111-111111111111",
            ownerAddress: (input as { ownerAddress: string }).ownerAddress,
            marketId: (input as { marketId: string }).marketId,
            name: (input as { name?: string }).name ?? "draft"
          }
        };
      }

      return {};
    }) as any
  });

  const trace: any[] = [];
  const tools = runtime.createTrackedLangChainTools({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    trace
  });

  const createDraftTool = tools.find((entry) => entry.name === "create_strategy_draft");
  assert.ok(createDraftTool);

  const result = await (createDraftTool as any).invoke({
    name: "EMA runtime test"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tool, "create_strategy_draft");
  assert.deepEqual(calls[0]?.input, {
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    name: "EMA runtime test"
  });
  assert.equal((result as { strategy?: { id?: string } }).strategy?.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(trace.length, 1);
  assert.equal(trace[0]?.tool, "create_strategy_draft");
  assert.deepEqual(trace[0]?.input, calls[0]?.input);
  assert.equal(trace[0]?.output?.strategy?.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(trace[0]?.failureClass, undefined);
});
