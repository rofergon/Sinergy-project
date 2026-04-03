import { tool } from "langchain";
import {
  createHttpStrategyToolTransport,
  createLangChainCompatibleStrategyTools,
  strategyToolDefinitions,
  type StrategyToolName
} from "@sinergy/shared";
import type { AgentToolTraceEntry } from "../types.js";
import { summarizeToolProgress } from "./runtimePolicy.js";
import { mergeToolContext } from "./toolInputContext.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createTrackedStrategyLangChainTools(options: {
  matcherUrl: string;
  ownerAddress: string;
  marketId?: string;
  strategyId?: string;
  trace: AgentToolTraceEntry[];
}) {
  const transport = createHttpStrategyToolTransport({
    baseUrl: options.matcherUrl
  });
  const compatible = createLangChainCompatibleStrategyTools(transport);

  return compatible.map((definition) =>
    tool(
      async (rawInput) => {
        const step = options.trace.length + 1;
        const startedAt = new Date().toISOString();
        const baseInput: Record<string, unknown> = isObject(rawInput) ? rawInput : {};
        const mergedInput = mergeToolContext(definition.name as StrategyToolName, baseInput, {
          ownerAddress: options.ownerAddress,
          marketId: options.marketId,
          strategyId: options.strategyId
        });

        const entry: AgentToolTraceEntry = {
          step,
          tool: definition.name as StrategyToolName,
          input: mergedInput,
          startedAt
        };
        options.trace.push(entry);

        try {
          const output = await definition.invoke(mergedInput);
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
        schema: definition.schema
      }
    )
  );
}

export function getStrategyToolCatalog() {
  return strategyToolDefinitions.map((definition) => ({
    name: definition.name,
    description: definition.description
  }));
}
