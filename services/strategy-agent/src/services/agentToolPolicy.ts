import { strategyToolDefinitions, type StrategyToolName } from "@sinergy/shared";

export const AGENT_BLOCKED_TOOLS = new Set<StrategyToolName>(["delete_strategy"]);

export function isAgentToolAllowed(tool: StrategyToolName) {
  return !AGENT_BLOCKED_TOOLS.has(tool);
}

export function getAgentToolDefinitions() {
  return strategyToolDefinitions.filter((definition) => isAgentToolAllowed(definition.name));
}

export function getAgentToolCatalog() {
  return getAgentToolDefinitions().map((definition) => ({
    name: definition.name,
    description: definition.description
  }));
}

export function filterAgentToolCatalog<TTool extends { name?: unknown }>(tools: TTool[]) {
  return tools.filter((tool) => typeof tool.name !== "string" || isAgentToolAllowed(tool.name as StrategyToolName));
}
