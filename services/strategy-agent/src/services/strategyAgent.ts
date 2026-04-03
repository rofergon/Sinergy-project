import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import {
  createHttpStrategyToolTransport,
  strategyToolDefinitions,
  type HexString,
  type StrategyToolName
} from "@sinergy/shared";
import { STRATEGY_AGENT_SYSTEM_PROMPT, buildUserPrompt } from "../prompts.js";
import type { AgentPlanResponse, AgentResponse, AgentStrategyRequest, AgentToolTraceEntry } from "../types.js";
import { createTrackedStrategyLangChainTools } from "./matcherTools.js";
import { probeModel } from "./modelProbe.js";
import { runFallbackJsonLoop } from "./fallbackRuntime.js";

function extractMessageText(output: unknown) {
  if (!output || typeof output !== "object") return "";

  if ("messages" in output && Array.isArray((output as { messages?: unknown[] }).messages)) {
    const messages = (output as { messages: Array<{ content?: unknown }> }).messages;
    const last = messages[messages.length - 1];
    if (typeof last?.content === "string") return last.content;
    if (Array.isArray(last?.content)) {
      return last.content
        .map((item) =>
          item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : ""
        )
        .join("");
    }
  }

  if ("content" in output && typeof (output as { content?: unknown }).content === "string") {
    return (output as { content: string }).content;
  }

  return "";
}

export class StrategyAgentService {
  private readonly model: ChatOpenAI;
  private readonly matcherTransport: ReturnType<typeof createHttpStrategyToolTransport>;

  constructor(private readonly options: {
    matcherUrl: string;
    modelBaseUrl: string;
    modelName: string;
    modelApiKey: string;
    modelTimeoutMs: number;
    maxSteps: number;
    toolcallRetries: number;
    forceFallbackJson: boolean;
  }) {
    this.model = new ChatOpenAI({
      model: options.modelName,
      apiKey: options.modelApiKey,
      configuration: {
        baseURL: options.modelBaseUrl
      },
      timeout: options.modelTimeoutMs,
      temperature: 0,
      maxRetries: 0
    });
    this.matcherTransport = createHttpStrategyToolTransport({
      baseUrl: options.matcherUrl
    });
  }

