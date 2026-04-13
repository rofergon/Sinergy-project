import type {
  StrategyAstV2,
  StrategyCompilationPreview,
  StrategyConditionExpressionV2,
  StrategyDefinition,
  StrategyEnabledSide,
  StrategyEngineDefinition,
  StrategyIndicatorKind,
  StrategyIndicatorOutput,
  StrategyIndicatorParams,
  StrategyPriceField,
  StrategyRuleOperator,
  StrategySourceType,
  StrategyValueExpressionV2
} from "@sinergy/shared";
import {
  collectIndicatorReferencesFromRuntime,
  type CompiledTradingStrategy,
  type RuntimeConditionExpression,
  type RuntimeValueExpression
} from "./strategyRuntime.js";
import { StrategyToolError } from "./strategyToolSecurity.js";

type Token =
  | { type: "number"; value: number }
  | { type: "identifier"; value: string }
  | { type: "string"; value: string }
  | { type: "operator"; value: string }
  | { type: "punct"; value: "(" | ")" | "," | "[" | "]" }
  | { type: "eof"; value: "" };

const SIGNAL_NAMES = ["longEntry", "longExit", "shortEntry", "shortExit"] as const;
type SignalName = (typeof SIGNAL_NAMES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSignalName(value: string): value is SignalName {
  return SIGNAL_NAMES.includes(value as SignalName);
}

function normalizeEnabledSides(input: unknown): StrategyEnabledSide[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const sides = input.filter((side): side is StrategyEnabledSide => side === "long" || side === "short");
  return sides.length > 0 ? sides : undefined;
}

function normalizeValueExpression(input: unknown): StrategyValueExpressionV2 {
  if (!isRecord(input)) {
    throw new StrategyToolError("Invalid AST value expression.", "invalid_strategy_ast", 422);
  }

  switch (input.type) {
    case "constant":
      return { type: "constant", value: Number(input.value ?? 0) };
    case "price":
      return {
        type: "price",
        field: (typeof input.field === "string" ? input.field : "close") as StrategyPriceField,
        barsAgo: typeof input.barsAgo === "number" ? Math.trunc(input.barsAgo) : undefined
      };
    case "indicator":
      return {
        type: "indicator",
        indicator: (typeof input.indicator === "string" ? input.indicator : "ema") as StrategyIndicatorKind,
        output: (typeof input.output === "string" ? input.output : "value") as StrategyIndicatorOutput,
        params: isRecord(input.params) ? (input.params as StrategyIndicatorParams) : undefined,
        barsAgo: typeof input.barsAgo === "number" ? Math.trunc(input.barsAgo) : undefined
      };
    case "identifier":
      return {
        type: "identifier",
        name: typeof input.name === "string" ? input.name : "unknown"
      };
    case "history_ref":
      return {
        type: "history_ref",
        expression: normalizeValueExpression(input.expression),
        barsAgo: typeof input.barsAgo === "number" ? Math.max(0, Math.trunc(input.barsAgo)) : 0
      };
    case "binary_op":
      return {
        type: "binary_op",
        operator: (typeof input.operator === "string" ? input.operator : "+") as "+" | "-" | "*" | "/",
        left: normalizeValueExpression(input.left),
        right: normalizeValueExpression(input.right)
      };
    case "unary_op":
      return {
        type: "unary_op",
        operator: input.operator === "abs" ? "abs" : "negate",
        expression: normalizeValueExpression(input.expression)
      };
    default:
      throw new StrategyToolError("Unsupported AST value expression type.", "invalid_strategy_ast", 422, {
        nodeType: String(input.type)
      });
  }
}

function normalizeConditionExpression(input: unknown): StrategyConditionExpressionV2 {
  if (!isRecord(input)) {
    throw new StrategyToolError("Invalid AST condition expression.", "invalid_strategy_ast", 422);
  }

  switch (input.type) {
    case "boolean_constant":
      return { type: "boolean_constant", value: Boolean(input.value) };
    case "comparison":
      return {
        type: "comparison",
        operator: (typeof input.operator === "string" ? input.operator : ">") as StrategyRuleOperator,
        left: normalizeValueExpression(input.left),
        right: normalizeValueExpression(input.right)
      };
    case "logical":
      return {
        type: "logical",
        operator: input.operator === "or" ? "or" : "and",
        conditions: Array.isArray(input.conditions) ? input.conditions.map(normalizeConditionExpression) : []
      };
    case "not":
      return {
        type: "not",
        condition: normalizeConditionExpression(input.condition)
      };
    default:
      throw new StrategyToolError("Unsupported AST condition expression type.", "invalid_strategy_ast", 422, {
        nodeType: String(input.type)
      });
  }
}

export function normalizeStrategyEngine(input: unknown): StrategyEngineDefinition | undefined {
  if (!isRecord(input) || !input.sourceType) return undefined;
  if (input.sourceType === "ast_v2") {
    const astInput = isRecord(input.ast) ? input.ast : {};
    return {
      version: "2",
      sourceType: "ast_v2",
      ast: {
        timeframe: typeof astInput.timeframe === "string" ? (astInput.timeframe as StrategyDefinition["timeframe"]) : undefined,
        enabledSides: normalizeEnabledSides(astInput.enabledSides),
        bindings: Array.isArray(astInput.bindings)
          ? astInput.bindings
              .filter(isRecord)
              .map((binding) => ({
                name: typeof binding.name === "string" ? binding.name : "binding",
                expression: normalizeValueExpression(binding.expression)
              }))
          : [],
        signals: Object.fromEntries(
          SIGNAL_NAMES.flatMap((signalName) =>
            astInput[signalName] !== undefined
              ? [[signalName, normalizeConditionExpression(astInput[signalName])]]
              : []
          )
        ) as StrategyAstV2["signals"]
      },
      ...(typeof input.script === "string" ? { script: input.script } : {})
    };
  }

  if (input.sourceType === "pine_like_v0" && typeof input.script === "string") {
    const parsedAst = parsePineLikeStrategy(input.script);
    return {
      version: "2",
      sourceType: "pine_like_v0",
      script: input.script,
      ast: parsedAst
    };
  }

  throw new StrategyToolError("Unsupported strategy engine source.", "invalid_strategy_engine", 422, {
    sourceType: input.sourceType
  });
}

class TokenCursor {
  constructor(private readonly tokens: Token[], private index = 0) {}

  peek() {
    return this.tokens[this.index] ?? { type: "eof", value: "" };
  }

  next() {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  match(type: Token["type"], value?: string) {
    const token = this.peek();
    if (token.type !== type) return false;
    if (value !== undefined && token.value !== value) return false;
    this.index += 1;
    return true;
  }

  expect(type: Token["type"], value?: string): Token {
    const token = this.next();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      throw new StrategyToolError("Invalid Pine-like strategy syntax.", "invalid_strategy_script", 422, {
        expectedType: type,
        expectedValue: value,
        receivedType: token.type,
        receivedValue: token.value
      });
    }
    return token;
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const twoChar = input.slice(index, index + 2);
    if ([">=", "<=", "==", "!="].includes(twoChar)) {
      tokens.push({ type: "operator", value: twoChar });
      index += 2;
      continue;
    }

    if (["+", "-", "*", "/", ">", "<"].includes(char)) {
      tokens.push({ type: "operator", value: char });
      index += 1;
      continue;
    }

    if (["(", ")", ",", "[", "]"].includes(char)) {
      tokens.push({ type: "punct", value: char as "(" | ")" | "," | "[" | "]" });
      index += 1;
      continue;
    }

    if (char === "\"") {
      let end = index + 1;
      while (end < input.length && input[end] !== "\"") end += 1;
      if (end >= input.length) {
        throw new StrategyToolError("Unterminated string literal in Pine-like script.", "invalid_strategy_script", 422);
      }
      tokens.push({ type: "string", value: input.slice(index + 1, end) });
      index = end + 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let end = index + 1;
      while (end < input.length && /[0-9.]/.test(input[end])) end += 1;
      tokens.push({ type: "number", value: Number(input.slice(index, end)) });
      index = end;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < input.length && /[A-Za-z0-9_.$]/.test(input[end])) end += 1;
      const value = input.slice(index, end);
      tokens.push({ type: "identifier", value });
      index = end;
      continue;
    }

    throw new StrategyToolError("Unsupported character in Pine-like script.", "invalid_strategy_script", 422, {
      character: char
    });
  }

  tokens.push({ type: "eof", value: "" });
  return tokens;
}

