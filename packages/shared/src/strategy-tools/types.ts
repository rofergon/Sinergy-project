import type { z } from "zod";
import type {
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyCapabilities,
  StrategyChartOverlay,
  StrategyDefinition,
  StrategyMarketAnalysis,
  StrategySourceCompilation,
  StrategyTemplate,
  StrategyToolName,
  StrategyValidationResult
} from "../strategy";
import { strategyToolInputSchemas } from "./schemas";

export type StrategyToolInput<TTool extends StrategyToolName> = z.infer<
  (typeof strategyToolInputSchemas)[TTool]
>;

export type StrategyToolResultMap = {
  list_strategy_capabilities: { capabilities: StrategyCapabilities };
  analyze_market_context: { analysis: StrategyMarketAnalysis };
  compile_strategy_source: StrategySourceCompilation;
  list_strategy_templates: { templates: StrategyTemplate[] };
  create_strategy_draft: { strategy: StrategyDefinition };
  update_strategy_draft: { strategy: StrategyDefinition };
  validate_strategy_draft: { validation: StrategyValidationResult };
  run_strategy_backtest: {
    summary: StrategyBacktestSummary;
    trades: StrategyBacktestTrade[];
    overlay: StrategyChartOverlay;
  };
  get_backtest_summary: { summary: StrategyBacktestSummary };
  get_backtest_trades: { trades: StrategyBacktestTrade[] };
  get_backtest_chart_overlay: { overlay: StrategyChartOverlay };
  save_strategy: { strategy: StrategyDefinition; validation: StrategyValidationResult };
  list_user_strategies: { strategies: StrategyDefinition[] };
  get_strategy: { strategy: StrategyDefinition };
  delete_strategy: { strategyId: string; deleted: true };
  clone_strategy_template: { strategy: StrategyDefinition };
};

export type StrategyToolResult<TTool extends StrategyToolName> = StrategyToolResultMap[TTool];

export type StrategyToolDefinition<TTool extends StrategyToolName = StrategyToolName> = {
  name: TTool;
  description: string;
  inputSchema: (typeof strategyToolInputSchemas)[TTool];
  endpoint: `/strategy-tools/${TTool}`;
};

export type StrategyToolTransport = <TTool extends StrategyToolName>(
  tool: TTool,
  input: StrategyToolInput<TTool>
) => Promise<StrategyToolResult<TTool>>;
