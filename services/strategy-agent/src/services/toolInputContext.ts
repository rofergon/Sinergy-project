import type { StrategyToolName } from "@sinergy/shared";

type MergeContextOptions = {
  ownerAddress: string;
  marketId?: string;
  strategyId?: string;
};

const MARKET_ROOT_TOOLS = new Set<StrategyToolName>([
  "analyze_market_context",
  "compile_strategy_source",
  "list_strategy_templates",
  "create_strategy_draft",
  "clone_strategy_template"
]);

const STRATEGY_ID_ROOT_TOOLS = new Set<StrategyToolName>([
  "run_strategy_backtest",
  "save_strategy",
  "get_strategy"
]);

export function mergeToolContext(
  tool: StrategyToolName,
  baseInput: Record<string, unknown>,
  options: MergeContextOptions
) {
  const mergedInput: Record<string, unknown> = {
    ...baseInput,
    ownerAddress: options.ownerAddress
  };

  if (options.marketId && baseInput.marketId === undefined && MARKET_ROOT_TOOLS.has(tool)) {
    mergedInput.marketId = options.marketId;
  }

  if (
    options.strategyId &&
    baseInput.strategyId === undefined &&
    STRATEGY_ID_ROOT_TOOLS.has(tool)
  ) {
    mergedInput.strategyId = options.strategyId;
  }

  if (
    tool === "validate_strategy_draft" &&
    options.strategyId &&
    baseInput.strategyId === undefined &&
    baseInput.strategy === undefined
  ) {
    mergedInput.strategyId = options.strategyId;
  }

  return mergedInput;
}