function priceExpression(field: StrategyPriceField): StrategyValueExpressionV2 {
  return { type: "price", field };
}

function applyHistoryRef(expression: StrategyValueExpressionV2, barsAgo: number): StrategyValueExpressionV2 {
  if (expression.type === "price") return { ...expression, barsAgo };
  if (expression.type === "indicator") return { ...expression, barsAgo };
  return { type: "history_ref", expression, barsAgo };
}

function parsePrimary(cursor: TokenCursor): StrategyValueExpressionV2 {
  const token = cursor.next();

  if (token.type === "number") {
    return { type: "constant", value: token.value };
  }

  if (token.type === "identifier") {
    if (token.value === "true" || token.value === "false") {
      throw new StrategyToolError("Boolean literals can only appear in condition expressions.", "invalid_strategy_script", 422);
    }

    if (cursor.match("punct", "(")) {
      const args: Array<StrategyValueExpressionV2 | StrategyConditionExpressionV2 | string> = [];
      if (!cursor.match("punct", ")")) {
        do {
          const nextToken = cursor.peek();
          if (nextToken.type === "string") {
            const stringToken = cursor.next();
            args.push(stringToken.value as string);
          } else if (token.value === "ta.crossover" || token.value === "ta.crossunder") {
            args.push(parseValueExpression(cursor));
          } else {
            args.push(parseValueExpression(cursor));
          }
        } while (cursor.match("punct", ","));
        cursor.expect("punct", ")");
      }

      const indicatorCall = compileFunctionCall(token.value, args);
      if ("condition" in indicatorCall) {
        throw new StrategyToolError("Condition function used where a value expression was expected.", "invalid_strategy_script", 422, {
          fn: token.value
        });
      }
      return indicatorCall.value;
    }

    const identifierValue = token.value;
    if (identifierValue === "open" || identifierValue === "high" || identifierValue === "low" || identifierValue === "close" || identifierValue === "volume" || identifierValue === "hl2" || identifierValue === "hlc3" || identifierValue === "ohlc4") {
      return priceExpression(identifierValue);
    }

    return { type: "identifier", name: identifierValue };
  }

  if (token.type === "operator" && token.value === "-") {
    return {
      type: "unary_op",
      operator: "negate",
      expression: parsePrimary(cursor)
    };
  }

  if (token.type === "punct" && token.value === "(") {
    const expression = parseValueExpression(cursor);
    cursor.expect("punct", ")");
    return expression;
  }

  throw new StrategyToolError("Invalid value expression in Pine-like script.", "invalid_strategy_script", 422, {
    tokenType: token.type,
    tokenValue: token.value
  });
}

