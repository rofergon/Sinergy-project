import type {
  StrategyCostModel,
  StrategyDefinition,
  StrategyEnabledSide,
  StrategyExitReason,
  StrategyOperand,
  StrategyRiskRules,
  StrategyRuleOperator,
  StrategySizing
} from "@sinergy/shared";
import {
  buildIndicatorSeriesMapFromRefs,
  collectIndicatorReferenceFromOperand,
  resolveOperandValue,
  type IndicatorReference,
  type IndicatorSeriesMap,
  type StrategyCandle
} from "./indicatorEngine.js";

export type RuntimeValueExpression =
  | {
      type: "operand";
      operand: StrategyOperand;
    }
  | {
      type: "history_ref";
      expression: RuntimeValueExpression;
      barsAgo: number;
    }
  | {
      type: "math";
      operator: "+" | "-" | "*" | "/";
      left: RuntimeValueExpression;
      right: RuntimeValueExpression;
    }
  | {
      type: "negate";
      expression: RuntimeValueExpression;
    }
  | {
      type: "abs";
      expression: RuntimeValueExpression;
    };

export type RuntimeConditionExpression =
  | {
      type: "comparison";
      operator: StrategyRuleOperator;
      left: RuntimeValueExpression;
      right: RuntimeValueExpression;
    }
  | {
      type: "logical";
      operator: "and" | "or";
      conditions: RuntimeConditionExpression[];
    }
  | {
      type: "not";
      condition: RuntimeConditionExpression;
    }
  | {
      type: "boolean_constant";
      value: boolean;
    };

export type CompiledTradingStrategy = {
  id: string;
  name: string;
  marketId: StrategyDefinition["marketId"];
  timeframe: StrategyDefinition["timeframe"];
  enabledSides: StrategyEnabledSide[];
  sizing: StrategySizing;
  riskRules: StrategyRiskRules;
  costModel: StrategyCostModel;
  entry: Partial<Record<StrategyEnabledSide, RuntimeConditionExpression>>;
  exit: Partial<Record<StrategyEnabledSide, RuntimeConditionExpression>>;
};

function operandExpression(operand: StrategyOperand): RuntimeValueExpression {
  return {
    type: "operand",
    operand
  };
}

function compileGroups(groups: StrategyDefinition["entryRules"]["long"]): RuntimeConditionExpression {
  const populatedGroups = groups.filter((group) => group.rules.length > 0);
  if (populatedGroups.length === 0) {
    return { type: "boolean_constant", value: false };
  }

  if (populatedGroups.length === 1) {
    const [group] = populatedGroups;
    if (group.rules.length === 1) {
      const [rule] = group.rules;
      return {
        type: "comparison",
        operator: rule.operator,
        left: operandExpression(rule.left),
        right: operandExpression(rule.right)
      };
    }

    return {
      type: "logical",
      operator: "and",
      conditions: group.rules.map((rule) => ({
        type: "comparison",
        operator: rule.operator,
        left: operandExpression(rule.left),
        right: operandExpression(rule.right)
      }))
    };
  }

  return {
    type: "logical",
    operator: "or",
    conditions: populatedGroups.map((group) => ({
      type: "logical",
      operator: "and",
      conditions: group.rules.map((rule) => ({
        type: "comparison",
        operator: rule.operator,
        left: operandExpression(rule.left),
        right: operandExpression(rule.right)
      }))
    }))
  };
}

export function compileStrategyToRuntime(strategy: StrategyDefinition): CompiledTradingStrategy {
  return {
    id: strategy.id,
    name: strategy.name,
    marketId: strategy.marketId,
    timeframe: strategy.timeframe,
    enabledSides: strategy.enabledSides,
    sizing: strategy.sizing,
    riskRules: strategy.riskRules,
    costModel: strategy.costModel,
    entry: {
      long: compileGroups(strategy.entryRules.long),
      short: compileGroups(strategy.entryRules.short)
    },
    exit: {
      long: compileGroups(strategy.exitRules.long),
      short: compileGroups(strategy.exitRules.short)
    }
  };
}

function evalMath(operator: "+" | "-" | "*" | "/", left: number, right: number) {
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return right === 0 ? null : left / right;
  }
}

export function compareResolvedValues(
  leftCurrent: number | null,
  leftPrevious: number | null,
  rightCurrent: number | null,
  rightPrevious: number | null,
  operator: StrategyRuleOperator
) {
  if (leftCurrent === null || rightCurrent === null) return false;

  switch (operator) {
    case ">":
      return leftCurrent > rightCurrent;
    case ">=":
      return leftCurrent >= rightCurrent;
    case "<":
      return leftCurrent < rightCurrent;
    case "<=":
      return leftCurrent <= rightCurrent;
    case "==":
      return leftCurrent === rightCurrent;
    case "!=":
      return leftCurrent !== rightCurrent;
    case "crosses_above":
      return leftPrevious !== null && rightPrevious !== null && leftPrevious <= rightPrevious && leftCurrent > rightCurrent;
    case "crosses_below":
      return leftPrevious !== null && rightPrevious !== null && leftPrevious >= rightPrevious && leftCurrent < rightCurrent;
  }
}

