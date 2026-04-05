import { randomUUID } from "node:crypto";
import {
  STRATEGY_SCHEMA_VERSION,
  type HexString,
  type StrategyCapabilities,
  type StrategyDefinition,
  type StrategyIndicatorKind,
  type StrategyIndicatorParams,
  type StrategyOperand,
  type StrategyRule,
  type StrategyRuleGroup,
  type StrategyRuleSet,
  type StrategyValidationIssue,
  type StrategyValidationResult
} from "@sinergy/shared";
import { STRATEGY_DEFAULTS, buildStrategyCapabilities, createEmptyStrategyDraft } from "./strategyCatalog.js";

const HEX_PATTERN = /^0x[0-9a-fA-F]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown, fallback?: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function normalizeOperand(input: unknown): StrategyOperand {
  if (!isRecord(input)) {
    return { type: "price_field", field: "close" };
  }

  if (input.type === "constant") {
    return {
      type: "constant",
      value: asNumber(input.value, 0) ?? 0
    };
  }

  if (input.type === "indicator_output") {
    const paramsInput = isRecord(input.params) ? input.params : {};
    const params: StrategyIndicatorParams = {};
    for (const key of ["period", "fastPeriod", "slowPeriod", "signalPeriod", "stdDev", "lookback"] as const) {
      const next = asNumber(paramsInput[key]);
      if (next !== undefined) {
        params[key] = next;
      }
    }

    return {
      type: "indicator_output",
      indicator: (typeof input.indicator === "string" ? input.indicator : "ema") as StrategyIndicatorKind,
      output: (typeof input.output === "string" ? input.output : "value") as any,
      params
    };
  }

  return {
    type: "price_field",
    field: (typeof input.field === "string" ? input.field : "close") as any
  };
}

function normalizeRule(input: unknown, fallbackId: string): StrategyRule {
  if (!isRecord(input)) {
    return {
      id: fallbackId,
      left: { type: "price_field", field: "close" },
      operator: ">",
      right: { type: "constant", value: 0 }
    };
  }

  return {
    id: typeof input.id === "string" && input.id ? input.id : fallbackId,
    left: normalizeOperand(input.left),
    operator: (typeof input.operator === "string" ? input.operator : ">") as any,
    right: normalizeOperand(input.right)
  };
}

function normalizeRuleGroups(input: unknown, prefix: string): StrategyRuleGroup[] {
  if (!Array.isArray(input)) return [];

  return input.map((group, groupIndex) => {
    if (!isRecord(group)) {
      return {
        id: `${prefix}-${groupIndex + 1}`,
        rules: []
      };
    }

    const rules = Array.isArray(group.rules)
      ? group.rules.map((rule, ruleIndex) =>
          normalizeRule(rule, `${prefix}-${groupIndex + 1}-rule-${ruleIndex + 1}`)
        )
      : [];

    return {
      id: typeof group.id === "string" && group.id ? group.id : `${prefix}-${groupIndex + 1}`,
      rules
    };
  });
}

function normalizeRuleSet(input: unknown, prefix: string): StrategyRuleSet {
  const data = isRecord(input) ? input : {};
  return {
    long: normalizeRuleGroups(data.long, `${prefix}-long`),
    short: normalizeRuleGroups(data.short, `${prefix}-short`)
  };
}

export function normalizeStrategyDefinition(input: unknown): StrategyDefinition {
  const payload = isRecord(input) ? input : {};
  const ownerAddress = (typeof payload.ownerAddress === "string" && HEX_PATTERN.test(payload.ownerAddress)
    ? payload.ownerAddress
    : "0x0000000000000000000000000000000000000000") as HexString;
  const marketId = (typeof payload.marketId === "string" && HEX_PATTERN.test(payload.marketId)
    ? payload.marketId
    : "0x0") as HexString;
  const strategyId = typeof payload.id === "string" && payload.id ? payload.id : randomUUID();
  const base = createEmptyStrategyDraft(
    strategyId,
    ownerAddress,
    marketId,
    typeof payload.name === "string" && payload.name.trim() ? payload.name : "Strategy Draft"
  );

  return {
    ...base,
    id: strategyId,
    ownerAddress,
    marketId,
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : base.name,
    timeframe: (typeof payload.timeframe === "string" ? payload.timeframe : base.timeframe) as any,
    enabledSides: Array.isArray(payload.enabledSides)
      ? payload.enabledSides.filter((side): side is "long" | "short" => side === "long" || side === "short")
      : base.enabledSides,
    entryRules: normalizeRuleSet(payload.entryRules, `${strategyId}-entry`),
    exitRules: normalizeRuleSet(payload.exitRules, `${strategyId}-exit`),
    sizing: isRecord(payload.sizing)
      ? {
          mode:
            payload.sizing.mode === "fixed_quote_notional"
              ? "fixed_quote_notional"
              : "percent_of_equity",
          value: asNumber(payload.sizing.value, base.sizing.value) ?? base.sizing.value
        }
      : base.sizing,
    riskRules: isRecord(payload.riskRules)
      ? {
          stopLossPct: asNumber(payload.riskRules.stopLossPct),
          takeProfitPct: asNumber(payload.riskRules.takeProfitPct),
          trailingStopPct: asNumber(payload.riskRules.trailingStopPct),
          maxBarsInTrade: asNumber(payload.riskRules.maxBarsInTrade)
        }
      : base.riskRules,
    costModel: isRecord(payload.costModel)
      ? {
          feeBps: asNumber(payload.costModel.feeBps, base.costModel.feeBps) ?? base.costModel.feeBps,
          slippageBps:
            asNumber(payload.costModel.slippageBps, base.costModel.slippageBps) ??
            base.costModel.slippageBps,
          startingEquity:
            asNumber(payload.costModel.startingEquity, base.costModel.startingEquity) ??
            base.costModel.startingEquity
        }
      : base.costModel,
    status:
      payload.status === "saved" || payload.status === "archived" || payload.status === "draft"
        ? payload.status
        : base.status,
    schemaVersion:
      typeof payload.schemaVersion === "string" && payload.schemaVersion
        ? payload.schemaVersion
        : STRATEGY_SCHEMA_VERSION,
    createdAt:
      typeof payload.createdAt === "string" && payload.createdAt ? payload.createdAt : base.createdAt,
    updatedAt:
      typeof payload.updatedAt === "string" && payload.updatedAt ? payload.updatedAt : new Date().toISOString()
  };
}

