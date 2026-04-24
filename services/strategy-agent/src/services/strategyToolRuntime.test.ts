import test from "node:test";
import assert from "node:assert/strict";
import { createStrategyToolRuntime } from "./strategyToolRuntime.js";

test("agent-facing LangChain tools and catalog exclude destructive strategy deletion", () => {
  const runtime = createStrategyToolRuntime({
    transport: (async () => ({})) as any
  });

  const tools = runtime.createTrackedLangChainTools({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    trace: []
  });

  assert.equal(tools.some((entry) => entry.name === "delete_strategy"), false);
  assert.equal(runtime.getCatalog().some((entry) => entry.name === "delete_strategy"), false);
});

test("tracked LangChain tools inject context, append trace entries, and persist artifacts to state", async () => {
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

  const result = await (createDraftTool as any).invoke(
    { name: "EMA runtime test" },
    {
      toolCallId: "tool-call-1",
      context: {
        ownerAddress: "0x00000000000000000000000000000000000000c3",
        marketId: "0x0000000000000000000000000000000000000000000000000000000000000111"
      }
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tool, "create_strategy_draft");
  assert.deepEqual(calls[0]?.input, {
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    name: "EMA runtime test"
  });
  assert.equal((result as { update?: { strategyId?: string } }).update?.strategyId, "11111111-1111-4111-8111-111111111111");
  assert.equal(trace.length, 1);
  assert.equal(trace[0]?.tool, "create_strategy_draft");
  assert.deepEqual(trace[0]?.input, calls[0]?.input);
  assert.equal(trace[0]?.output?.strategy?.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(trace[0]?.failureClass, undefined);
});

test("tracked LangChain tools read strategyId and runId from runtime state", async () => {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const runtime = createStrategyToolRuntime({
    transport: (async (tool: string, input: Record<string, unknown>) => {
      calls.push({ tool, input });
      return tool === "run_strategy_backtest"
        ? {
            summary: {
              runId: "22222222-2222-4222-8222-222222222222"
            }
          }
        : {
            summary: {}
          };
    }) as any
  });

  const trace: any[] = [];
  const tools = runtime.createTrackedLangChainTools({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    trace
  });

  const backtestTool = tools.find((entry) => entry.name === "run_strategy_backtest");
  assert.ok(backtestTool);

  const result = await (backtestTool as any).invoke(
    { bars: 500 },
    {
      toolCallId: "tool-call-2",
      context: {
        ownerAddress: "0x00000000000000000000000000000000000000c3"
      },
      state: {
        strategyId: "11111111-1111-4111-8111-111111111111",
        runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      }
    }
  );

  assert.deepEqual(calls[0], {
    tool: "run_strategy_backtest",
    input: {
      ownerAddress: "0x00000000000000000000000000000000000000c3",
      strategyId: "11111111-1111-4111-8111-111111111111",
      bars: 500
    }
  });
  assert.equal((result as { update?: { runId?: string } }).update?.runId, "22222222-2222-4222-8222-222222222222");
  assert.equal(trace[0]?.input?.strategyId, "11111111-1111-4111-8111-111111111111");
});

test("tracked LangChain tools emit custom progress events through runtime writer", async () => {
  const progressEvents: Array<{ type?: string; tool?: string; message?: string }> = [];
  const runtime = createStrategyToolRuntime({
    transport: (async () => ({
      capabilities: {}
    })) as any
  });

  const trace: any[] = [];
  const tools = runtime.createTrackedLangChainTools({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    trace
  });

  const capabilitiesTool = tools.find((entry) => entry.name === "list_strategy_capabilities");
  assert.ok(capabilitiesTool);

  await (capabilitiesTool as any).invoke(
    {},
    {
      context: {
        ownerAddress: "0x00000000000000000000000000000000000000c3"
      },
      writer(chunk: unknown) {
        progressEvents.push(chunk as { type?: string; tool?: string; message?: string });
      }
    }
  );

  assert.ok(progressEvents.length >= 2);
  assert.equal(progressEvents[0]?.type, "tool_progress");
  assert.equal(progressEvents[0]?.tool, "list_strategy_capabilities");
  assert.match(String(progressEvents.map((event) => event.message).join("\n")), /Calling strategy tool service|completed successfully|capabilities/i);
});
