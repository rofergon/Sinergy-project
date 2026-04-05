import type {
  HexString,
  StrategyStatus,
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyChartOverlay,
  StrategyTimeframe,
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

export type ChartViewport = {
  bars: number;
  fromTs: number;
  toTs: number;
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
  session: StrategyAgentSessionSnapshot;
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
    strategy?: StrategyAgentStrategySummary;
    runId?: string;
    summary?: Record<string, unknown>;
    validation?: Record<string, unknown>;
  };
  session: StrategyAgentSessionSnapshot;
  modelModeUsed: "native-tools" | "fallback-json";
  warnings: string[];
};

export type StrategyAgentSessionSnapshot = {
  sessionId: string;
  ownerAddress: HexString;
  marketId?: HexString;
  strategyId?: string;
  strategy?: StrategyAgentStrategySummary;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  recentTurns: Array<{
    id: string;
    role: "user" | "assistant";
    mode: "run" | "plan";
    text: string;
    createdAt: string;
    usedTools?: StrategyToolName[];
    warnings?: string[];
  }>;
};

export type StrategyAgentStrategySummary = {
  id: string;
  name?: string;
  marketId?: HexString;
  timeframe?: StrategyTimeframe;
  status?: StrategyStatus;
  updatedAt?: string;
};

export type StrategyAgentSessionListItem = Omit<StrategyAgentSessionSnapshot, "recentTurns"> & {
  lastUserMessage?: string;
  lastAssistantMessage?: string;
};
