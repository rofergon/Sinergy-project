import { tool } from "langchain";
import { z } from "zod";
import {
  createHttpStrategyToolTransport,
  strategyDraftPayloadSchema,
  strategyToolDefinitions,
  type StrategyToolInput,
  type StrategyToolName,
  type StrategyToolResult,
  type StrategyToolTransport
} from "@sinergy/shared";
import type { AgentToolTraceEntry } from "../types.js";
import { summarizeToolProgress } from "./runtimePolicy.js";
import { mergeToolContext } from "./toolInputContext.js";

type StrategyToolExecutionContext = {
  ownerAddress: string;
  marketId?: string;
  strategyId?: string;
};

type TrackedLangChainToolOptions = StrategyToolExecutionContext & {
  trace: AgentToolTraceEntry[];
};

export const strategyLangChainContextSchema = z.object({
  ownerAddress: z.string(),
  marketId: z.string().optional(),
  strategyId: z.string().uuid().optional()
});

const langChainVisibleToolSchemas = {
  list_strategy_capabilities: z.object({}),
  analyze_market_context: z.object({
    bars: z.number().int().positive().optional(),
    fromTs: z.number().int().positive().optional(),
    toTs: z.number().int().positive().optional()
  }),
  compile_strategy_source: z.object({
    name: z.string().trim().optional(),
    timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional(),
    enabledSides: z.array(z.enum(["long", "short"])).min(1).optional(),
    engine: z.unknown()
  }),
  list_strategy_templates: z.object({}),
  create_strategy_draft: z.object({
    name: z.string().trim().optional(),
    engine: z.unknown().optional()
  }),
  update_strategy_draft: z.object({
    strategy: strategyDraftPayloadSchema
  }),
  validate_strategy_draft: z.object({
    strategyId: z.string().uuid().optional(),
    strategy: strategyDraftPayloadSchema.optional()
  }),
  run_strategy_backtest: z.object({
    strategyId: z.string().uuid(),
    bars: z.number().int().positive().optional(),
    fromTs: z.number().int().positive().optional(),
    toTs: z.number().int().positive().optional()
  }),
  get_backtest_summary: z.object({
    runId: z.string().uuid()
  }),
  get_backtest_trades: z.object({
    runId: z.string().uuid()
  }),
  get_backtest_chart_overlay: z.object({
    runId: z.string().uuid()
  }),
  save_strategy: z.object({
    strategyId: z.string().uuid()
  }),
  list_user_strategies: z.object({}),
  get_strategy: z.object({
    strategyId: z.string().uuid()
  }),
  clone_strategy_template: z.object({
    templateId: z.string().min(1)
  })
} satisfies Record<StrategyToolName, z.ZodTypeAny>;

export type StrategyToolRuntime = {
  transport: StrategyToolTransport;
  invoke: <TTool extends StrategyToolName>(
    tool: TTool,
    input: StrategyToolInput<TTool>
  ) => Promise<StrategyToolResult<TTool>>;
  invokeUntyped: (tool: StrategyToolName, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  createTrackedLangChainTools: (options: TrackedLangChainToolOptions) => any[];
  getCatalog: () => Array<{ name: StrategyToolName; description: string }>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveExecutionContext(
  runtime: unknown,
  fallback: StrategyToolExecutionContext
): StrategyToolExecutionContext {
  const context =
    runtime && typeof runtime === "object" && "context" in runtime
      ? (runtime as { context?: unknown }).context
      : undefined;

  if (!isObject(context)) {
    return fallback;
  }

  return {
    ownerAddress: typeof context.ownerAddress === "string" ? context.ownerAddress : fallback.ownerAddress,
    marketId: typeof context.marketId === "string" ? context.marketId : fallback.marketId,
    strategyId: typeof context.strategyId === "string" ? context.strategyId : fallback.strategyId
  };
}

export function createStrategyToolRuntime(options: {
  matcherUrl?: string;
  transport?: StrategyToolTransport;
}): StrategyToolRuntime {
  const transport =
    options.transport ??
    (() => {
      if (!options.matcherUrl) {
        throw new Error("matcherUrl is required when no strategy tool transport is provided.");
      }
      return createHttpStrategyToolTransport({
        baseUrl: options.matcherUrl
      });
    })();

  const invoke: StrategyToolRuntime["invoke"] = async (toolName, input) => {
    return await transport(toolName, input);
  };

  const invokeUntyped: StrategyToolRuntime["invokeUntyped"] = async (toolName, input) => {
    return await transport(toolName, input as never) as Record<string, unknown>;
  };

  const createTrackedLangChainTools: StrategyToolRuntime["createTrackedLangChainTools"] = (toolOptions) =>
    strategyToolDefinitions.map((definition) =>
      tool(
        async (rawInput, runtime) => {
          const step = toolOptions.trace.length + 1;
          const startedAt = new Date().toISOString();
          const baseInput: Record<string, unknown> = isObject(rawInput) ? rawInput : {};
          const executionContext = resolveExecutionContext(runtime, {
            ownerAddress: toolOptions.ownerAddress,
            marketId: toolOptions.marketId,
            strategyId: toolOptions.strategyId
          });
          const mergedInput = mergeToolContext(definition.name, baseInput, {
            ownerAddress: executionContext.ownerAddress,
            marketId: executionContext.marketId,
            strategyId: executionContext.strategyId
          });

          const entry: AgentToolTraceEntry = {
            step,
            tool: definition.name,
            input: mergedInput,
            startedAt
          };
          toolOptions.trace.push(entry);

          try {
            const output = await invokeUntyped(definition.name, mergedInput);
            entry.output = isObject(output) ? output : { value: output };
            entry.completedAt = new Date().toISOString();
            const progress = summarizeToolProgress(entry);
            entry.progressObserved = progress.progressObserved;
            entry.resultSummary = progress.resultSummary;
            return output;
          } catch (error) {
            entry.error = {
              message: error instanceof Error ? error.message : String(error)
            };
            entry.completedAt = new Date().toISOString();
            entry.failureClass = "tool_error";
            entry.progressObserved = false;
            entry.resultSummary = entry.error.message;
            throw error;
          }
        },
        {
          name: definition.name,
          description: definition.description,
          schema: langChainVisibleToolSchemas[definition.name]
        }
      )
    );

  return {
    transport,
    invoke,
    invokeUntyped,
    createTrackedLangChainTools,
    getCatalog() {
      return strategyToolDefinitions.map((definition) => ({
        name: definition.name,
        description: definition.description
      }));
    }
  };
}
