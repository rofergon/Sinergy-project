import type {
  HexString,
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyChartOverlay,
  StrategyToolName
} from "@sinergy/shared";

export type Token = {
  symbol: string;
  name: string;
  address: HexString;
  decimals: number;
  kind: "quote" | "rwa" | "crypto";
};

export type Market = {
  id: HexString;
  symbol: string;
  baseToken: Token;
  quoteToken: Token;
  referencePrice: string;
  series?: number[];
  routeable: boolean;
  routePolicy: "router-enabled" | "dark-pool-only";
};

export type MarketSnapshot = Market & {
  series: number[];
  changePct: number;
  trend: "up" | "down";
  volumeLabel: string;
};

export type StrategyBacktestBundle = {
  summary: StrategyBacktestSummary;
  trades: StrategyBacktestTrade[];
  overlay: StrategyChartOverlay;
};

export type StrategyAgentPlanResponse = {
  requestId: string;
  finalMessage: string;
  plannedTools: Array<{
    tool: StrategyToolName;
    why: string;
  }>;
  modelModeUsed: "native-tools" | "fallback-json";
  warnings: string[];
};

export type StrategyAgentToolTraceEntry = {
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

export type StrategyAgentRunResponse = {
  requestId: string;
  finalMessage: string;
  usedTools: StrategyToolName[];
  toolTrace: StrategyAgentToolTraceEntry[];
  artifacts: {
    strategyId?: string;
    runId?: string;
    summary?: Record<string, unknown>;
    validation?: Record<string, unknown>;
  };
  modelModeUsed: "native-tools" | "fallback-json";
  warnings: string[];
};
