import type {
  StrategyDefinition,
  StrategyValidationIssue,
  StrategyValidationResult,
  StrategyRuleGroup,
  StrategyOperand,
  StrategyIndicatorKind,
  StrategyCapabilities,
  StrategyRuleOperator,
  StrategyIndicatorOutput,
  StrategyRule
} from "@sinergy/shared";

export type RepairAttempt = {
  issueCode: string;
  path: string;
  action: string;
  success: boolean;
};

export type RepairResult = {
  repaired: boolean;
  attempts: RepairAttempt[];
  patchedStrategy: StrategyDefinition;
};

const SUPPORTED_INDICATORS = ["ema", "sma", "rsi", "macd", "bollinger", "vwap", "rolling_high", "rolling_low", "candle_body_pct", "candle_direction"] as const;

const DEFAULT_INDICATOR_PARAMS: Record<string, Record<string, number>> = {
  sma: { period: 20 },
  ema: { period: 20 },
  rsi: { period: 14 },
  macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  bollinger: { period: 20, stdDev: 2 },
  rolling_high: { lookback: 20 },
  rolling_low: { lookback: 20 }
};

const DEFAULT_INDICATOR_OUTPUTS: Record<string, StrategyIndicatorOutput> = {
  sma: "value",
  ema: "value",
  rsi: "value",
  macd: "line",
  bollinger: "middle",
  vwap: "value",
  rolling_high: "value",
  rolling_low: "value",
  candle_body_pct: "value",
  candle_direction: "direction"
};

function makeOperand(kind: StrategyIndicatorKind | "price", fieldOrParams?: string, params?: Record<string, number>): StrategyOperand {
  if (kind === "price") {
    return { type: "price_field", field: (fieldOrParams ?? "close") as "open" | "high" | "low" | "close" | "volume" };
  }
  return {
    type: "indicator_output",
    indicator: kind as StrategyIndicatorKind,
    output: DEFAULT_INDICATOR_OUTPUTS[kind] ?? "value",
    params: params ?? DEFAULT_INDICATOR_PARAMS[kind] ?? {}
  };
}

function makeRule(id: string, left: StrategyOperand, operator: StrategyRuleOperator, right: StrategyOperand): StrategyRule {
  return { id, left, operator, right };
}

function findGroupForSide(strategy: StrategyDefinition, side: "long" | "short", rulesType: "entryRules" | "exitRules"): StrategyRuleGroup[] {
  return strategy[rulesType][side];
}

function ensureGroupExists(strategy: StrategyDefinition, side: "long" | "short", rulesType: "entryRules" | "exitRules", strategyId: string): StrategyRuleGroup {
  const groups = findGroupForSide(strategy, side, rulesType);
  if (groups.length === 0) {
    const newGroup: StrategyRuleGroup = { id: `${strategyId}-${rulesType}-${side}-1`, rules: [] };
    strategy[rulesType][side] = [newGroup];
    return newGroup;
  }
  return groups[0];
}

function applyMissingEntryRulesFix(strategy: StrategyDefinition, side: "long" | "short"): RepairAttempt {
  const strategyId = strategy.id;
  const group = ensureGroupExists(strategy, side, "entryRules", strategyId);

  if (group.rules.length === 0) {
    group.rules.push(
      makeRule(
        `${strategyId}-entry-${side}-fix-1`,
        makeOperand("ema", undefined, { period: 9 }),
        "crosses_above",
        makeOperand("ema", undefined, { period: 21 })
      )
    );
  }

  return {
    issueCode: "missing_entry_rules",
    path: `entryRules.${side}`,
    action: `Added default EMA crossover entry rule for ${side}`,
    success: true
  };
}

function applyMissingIndicatorParamFix(strategy: StrategyDefinition, issue: StrategyValidationIssue): RepairAttempt {
  const pathParts = issue.path.split(".");
  const paramName = pathParts[pathParts.length - 1];

  for (const rulesType of ["entryRules", "exitRules"] as const) {
    for (const side of ["long", "short"] as const) {
      for (const group of strategy[rulesType][side]) {
        for (const rule of group.rules) {
          for (const operandKey of ["left", "right"] as const) {
            const operand = rule[operandKey];
            if (operand.type === "indicator_output") {
              const indicatorKind = operand.indicator;
              const defaults = DEFAULT_INDICATOR_PARAMS[indicatorKind];
              if (defaults && paramName in defaults) {
                if (!operand.params) operand.params = {};
                operand.params[paramName as keyof typeof operand.params] = defaults[paramName];
                return {
                  issueCode: issue.code,
                  path: issue.path,
                  action: `Set default value for ${paramName} on ${indicatorKind}`,
                  success: true
                };
              }
            }
          }
        }
      }
    }
  }

  return {
    issueCode: issue.code,
    path: issue.path,
    action: `Could not find indicator with param ${paramName}`,
    success: false
  };
}

