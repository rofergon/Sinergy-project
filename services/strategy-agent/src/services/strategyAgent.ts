import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import {
  createHttpStrategyToolTransport,
  strategyToolDefinitions,
  type HexString,
  type StrategyToolName,
  type StrategyDefinition
} from "@sinergy/shared";
import { STRATEGY_AGENT_SYSTEM_PROMPT, buildUserPrompt, buildValidationCorrectionPrompt } from "../prompts.js";
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
import { createEmptyMetrics, finalizeMetrics, finalMessageMentionsRealArtifacts, summarizeToolProgress } from "./runtimePolicy.js";
import { StrategyAgentSessionStore } from "./sessionStore.js";
import { attemptValidationRepair } from "./validationRepairLoop.js";

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

type CompletionEnforcementOptions = {
  ownerAddress: string;
  marketId?: string;
  goal: string;
  finalMessage: string;
  trace: AgentToolTraceEntry[];
  artifacts: AgentResponse["artifacts"];
  metrics: AgentResponse["metrics"];
  warnings: string[];
  matcherTransport: (tool: StrategyToolName, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  model?: ChatOpenAI;
  capabilities?: Record<string, unknown>;
};

async function llmCorrectionLoop(options: {
  model: ChatOpenAI;
  ownerAddress: string;
  strategyId: string;
  strategy: StrategyDefinition;
  issues: Array<{ path: string; code: string; message: string; suggestion?: string }>;
  maxAttempts: number;
  matcherTransport: (tool: StrategyToolName, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  trace: AgentToolTraceEntry[];
  warnings: string[];
  goal: string;
  marketId?: string;
  capabilities?: Record<string, unknown>;
}): Promise<{ validationOk: boolean; patchedStrategy: StrategyDefinition | null }> {
  const { model, ownerAddress, strategyId, matcherTransport, trace, warnings, goal, marketId, capabilities } = options;
  let currentStrategy = options.strategy;
  let currentIssues = options.issues;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    const prompt = buildValidationCorrectionPrompt({
      goal,
      ownerAddress,
      marketId,
      strategyId,
      strategy: currentStrategy as unknown as Record<string, unknown>,
      validationIssues: currentIssues,
      attemptNumber: attempt,
      maxAttempts: options.maxAttempts,
      capabilities
    });

    const correctionEntry: AgentToolTraceEntry = {
      step: trace.length + 1,
      tool: "validate_strategy_draft",
      input: { ownerAddress, strategyId, correctionAttempt: attempt, issues: currentIssues },
      reason: "Request LLM-guided repair plan for remaining validation issues",
      expectedArtifact: "corrected strategy payload",
      startedAt: new Date().toISOString(),
      error: undefined
    };
    correctionEntry.error = { message: `LLM correction attempt ${attempt}/${options.maxAttempts}` };
    trace.push(correctionEntry);

    try {
      const response = await model.invoke(prompt);
      const rawText = extractMessageText(response);
      let correctedStrategy: StrategyDefinition;

      try {
        const start = rawText.indexOf("{");
        const end = rawText.lastIndexOf("}");
        if (start === -1 || end === -1) throw new Error("No JSON found");
        const parsed = JSON.parse(rawText.slice(start, end + 1)) as { correctedStrategy?: Record<string, unknown> };
        if (!parsed.correctedStrategy) throw new Error("No correctedStrategy in response");
        correctedStrategy = parsed.correctedStrategy as unknown as StrategyDefinition;
      } catch {
        warnings.push(`LLM correction attempt ${attempt}: failed to parse response.`);
        correctionEntry.error = { message: `LLM correction attempt ${attempt}: failed to parse response` };
        correctionEntry.completedAt = new Date().toISOString();
        correctionEntry.failureClass = "parse_error";
        correctionEntry.progressObserved = false;
        correctionEntry.resultSummary = correctionEntry.error.message;
        continue;
      }

      const updateEntry: AgentToolTraceEntry = {
        step: trace.length + 1,
        tool: "update_strategy_draft",
        input: { ownerAddress, strategy: correctedStrategy },
        reason: "Apply LLM-proposed strategy corrections",
        expectedArtifact: "updated strategy draft",
        startedAt: new Date().toISOString()
      };
      trace.push(updateEntry);

      try {
        const updateOutput = await matcherTransport("update_strategy_draft", {
          ownerAddress: ownerAddress as HexString,
          strategy: correctedStrategy
        });
        updateEntry.output = updateOutput as Record<string, unknown>;
        updateEntry.completedAt = new Date().toISOString();
        Object.assign(updateEntry, summarizeToolProgress(updateEntry));

        if (typeof updateOutput.strategy === "object" && updateOutput.strategy && "id" in updateOutput.strategy) {
          currentStrategy = updateOutput.strategy as unknown as StrategyDefinition;
        }

        const revalidateEntry: AgentToolTraceEntry = {
          step: trace.length + 1,
          tool: "validate_strategy_draft",
          input: { ownerAddress, strategyId },
          reason: "Verify whether LLM corrections fixed validation issues",
          expectedArtifact: "validation result",
          startedAt: new Date().toISOString()
        };
        trace.push(revalidateEntry);

        try {
          const revalidateOutput = await matcherTransport("validate_strategy_draft", {
            ownerAddress: ownerAddress as HexString,
            strategyId
          });
          revalidateEntry.output = revalidateOutput as Record<string, unknown>;
          revalidateEntry.completedAt = new Date().toISOString();
          Object.assign(revalidateEntry, summarizeToolProgress(revalidateEntry));

          const revalidateValidation = revalidateOutput.validation as { ok?: boolean; issues?: Array<{ path: string; code: string; message: string; suggestion?: string }> } | undefined;
          if (revalidateValidation?.ok) {
            warnings.push(`LLM correction succeeded on attempt ${attempt}/${options.maxAttempts}.`);
            correctionEntry.error = undefined;
            correctionEntry.output = revalidateOutput.validation as Record<string, unknown>;
            correctionEntry.completedAt = new Date().toISOString();
            return { validationOk: true, patchedStrategy: currentStrategy };
          }

          currentIssues = revalidateValidation?.issues ?? [];
          warnings.push(`LLM correction attempt ${attempt}: ${currentIssues.length} issues remain.`);
          correctionEntry.error = { message: `LLM correction attempt ${attempt}: ${currentIssues.length} issues remain` };
          correctionEntry.completedAt = new Date().toISOString();
        } catch (error) {
          revalidateEntry.error = { message: error instanceof Error ? error.message : String(error) };
          revalidateEntry.completedAt = new Date().toISOString();
          revalidateEntry.failureClass = "tool_error";
          revalidateEntry.progressObserved = false;
          revalidateEntry.resultSummary = revalidateEntry.error.message;
          warnings.push(`Re-validation after LLM correction attempt ${attempt} failed: ${revalidateEntry.error.message}`);
          correctionEntry.completedAt = new Date().toISOString();
        }
      } catch (error) {
        updateEntry.error = { message: error instanceof Error ? error.message : String(error) };
        updateEntry.completedAt = new Date().toISOString();
        updateEntry.failureClass = "tool_error";
        updateEntry.progressObserved = false;
        updateEntry.resultSummary = updateEntry.error.message;
        warnings.push(`LLM correction attempt ${attempt} update failed: ${updateEntry.error.message}`);
        correctionEntry.completedAt = new Date().toISOString();
      }
    } catch (error) {
      warnings.push(`LLM correction attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
      correctionEntry.error = { message: `LLM correction attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}` };
      correctionEntry.completedAt = new Date().toISOString();
      correctionEntry.failureClass = "parse_error";
      correctionEntry.progressObserved = false;
      correctionEntry.resultSummary = correctionEntry.error.message;
    }
  }

  warnings.push(`LLM correction exhausted after ${options.maxAttempts} attempts. Strategy may not be valid.`);
  return { validationOk: false, patchedStrategy: currentStrategy };
}

async function enforceCompletion(options: CompletionEnforcementOptions): Promise<{
  finalMessage: string;
  artifacts: AgentResponse["artifacts"];
  metrics: AgentResponse["metrics"];
  warnings: string[];
  trace: AgentToolTraceEntry[];
  finalMessageAddition: string;
}> {
  const { ownerAddress, marketId, goal, trace, artifacts, metrics, warnings, matcherTransport, model, capabilities } = options;
  let finalMessageAddition = "";
  let finalMessage = options.finalMessage;
  let currentStrategyId = artifacts.strategyId;
  const goalMentionsBacktest = /backtest|test|evaluat/i.test(goal);

  if (!currentStrategyId) {
    warnings.push("No strategy was created by the agent. Cannot enforce completion.");
    metrics.enforcementTriggered = true;
    metrics.finalizationBlocks += 1;
    metrics.finalizationGuardrailsApplied.push("missing_strategy_artifact");
    return { finalMessage, artifacts, metrics, warnings, trace, finalMessageAddition };
  }

  // STEP 1: Ensure validation was run
  const backtestDone = trace.some(entry => entry.tool === "run_strategy_backtest" && entry.output && !entry.error);
  let validationOk = false;
  const lastValidationEntry = [...trace].reverse().find(entry => entry.tool === "validate_strategy_draft");

  if (!lastValidationEntry || !lastValidationEntry.output) {
    warnings.push("Agent did not validate the strategy. Running validation now.");
    metrics.enforcementTriggered = true;
    metrics.finalizationGuardrailsApplied.push("forced_validation");
    const entry: AgentToolTraceEntry = {
      step: trace.length + 1,
      tool: "validate_strategy_draft",
      input: { ownerAddress, strategyId: currentStrategyId },
      reason: "Enforce validation before finalization",
      expectedArtifact: "validation result",
      startedAt: new Date().toISOString()
    };
    trace.push(entry);
    try {
      const result = await matcherTransport("validate_strategy_draft", { ownerAddress: ownerAddress as HexString, strategyId: currentStrategyId });
      entry.output = result as Record<string, unknown>;
      entry.completedAt = new Date().toISOString();
      Object.assign(entry, summarizeToolProgress(entry));
      artifacts.validation = result.validation as Record<string, unknown>;
      validationOk = (result.validation as { ok?: boolean })?.ok ?? false;
    } catch (error) {
      entry.error = { message: error instanceof Error ? error.message : String(error) };
      entry.completedAt = new Date().toISOString();
      entry.failureClass = "tool_error";
      entry.progressObserved = false;
      entry.resultSummary = entry.error.message;
      warnings.push(`Validation failed: ${entry.error.message}`);
    }
  } else if (lastValidationEntry.output) {
    const validation = lastValidationEntry.output.validation as { ok?: boolean } | undefined;
    validationOk = validation?.ok ?? false;
  }

  // STEP 2: If validation failed, attempt auto-repair first
  if (!validationOk && currentStrategyId) {
    const failedValidationEntry = [...trace].reverse().find(entry =>
      entry.tool === "validate_strategy_draft" && entry.output && !(entry.output.validation as { ok?: boolean })?.ok
    );

    if (failedValidationEntry?.output) {
      const validation = failedValidationEntry.output.validation as { ok: boolean; issues: Array<{ path: string; code: string; message: string; suggestion?: string }> };
      const strategyEntry = [...trace].reverse().find(entry =>
        entry.tool === "update_strategy_draft" && entry.output && typeof entry.output.strategy === "object" && entry.output.strategy
      );
      const strategyData = strategyEntry?.output?.strategy as StrategyDefinition | undefined;

      if (strategyData && validation.issues.length > 0) {
        const repairResult = attemptValidationRepair(strategyData, validation, { ownerAddress, marketId });
        const fixableAttempts = repairResult.attempts.filter((a) => a.success);
        metrics.repairsAttempted += 1;

        if (fixableAttempts.length > 0) {
          warnings.push(`Auto-repaired ${fixableAttempts.length} of ${validation.issues.length} validation issues.`);
          metrics.enforcementTriggered = true;
          metrics.finalizationGuardrailsApplied.push("rule_based_repair");

          const updateEntry: AgentToolTraceEntry = {
            step: trace.length + 1,
            tool: "update_strategy_draft",
            input: { ownerAddress, strategy: repairResult.patchedStrategy },
            reason: "Apply rule-based repair before finalization",
            expectedArtifact: "updated strategy draft",
            startedAt: new Date().toISOString()
          };
          trace.push(updateEntry);
          try {
            const updateOutput = await matcherTransport("update_strategy_draft", {
              ownerAddress: ownerAddress as HexString,
              strategy: repairResult.patchedStrategy
            });
            updateEntry.output = updateOutput as Record<string, unknown>;
            updateEntry.completedAt = new Date().toISOString();
            Object.assign(updateEntry, summarizeToolProgress(updateEntry));

            if (typeof updateOutput.strategy === "object" && updateOutput.strategy && "id" in updateOutput.strategy) {
              currentStrategyId = String((updateOutput.strategy as { id: string }).id);
              artifacts.strategyId = currentStrategyId;
            }

            const revalidateEntry: AgentToolTraceEntry = {
              step: trace.length + 1,
              tool: "validate_strategy_draft",
              input: { ownerAddress, strategyId: currentStrategyId },
              reason: "Re-validate repaired strategy",
              expectedArtifact: "validation result",
              startedAt: new Date().toISOString()
            };
            trace.push(revalidateEntry);
            try {
              const revalidateOutput = await matcherTransport("validate_strategy_draft", {
                ownerAddress: ownerAddress as HexString,
                strategyId: currentStrategyId
              });
              revalidateEntry.output = revalidateOutput as Record<string, unknown>;
              revalidateEntry.completedAt = new Date().toISOString();
              Object.assign(revalidateEntry, summarizeToolProgress(revalidateEntry));

              const revalidateValidation = revalidateOutput.validation as { ok?: boolean; issues?: unknown[] } | undefined;
              if (revalidateValidation?.ok) {
                warnings.push("Auto-repair succeeded: strategy is now valid.");
                metrics.repairsSucceeded += 1;
                artifacts.validation = revalidateOutput.validation as Record<string, unknown>;
                validationOk = true;
              } else if (revalidateValidation) {
                const remaining = revalidateValidation.issues?.length ?? 0;
                warnings.push(`Auto-repair partial: ${fixableAttempts.length} fixed, ${remaining} remain. Starting LLM correction loop.`);

                const llmResult = await llmCorrectionLoop({
                  model: model!,
                  ownerAddress,
                  strategyId: currentStrategyId,
                  strategy: typeof revalidateOutput.strategy === "object" && revalidateOutput.strategy ? (revalidateOutput.strategy as StrategyDefinition) : repairResult.patchedStrategy,
                  issues: (revalidateValidation.issues ?? []) as Array<{ path: string; code: string; message: string; suggestion?: string }>,
                  maxAttempts: 3,
                  matcherTransport,
                  trace,
                  warnings,
                  goal,
                  marketId,
                  capabilities
                });

                if (llmResult.validationOk) {
                  validationOk = true;
                  artifacts.validation = { ok: true, issues: [] } as Record<string, unknown>;
                  metrics.repairsSucceeded += 1;
                }
              }
            } catch (error) {
              revalidateEntry.error = { message: error instanceof Error ? error.message : String(error) };
              revalidateEntry.completedAt = new Date().toISOString();
              revalidateEntry.failureClass = "tool_error";
              revalidateEntry.progressObserved = false;
              revalidateEntry.resultSummary = revalidateEntry.error.message;
              warnings.push(`Re-validation after auto-repair failed: ${revalidateEntry.error.message}`);
            }
          } catch (error) {
            updateEntry.error = { message: error instanceof Error ? error.message : String(error) };
            updateEntry.completedAt = new Date().toISOString();
            updateEntry.failureClass = "tool_error";
            updateEntry.progressObserved = false;
            updateEntry.resultSummary = updateEntry.error.message;
            warnings.push(`Auto-repair update_strategy_draft failed: ${updateEntry.error.message}`);
          }
        } else {
          warnings.push(`Auto-repair could not fix any of ${validation.issues.length} issues. Starting LLM correction loop.`);
          metrics.enforcementTriggered = true;
          metrics.finalizationGuardrailsApplied.push("llm_repair");

          if (model) {
            const llmResult = await llmCorrectionLoop({
              model,
              ownerAddress,
              strategyId: currentStrategyId,
              strategy: strategyData,
              issues: validation.issues,
              maxAttempts: 3,
              matcherTransport,
              trace,
              warnings,
              goal,
              marketId,
              capabilities
            });

            if (llmResult.validationOk) {
              validationOk = true;
              artifacts.validation = { ok: true, issues: [] } as Record<string, unknown>;
              metrics.repairsSucceeded += 1;
            }
          } else {
            warnings.push("No model available for LLM correction. Strategy may not be backtestable.");
          }
        }
      }
    }
  }

  // STEP 3: If backtest was requested but not done, run it now (only if validation passed)
  if (goalMentionsBacktest && !backtestDone && currentStrategyId) {
    if (validationOk) {
      warnings.push("Agent did not run backtest. Auto-executing backtest safety net.");
      metrics.enforcementTriggered = true;
      metrics.finalizationGuardrailsApplied.push("forced_backtest");
      const entry: AgentToolTraceEntry = {
        step: trace.length + 1,
        tool: "run_strategy_backtest",
        input: { ownerAddress, strategyId: currentStrategyId },
        reason: "Enforce requested backtest before finalization",
        expectedArtifact: "backtest summary",
        startedAt: new Date().toISOString()
      };
      trace.push(entry);
      try {
        const result = await matcherTransport("run_strategy_backtest", { ownerAddress: ownerAddress as HexString, strategyId: currentStrategyId });
        entry.output = result as Record<string, unknown>;
        entry.completedAt = new Date().toISOString();
        Object.assign(entry, summarizeToolProgress(entry));
        const newArtifacts = collectArtifactsFromTrace([entry], artifacts);
        Object.assign(artifacts, newArtifacts);
        finalMessageAddition = " (A backtest was automatically run to complete your request).";
      } catch (error) {
        entry.error = { message: error instanceof Error ? error.message : String(error) };
        entry.completedAt = new Date().toISOString();
        entry.failureClass = "tool_error";
        entry.progressObserved = false;
        entry.resultSummary = entry.error.message;
        warnings.push(`Auto-backtest failed: ${entry.error.message}`);
      }
    } else {
      warnings.push("Skipping backtest: strategy validation has not passed after all repair attempts.");
      metrics.finalizationBlocks += 1;
      metrics.finalizationGuardrailsApplied.push("blocked_backtest_on_invalid_strategy");
    }
  }

  if (!finalMessageMentionsRealArtifacts(finalMessage, trace, artifacts.strategyId, artifacts.runId)) {
    metrics.enforcementTriggered = true;
    metrics.finalizationBlocks += 1;
    metrics.finalizationGuardrailsApplied.push("artifact_grounding");
    finalMessage = [
      finalMessage.trim(),
      `Artifacts: strategyId=${artifacts.strategyId ?? "unknown"}, runId=${artifacts.runId ?? "not-run"}.`
    ]
      .filter(Boolean)
      .join(" ");
  }

  return { finalMessage, artifacts, metrics, warnings, trace, finalMessageAddition };
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

  async getDiagnostics(input: { ownerAddress: string; sessionId: string }) {
    const session = this.sessions.getSession(input.sessionId, input.ownerAddress);
    if (!session) {
      throw new Error("Session not found.");
    }

    return {
      sessionId: session.sessionId,
      lastRunMode: session.lastRunMode,
      metrics: session.metrics,
      comparisonHint:
        session.lastRunMode === "native-tools"
          ? "Compare this session against a fallback-json run of the same prompt to evaluate tool reliability drift."
          : "Compare this session against a native-tools run of the same prompt to evaluate orchestration drift."
    };
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
    let metrics = createEmptyMetrics();
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

          const capabilities = await this.matcherTransport("list_strategy_capabilities", {
            ownerAddress: activeInput.ownerAddress as HexString
          });
          const enforcement = await enforceCompletion({
            ownerAddress: activeInput.ownerAddress,
            marketId: activeInput.marketId,
            goal: activeInput.goal,
            finalMessage: nativeResult.finalMessage,
            trace,
            artifacts,
            metrics,
            warnings,
            matcherTransport: async (toolName, rawInput) => {
              return this.matcherTransport(toolName, rawInput as never) as Promise<Record<string, unknown>>;
            },
            model: this.model,
            capabilities: capabilities.capabilities as Record<string, unknown>
          });
          metrics = finalizeMetrics(enforcement.metrics, trace);
          artifacts = enforcement.artifacts;
          nativeResult.finalMessage = enforcement.finalMessage + enforcement.finalMessageAddition;

          this.sessions.applyArtifacts(session, artifacts);
          this.sessions.applyRunDiagnostics(session, { mode: "native-tools", metrics });
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
            warnings,
            metrics
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
      metrics,
      invokeTool: async (toolName, rawInput) => {
        return this.matcherTransport(toolName, rawInput as never) as Promise<Record<string, unknown>>;
      }
    });
    artifacts = collectArtifactsFromTrace(trace, fallbackResult.artifacts);

    const capabilities = await this.matcherTransport("list_strategy_capabilities", {
      ownerAddress: activeInput.ownerAddress as HexString
    });
    const enforcement = await enforceCompletion({
      ownerAddress: activeInput.ownerAddress,
      marketId: activeInput.marketId,
      goal: activeInput.goal,
      finalMessage: fallbackResult.finalMessage,
      trace,
      artifacts,
      metrics: fallbackResult.metrics,
      warnings,
      matcherTransport: async (toolName, rawInput) => {
        return this.matcherTransport(toolName, rawInput as never) as Promise<Record<string, unknown>>;
      },
      model: this.model,
      capabilities: capabilities.capabilities as Record<string, unknown>
    });
    metrics = finalizeMetrics(enforcement.metrics, trace);
    artifacts = enforcement.artifacts;
    fallbackResult.finalMessage = enforcement.finalMessage + enforcement.finalMessageAddition;

    this.sessions.applyArtifacts(session, artifacts);
    this.sessions.applyRunDiagnostics(session, { mode: "fallback-json", metrics });
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
      warnings,
      metrics
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