function pushIssue(
  issues: StrategyValidationIssue[],
  path: string,
  code: string,
  message: string,
  suggestion?: string
) {
  issues.push({ path, code, message, suggestion });
}

function validateOperand(
  operand: StrategyOperand,
  path: string,
  issues: StrategyValidationIssue[],
  capabilities: StrategyCapabilities
) {
  if (operand.type === "constant") {
    if (!Number.isFinite(operand.value)) {
      pushIssue(issues, path, "invalid_constant", "Constant value must be a finite number.", "Use a numeric constant like 20 or 55.");
    }
    return;
  }

  if (operand.type === "price_field") {
    if (!capabilities.priceFields.includes(operand.field)) {
      pushIssue(issues, path, "invalid_price_field", `Unsupported price field '${operand.field}'.`);
    }
    return;
  }

  const indicatorDef = capabilities.indicatorCatalog.find((entry) => entry.kind === operand.indicator);
  if (!indicatorDef) {
    pushIssue(issues, path, "invalid_indicator", `Unsupported indicator '${operand.indicator}'.`);
    return;
  }

  if (!indicatorDef.outputs.includes(operand.output)) {
    pushIssue(
      issues,
      path,
      "invalid_indicator_output",
      `Indicator '${operand.indicator}' does not expose output '${operand.output}'.`,
      `Use one of: ${indicatorDef.outputs.join(", ")}.`
    );
  }

  for (const paramDef of indicatorDef.params) {
    const rawValue = operand.params?.[paramDef.name];
    if (rawValue === undefined) {
      if (paramDef.required) {
        pushIssue(
          issues,
          `${path}.params.${paramDef.name}`,
          "missing_indicator_param",
          `Missing required parameter '${paramDef.name}'.`,
          `Set it to ${paramDef.defaultValue ?? paramDef.min ?? 1}.`
        );
      }
      continue;
    }

    if (!Number.isFinite(rawValue)) {
      pushIssue(
        issues,
        `${path}.params.${paramDef.name}`,
        "invalid_indicator_param",
        `Parameter '${paramDef.name}' must be numeric.`
      );
      continue;
    }

    if (paramDef.min !== undefined && rawValue < paramDef.min) {
      pushIssue(
        issues,
        `${path}.params.${paramDef.name}`,
        "indicator_param_low",
        `Parameter '${paramDef.name}' must be >= ${paramDef.min}.`
      );
    }

    if (paramDef.max !== undefined && rawValue > paramDef.max) {
      pushIssue(
        issues,
        `${path}.params.${paramDef.name}`,
        "indicator_param_high",
        `Parameter '${paramDef.name}' must be <= ${paramDef.max}.`
      );
    }
  }
}

function validateRuleGroups(
  groups: StrategyRuleGroup[],
  path: string,
  issues: StrategyValidationIssue[],
  capabilities: StrategyCapabilities
) {
  if (groups.length > capabilities.defaults.maxRuleGroupsPerSide) {
    pushIssue(
      issues,
      path,
      "too_many_groups",
      `At most ${capabilities.defaults.maxRuleGroupsPerSide} rule groups are supported per side.`
    );
  }

  groups.forEach((group, groupIndex) => {
    if (!group.rules.length) {
      return;
    }

    if (group.rules.length > capabilities.defaults.maxRulesPerGroup) {
      pushIssue(
        issues,
        `${path}[${groupIndex}]`,
        "too_many_rules",
        `At most ${capabilities.defaults.maxRulesPerGroup} rules are supported per group.`
      );
    }

    group.rules.forEach((rule, ruleIndex) => {
      const rulePath = `${path}[${groupIndex}].rules[${ruleIndex}]`;
      if (!capabilities.operators.includes(rule.operator)) {
        pushIssue(issues, `${rulePath}.operator`, "invalid_operator", `Unsupported operator '${rule.operator}'.`);
      }
      validateOperand(rule.left, `${rulePath}.left`, issues, capabilities);
      validateOperand(rule.right, `${rulePath}.right`, issues, capabilities);
    });
  });
}