  async getHealth() {
    const [modelProbe, matcherHealth] = await Promise.all([
      probeModel(this.options.modelBaseUrl, this.options.modelName),
      fetch(`${this.options.matcherUrl}/health`)
        .then((response) => response.json())
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }))
    ]);

    return {
      ok: Boolean(modelProbe.reachable && matcherHealth?.ok),
      model: modelProbe,
      matcher: matcherHealth
    };
  }

  async getCapabilities() {
    const [modelProbe, toolCatalog] = await Promise.all([
      probeModel(this.options.modelBaseUrl, this.options.modelName),
      fetch(`${this.options.matcherUrl}/strategy-tools/catalog`).then((response) => response.json())
    ]);

    return {
      model: {
        baseUrl: this.options.modelBaseUrl,
        modelName: this.options.modelName,
        ...modelProbe
      },
      runtime: {
        maxSteps: this.options.maxSteps,
        toolcallRetries: this.options.toolcallRetries,
        forceFallbackJson: this.options.forceFallbackJson
      },
      tools: toolCatalog?.result?.tools ?? strategyToolDefinitions.map((definition) => ({
        name: definition.name,
        description: definition.description
      }))
    };
  }

  async plan(input: AgentStrategyRequest): Promise<AgentPlanResponse> {
    const requestId = crypto.randomUUID();
    const capabilities = await this.matcherTransport("list_strategy_capabilities", {
      ownerAddress: input.ownerAddress as HexString
    });
    const prompt = `
${STRATEGY_AGENT_SYSTEM_PROMPT}

You are in planning mode only. Do not execute tools.

Available tools:
${strategyToolDefinitions.map((definition) => `- ${definition.name}: ${definition.description}`).join("\n")}

Capabilities summary:
${JSON.stringify(capabilities.capabilities, null, 2)}

User request:
${buildUserPrompt(input)}

Return JSON like:
{"finalMessage":"...","plannedTools":[{"tool":"list_strategy_capabilities","why":"..."},{"tool":"create_strategy_draft","why":"..."}]}
`.trim();

    const response = await this.model.invoke(prompt);
    const rawText = extractMessageText(response);
    let parsed: { finalMessage: string; plannedTools: Array<{ tool: StrategyToolName; why: string }> };

    try {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");
      parsed = JSON.parse(rawText.slice(start, end + 1));
    } catch {
      parsed = {
        finalMessage: "Plan the strategy task by reading capabilities, drafting or cloning, validating, then backtesting.",
        plannedTools: [
          { tool: "list_strategy_capabilities", why: "Read the supported indicators, operators and limits." },
          { tool: "list_strategy_templates", why: "Check whether an existing template already matches the request." },
          { tool: "create_strategy_draft", why: "Create a draft when no suitable strategy exists." },
          { tool: "validate_strategy_draft", why: "Verify schema and rule correctness before saving or testing." },
          { tool: "run_strategy_backtest", why: "Measure performance after the draft is valid." }
        ]
      };
    }

    return {
      requestId,
      finalMessage: parsed.finalMessage,
      plannedTools: parsed.plannedTools,
      modelModeUsed: "fallback-json",
      warnings: []
    };
  }

  async run(input: AgentStrategyRequest): Promise<AgentResponse> {
    const requestId = crypto.randomUUID();
    const trace: AgentToolTraceEntry[] = [];
    const warnings: string[] = [];
    let artifacts: AgentResponse["artifacts"] = {};

    if (!this.options.forceFallbackJson) {
      try {
        const nativeResult = await this.runNativeToolAgent(input, trace);
        if (trace.length > 0) {
          return {
            requestId,
            finalMessage: nativeResult.finalMessage,
            usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
            toolTrace: trace,
            artifacts: nativeResult.artifacts,
            modelModeUsed: "native-tools",
            warnings
          };
        }

        warnings.push("Native tool mode returned no tool calls; fallback JSON mode used.");
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }

    const fallbackResult = await runFallbackJsonLoop({
      model: this.model,
      goal: input.goal,
      ownerAddress: input.ownerAddress,
      marketId: input.marketId,
      strategyId: input.strategyId,
      maxSteps: this.options.maxSteps,
      trace,
      invokeTool: async (toolName, rawInput) => {
        const step = trace.length + 1;
        const entry: AgentToolTraceEntry = {
          step,
          tool: toolName,
          input: rawInput,
          startedAt: new Date().toISOString()
        };
        trace.push(entry);
        try {
          const result = await this.matcherTransport(toolName, rawInput as never);
          entry.output = result as Record<string, unknown>;
          entry.completedAt = new Date().toISOString();
          return result as Record<string, unknown>;
        } catch (error) {
          entry.error = {
            message: error instanceof Error ? error.message : String(error)
          };
          entry.completedAt = new Date().toISOString();
          throw error;
        }
      }
    });
    artifacts = fallbackResult.artifacts;
    warnings.push(...fallbackResult.warnings);

    return {
      requestId,
      finalMessage: fallbackResult.finalMessage,
      usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
      toolTrace: trace,
      artifacts,
      modelModeUsed: "fallback-json",
      warnings
    };
  }

  private async runNativeToolAgent(
    input: AgentStrategyRequest,
    trace: AgentToolTraceEntry[]
  ): Promise<{ finalMessage: string; artifacts: AgentResponse["artifacts"] }> {
    const tools = createTrackedStrategyLangChainTools({
      matcherUrl: this.options.matcherUrl,
      ownerAddress: input.ownerAddress,
      marketId: input.marketId,
      strategyId: input.strategyId,
      trace
    });

    const dummyTool = tool(
      async () => ({ pong: true }),
      {
        name: "agent_runtime_ping",
        description: "Internal connectivity check tool.",
        schema: {
          parse: () => ({})
        } as never
      }
    );

    const agent = createAgent({
      model: this.model,
      tools: [dummyTool, ...tools],
      systemPrompt: STRATEGY_AGENT_SYSTEM_PROMPT
    });

    const response = await agent.invoke({
      messages: [
        {
          role: "user",
          content: buildUserPrompt(input)
        }
      ]
    });

    const finalMessage =
      extractMessageText(response) ||
      "Native tool agent completed without a textual summary.";

    const artifacts: AgentResponse["artifacts"] = {};
    for (const entry of trace) {
      const output = entry.output ?? {};
      if (typeof output.strategy === "object" && output.strategy && "id" in output.strategy) {
        artifacts.strategyId = String((output.strategy as { id: string }).id);
      }
      if (typeof output.summary === "object" && output.summary && "runId" in output.summary) {
        artifacts.runId = String((output.summary as { runId: string }).runId);
        artifacts.summary = output.summary as Record<string, unknown>;
      }
      if (typeof output.validation === "object" && output.validation) {
        artifacts.validation = output.validation as Record<string, unknown>;
      }
    }

    return {
      finalMessage,
      artifacts
    };
  }
}
