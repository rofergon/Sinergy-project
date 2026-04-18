import { strategyToolDefinitions } from "./definitions";
import { strategyToolInputSchemas } from "./schemas";
import type { StrategyToolInput, StrategyToolResult, StrategyToolTransport } from "./types";
import type { StrategyToolName } from "../strategy";

export function createHttpStrategyToolTransport(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): StrategyToolTransport {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function transport<TTool extends StrategyToolName>(
    tool: TTool,
    input: StrategyToolInput<TTool>
  ): Promise<StrategyToolResult<TTool>> {
    const parsed = strategyToolInputSchemas[tool].parse(input);
    const response = await fetchImpl(`${options.baseUrl}/strategy-tools/${tool}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(parsed)
    });

    const payload = await response.json();
    if (!payload.ok) {
      const error = payload.error ?? { message: `Strategy tool '${tool}' failed.` };
      const next = new Error(error.message) as Error & {
        code?: string;
        details?: Record<string, unknown>;
        retryable?: boolean;
      };
      next.code = error.code;
      next.details = error.details;
      next.retryable = error.retryable;
      throw next;
    }

    return payload.result as StrategyToolResult<TTool>;
  };
}

export function createLangChainCompatibleStrategyTools(transport: StrategyToolTransport) {
  return strategyToolDefinitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    schema: definition.inputSchema,
    invoke: (input: unknown) =>
      transport(
        definition.name,
        definition.inputSchema.parse(input) as StrategyToolInput<typeof definition.name>
      )
  }));
}
