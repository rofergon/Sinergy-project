import test from "node:test";
import assert from "node:assert/strict";
import { STRATEGY_AGENT_SYSTEM_PROMPT, buildFallbackPlannerPrompt, buildNativeRuntimeStatePrompt } from "../prompts.js";

test("system prompt documents strict tool schemas and invalid key examples", () => {
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /Every tool input uses a STRICT JSON schema/i);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /list_strategy_capabilities.*ownerAddress/s);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /analyze_market_context.*ownerAddress.*marketId/s);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /compile_strategy_source.*ownerAddress.*marketId.*engine/s);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /update_strategy_draft.*ownerAddress.*strategy/s);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /list_strategy_capabilities.*marketId/s);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /update_strategy_draft.*root-level `marketId` or `strategyId`/i);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /Prefer engine-backed strategies for new custom work/i);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /goal_state/);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /expected_artifact/);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /stop_condition/);
});

test("fallback planner prompt repeats root key restrictions for tools", () => {
  const prompt = buildFallbackPlannerPrompt({
    goal: "Create an EMA crossover strategy and backtest it",
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    toolsCatalog: [
      { name: "list_strategy_capabilities", description: "Return capabilities" },
      { name: "create_strategy_draft", description: "Create a draft" }
    ],
    priorTrace: [],
    maxStepsRemaining: 4
  });

  assert.match(prompt, /compile_strategy_source accepts ownerAddress, marketId, optional name\/timeframe\/enabledSides, and engine/i);
  assert.match(prompt, /list_strategy_capabilities accepts only ownerAddress/i);
  assert.match(prompt, /analyze_market_context accepts ownerAddress, marketId, and optional bars\/fromTs\/toTs/i);
  assert.match(prompt, /update_strategy_draft accepts ownerAddress and strategy only/i);
  assert.match(prompt, /run_strategy_backtest accepts ownerAddress, strategyId, and optional bars\/fromTs\/toTs/i);
  assert.match(prompt, /Prefer compile_strategy_source for new custom strategies/i);
  assert.match(prompt, /Never add root-level marketId or strategyId/i);
  assert.match(prompt, /goal_state/);
  assert.match(prompt, /expected_artifact/);
  assert.match(prompt, /If you are not making observable progress, return type=final/i);
});

test("native runtime state prompt exposes active artifacts and reuse guidance", () => {
  const prompt = buildNativeRuntimeStatePrompt({
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    strategyId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222"
  });

  assert.match(prompt, /active strategyId from runtime state: 11111111-1111-4111-8111-111111111111/i);
  assert.match(prompt, /active runId from runtime state: 22222222-2222-4222-8222-222222222222/i);
  assert.match(prompt, /reuse the active strategyId/i);
  assert.match(prompt, /do not ask the user to repeat IDs/i);
});