function applyInvalidIndicatorParamFix(strategy: StrategyDefinition, issue: StrategyValidationIssue, capabilities?: StrategyCapabilities): RepairAttempt {
  const pathParts = issue.path.split(".");
  const paramName = pathParts[pathParts.length - 1];

  const paramDefaults: Record<string, number> = {
    period: 20,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    stdDev: 2,
    lookback: 20
  };

  const paramMinValues: Record<string, number> = {
    period: 1,
    fastPeriod: 1,
    slowPeriod: 1,
    signalPeriod: 1,
    stdDev: 0.1,
    lookback: 1
  };

  const paramMaxValues: Record<string, number> = {
    period: 400,
    fastPeriod: 200,
    slowPeriod: 200,
    signalPeriod: 200,
    stdDev: 10,
    lookback: 400
  };

  for (const rulesType of ["entryRules", "exitRules"] as const) {
    for (const side of ["long", "short"] as const) {
      for (const group of strategy[rulesType][side]) {
        for (const rule of group.rules) {
          for (const operandKey of ["left", "right"] as const) {
            const operand = rule[operandKey];
            if (operand.type === "indicator_output" && operand.params && paramName in operand.params) {
              const currentValue = operand.params[paramName as keyof typeof operand.params];
              if (typeof currentValue === "number") {
                const min = paramMinValues[paramName] ?? 1;
                const max = paramMaxValues[paramName] ?? 400;
                if (currentValue < min) {
                  operand.params[paramName as keyof typeof operand.params] = min as never;
                  return {
                    issueCode: issue.code,
                    path: issue.path,
                    action: `Clamped ${paramName} from ${currentValue} to min ${min}`,
                    success: true
                  };
                }
                if (currentValue > max) {
                  operand.params[paramName as keyof typeof operand.params] = max as never;
                  return {
                    issueCode: issue.code,
                    path: issue.path,
                    action: `Clamped ${paramName} from ${currentValue} to max ${max}`,
                    success: true
                  };
                }
              }
              if (currentValue === undefined || currentValue === null) {
                operand.params[paramName as keyof typeof operand.params] = (paramDefaults[paramName] ?? 20) as never;
                return {
                  issueCode: issue.code,
                  path: issue.path,
                  action: `Set default value for ${paramName}`,
                  success: true
                };
              }
            }
          }
        }
      }
    }
  }

  return {
    issueCode: issue.code,
    path: issue.path,
    action: `Could not fix ${paramName}`,
    success: false
  };
}

function applyInvalidIndicatorFix(strategy: StrategyDefinition, issue: StrategyValidationIssue): RepairAttempt {
  const indicatorMatch = issue.message.match(/'([^']+)'/);
  if (!indicatorMatch) {
    return { issueCode: issue.code, path: issue.path, action: "Could not parse indicator name", success: false };
  }

  const badIndicator = indicatorMatch[1];
  const replacement = "ema";

  for (const rulesType of ["entryRules", "exitRules"] as const) {
    for (const side of ["long", "short"] as const) {
      for (const group of strategy[rulesType][side]) {
        for (const rule of group.rules) {
          for (const operandKey of ["left", "right"] as const) {
            const operand = rule[operandKey];
            if (operand.type === "indicator_output" && operand.indicator === badIndicator) {
              operand.indicator = replacement as StrategyIndicatorKind;
              operand.output = DEFAULT_INDICATOR_OUTPUTS[replacement];
              operand.params = DEFAULT_INDICATOR_PARAMS[replacement];
              return {
                issueCode: issue.code,
                path: issue.path,
                action: `Replaced invalid indicator '${badIndicator}' with '${replacement}'`,
                success: true
              };
            }
          }
        }
      }
    }
  }

  return { issueCode: issue.code, path: issue.path, action: `Indicator '${badIndicator}' not found in rules`, success: false };
}

