import { z } from "zod";
import type { StrategyToolName } from "@sinergy/shared";

export const agentStrategyRequestSchema = z.object({
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  goal: z.string().min(1),
  marketId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  strategyId: z.string().uuid().optional(),
  mode: z.enum(["run", "plan"]).default("run")
});

export type AgentStrategyRequest = z.infer<typeof agentStrategyRequestSchema>;

export type AgentToolTraceEntry = {
  step: number;
  tool: StrategyToolName;
  input: Record<string, unknown>;
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
  runId?: string;
  summary?: Record<string, unknown>;
  validation?: Record<string, unknown>;
};

export type AgentResponse = {
  requestId: string;
  finalMessage: string;
  usedTools: StrategyToolName[];
  toolTrace: AgentToolTraceEntry[];
  artifacts: AgentArtifacts;
  modelModeUsed: "native-tools" | "fallback-json";
  warnings: string[];
};

export type AgentPlanResponse = {
  requestId: string;
  finalMessage: string;
  plannedTools: Array<{
    tool: StrategyToolName;
    why: string;
  }>;
  modelModeUsed: "native-tools" | "fallback-json";
  warnings: string[];
};