function canonicalizeOperand(operand: StrategyOperand): string {
  if (operand.type === "constant") {
    return `constant:${operand.value}`;
  }

  if (operand.type === "price_field") {
    return `price:${operand.field}`;
  }

  const params = Object.entries(operand.params ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join(",");

  return `indicator:${operand.indicator}:${operand.output}:${params}`;
}

function canonicalizeRuleGroups(groups: StrategyRuleGroup[]): string {
  return JSON.stringify(
    groups.map((group) => ({
      rules: group.rules.map((rule) => ({
        left: canonicalizeOperand(rule.left),
        operator: rule.operator,
        right: canonicalizeOperand(rule.right)
      }))
    }))
  );
}

export function validateStrategyDefinition(
  strategy: StrategyDefinition,
  marketIds: Set<string>,
  capabilities = buildStrategyCapabilities()
): StrategyValidationResult {
  const issues: StrategyValidationIssue[] = [];

  if (!HEX_PATTERN.test(strategy.ownerAddress) || strategy.ownerAddress.length !== 42) {
    pushIssue(
      issues,
      "ownerAddress",
      "invalid_owner_address",
      "Owner address must be a 20-byte hex address.",
      "Use the connected wallet address."
    );
  }

  if (!HEX_PATTERN.test(strategy.marketId) || !marketIds.has(strategy.marketId.toLowerCase())) {
    pushIssue(
      issues,
      "marketId",
      "invalid_market",
      "Strategy market is not available in the current matcher deployment.",
      "Pick one of the markets returned by /markets."
    );
  }

  if (!capabilities.timeframes.includes(strategy.timeframe)) {
    pushIssue(issues, "timeframe", "invalid_timeframe", `Unsupported timeframe '${strategy.timeframe}'.`);
  }

  if (!strategy.name.trim()) {
    pushIssue(issues, "name", "missing_name", "Strategy name is required.");
  }

  if (!strategy.enabledSides.length) {
    pushIssue(issues, "enabledSides", "missing_side", "Enable at least one side: long or short.");
  }

  if (strategy.sizing.value <= 0) {
    pushIssue(issues, "sizing.value", "invalid_sizing", "Sizing value must be greater than zero.");
  }

  if (strategy.sizing.mode === "percent_of_equity" && strategy.sizing.value > 100) {
    pushIssue(
      issues,
      "sizing.value",
      "percent_above_limit",
      "Percent-of-equity sizing must be <= 100 in v1.",
      "Use a value between 1 and 100."
    );
  }

  if (strategy.costModel.startingEquity <= 0) {
    pushIssue(issues, "costModel.startingEquity", "invalid_starting_equity", "Starting equity must be positive.");
  }

  if (strategy.costModel.feeBps < 0 || strategy.costModel.slippageBps < 0) {
    pushIssue(issues, "costModel", "invalid_costs", "Fee and slippage cannot be negative.");
  }

  const riskKeys: Array<keyof StrategyDefinition["riskRules"]> = [
    "stopLossPct",
    "takeProfitPct",
    "trailingStopPct",
    "maxBarsInTrade"
  ];
  for (const key of riskKeys) {
    const value = strategy.riskRules[key];
    if (value !== undefined && value <= 0) {
      pushIssue(issues, `riskRules.${key}`, "invalid_risk", `${key} must be greater than zero when set.`);
    }
  }

  for (const side of strategy.enabledSides) {
    if (strategy.entryRules[side].every((group) => group.rules.length === 0)) {
      pushIssue(
        issues,
        `entryRules.${side}`,
        "missing_entry_rules",
        `At least one ${side} entry rule is required.`,
        "Add a rule like EMA 9 crosses above EMA 21."
      );
    }
  }

  if (
    strategy.enabledSides.includes("long") &&
    strategy.enabledSides.includes("short") &&
    canonicalizeRuleGroups(strategy.entryRules.long) === canonicalizeRuleGroups(strategy.entryRules.short)
  ) {
    pushIssue(
      issues,
      "entryRules.short",
      "ambiguous_dual_side_entries",
      "Long and short entry rules are identical, so both sides trigger together and no position can be opened.",
      "Use the inverse condition for short entries, for example EMA fast crosses_below EMA slow."
    );
  }

  validateRuleGroups(strategy.entryRules.long, "entryRules.long", issues, capabilities);
  validateRuleGroups(strategy.entryRules.short, "entryRules.short", issues, capabilities);
  validateRuleGroups(strategy.exitRules.long, "exitRules.long", issues, capabilities);
  validateRuleGroups(strategy.exitRules.short, "exitRules.short", issues, capabilities);

  return {
    ok: issues.length === 0,
    issues
  };
}

export function ensureSavedStrategy(strategy: StrategyDefinition): StrategyDefinition {
  return {
    ...strategy,
    status: "saved",
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString()
  };
}
