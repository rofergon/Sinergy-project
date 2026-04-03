import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import {
  createHttpStrategyToolTransport,
  strategyToolDefinitions,
  type HexString,
  type StrategyToolName
} from "@sinergy/shared";
import { STRATEGY_AGENT_SYSTEM_PROMPT, buildUserPrompt } from "../prompts.js";
import type {
  AgentPlanResponse,
  AgentResponse,
  AgentStrategyRequest,
  AgentStrategySummary,
  AgentToolTraceEntry
} from "../types.js";
import { createTrackedStrategyLangChainTools } from "./matcherTools.js";
import { probeModel } from "./modelProbe.js";
import { runFallbackJsonLoop } from "./fallbackRuntime.js";
import { StrategyAgentSessionStore } from "./sessionStore.js";

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

function collectArtifactsFromTrace(
  trace: AgentToolTraceEntry[],
  initial: AgentResponse["artifacts"] = {}
): AgentResponse["artifacts"] {
  const artifacts: AgentResponse["artifacts"] = { ...initial };

  for (const entry of trace) {
    const output = entry.output;
    if (!output) continue;

    if (typeof output.strategy === "object" && output.strategy && "id" in output.strategy) {
      const strategy = output.strategy as AgentStrategySummary;
      artifacts.strategyId = String(strategy.id);
      artifacts.strategy = {
        id: String(strategy.id),
        name: strategy.name,
        marketId: strategy.marketId,
        timeframe: strategy.timeframe,
        status: strategy.status,
        updatedAt: strategy.updatedAt
      };
    }
    if (typeof output.summary === "object" && output.summary && "runId" in output.summary) {
      artifacts.runId = String((output.summary as { runId: string }).runId);
      artifacts.summary = output.summary as Record<string, unknown>;
    }
    if (typeof output.validation === "object" && output.validation) {
      artifacts.validation = output.validation as Record<string, unknown>;
    }
  }

  return artifacts;
}

export class StrategyAgentService {
  private readonly model: ChatOpenAI;
  private readonly matcherTransport: ReturnType<typeof createHttpStrategyToolTransport>;
  private readonly sessions: StrategyAgentSessionStore;