function parsePostfix(cursor: TokenCursor): StrategyValueExpressionV2 {
  let expression = parsePrimary(cursor);
  while (cursor.match("punct", "[")) {
    const offsetToken = cursor.expect("number");
    cursor.expect("punct", "]");
    expression = applyHistoryRef(expression, Math.max(0, Math.trunc(offsetToken.value as number)));
  }
  return expression;
}

function parseMulDiv(cursor: TokenCursor): StrategyValueExpressionV2 {
  let expression = parsePostfix(cursor);
  while (true) {
    const token = cursor.peek();
    if (token.type !== "operator" || (token.value !== "*" && token.value !== "/")) break;
    cursor.next();
    expression = {
      type: "binary_op",
      operator: token.value as "*" | "/",
      left: expression,
      right: parsePostfix(cursor)
    };
  }
  return expression;
}

function parseAddSub(cursor: TokenCursor): StrategyValueExpressionV2 {
  let expression = parseMulDiv(cursor);
  while (true) {
    const token = cursor.peek();
    if (token.type !== "operator" || (token.value !== "+" && token.value !== "-")) break;
    cursor.next();
    expression = {
      type: "binary_op",
      operator: token.value as "+" | "-",
      left: expression,
      right: parseMulDiv(cursor)
    };
  }
  return expression;
}

