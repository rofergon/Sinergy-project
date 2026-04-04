import { z } from "zod";
import type { StrategyStatus, StrategyTimeframe, StrategyToolName } from "@sinergy/shared";

export const agentStrategyRequestSchema = z.object({
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  goal: z.string().min(1),
  marketId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  preferredTimeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional(),
  strategyId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  mode: z.enum(["run", "plan"]).default("run")
});

export type AgentStrategyRequest = z.infer<typeof agentStrategyRequestSchema>;

export type AgentToolTraceEntry = {
  step: number;
  tool: StrategyToolName;
  input: Record<string, unknown>;
  reason?: string;
  expectedArtifact?: string;
  resultSummary?: string;
  progressObserved?: boolean;
  failureClass?: "invalid_input" | "tool_error" | "parse_error" | "stalled" | "policy_block" | "unknown";
  output?: Record<string, unknown>;
  error?: {
    code?: string;
    message: string;
  };
  startedAt: string;
  completedAt?: string;
};

export type AgentArtifacts = {
  strategyId?: string;
  strategy?: AgentStrategySummary;
  runId?: string;
  summary?: Record<string, unknown>;
  validation?: Record<string, unknown>;
};

export type AgentExecutionMetrics = {
  toolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  firstPassValidationSuccess: boolean;
  repairsAttempted: number;
  repairsSucceeded: number;
  loopsAborted: number;
  toolMisuseCount: number;
  stalledTurns: number;
  finalizationBlocks: number;
  enforcementTriggered: boolean;
  finalizationGuardrailsApplied: string[];
};

export type AgentStrategySummary = {
  id: string;
  name?: string;
  marketId?: string;
  timeframe?: StrategyTimeframe;
  status?: StrategyStatus;
  updatedAt?: string;
};

export type AgentSessionTurn = {
  id: string;
  role: "user" | "assistant";
  mode: "run" | "plan";
  text: string;
  createdAt: string;
  usedTools?: StrategyToolName[];
  warnings?: string[];
};

export type AgentSessionSnapshot = {
  sessionId: string;
  ownerAddress: string;
  marketId?: string;
  strategyId?: string;
  strategy?: AgentStrategySummary;
  runId?: string;
  lastRunMode?: "native-tools" | "fallback-json";
  metrics?: AgentExecutionMetrics;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  recentTurns: AgentSessionTurn[];
};

export type AgentSessionListItem = Omit<AgentSessionSnapshot, "recentTurns"> & {
  lastUserMessage?: string;
  lastAssistantMessage?: string;
};

export const agentSessionListQuerySchema = z.object({
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  marketId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  limit: z.coerce.number().int().positive().max(50).default(20)
});

export const agentSessionParamsSchema = z.object({
  sessionId: z.string().uuid()
});

export type AgentResponse = {
  requestId: string;
  finalMessage: string;
  usedTools: StrategyToolName[];
  toolTrace: AgentToolTraceEntry[];
  artifacts: AgentArtifacts;
  session: AgentSessionSnapshot;
  modelModeUsed: "native-tools" | "fallback-json";
  warnings: string[];
  metrics: AgentExecutionMetrics;
};

export type AgentPlanResponse = {
  requestId: string;
  finalMessage: string;
  plannedTools: Array<{
    tool: StrategyToolName;
    why: string;
  }>;
  session: AgentSessionSnapshot;
  modelModeUsed: "native-tools" | "fallback-json";
  warnings: string[];
};
