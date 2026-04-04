import test from "node:test";
import assert from "node:assert/strict";
import { mergeToolContext } from "./toolInputContext.js";

test("does not inject marketId into list_strategy_capabilities", () => {
  const merged = mergeToolContext("list_strategy_capabilities", {}, {
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    strategyId: "11111111-1111-4111-8111-111111111111"
  });

  assert.deepEqual(merged, {
    ownerAddress: "0x00000000000000000000000000000000000000c3"
  });
});

test("injects required marketId into create_strategy_draft only", () => {
  const merged = mergeToolContext("create_strategy_draft", { name: "EMA draft" }, {
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111"
  });

  assert.deepEqual(merged, {
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    name: "EMA draft"
  });
});

test("injects marketId into analyze_market_context", () => {
  const merged = mergeToolContext("analyze_market_context", {}, {
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111"
  });

  assert.deepEqual(merged, {
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111"
  });
});

test("does not inject strategyId into update_strategy_draft", () => {
  const merged = mergeToolContext(
    "update_strategy_draft",
    { strategy: { id: "11111111-1111-4111-8111-111111111111" } },
    {
      ownerAddress: "0x00000000000000000000000000000000000000c3",
      strategyId: "11111111-1111-4111-8111-111111111111"
    }
  );

  assert.deepEqual(merged, {
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    strategy: { id: "11111111-1111-4111-8111-111111111111" }
  });
});