  constructor(private readonly options: {
    matcherUrl: string;
    sessionDbFile: string;
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
    this.sessions = new StrategyAgentSessionStore({
      dbFile: options.sessionDbFile
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

  async listSessions(input: { ownerAddress: string; marketId?: string; limit?: number }) {
    return {
      sessions: this.sessions.listSessions(input)
    };
  }

  async getSession(input: { ownerAddress: string; sessionId: string }) {
    const session = this.sessions.getSession(input.sessionId, input.ownerAddress);
    if (!session) {
      throw new Error("Session not found.");
    }

    return { session };
  }

  async plan(input: AgentStrategyRequest): Promise<AgentPlanResponse> {
    const requestId = crypto.randomUUID();
    const session = this.sessions.getOrCreate(input);
    this.sessions.addTurn(session, {
      role: "user",
      mode: "plan",
      text: input.goal
    });
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
${buildUserPrompt({
  ...input,
  strategyId: input.strategyId ?? session.strategyId,
  session: this.sessions.snapshot(session)
})}

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

    this.sessions.addTurn(session, {
      role: "assistant",
      mode: "plan",
      text: parsed.finalMessage,
      usedTools: parsed.plannedTools.map((item) => item.tool)
    });

    return {
      requestId,
      finalMessage: parsed.finalMessage,
      plannedTools: parsed.plannedTools,
      session: this.sessions.snapshot(session),
      modelModeUsed: "fallback-json",
      warnings: []
    };
  }

  async run(input: AgentStrategyRequest): Promise<AgentResponse> {
    const requestId = crypto.randomUUID();
    const trace: AgentToolTraceEntry[] = [];
    const warnings: string[] = [];
    let artifacts: AgentResponse["artifacts"] = {};
    const session = this.sessions.getOrCreate(input);
    this.sessions.addTurn(session, {
      role: "user",
      mode: "run",
      text: input.goal
    });
    const sessionSnapshot = this.sessions.snapshot(session);
    const activeInput = {
      ...input,
      strategyId: input.strategyId ?? sessionSnapshot.strategyId
    };

    if (!this.options.forceFallbackJson) {
      try {
        const nativeResult = await this.runNativeToolAgent(activeInput, trace, sessionSnapshot);
        if (trace.length > 0) {
          artifacts = collectArtifactsFromTrace(trace, nativeResult.artifacts);
          
          // AUTO-BACKTEST SAFETY NET
          const goalMentionsBacktest = /backtest|test|evaluat/i.test(activeInput.goal);
          const backtestDone = trace.some(entry => entry.tool === "run_strategy_backtest" && entry.output && !entry.error);
          
          if (goalMentionsBacktest && !backtestDone && artifacts.strategyId) {
            warnings.push("Agent finished without running requested backtest. Auto-executing backtest safety net.");
            const step = trace.length + 1;
            const entry: AgentToolTraceEntry = {
              step,
              tool: "run_strategy_backtest",
              input: { ownerAddress: activeInput.ownerAddress, strategyId: artifacts.strategyId },
              startedAt: new Date().toISOString()
            };
            trace.push(entry);
            try {
              const result = await this.matcherTransport("run_strategy_backtest", { ownerAddress: activeInput.ownerAddress as HexString, strategyId: artifacts.strategyId });
              entry.output = result as Record<string, unknown>;
              entry.completedAt = new Date().toISOString();
              artifacts = collectArtifactsFromTrace([entry], artifacts);
              nativeResult.finalMessage += " (A backtest was automatically run to complete your request).";
            } catch (error) {
              entry.error = { message: error instanceof Error ? error.message : String(error) };
              entry.completedAt = new Date().toISOString();
              warnings.push(`Auto-backtest failed: ${entry.error.message}`);
            }
          }

          this.sessions.applyArtifacts(session, artifacts);
          this.sessions.appendTrace(session, trace);
          this.sessions.addTurn(session, {
            role: "assistant",
            mode: "run",
            text: nativeResult.finalMessage,
            usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
            warnings
          });

          return {
            requestId,
            finalMessage: nativeResult.finalMessage,
            usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
            toolTrace: trace,
            artifacts,
            session: this.sessions.snapshot(session),
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
      goal: activeInput.goal,
      ownerAddress: activeInput.ownerAddress,
      marketId: activeInput.marketId,
      strategyId: activeInput.strategyId,
      session: sessionSnapshot,
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
    artifacts = collectArtifactsFromTrace(trace, fallbackResult.artifacts);

    // AUTO-BACKTEST SAFETY NET
    const goalMentionsBacktest = /backtest|test|evaluat/i.test(activeInput.goal);
    const backtestDoneFallback = trace.some(entry => entry.tool === "run_strategy_backtest" && entry.output && !entry.error);
    
    if (goalMentionsBacktest && !backtestDoneFallback && artifacts.strategyId) {
      warnings.push("Fallback agent finished without running requested backtest. Auto-executing backtest safety net.");
      const step = trace.length + 1;
      const entry: AgentToolTraceEntry = {
        step,
        tool: "run_strategy_backtest",
        input: { ownerAddress: activeInput.ownerAddress, strategyId: artifacts.strategyId },
        startedAt: new Date().toISOString()
      };
      trace.push(entry);
      try {
        const result = await this.matcherTransport("run_strategy_backtest", { ownerAddress: activeInput.ownerAddress as HexString, strategyId: artifacts.strategyId });
        entry.output = result as Record<string, unknown>;
        entry.completedAt = new Date().toISOString();
        artifacts = collectArtifactsFromTrace([entry], artifacts);
        fallbackResult.finalMessage += " (A backtest was automatically run to complete your request).";
      } catch (error) {
        entry.error = { message: error instanceof Error ? error.message : String(error) };
        entry.completedAt = new Date().toISOString();
        warnings.push(`Auto-backtest failed: ${entry.error.message}`);
      }
    }

    this.sessions.applyArtifacts(session, artifacts);
    this.sessions.appendTrace(session, trace);
    warnings.push(...fallbackResult.warnings);
    this.sessions.addTurn(session, {
      role: "assistant",
      mode: "run",
      text: fallbackResult.finalMessage,
      usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
      warnings
    });

    return {
      requestId,
      finalMessage: fallbackResult.finalMessage,
      usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
      toolTrace: trace,
      artifacts,
      session: this.sessions.snapshot(session),
      modelModeUsed: "fallback-json",
      warnings
    };
  }

  private async runNativeToolAgent(
    input: AgentStrategyRequest,
    trace: AgentToolTraceEntry[],
    session: AgentPlanResponse["session"]
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
          content: buildUserPrompt({ ...input, session })
        }
      ]
    });

    const finalMessage =
      extractMessageText(response) ||
      "Native tool agent completed without a textual summary.";

    return {
      finalMessage,
      artifacts: collectArtifactsFromTrace(trace)
    };
  }
}