function parseValueExpression(cursor: TokenCursor): StrategyValueExpressionV2 {
  return parseAddSub(cursor);
}

function parseComparisonOrBoolean(cursor: TokenCursor): StrategyConditionExpressionV2 {
  const nextToken = cursor.peek();
  if (nextToken.type === "identifier" && (nextToken.value === "true" || nextToken.value === "false")) {
    cursor.next();
    return { type: "boolean_constant", value: nextToken.value === "true" };
  }

  if (nextToken.type === "punct" && nextToken.value === "(") {
    cursor.next();
    const inner = parseConditionExpression(cursor);
    cursor.expect("punct", ")");
    return inner;
  }

  if (nextToken.type === "identifier" && (nextToken.value === "ta.crossover" || nextToken.value === "ta.crossunder")) {
    const callToken = cursor.next();
    cursor.expect("punct", "(");
    const left = parseValueExpression(cursor);
    cursor.expect("punct", ",");
    const right = parseValueExpression(cursor);
    cursor.expect("punct", ")");
    return {
      type: "comparison",
      operator: callToken.value === "ta.crossover" ? "crosses_above" : "crosses_below",
      left,
      right
    };
  }

  const left = parseValueExpression(cursor);
  const token = cursor.peek();
  if (token.type === "operator" && [">", ">=", "<", "<=", "==", "!="].includes(token.value)) {
    cursor.next();
    return {
      type: "comparison",
      operator: token.value as StrategyRuleOperator,
      left,
      right: parseValueExpression(cursor)
    };
  }

  throw new StrategyToolError("A condition expression must resolve to a comparison, boolean, or crossover call.", "invalid_strategy_script", 422);
}

function parseNot(cursor: TokenCursor): StrategyConditionExpressionV2 {
  const token = cursor.peek();
  if (token.type === "identifier" && token.value === "not") {
    cursor.next();
    return {
      type: "not",
      condition: parseNot(cursor)
    };
  }
  return parseComparisonOrBoolean(cursor);
}

function parseAnd(cursor: TokenCursor): StrategyConditionExpressionV2 {
  let expression = parseNot(cursor);
  while (cursor.peek().type === "identifier" && cursor.peek().value === "and") {
    cursor.next();
    const right = parseNot(cursor);
    expression =
      expression.type === "logical" && expression.operator === "and"
        ? { ...expression, conditions: [...expression.conditions, right] }
        : { type: "logical", operator: "and", conditions: [expression, right] };
  }
  return expression;
}

function parseConditionExpression(cursor: TokenCursor): StrategyConditionExpressionV2 {
  let expression = parseAnd(cursor);
  while (cursor.peek().type === "identifier" && cursor.peek().value === "or") {
    cursor.next();
    const right = parseAnd(cursor);
    expression =
      expression.type === "logical" && expression.operator === "or"
        ? { ...expression, conditions: [...expression.conditions, right] }
        : { type: "logical", operator: "or", conditions: [expression, right] };
  }
  return expression;
}

function expectNumberArg(arg: StrategyValueExpressionV2 | StrategyConditionExpressionV2 | string, label: string) {
  if (typeof arg === "object" && arg.type === "constant") return arg.value;
  throw new StrategyToolError("Strategy function expected a numeric constant argument.", "invalid_strategy_script", 422, {
    label
  });
}

function expectStringArg(arg: StrategyValueExpressionV2 | StrategyConditionExpressionV2 | string, label: string) {
  if (typeof arg === "string") return arg;
  throw new StrategyToolError("Strategy function expected a string argument.", "invalid_strategy_script", 422, {
    label
  });
}

function expectValueArg(arg: StrategyValueExpressionV2 | StrategyConditionExpressionV2 | string, label: string) {
  if (typeof arg === "object" && "type" in arg && arg.type !== "comparison" && arg.type !== "logical" && arg.type !== "not" && arg.type !== "boolean_constant") {
    return arg as StrategyValueExpressionV2;
  }
  throw new StrategyToolError("Strategy function expected a value expression argument.", "invalid_strategy_script", 422, {
    label
  });
}

