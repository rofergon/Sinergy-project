import test from "node:test";
import assert from "node:assert/strict";
import type { StrategyDefinition, StrategyValidationResult } from "@sinergy/shared";
import { attemptValidationRepair } from "./validationRepairLoop.js";

function buildStrategy(): StrategyDefinition {
  const now = new Date().toISOString();

  return {
    id: "11111111-1111-4111-8111-111111111111",
    ownerAddress: "0x00000000000000000000000000000000000000c3",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000111",
    name: "EMA crossover",
    timeframe: "1h",
    enabledSides: ["long", "short"],
    entryRules: {
      long: [
        {
          id: "long-entry-1",
          rules: [
            {
              id: "long-entry-rule-1",
              left: { type: "indicator_output", indicator: "ema", output: "value", params: { period: 9 } },
              operator: "crosses_above",
              right: { type: "indicator_output", indicator: "ema", output: "value", params: { period: 21 } }
            }
          ]
        }
      ],
      short: [
        {
          id: "short-entry-1",
          rules: [
            {
              id: "short-entry-rule-1",
              left: { type: "indicator_output", indicator: "ema", output: "value", params: { period: 9 } },
              operator: "crosses_above",
              right: { type: "indicator_output", indicator: "ema", output: "value", params: { period: 21 } }
            }
          ]
        }
      ]
    },
    exitRules: {
      long: [{ id: "long-exit-1", rules: [] }],
      short: [{ id: "short-exit-1", rules: [] }]
    },
    sizing: {
      mode: "percent_of_equity",
      value: 25
    },
    riskRules: {
      stopLossPct: 2,
      takeProfitPct: 4,
      trailingStopPct: 1,
      maxBarsInTrade: 40
    },
    costModel: {
      feeBps: 10,
      slippageBps: 5,
      startingEquity: 10_000
    },
    status: "draft",
    schemaVersion: "strategy.v1",
    createdAt: now,
    updatedAt: now
  };
}

test("repair loop inverts duplicated short crossover entries", () => {
  const strategy = buildStrategy();
  const validation: StrategyValidationResult = {
    ok: false,
    issues: [
      {
        path: "entryRules.short",
        code: "ambiguous_dual_side_entries",
        message: "Long and short entry rules are identical, so both sides trigger together and no position can be opened.",
        suggestion: "Use the inverse condition for short entries, for example EMA fast crosses_below EMA slow."
      }
    ]
  };

  const result = attemptValidationRepair(strategy, validation);

  assert.equal(result.repaired, true);
  assert.equal(result.attempts[0]?.success, true);
  assert.equal(result.patchedStrategy.entryRules.long[0]?.rules[0]?.operator, "crosses_above");
  assert.equal(result.patchedStrategy.entryRules.short[0]?.rules[0]?.operator, "crosses_below");
});
