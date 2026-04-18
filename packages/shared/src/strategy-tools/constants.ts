export const STRATEGY_TOOL_LIMITS = {
  maxNameLength: 80,
  minNameLength: 3,
  maxBarsPerBacktest: 200_000,
  defaultBacktestBars: 8_640,
  maxSerializedStrategyBytes: 100_000,
  requestsPerMinutePerOwnerPerTool: 60
} as const;
