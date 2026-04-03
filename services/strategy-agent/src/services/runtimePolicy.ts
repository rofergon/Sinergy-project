import type { StrategyToolName } from "@sinergy/shared";
import type { AgentExecutionMetrics, AgentToolTraceEntry } from "../types.js";

export type AgentDecision = {
  goal_state: string;
  next_tool: StrategyToolName | "final";
  why: string;
  expected_artifact: string;
  stop_condition: string;
  input?: Record<string, unknown>;
  message?: string;
  artifacts?: {
    strategyId?: string;
    runId?: string;
  };
};

export function createEmptyMetrics(): AgentExecutionMetrics {
  return {
    toolCalls: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    firstPassValidationSuccess: false,
    repairsAttempted: 0,
    repairsSucceeded: 0,
    loopsAborted: 0,
    toolMisuseCount: 0,
    stalledTurns: 0,
    finalizationBlocks: 0,
    enforcementTriggered: false,
    finalizationGuardrailsApplied: []
  };
}

export function classifyTool(tool: StrategyToolName) {
  if (tool === "list_strategy_capabilities" || tool === "list_strategy_templates" || tool === "list_user_strategies" || tool === "get_strategy") {
    return "discovery";
  }
  if (tool === "validate_strategy_draft") {
    return "verification";
  }
  if (tool === "run_strategy_backtest" || tool === "get_backtest_summary" || tool === "get_backtest_trades" || tool === "get_backtest_chart_overlay") {
    return "terminal";
  }
  return "mutation";
}

export function summarizeToolProgress(entry: AgentToolTraceEntry) {
  if (entry.error) {
    return { progressObserved: false, resultSummary: entry.error.message };
  }

  const output = entry.output ?? {};
  if (entry.tool === "validate_strategy_draft" && typeof output.validation === "object" && output.validation) {
    const validation = output.validation as { ok?: boolean; issues?: unknown[] };
    return {
      progressObserved: validation.ok === true || Array.isArray(validation.issues),
      resultSummary: validation.ok ? "validation_ok" : `validation_issues:${validation.issues?.length ?? 0}`
    };
  }

  if (entry.tool === "run_strategy_backtest" && typeof output.summary === "object" && output.summary) {
    return { progressObserved: true, resultSummary: "backtest_completed" };
  }

  if (typeof output.strategy === "object" && output.strategy) {
    return { progressObserved: true, resultSummary: "strategy_materialized" };
  }

  if (typeof output.capabilities === "object" && output.capabilities) {
    return { progressObserved: true, resultSummary: "capabilities_loaded" };
  }

  if (typeof output.templates === "object" || typeof output.templates === "undefined") {
    return { progressObserved: true, resultSummary: "tool_completed" };
  }

  return { progressObserved: Object.keys(output).length > 0, resultSummary: Object.keys(output).length > 0 ? "tool_completed" : "no_output" };
}

export function hasSemanticStall(trace: AgentToolTraceEntry[], nextTool: StrategyToolName, nextInput: Record<string, unknown>) {
  const recent = trace
    .filter((entry) => entry.tool === nextTool)
    .slice(-2)
    .map((entry) => JSON.stringify({ tool: entry.tool, input: entry.input, progress: entry.progressObserved }));

  return recent.length >= 2 && recent.every((value) => value === JSON.stringify({ tool: nextTool, input: nextInput, progress: false }));
}

export function finalMessageMentionsRealArtifacts(message: string, trace: AgentToolTraceEntry[], strategyId?: string, runId?: string) {
  if (!message.trim()) return false;
  if (runId && message.includes(runId)) return true;
  if (strategyId && message.includes(strategyId)) return true;
  const hasBacktestTrace = trace.some((entry) => entry.tool === "run_strategy_backtest" && entry.output && !entry.error);
  return hasBacktestTrace ? /backtest|PnL|drawdown|profit factor|win rate|trade/i.test(message) : true;
}

export function finalizeMetrics(base: AgentExecutionMetrics, trace: AgentToolTraceEntry[]) {
  const toolCalls = trace.length;
  const successfulToolCalls = trace.filter((entry) => entry.output && !entry.error).length;
  const failedToolCalls = trace.filter((entry) => entry.error).length;
  const toolMisuseFromTrace = trace.filter((entry) => entry.failureClass === "invalid_input").length;
  const stalledTurnsFromTrace = trace.filter((entry) => entry.progressObserved === false).length;

  return {
    ...base,
    toolCalls: Math.max(base.toolCalls, toolCalls),
    successfulToolCalls: Math.max(base.successfulToolCalls, successfulToolCalls),
    failedToolCalls: Math.max(base.failedToolCalls, failedToolCalls),
    toolMisuseCount: Math.max(base.toolMisuseCount, toolMisuseFromTrace),
    stalledTurns: Math.max(base.stalledTurns, stalledTurnsFromTrace)
  };
}
