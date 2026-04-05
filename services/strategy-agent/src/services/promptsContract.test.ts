import test from "node:test";
import assert from "node:assert/strict";
import { STRATEGY_AGENT_SYSTEM_PROMPT, buildFallbackPlannerPrompt } from "../prompts.js";

test("system prompt documents strict tool schemas and invalid key examples", () => {
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /Every tool input uses a STRICT JSON schema/i);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /list_strategy_capabilities.*ownerAddress/s);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /analyze_market_context.*ownerAddress.*marketId/s);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /update_strategy_draft.*ownerAddress.*strategy/s);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /list_strategy_capabilities.*marketId/s);
  assert.match(STRATEGY_AGENT_SYSTEM_PROMPT, /update_strategy_draft.*root-level `marketId` or `strategyId`/i);
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

  assert.match(prompt, /list_strategy_capabilities accepts only ownerAddress/i);
  assert.match(prompt, /analyze_market_context accepts ownerAddress, marketId, and optional bars\/fromTs\/toTs/i);
  assert.match(prompt, /update_strategy_draft accepts ownerAddress and strategy only/i);
  assert.match(prompt, /run_strategy_backtest accepts ownerAddress, strategyId, and optional bars\/fromTs\/toTs/i);
  assert.match(prompt, /Never add root-level marketId or strategyId/i);
  assert.match(prompt, /goal_state/);
  assert.match(prompt, /expected_artifact/);
  assert.match(prompt, /If you are not making observable progress, return type=final/i);
});