function applyInvalidIndicatorOutputFix(strategy: StrategyDefinition, issue: StrategyValidationIssue): RepairAttempt {
  const indicatorMatch = issue.message.match(/'([^']+)'/);
  const outputMatch = issue.message.match(/output '([^']+)'/);
  if (!indicatorMatch || !outputMatch) {
    return { issueCode: issue.code, path: issue.path, action: "Could not parse indicator/output", success: false };
  }

  const indicator = indicatorMatch[1] as StrategyIndicatorKind;
  const defaultOutput = DEFAULT_INDICATOR_OUTPUTS[indicator];
  if (!defaultOutput) {
    return { issueCode: issue.code, path: issue.path, action: `No default output for '${indicator}'`, success: false };
  }

  for (const rulesType of ["entryRules", "exitRules"] as const) {
    for (const side of ["long", "short"] as const) {
      for (const group of strategy[rulesType][side]) {
        for (const rule of group.rules) {
          for (const operandKey of ["left", "right"] as const) {
            const operand = rule[operandKey];
            if (operand.type === "indicator_output" && operand.indicator === indicator && operand.output === outputMatch[1]) {
              operand.output = defaultOutput;
              return {
                issueCode: issue.code,
                path: issue.path,
                action: `Changed output '${outputMatch[1]}' to '${defaultOutput}' for ${indicator}`,
                success: true
              };
            }
          }
        }
      }
    }
  }

  return { issueCode: issue.code, path: issue.path, action: `Indicator/output not found in rules`, success: false };
}

function applyInvalidOperatorFix(strategy: StrategyDefinition, issue: StrategyValidationIssue): RepairAttempt {
  const validOperators = [">", ">=", "<", "<=", "crosses_above", "crosses_below"];
  const operatorMatch = issue.message.match(/'([^']+)'/);
  if (!operatorMatch) {
    return { issueCode: issue.code, path: issue.path, action: "Could not parse operator", success: false };
  }

  const badOperator = operatorMatch[1];

  for (const rulesType of ["entryRules", "exitRules"] as const) {
    for (const side of ["long", "short"] as const) {
      for (const group of strategy[rulesType][side]) {
        for (const rule of group.rules) {
          if (rule.operator === badOperator) {
            rule.operator = "crosses_above";
            return {
              issueCode: issue.code,
              path: issue.path,
              action: `Replaced invalid operator '${badOperator}' with 'crosses_above'`,
              success: true
            };
          }
        }
      }
    }
  }

  return { issueCode: issue.code, path: issue.path, action: `Operator '${badOperator}' not found`, success: false };
}

function applyInvalidSizingFix(strategy: StrategyDefinition): RepairAttempt {
  if (strategy.sizing.value <= 0) {
    strategy.sizing.value = 25;
    strategy.sizing.mode = "percent_of_equity";
    return { issueCode: "invalid_sizing", path: "sizing.value", action: "Set sizing to 25% of equity", success: true };
  }
  if (strategy.sizing.mode === "percent_of_equity" && strategy.sizing.value > 100) {
    strategy.sizing.value = 25;
    return { issueCode: "percent_above_limit", path: "sizing.value", action: "Clamped sizing to 25%", success: true };
  }
  return { issueCode: "invalid_sizing", path: "sizing.value", action: "Sizing appears valid, no fix needed", success: false };
}

function applyInvalidCostsFix(strategy: StrategyDefinition): RepairAttempt {
  let fixed = false;
  if (strategy.costModel.feeBps < 0) {
    strategy.costModel.feeBps = 10;
    fixed = true;
  }
  if (strategy.costModel.slippageBps < 0) {
    strategy.costModel.slippageBps = 5;
    fixed = true;
  }
  if (strategy.costModel.startingEquity <= 0) {
    strategy.costModel.startingEquity = 10000;
    fixed = true;
  }
  return {
    issueCode: "invalid_costs",
    path: "costModel",
    action: fixed ? "Reset invalid cost parameters to defaults" : "No fix applied",
    success: fixed
  };
}

function applyInvalidRiskFix(strategy: StrategyDefinition, issue: StrategyValidationIssue): RepairAttempt {
  const riskKey = issue.path.replace("riskRules.", "");
  const riskDefaults: Record<string, number> = {
    stopLossPct: 2,
    takeProfitPct: 4,
    trailingStopPct: 1,
    maxBarsInTrade: 40
  };

  if (riskKey in riskDefaults && riskDefaults[riskKey] !== undefined) {
    (strategy.riskRules as Record<string, number | undefined>)[riskKey] = riskDefaults[riskKey];
    return {
      issueCode: issue.code,
      path: issue.path,
      action: `Set ${riskKey} to default ${riskDefaults[riskKey]}`,
      success: true
    };
  }

  return { issueCode: issue.code, path: issue.path, action: `Unknown risk key: ${riskKey}`, success: false };
}

