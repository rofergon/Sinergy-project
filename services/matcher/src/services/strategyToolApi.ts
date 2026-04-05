import {
  strategyToolInputSchemas,
  type StrategyToolName
} from "@sinergy/shared";
import { StrategyService } from "./strategyService.js";
import { StrategyToolError, StrategyToolRateLimiter } from "./strategyToolSecurity.js";

type ToolInput = Record<string, unknown>;

export class StrategyToolApi {
  private readonly rateLimiter = new StrategyToolRateLimiter();

  constructor(private readonly strategyService: StrategyService) {}

  async execute(tool: StrategyToolName, input: ToolInput) {
    const schema = strategyToolInputSchemas[tool];
    if (!schema) {
      throw new StrategyToolError("Unknown strategy tool.", "unknown_strategy_tool", 404, {
        tool
      });
    }

    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new StrategyToolError(
        "Strategy tool input validation failed.",
        "invalid_tool_input",
        422,
        {
          issues: parsed.error.issues
        }
      );
    }

    const payload = parsed.data as ToolInput & { ownerAddress: string };
    this.rateLimiter.check(tool, payload.ownerAddress);

    switch (tool) {
      case "list_strategy_capabilities":
        return {
          capabilities: this.strategyService.listCapabilities()
        };
      case "analyze_market_context":
        return {
          analysis: this.strategyService.analyzeMarketContext({
            ownerAddress: payload.ownerAddress as `0x${string}`,
            marketId: payload.marketId as `0x${string}`,
            bars: typeof payload.bars === "number" ? payload.bars : undefined,
            fromTs: typeof payload.fromTs === "number" ? payload.fromTs : undefined,
            toTs: typeof payload.toTs === "number" ? payload.toTs : undefined
          })
        };
      case "list_strategy_templates":
        return {
          templates: this.strategyService.listTemplates(
            payload.ownerAddress as `0x${string}`,
            payload.marketId as `0x${string}` | undefined
          )
        };
      case "create_strategy_draft":
        return {
          strategy: this.strategyService.createDraft({
            ownerAddress: payload.ownerAddress as `0x${string}`,
            marketId: payload.marketId as `0x${string}`,
            name: typeof payload.name === "string" ? payload.name : undefined
          })
        };
      case "update_strategy_draft":
        return {
          strategy: this.strategyService.updateDraft({
            ownerAddress: payload.ownerAddress as `0x${string}`,
            strategy: payload.strategy
          })
        };
      case "validate_strategy_draft":
        return {
          validation: this.strategyService.validateDraft({
            ownerAddress: payload.ownerAddress as `0x${string}`,
            strategy: payload.strategy,
            strategyId: typeof payload.strategyId === "string" ? payload.strategyId : undefined
          })
        };
      case "run_strategy_backtest":
        return {
          ...(this.strategyService.runBacktest({
            ownerAddress: payload.ownerAddress as `0x${string}`,
            strategyId: payload.strategyId as string,
            bars: typeof payload.bars === "number" ? payload.bars : undefined,
            fromTs: typeof payload.fromTs === "number" ? payload.fromTs : undefined,
            toTs: typeof payload.toTs === "number" ? payload.toTs : undefined
          }))
        };
      case "get_backtest_summary":
        return {
          summary: this.strategyService.getBacktestSummary({
            ownerAddress: payload.ownerAddress as `0x${string}`,
            runId: payload.runId as string
          })
        };
      case "get_backtest_trades":
        return {
          trades: this.strategyService.getBacktestTrades({
            ownerAddress: payload.ownerAddress as `0x${string}`,
            runId: payload.runId as string
          })
        };
      case "get_backtest_chart_overlay":
        return {
          overlay: this.strategyService.getBacktestChartOverlay({
            ownerAddress: payload.ownerAddress as `0x${string}`,
            runId: payload.runId as string
          })
        };
      case "save_strategy":
        return {
          ...(this.strategyService.saveStrategy({
            ownerAddress: payload.ownerAddress as `0x${string}`,
            strategyId: payload.strategyId as string
          }))
        };
      case "list_user_strategies":
        return {
          strategies: this.strategyService.listUserStrategies(payload.ownerAddress as `0x${string}`)
        };
      case "get_strategy":
        return {
          strategy: this.strategyService.getStrategy(
            payload.strategyId as string,
            payload.ownerAddress as `0x${string}`
          )
        };
      case "clone_strategy_template":
        return {
          strategy: this.strategyService.cloneTemplate({
            ownerAddress: payload.ownerAddress as `0x${string}`,
            marketId: payload.marketId as `0x${string}`,
            templateId: payload.templateId as string
          })
        };
    }
  }
}