export function evaluateRuntimeValue(
  expression: RuntimeValueExpression,
  candles: StrategyCandle[],
  seriesMap: IndicatorSeriesMap,
  index: number
): number | null {
  switch (expression.type) {
    case "operand":
      return resolveOperandValue(expression.operand, candles, seriesMap, index);
    case "history_ref":
      return index - expression.barsAgo < 0
        ? null
        : evaluateRuntimeValue(expression.expression, candles, seriesMap, index - expression.barsAgo);
    case "math": {
      const left = evaluateRuntimeValue(expression.left, candles, seriesMap, index);
      const right = evaluateRuntimeValue(expression.right, candles, seriesMap, index);
      if (left === null || right === null) return null;
      return evalMath(expression.operator, left, right);
    }
    case "negate": {
      const value = evaluateRuntimeValue(expression.expression, candles, seriesMap, index);
      return value === null ? null : value * -1;
    }
    case "abs": {
      const value = evaluateRuntimeValue(expression.expression, candles, seriesMap, index);
      return value === null ? null : Math.abs(value);
    }
  }
}

export function evaluateRuntimeCondition(
  expression: RuntimeConditionExpression,
  candles: StrategyCandle[],
  seriesMap: IndicatorSeriesMap,
  index: number
): boolean {
  switch (expression.type) {
    case "boolean_constant":
      return expression.value;
    case "not":
      return !evaluateRuntimeCondition(expression.condition, candles, seriesMap, index);
    case "logical":
      return expression.operator === "and"
        ? expression.conditions.every((condition) => evaluateRuntimeCondition(condition, candles, seriesMap, index))
        : expression.conditions.some((condition) => evaluateRuntimeCondition(condition, candles, seriesMap, index));
    case "comparison": {
      const leftCurrent = evaluateRuntimeValue(expression.left, candles, seriesMap, index);
      const rightCurrent = evaluateRuntimeValue(expression.right, candles, seriesMap, index);
      const leftPrevious = index > 0 ? evaluateRuntimeValue(expression.left, candles, seriesMap, index - 1) : null;
      const rightPrevious = index > 0 ? evaluateRuntimeValue(expression.right, candles, seriesMap, index - 1) : null;
      return compareResolvedValues(
        leftCurrent,
        leftPrevious,
        rightCurrent,
        rightPrevious,
        expression.operator
      );
    }
  }
}

function collectIndicatorReferencesFromValue(
  expression: RuntimeValueExpression,
  refs: Map<string, IndicatorReference>
) {
  switch (expression.type) {
    case "operand":
      collectIndicatorReferenceFromOperand(expression.operand, refs);
      return;
    case "history_ref":
      collectIndicatorReferencesFromValue(expression.expression, refs);
      return;
    case "math":
      collectIndicatorReferencesFromValue(expression.left, refs);
      collectIndicatorReferencesFromValue(expression.right, refs);
      return;
    case "negate":
    case "abs":
      collectIndicatorReferencesFromValue(expression.expression, refs);
      return;
  }
}

function collectIndicatorReferencesFromCondition(
  expression: RuntimeConditionExpression,
  refs: Map<string, IndicatorReference>
) {
  switch (expression.type) {
    case "boolean_constant":
      return;
    case "not":
      collectIndicatorReferencesFromCondition(expression.condition, refs);
      return;
    case "logical":
      expression.conditions.forEach((condition) => collectIndicatorReferencesFromCondition(condition, refs));
      return;
    case "comparison":
      collectIndicatorReferencesFromValue(expression.left, refs);
      collectIndicatorReferencesFromValue(expression.right, refs);
      return;
  }
}

export function collectIndicatorReferencesFromRuntime(
  runtime: CompiledTradingStrategy
): IndicatorReference[] {
  const refs = new Map<string, IndicatorReference>();
  for (const side of runtime.enabledSides) {
    const entry = runtime.entry[side];
    const exit = runtime.exit[side];
    if (entry) collectIndicatorReferencesFromCondition(entry, refs);
    if (exit) collectIndicatorReferencesFromCondition(exit, refs);
  }
  return [...refs.values()];
}

export function buildRuntimeIndicatorSeriesMap(
  candles: StrategyCandle[],
  runtime: CompiledTradingStrategy
) {
  return buildIndicatorSeriesMapFromRefs(candles, collectIndicatorReferencesFromRuntime(runtime));
}

export function runtimeExitConditionForSide(
  runtime: CompiledTradingStrategy,
  side: StrategyEnabledSide
): RuntimeConditionExpression {
  return runtime.exit[side] ?? { type: "boolean_constant", value: false };
}

export function runtimeEntryConditionForSide(
  runtime: CompiledTradingStrategy,
  side: StrategyEnabledSide
): RuntimeConditionExpression {
  return runtime.entry[side] ?? { type: "boolean_constant", value: false };
}

export type RuntimePositionExitSignal = {
  side: StrategyEnabledSide;
  reason: StrategyExitReason;
};