function indicatorExpression(
  indicator: StrategyIndicatorKind,
  output: StrategyIndicatorOutput,
  params?: StrategyIndicatorParams
): StrategyValueExpressionV2 {
  return {
    type: "indicator",
    indicator,
    output,
    ...(params ? { params } : {})
  };
}

function compileFunctionCall(
  name: string,
  args: Array<StrategyValueExpressionV2 | StrategyConditionExpressionV2 | string>
): { value: StrategyValueExpressionV2 } | { condition: StrategyConditionExpressionV2 } {
  switch (name) {
    case "math.abs":
      return {
        value: {
          type: "unary_op",
          operator: "abs",
          expression: expectValueArg(args[0]!, "value")
        }
      };
    case "ta.ema":
      return {
        value: indicatorExpression("ema", "value", {
          source: sourceFieldFromExpression(expectValueArg(args[0]!, "source")),
          period: expectNumberArg(args[1]!, "period")
        })
      };
    case "ta.sma":
      return {
        value: indicatorExpression("sma", "value", {
          source: sourceFieldFromExpression(expectValueArg(args[0]!, "source")),
          period: expectNumberArg(args[1]!, "period")
        })
      };
    case "ta.rsi":
      return {
        value: indicatorExpression("rsi", "value", {
          source: sourceFieldFromExpression(expectValueArg(args[0]!, "source")),
          period: expectNumberArg(args[1]!, "period")
        })
      };
    case "ta.atr":
      return {
        value: indicatorExpression("atr", "value", {
          period: expectNumberArg(args[0]!, "period")
        })
      };
    case "ta.roc":
      return {
        value: indicatorExpression("roc", "value", {
          source: sourceFieldFromExpression(expectValueArg(args[0]!, "source")),
          period: expectNumberArg(args[1]!, "period")
        })
      };
    case "ta.vwap":
      return { value: indicatorExpression("vwap", "value") };
    case "ta.highest":
      return {
        value:
          sourceFieldFromExpression(expectValueArg(args[0]!, "source")) === "high"
            ? indicatorExpression("rolling_high", "value", {
                lookback: expectNumberArg(args[1]!, "lookback")
              })
            : indicatorExpression("rolling_high", "value", {
                lookback: expectNumberArg(args[1]!, "lookback")
              })
      };
    case "ta.lowest":
      return {
        value: indicatorExpression("rolling_low", "value", {
          lookback: expectNumberArg(args[1]!, "lookback")
        })
      };
    case "ta.stoch":
      return {
        value: indicatorExpression("stoch", (args[3] ? expectStringArg(args[3], "output") : "k") as StrategyIndicatorOutput, {
          period: expectNumberArg(args[0]!, "period"),
          smoothK: expectNumberArg(args[1]!, "smoothK"),
          smoothD: expectNumberArg(args[2]!, "smoothD")
        })
      };
    case "ta.macd":
      return {
        value: indicatorExpression(
          "macd",
          (args[4] ? expectStringArg(args[4], "output") : "line") as StrategyIndicatorOutput,
          {
            source: sourceFieldFromExpression(expectValueArg(args[0]!, "source")),
            fastPeriod: expectNumberArg(args[1]!, "fastPeriod"),
            slowPeriod: expectNumberArg(args[2]!, "slowPeriod"),
            signalPeriod: expectNumberArg(args[3]!, "signalPeriod")
          }
        )
      };
    case "ta.bb":
      return {
        value: indicatorExpression(
          "bollinger",
          (args[3] ? expectStringArg(args[3], "output") : "middle") as StrategyIndicatorOutput,
          {
            source: sourceFieldFromExpression(expectValueArg(args[0]!, "source")),
            period: expectNumberArg(args[1]!, "period"),
            stdDev: expectNumberArg(args[2]!, "stdDev")
          }
        )
      };
    case "ta.crossover":
      return {
        condition: {
          type: "comparison",
          operator: "crosses_above",
          left: expectValueArg(args[0]!, "left"),
          right: expectValueArg(args[1]!, "right")
        }
      };
    case "ta.crossunder":
      return {
        condition: {
          type: "comparison",
          operator: "crosses_below",
          left: expectValueArg(args[0]!, "left"),
          right: expectValueArg(args[1]!, "right")
        }
      };
    default:
      throw new StrategyToolError("Unsupported Pine-like function call.", "invalid_strategy_script", 422, {
        fn: name
      });
  }
}