function applyInvalidNameFix(strategy: StrategyDefinition, issue: StrategyValidationIssue): RepairAttempt {
  if (!strategy.name.trim()) {
    strategy.name = "Auto-Repaired Strategy";
    return { issueCode: issue.code, path: issue.path, action: "Set default strategy name", success: true };
  }
  if (strategy.name.trim().length < 3) {
    strategy.name = strategy.name.trim().padEnd(3, "#");
    return { issueCode: issue.code, path: issue.path, action: "Padded strategy name to minimum length", success: true };
  }
  if (strategy.name.length > 80) {
    strategy.name = strategy.name.slice(0, 80);
    return { issueCode: issue.code, path: issue.path, action: "Truncated strategy name to max length", success: true };
  }
  return { issueCode: issue.code, path: issue.path, action: "Name appears valid, no fix needed", success: false };
}

function applyInvalidTimeframeFix(strategy: StrategyDefinition): RepairAttempt {
  strategy.timeframe = "15m";
  return { issueCode: "invalid_timeframe", path: "timeframe", action: "Set timeframe to 15m", success: true };
}

function applyInvalidOwnerAddressFix(strategy: StrategyDefinition, issue: StrategyValidationIssue, ownerAddress?: string): RepairAttempt {
  if (ownerAddress && /^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
    strategy.ownerAddress = ownerAddress as `0x${string}`;
    return { issueCode: issue.code, path: issue.path, action: "Fixed owner address from caller context", success: true };
  }
  return { issueCode: issue.code, path: issue.path, action: "No valid owner address available to fix", success: false };
}

function applyInvalidMarketFix(strategy: StrategyDefinition, issue: StrategyValidationIssue, marketId?: string): RepairAttempt {
  if (marketId && /^0x[0-9a-fA-F]{64}$/.test(marketId)) {
    strategy.marketId = marketId as `0x${string}`;
    return { issueCode: issue.code, path: issue.path, action: "Fixed market ID from caller context", success: true };
  }
  return { issueCode: issue.code, path: issue.path, action: "No valid market ID available to fix", success: false };
}

function applyTooManyGroupsFix(strategy: StrategyDefinition, issue: StrategyValidationIssue): RepairAttempt {
  const maxGroups = 5;
  const pathParts = issue.path.split(".");
  const rulesType = pathParts[0] as "entryRules" | "exitRules";
  const side = pathParts[1] as "long" | "short";

  if (strategy[rulesType][side].length > maxGroups) {
    strategy[rulesType][side] = strategy[rulesType][side].slice(0, maxGroups);
    return {
      issueCode: issue.code,
      path: issue.path,
      action: `Truncated ${rulesType}.${side} to ${maxGroups} groups`,
      success: true
    };
  }
  return { issueCode: issue.code, path: issue.path, action: "Groups count appears valid", success: false };
}

function applyTooManyRulesFix(strategy: StrategyDefinition, issue: StrategyValidationIssue): RepairAttempt {
  const maxRules = 8;
  const pathParts = issue.path.split(".");
  const rulesType = pathParts[0] as "entryRules" | "exitRules";
  const side = pathParts[1] as "long" | "short";
  const groupIndex = parseInt(pathParts[2]?.match(/\d+/)?.[0] ?? "-1", 10);

  if (groupIndex >= 0 && strategy[rulesType][side][groupIndex]) {
    const group = strategy[rulesType][side][groupIndex];
    if (group.rules.length > maxRules) {
      group.rules = group.rules.slice(0, maxRules);
      return {
        issueCode: issue.code,
        path: issue.path,
        action: `Truncated group ${groupIndex} to ${maxRules} rules`,
        success: true
      };
    }
  }
  return { issueCode: issue.code, path: issue.path, action: "Rules count appears valid", success: false };
}

function applyInvalidPriceFieldFix(strategy: StrategyDefinition, issue: StrategyValidationIssue): RepairAttempt {
  const validFields = ["open", "high", "low", "close", "volume"];

  for (const rulesType of ["entryRules", "exitRules"] as const) {
    for (const side of ["long", "short"] as const) {
      for (const group of strategy[rulesType][side]) {
        for (const rule of group.rules) {
          for (const operandKey of ["left", "right"] as const) {
            const operand = rule[operandKey];
            if (operand.type === "price_field" && !validFields.includes(operand.field)) {
              operand.field = "close";
              return {
                issueCode: issue.code,
                path: issue.path,
                action: `Replaced invalid price field '${operand.field}' with 'close'`,
                success: true
              };
            }
          }
        }
      }
    }
  }

  return { issueCode: issue.code, path: issue.path, action: "Invalid price field not found in rules", success: false };
}

