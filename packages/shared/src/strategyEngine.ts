import type {
  StrategyEnabledSide,
  StrategyIndicatorKind,
  StrategyIndicatorOutput,
  StrategyIndicatorParams,
  StrategyPriceField,
  StrategyRuleOperator,
  StrategyTimeframe
} from "./strategy";

export type StrategySourceType = "ast_v2" | "pine_like_v0";

export type StrategyValueExpressionV2 =
  | {
      type: "constant";
      value: number;
    }
  | {
      type: "price";
      field: StrategyPriceField;
      barsAgo?: number;
    }
  | {
      type: "indicator";
      indicator: StrategyIndicatorKind;
      output: StrategyIndicatorOutput;
      params?: StrategyIndicatorParams;
      barsAgo?: number;
    }
  | {
      type: "identifier";
      name: string;
    }
  | {
      type: "history_ref";
      expression: StrategyValueExpressionV2;
      barsAgo: number;
    }
  | {
      type: "binary_op";
      operator: "+" | "-" | "*" | "/";
      left: StrategyValueExpressionV2;
      right: StrategyValueExpressionV2;
    }
  | {
      type: "unary_op";
      operator: "negate" | "abs";
      expression: StrategyValueExpressionV2;
    };

export type StrategyConditionExpressionV2 =
  | {
      type: "comparison";
      operator: StrategyRuleOperator;
      left: StrategyValueExpressionV2;
      right: StrategyValueExpressionV2;
    }
  | {
      type: "logical";
      operator: "and" | "or";
      conditions: StrategyConditionExpressionV2[];
    }
  | {
      type: "not";
      condition: StrategyConditionExpressionV2;
    }
  | {
      type: "boolean_constant";
      value: boolean;
    };

export type StrategyBindingV2 = {
  name: string;
  expression: StrategyValueExpressionV2;
};

export type StrategyAstV2 = {
  timeframe?: StrategyTimeframe;
  enabledSides?: StrategyEnabledSide[];
  bindings: StrategyBindingV2[];
  signals: Partial<Record<"longEntry" | "longExit" | "shortEntry" | "shortExit", StrategyConditionExpressionV2>>;
};

export type StrategyEngineDefinition =
  | {
      version: "2";
      sourceType: "ast_v2";
      ast: StrategyAstV2;
      script?: string;
    }
  | {
      version: "2";
      sourceType: "pine_like_v0";
      script: string;
      ast?: StrategyAstV2;
    };

export type StrategyCompilationPreview = {
  sourceType: StrategySourceType;
  bindingCount: number;
  signalsPresent: Array<"longEntry" | "longExit" | "shortEntry" | "shortExit">;
  enabledSides: StrategyEnabledSide[];
  timeframe?: StrategyTimeframe;
  indicatorRefs: Array<{
    indicator: StrategyIndicatorKind;
    output: StrategyIndicatorOutput;
    params?: StrategyIndicatorParams;
  }>;
  warnings: string[];
};