function sourceFieldFromExpression(expression: StrategyValueExpressionV2): StrategyPriceField {
  if (expression.type === "price") return expression.field;
  if (expression.type === "history_ref" && expression.expression.type === "price") return expression.expression.field;
  throw new StrategyToolError("Indicator source arguments must be direct price series.", "invalid_strategy_script", 422);
}

export function parsePineLikeStrategy(script: string): StrategyAstV2 {
  const ast: StrategyAstV2 = {
    bindings: [],
    signals: {}
  };

  const lines = script
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/^strategy\s*\(/.test(line)) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!match) {
      throw new StrategyToolError("Each Pine-like line must be an assignment.", "invalid_strategy_script", 422, {
        line
      });
    }

    const [, rawName, rawExpression] = match;
    const name = rawName.trim();
    const expression = rawExpression.trim();

    if (name === "timeframe") {
      ast.timeframe = expression.replace(/^"|"$/g, "") as StrategyDefinition["timeframe"];
      continue;
    }

    if (name === "enabledSides") {
      ast.enabledSides = expression
        .replace(/^"|"$/g, "")
        .split(",")
        .map((side) => side.trim())
        .filter((side): side is StrategyEnabledSide => side === "long" || side === "short");
      continue;
    }

    const cursor = new TokenCursor(tokenize(expression));
    if (isSignalName(name)) {
      ast.signals[name] = parseConditionExpression(cursor);
      cursor.expect("eof");
      continue;
    }

    ast.bindings.push({
      name,
      expression: parseValueExpression(cursor)
    });
    cursor.expect("eof");
  }

  return ast;
}

function resolveBinding(
  name: string,
  bindings: Map<string, StrategyValueExpressionV2>,
  stack: Set<string>
): StrategyValueExpressionV2 {
  const expression = bindings.get(name);
  if (!expression) {
    throw new StrategyToolError("Unknown identifier in strategy AST.", "invalid_strategy_ast", 422, {
      identifier: name
    });
  }
  if (stack.has(name)) {
    throw new StrategyToolError("Circular binding detected in strategy AST.", "invalid_strategy_ast", 422, {
      identifier: name
    });
  }

  stack.add(name);
  const resolved = inlineIdentifiers(expression, bindings, stack);
  stack.delete(name);
  return resolved;
}

function inlineIdentifiers(
  expression: StrategyValueExpressionV2,
  bindings: Map<string, StrategyValueExpressionV2>,
  stack = new Set<string>()
): StrategyValueExpressionV2 {
  switch (expression.type) {
    case "identifier":
      return resolveBinding(expression.name, bindings, stack);
    case "history_ref":
      return {
        type: "history_ref",
        expression: inlineIdentifiers(expression.expression, bindings, stack),
        barsAgo: expression.barsAgo
      };
    case "binary_op":
      return {
        ...expression,
        left: inlineIdentifiers(expression.left, bindings, stack),
        right: inlineIdentifiers(expression.right, bindings, stack)
      };
    case "unary_op":
      return {
        ...expression,
        expression: inlineIdentifiers(expression.expression, bindings, stack)
      };
    default:
      return expression;
  }
}

function compileValueExpression(
  expression: StrategyValueExpressionV2,
  bindings: Map<string, StrategyValueExpressionV2>
): RuntimeValueExpression {
  const resolved = inlineIdentifiers(expression, bindings);

  switch (resolved.type) {
    case "constant":
      return { type: "operand", operand: { type: "constant", value: resolved.value } };
    case "price":
      return {
        type: "operand",
        operand: { type: "price_field", field: resolved.field, barsAgo: resolved.barsAgo }
      };
    case "indicator":
      return {
        type: "operand",
        operand: {
          type: "indicator_output",
          indicator: resolved.indicator,
          output: resolved.output,
          params: resolved.params,
          barsAgo: resolved.barsAgo
        }
      };
    case "history_ref":
      return {
        type: "history_ref",
        expression: compileValueExpression(resolved.expression, bindings),
        barsAgo: resolved.barsAgo
      };
    case "binary_op":
      return {
        type: "math",
        operator: resolved.operator,
        left: compileValueExpression(resolved.left, bindings),
        right: compileValueExpression(resolved.right, bindings)
      };
    case "unary_op":
      return resolved.operator === "abs"
        ? {
            type: "abs",
            expression: compileValueExpression(resolved.expression, bindings)
          }
        : {
            type: "negate",
            expression: compileValueExpression(resolved.expression, bindings)
          };
    case "identifier":
      throw new StrategyToolError("Unexpected unresolved identifier in strategy AST.", "invalid_strategy_ast", 422, {
        identifier: resolved.name
      });
  }
}