function applyEmptyGroupFix(strategy: StrategyDefinition, issue: StrategyValidationIssue): RepairAttempt {
  const pathParts = issue.path.split(".");
  const rulesType = pathParts[0] as "entryRules" | "exitRules";
  const side = pathParts[1] as "long" | "short";
  const groupIndex = parseInt(pathParts[2]?.match(/\d+/)?.[0] ?? "-1", 10);

  if (groupIndex >= 0 && strategy[rulesType][side][groupIndex]) {
    const group = strategy[rulesType][side][groupIndex];
    if (group.rules.length === 0) {
      group.rules.push(
        makeRule(
          `${strategy.id}-${rulesType}-${side}-${groupIndex}-fix-1`,
          makeOperand("ema", undefined, { period: 9 }),
          "crosses_above",
          makeOperand("ema", undefined, { period: 21 })
        )
      );
      return {
        issueCode: issue.code,
        path: issue.path,
        action: `Added default EMA rule to empty group ${groupIndex}`,
        success: true
      };
    }
  }
  return { issueCode: issue.code, path: issue.path, action: "Could not locate empty group", success: false };
}

export function attemptValidationRepair(
  strategy: StrategyDefinition,
  validation: StrategyValidationResult,
  context?: { ownerAddress?: string; marketId?: string; capabilities?: StrategyCapabilities }
): RepairResult {
  const attempts: RepairAttempt[] = [];
  const patchedStrategy = JSON.parse(JSON.stringify(strategy)) as StrategyDefinition;

  for (const issue of validation.issues) {
    let attempt: RepairAttempt;

    switch (issue.code) {
      case "missing_entry_rules":
        attempt = applyMissingEntryRulesFix(patchedStrategy, issue.path.includes(".short") ? "short" : "long");
        break;
      case "missing_indicator_param":
        attempt = applyMissingIndicatorParamFix(patchedStrategy, issue);
        break;
      case "indicator_param_low":
      case "indicator_param_high":
      case "invalid_indicator_param":
        attempt = applyInvalidIndicatorParamFix(patchedStrategy, issue, context?.capabilities);
        break;
      case "invalid_indicator":
        attempt = applyInvalidIndicatorFix(patchedStrategy, issue);
        break;
      case "invalid_indicator_output":
        attempt = applyInvalidIndicatorOutputFix(patchedStrategy, issue);
        break;
      case "invalid_operator":
        attempt = applyInvalidOperatorFix(patchedStrategy, issue);
        break;
      case "invalid_sizing":
      case "percent_above_limit":
        attempt = applyInvalidSizingFix(patchedStrategy);
        break;
      case "invalid_costs":
      case "invalid_starting_equity":
        attempt = applyInvalidCostsFix(patchedStrategy);
        break;
      case "invalid_risk":
        attempt = applyInvalidRiskFix(patchedStrategy, issue);
        break;
      case "missing_name":
      case "strategy_name_too_short":
      case "strategy_name_too_long":
        attempt = applyInvalidNameFix(patchedStrategy, issue);
        break;
      case "invalid_timeframe":
        attempt = applyInvalidTimeframeFix(patchedStrategy);
        break;
      case "invalid_owner_address":
        attempt = applyInvalidOwnerAddressFix(patchedStrategy, issue, context?.ownerAddress);
        break;
      case "invalid_market":
        attempt = applyInvalidMarketFix(patchedStrategy, issue, context?.marketId);
        break;
      case "too_many_groups":
        attempt = applyTooManyGroupsFix(patchedStrategy, issue);
        break;
      case "too_many_rules":
        attempt = applyTooManyRulesFix(patchedStrategy, issue);
        break;
      case "invalid_price_field":
        attempt = applyInvalidPriceFieldFix(patchedStrategy, issue);
        break;
      case "missing_side":
        patchedStrategy.enabledSides = ["long", "short"];
        attempt = { issueCode: issue.code, path: issue.path, action: "Enabled both long and short sides", success: true };
        break;
      default:
        attempt = { issueCode: issue.code, path: issue.path, action: `No automated fix for: ${issue.code}`, success: false };
        break;
    }

    attempts.push(attempt);
  }

  const repaired = attempts.every((a) => a.success);

  return {
    repaired,
    attempts,
    patchedStrategy
  };
}
