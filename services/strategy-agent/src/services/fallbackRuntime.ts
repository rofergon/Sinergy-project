import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StrategyToolName, StrategyDefinition } from "@sinergy/shared";
import type { AgentArtifacts, AgentExecutionMetrics, AgentSessionSnapshot, AgentToolTraceEntry } from "../types.js";
import { buildFallbackPlannerPrompt } from "../prompts.js";
import { createEmptyMetrics, hasSemanticStall, summarizeToolProgress, summarizeTraceEntryForPrompt, type AgentDecision } from "./runtimePolicy.js";
import { attemptValidationRepair } from "./validationRepairLoop.js";
import { mergeToolContext } from "./toolInputContext.js";
import { getAgentToolCatalog, isAgentToolAllowed } from "./agentToolPolicy.js";

function extractJsonObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model did not return a JSON object.");
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    type?: "tool" | "final";
    tool?: StrategyToolName;
    input?: Record<string, unknown>;
    reason?: string;
    message?: string;
    artifacts?: AgentArtifacts;
    goal_state?: string;
    expected_artifact?: string;
    stop_condition?: string;
  };

  if (parsed.type === "tool" && parsed.tool) {
    return {
      goal_state: parsed.goal_state ?? "advance workflow safely",
      next_tool: parsed.tool,
      why: parsed.reason ?? "not provided",
      expected_artifact: parsed.expected_artifact ?? "tool output",
      stop_condition: parsed.stop_condition ?? "tool returns successfully",
      input: parsed.input ?? {}
    } satisfies AgentDecision;
  }

  return {
    goal_state: parsed.goal_state ?? "complete response",
    next_tool: "final",
    why: parsed.reason ?? "finish execution",
    expected_artifact: parsed.expected_artifact ?? "final answer",
    stop_condition: parsed.stop_condition ?? "response returned",
    message: parsed.message ?? "Completed strategy task.",
    artifacts: parsed.artifacts
  } satisfies AgentDecision;
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
  preferredTimeframe?: string;
  chartBars?: number;
  strategyId?: string;
  session?: AgentSessionSnapshot;
  maxSteps: number;
  trace: AgentToolTraceEntry[];
  invokeTool: (tool: StrategyToolName, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  invokeText?: (prompt: string) => Promise<string>;
  onStatus?: (message: string) => void;
  onTool?: (event: { phase: "start" | "done" | "error"; tool: string; step?: number; message?: string }) => void;
  metrics?: AgentExecutionMetrics;
}) {
  const warnings: string[] = [];
  const metrics = options.metrics ?? createEmptyMetrics();
  const toolsCatalog = getAgentToolCatalog();
  let finalMessage = "";
  let artifacts: AgentArtifacts = {};
  let activeStrategyId = options.strategyId ?? options.session?.strategyId;
  let activeRunId = options.session?.runId;
  const repeatedCalls = new Map<string, number>();
  let lastValidationFailure: { output: Record<string, unknown>; strategy: StrategyDefinition } | null = null;
  let repairAttempts = 0;
  const maxRepairAttempts = 3;
  let remainingValidationIssues: Array<{ path: string; code: string; message: string; suggestion?: string }> = [];

  for (let index = 0; index < options.maxSteps; index += 1) {
    const summarizedTrace = options.trace
      .slice(-8)
      .map(summarizeTraceEntryForPrompt);

    const prompt = buildFallbackPlannerPrompt({
      goal: options.goal,
      ownerAddress: options.ownerAddress,
      marketId: options.marketId,
      preferredTimeframe: options.preferredTimeframe,
      chartBars: options.chartBars,
      strategyId: activeStrategyId,
      runId: activeRunId,
      session: options.session,
      toolsCatalog,
      priorTrace: summarizedTrace,
      maxStepsRemaining: options.maxSteps - index,
      remainingValidationIssues: remainingValidationIssues.length > 0 ? remainingValidationIssues : undefined
    });

    options.onStatus?.(`Reasoning step ${index + 1}/${options.maxSteps}...`);
    const rawText = options.invokeText
      ? await options.invokeText(prompt)
      : extractTextContent(await options.model.invoke(prompt));
    console.log(`[FALLBACK] Step ${index + 1}/${options.maxSteps} LLM response:`, rawText.slice(0, 500));
    let decision: AgentDecision;
    try {
      decision = extractJsonObject(rawText);
      console.log(`[FALLBACK] Step ${index + 1} decision: tool=${decision.next_tool}`);
    } catch (error) {
      console.log(`[FALLBACK] Step ${index + 1} parse error:`, error instanceof Error ? error.message : String(error));
      warnings.push(error instanceof Error ? error.message : String(error));
      metrics.stalledTurns += 1;
      continue;
    }

    if (decision.next_tool === "final") {
      finalMessage = decision.message ?? "Completed strategy task.";
      console.log(`[FALLBACK] Step ${index + 1} final: ${finalMessage}`);
      artifacts = decision.artifacts ?? artifacts;
      activeStrategyId = decision.artifacts?.strategyId ?? activeStrategyId;
      activeRunId = decision.artifacts?.runId ?? activeRunId;
      break;
    }

    if (!isAgentToolAllowed(decision.next_tool)) {
      console.log(`[FALLBACK] Step ${index + 1} blocked tool: ${decision.next_tool}`);
      warnings.push(`Fallback planner proposed blocked tool ${decision.next_tool}.`);
      metrics.toolMisuseCount += 1;
      continue;
    }

    if (!toolsCatalog.find((entry) => entry.name === decision.next_tool)) {
      console.log(`[FALLBACK] Step ${index + 1} unknown tool: ${decision.next_tool}`);
      warnings.push("Fallback planner proposed an unknown tool.");
      metrics.toolMisuseCount += 1;
      continue;
    }

    const toolInput = mergeToolContext(decision.next_tool, decision.input ?? {}, {
      ownerAddress: options.ownerAddress,
      marketId: options.marketId,
      strategyId: activeStrategyId,
      runId: activeRunId
    });
    console.log(`[FALLBACK] Step ${index + 1} invoking ${decision.next_tool} with input:`, JSON.stringify(toolInput).slice(0, 300));
    const repeatKey = `${decision.next_tool}:${JSON.stringify(toolInput)}`;
    const repeatCount = (repeatedCalls.get(repeatKey) ?? 0) + 1;
    repeatedCalls.set(repeatKey, repeatCount);
    if (repeatCount > 2 || hasSemanticStall(options.trace, decision.next_tool, toolInput)) {
      warnings.push(`Aborted repeated tool call for ${decision.next_tool}.`);
      metrics.loopsAborted += 1;
      metrics.stalledTurns += 1;
      break;
    }

    metrics.toolCalls += 1;
    const traceEntry: AgentToolTraceEntry = {
      step: options.trace.length + 1,
      tool: decision.next_tool,
      input: toolInput,
      reason: decision.why,
      expectedArtifact: decision.expected_artifact,
      startedAt: new Date().toISOString()
    };
    options.trace.push(traceEntry);
    options.onTool?.({
      phase: "start",
      tool: decision.next_tool,
      step: traceEntry.step,
      message: decision.why
    });

    try {
      const output = await options.invokeTool(decision.next_tool, toolInput);
      traceEntry.output = output;
      traceEntry.completedAt = new Date().toISOString();
      const progress = summarizeToolProgress(traceEntry);
      traceEntry.progressObserved = progress.progressObserved;
      traceEntry.resultSummary = progress.resultSummary;
      metrics.successfulToolCalls += 1;
      options.onTool?.({
        phase: "done",
        tool: decision.next_tool,
        step: traceEntry.step,
        message: progress.resultSummary
      });
      console.log(`[FALLBACK] Step ${index + 1} ${decision.next_tool} succeeded, output keys:`, Object.keys(output ?? {}));

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

        if (decision.next_tool === "validate_strategy_draft") {
          const validation = output.validation as { ok?: boolean };
          if (validation.ok && !metrics.firstPassValidationSuccess) {
            metrics.firstPassValidationSuccess = repairAttempts === 0;
          }
        }

        if (decision.next_tool === "validate_strategy_draft" && (output.validation as { ok?: boolean }).ok === false) {
          const strategyData = typeof output.strategy === "object" && output.strategy ? (output.strategy as StrategyDefinition) : null;
          if (strategyData) {
            lastValidationFailure = {
              output,
              strategy: strategyData
            };
          }
        }
      }
    } catch (error) {
      traceEntry.error = { message: error instanceof Error ? error.message : String(error) };
      traceEntry.completedAt = new Date().toISOString();
      traceEntry.failureClass = "tool_error";
      traceEntry.progressObserved = false;
      traceEntry.resultSummary = traceEntry.error.message;
      metrics.failedToolCalls += 1;
      options.onTool?.({
        phase: "error",
        tool: decision.next_tool,
        step: traceEntry.step,
        message: traceEntry.error.message
      });
      console.log(`[FALLBACK] Step ${index + 1} ${decision.next_tool} FAILED:`, error instanceof Error ? error.message : String(error));
      throw error;
    }

    if (decision.next_tool === "validate_strategy_draft" && lastValidationFailure && repairAttempts < maxRepairAttempts) {
      const validation = lastValidationFailure.output.validation as { ok: boolean; issues: Array<{ path: string; code: string; message: string; suggestion?: string }> };
      if (!validation.ok && validation.issues.length > 0) {
        const currentStrategy: StrategyDefinition = lastValidationFailure.strategy;
        if (currentStrategy) {
          const repairResult = attemptValidationRepair(currentStrategy, validation, {
            ownerAddress: options.ownerAddress,
            marketId: options.marketId
          });
          metrics.repairsAttempted += 1;

          if (repairResult.repaired) {
            warnings.push(`Auto-repaired ${repairResult.attempts.length} validation issue(s) after validate_strategy_draft.`);
            repairAttempts += 1;
            metrics.repairsSucceeded += 1;

            const step = options.trace.length + 1;
            const updateEntry: AgentToolTraceEntry = {
              step,
              tool: "update_strategy_draft",
              input: { ownerAddress: options.ownerAddress, strategy: repairResult.patchedStrategy },
              reason: "Apply rule-based validation repair",
              expectedArtifact: "updated strategy draft",
              startedAt: new Date().toISOString()
            };
            options.trace.push(updateEntry);

            try {
              const updateOutput = await options.invokeTool("update_strategy_draft", {
                ownerAddress: options.ownerAddress,
                strategy: repairResult.patchedStrategy
              });
              updateEntry.output = updateOutput as Record<string, unknown>;
              updateEntry.completedAt = new Date().toISOString();

              if (typeof updateOutput.strategy === "object" && updateOutput.strategy && "id" in updateOutput.strategy) {
                activeStrategyId = String((updateOutput.strategy as { id: string }).id);
                artifacts.strategyId = activeStrategyId;
              }

              const revalidateEntry: AgentToolTraceEntry = {
                step: options.trace.length + 1,
                tool: "validate_strategy_draft",
                input: { ownerAddress: options.ownerAddress, strategyId: activeStrategyId },
                startedAt: new Date().toISOString()
              };
              options.trace.push(revalidateEntry);

              try {
                const revalidateOutput = await options.invokeTool("validate_strategy_draft", {
                  ownerAddress: options.ownerAddress,
                  strategyId: activeStrategyId
                });
                revalidateEntry.output = revalidateOutput as Record<string, unknown>;
                revalidateEntry.completedAt = new Date().toISOString();

                if (typeof revalidateOutput.validation === "object" && revalidateOutput.validation) {
                  artifacts.validation = revalidateOutput.validation as Record<string, unknown>;
                  const revalidateValidation = revalidateOutput.validation as { ok?: boolean; issues?: unknown[] };

                  if (revalidateValidation.ok === true) {
                    warnings.push("Auto-repair succeeded: strategy is now valid.");
                    metrics.repairsSucceeded += 1;
                    lastValidationFailure = null;
                    remainingValidationIssues = [];
                  } else {
                    const remainingIssuesList = (revalidateValidation.issues ?? []) as Array<{ path: string; code: string; message: string; suggestion?: string }>;
                    const remainingIssues = remainingIssuesList.length;
                    warnings.push(`Auto-repair partial: ${repairResult.attempts.length} issues fixed, but ${remainingIssues} remain. Passing to LLM for correction.`);
                    lastValidationFailure = {
                      output: revalidateOutput as Record<string, unknown>,
                      strategy: typeof revalidateOutput.strategy === "object" && revalidateOutput.strategy ? (revalidateOutput.strategy as StrategyDefinition) : currentStrategy
                    };
                    remainingValidationIssues = remainingIssuesList;
                  }
                }
              } catch (error) {
                revalidateEntry.error = { message: error instanceof Error ? error.message : String(error) };
                revalidateEntry.completedAt = new Date().toISOString();
                warnings.push(`Re-validation after auto-repair failed: ${revalidateEntry.error.message}`);
              }
            } catch (error) {
              updateEntry.error = { message: error instanceof Error ? error.message : String(error) };
              updateEntry.completedAt = new Date().toISOString();
              warnings.push(`Auto-repair update_strategy_draft failed: ${updateEntry.error.message}`);
            }
            } else {
              const fixableAttempts = repairResult.attempts.filter((a) => a.success);
              const unfixableIssues = repairResult.attempts.filter((a) => !a.success);
              if (fixableAttempts.length > 0) {
                warnings.push(`Auto-repaired ${fixableAttempts.length} of ${validation.issues.length} issues. Remaining issues passed to LLM for correction.`);
                repairAttempts += 1;
                remainingValidationIssues = unfixableIssues.map((a) => {
                  const orig = validation.issues.find((i) => i.code === a.issueCode && i.path === a.path);
                  return orig ?? { path: a.path, code: a.issueCode, message: a.action };
                });

                const step = options.trace.length + 1;
                const updateEntry: AgentToolTraceEntry = {
                  step,
                  tool: "update_strategy_draft",
                  input: { ownerAddress: options.ownerAddress, strategy: repairResult.patchedStrategy },
                  startedAt: new Date().toISOString()
                };
                options.trace.push(updateEntry);

                try {
                  const updateOutput = await options.invokeTool("update_strategy_draft", {
                    ownerAddress: options.ownerAddress,
                    strategy: repairResult.patchedStrategy
                  });
                  updateEntry.output = updateOutput as Record<string, unknown>;
                  updateEntry.completedAt = new Date().toISOString();

                  if (typeof updateOutput.strategy === "object" && updateOutput.strategy && "id" in updateOutput.strategy) {
                    activeStrategyId = String((updateOutput.strategy as { id: string }).id);
                    artifacts.strategyId = activeStrategyId;
                  }
                } catch (error) {
                  updateEntry.error = { message: error instanceof Error ? error.message : String(error) };
                  updateEntry.completedAt = new Date().toISOString();
                  warnings.push(`Partial auto-repair update failed: ${updateEntry.error.message}`);
                }
              } else {
                warnings.push(`Auto-repair could not fix any of ${validation.issues.length} issues. Passing to LLM for correction.`);
                remainingValidationIssues = validation.issues;
              }
            }
        }
      }
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
    warnings,
    metrics
  };
}