function compileConditionExpression(
  expression: StrategyConditionExpressionV2,
  bindings: Map<string, StrategyValueExpressionV2>
): RuntimeConditionExpression {
  switch (expression.type) {
    case "boolean_constant":
      return expression;
    case "not":
      return {
        type: "not",
        condition: compileConditionExpression(expression.condition, bindings)
      };
    case "logical":
      return {
        type: "logical",
        operator: expression.operator,
        conditions: expression.conditions.map((condition) => compileConditionExpression(condition, bindings))
      };
    case "comparison":
      return {
        type: "comparison",
        operator: expression.operator,
        left: compileValueExpression(expression.left, bindings),
        right: compileValueExpression(expression.right, bindings)
      };
  }
}

function bindingsMap(ast: StrategyAstV2) {
  return new Map(ast.bindings.map((binding) => [binding.name, binding.expression]));
}

export function compileAstToRuntime(strategy: StrategyDefinition, ast: StrategyAstV2): CompiledTradingStrategy {
  const bindings = bindingsMap(ast);
  const enabledSides = ast.enabledSides ?? strategy.enabledSides;

  return {
    id: strategy.id,
    name: strategy.name,
    marketId: strategy.marketId,
    timeframe: ast.timeframe ?? strategy.timeframe,
    enabledSides,
    sizing: strategy.sizing,
    riskRules: strategy.riskRules,
    costModel: strategy.costModel,
    entry: {
      ...(ast.signals.longEntry ? { long: compileConditionExpression(ast.signals.longEntry, bindings) } : {}),
      ...(ast.signals.shortEntry ? { short: compileConditionExpression(ast.signals.shortEntry, bindings) } : {})
    },
    exit: {
      ...(ast.signals.longExit ? { long: compileConditionExpression(ast.signals.longExit, bindings) } : {}),
      ...(ast.signals.shortExit ? { short: compileConditionExpression(ast.signals.shortExit, bindings) } : {})
    }
  };
}

export function compileEngineToRuntime(
  strategy: StrategyDefinition,
  engine: StrategyEngineDefinition
): CompiledTradingStrategy {
  const ast = engine.sourceType === "pine_like_v0"
    ? engine.ast ?? parsePineLikeStrategy(engine.script)
    : engine.ast;
  return compileAstToRuntime(strategy, ast);
}

export function buildCompilationPreview(
  strategy: StrategyDefinition,
  engine: StrategyEngineDefinition
): StrategyCompilationPreview {
  const runtime = compileEngineToRuntime(strategy, engine);
  const indicatorRefs = collectIndicatorReferencesFromRuntime(runtime);
  return {
    sourceType: engine.sourceType as StrategySourceType,
    bindingCount: engine.sourceType === "pine_like_v0"
      ? (engine.ast ?? parsePineLikeStrategy(engine.script)).bindings.length
      : engine.ast.bindings.length,
    signalsPresent: SIGNAL_NAMES.filter((name) => {
      const ast = engine.sourceType === "pine_like_v0"
        ? engine.ast ?? parsePineLikeStrategy(engine.script)
        : engine.ast;
      return Boolean(ast.signals[name]);
    }),
    enabledSides: runtime.enabledSides,
    timeframe: runtime.timeframe,
    indicatorRefs: indicatorRefs.map((ref) => ({
      indicator: ref.indicator,
      output: ref.output,
      params: ref.params as StrategyIndicatorParams | undefined
    })),
    warnings: []
  };
}
