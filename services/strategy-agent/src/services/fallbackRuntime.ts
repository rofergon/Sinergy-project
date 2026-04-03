import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StrategyToolName } from "@sinergy/shared";
import { strategyToolDefinitions } from "@sinergy/shared";
import type { AgentArtifacts, AgentSessionSnapshot, AgentToolTraceEntry } from "../types.js";
import { buildFallbackPlannerPrompt } from "../prompts.js";

function extractJsonObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model did not return a JSON object.");
  }
  return JSON.parse(text.slice(start, end + 1)) as {
    type: "tool" | "final";
    tool?: StrategyToolName;
    input?: Record<string, unknown>;
    reason?: string;
    message?: string;
    artifacts?: AgentArtifacts;
  };
}

function extractTextContent(message: unknown) {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : ""
      )
      .join("");
  }
  return "";
}

export async function runFallbackJsonLoop(options: {
  model: BaseChatModel;
  goal: string;
  ownerAddress: string;
  marketId?: string;
  strategyId?: string;
  session?: AgentSessionSnapshot;
  maxSteps: number;
  trace: AgentToolTraceEntry[];
  invokeTool: (tool: StrategyToolName, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}) {
  const warnings: string[] = [];
  const toolsCatalog = strategyToolDefinitions.map((definition) => ({
    name: definition.name,
    description: definition.description
  }));
  let finalMessage = "";
  let artifacts: AgentArtifacts = {};
  let activeStrategyId = options.strategyId ?? options.session?.strategyId;
  let activeRunId = options.session?.runId;
  const repeatedCalls = new Map<string, number>();

  for (let index = 0; index < options.maxSteps; index += 1) {
    const prompt = buildFallbackPlannerPrompt({
      goal: options.goal,
      ownerAddress: options.ownerAddress,
      marketId: options.marketId,
      strategyId: activeStrategyId,
      runId: activeRunId,
      session: options.session,
      toolsCatalog,
      priorTrace: options.trace.map((entry) => ({
        tool: entry.tool,
        output: entry.output,
        error: entry.error
      })),
      maxStepsRemaining: options.maxSteps - index
    });

    const message = await options.model.invoke(prompt);
    const rawText = extractTextContent(message);
    let decision;
    try {
      decision = extractJsonObject(rawText);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    if (decision.type === "final") {
      finalMessage = decision.message ?? "Completed strategy task.";
      artifacts = decision.artifacts ?? artifacts;
      activeStrategyId = decision.artifacts?.strategyId ?? activeStrategyId;
      activeRunId = decision.artifacts?.runId ?? activeRunId;
      break;
    }

    if (!decision.tool || !strategyToolDefinitions.find((entry) => entry.name === decision.tool)) {
      warnings.push("Fallback planner proposed an unknown tool.");
      continue;
    }

    const toolInput = {
      ...(decision.input ?? {}),
      ownerAddress: options.ownerAddress,
      ...(options.marketId && decision.input?.marketId === undefined ? { marketId: options.marketId } : {}),
      ...(activeStrategyId && decision.input?.strategyId === undefined
        ? { strategyId: activeStrategyId }
        : {})
    };
    const repeatKey = `${decision.tool}:${JSON.stringify(toolInput)}`;
    const repeatCount = (repeatedCalls.get(repeatKey) ?? 0) + 1;
    repeatedCalls.set(repeatKey, repeatCount);
    if (repeatCount > 2) {
      warnings.push(`Aborted repeated tool call for ${decision.tool}.`);
      break;
    }

    const output = await options.invokeTool(decision.tool, toolInput);
    if (typeof output.strategy === "object" && output.strategy && "id" in output.strategy) {
      activeStrategyId = String((output.strategy as { id: string }).id);
      artifacts.strategyId = activeStrategyId;
    }
    if (typeof output.summary === "object" && output.summary && "runId" in output.summary) {
      activeRunId = String((output.summary as { runId: string }).runId);
      artifacts.runId = activeRunId;
      artifacts.summary = output.summary as Record<string, unknown>;
    }
    if (typeof output.validation === "object" && output.validation) {
      artifacts.validation = output.validation as Record<string, unknown>;
    }
  }

  if (!finalMessage) {
    finalMessage =
      artifacts.runId
        ? "Strategy task completed with a backtest run."
        : artifacts.strategyId
          ? "Strategy task completed up to draft/save stage."
          : "Strategy task ended without a complete result.";
  }

  return {
    finalMessage,
    artifacts,
    warnings
  };
}
