import { strategyToolDefinitions } from "@sinergy/shared";
import { createStrategyToolRuntime } from "./strategyToolRuntime.js";

export function createTrackedStrategyLangChainTools(options: {
  matcherUrl: string;
  ownerAddress: string;
  marketId?: string;
  strategyId?: string;
  trace: import("../types.js").AgentToolTraceEntry[];
}) {
  return createStrategyToolRuntime({
    matcherUrl: options.matcherUrl
  }).createTrackedLangChainTools(options);
}

export function getStrategyToolCatalog() {
  return strategyToolDefinitions.map((definition) => ({
    name: definition.name,
    description: definition.description
  }));
}
