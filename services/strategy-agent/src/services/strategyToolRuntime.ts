import { tool } from "langchain";
import {
  createHttpStrategyToolTransport,
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
        async (rawInput) => {
          const step = toolOptions.trace.length + 1;
          const startedAt = new Date().toISOString();
          const baseInput: Record<string, unknown> = isObject(rawInput) ? rawInput : {};
          const mergedInput = mergeToolContext(definition.name, baseInput, {
            ownerAddress: toolOptions.ownerAddress,
            marketId: toolOptions.marketId,
            strategyId: toolOptions.strategyId
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
          schema: {
            parse(value: unknown) {
              return isObject(value) ? value : {};
            }
          } as never
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
