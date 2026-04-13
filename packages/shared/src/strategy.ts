import type { StrategyCompilationPreview, StrategyEngineDefinition, StrategySourceType } from "./strategyEngine";

export const STRATEGY_API_VERSION = "1.0.0";
export const STRATEGY_SCHEMA_VERSION = "1.0.0";
export const STRATEGY_CAPABILITIES_VERSION = "1.0.0";

export type HexString = `0x${string}`;

export type StrategyTimeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type StrategyStatus = "draft" | "saved" | "archived";
export type StrategyEnabledSide = "long" | "short";
export type StrategyIdeaKind =
  | "ema"
  | "rsi-mean-reversion"
  | "range-breakout"
  | "bollinger-reversion";
export type StrategyMarketRegime = "trend" | "range" | "breakout_ready" | "high_noise";
export type StrategyTrendBias = "bullish" | "bearish" | "sideways";
export type StrategySideBias = "long_only" | "short_only" | "both";
export type StrategyRuleOperator =
  | ">"
  | ">="
  | "<"
  | "<="
  | "=="
  | "!="
  | "crosses_above"
  | "crosses_below";
export type StrategyPriceField =
  | "open"
  | "high"
  | "low"
  | "close"
  | "volume"
  | "hl2"
  | "hlc3"
  | "ohlc4";
export type StrategyIndicatorKind =
  | "sma"
  | "ema"
  | "rsi"
  | "macd"
  | "bollinger"
  | "atr"
  | "roc"
  | "stoch"
  | "vwap"
  | "rolling_high"
  | "rolling_low"
  | "candle_body_pct"
  | "candle_direction";
export type StrategyIndicatorOutput =
  | "value"
  | "line"
  | "signal"
  | "histogram"
  | "upper"
  | "middle"
  | "lower"
  | "k"
  | "d"
  | "direction";
export type StrategyExitReason =
  | "rule"
  | "reverse"
  | "stop_loss"
  | "take_profit"
  | "trailing_stop"
  | "max_bars";
export type StrategyMarkerPosition = "aboveBar" | "belowBar" | "inBar";
export type StrategyMarkerShape = "arrowUp" | "arrowDown" | "circle" | "square";
export type StrategyOverlaySeriesType = "line";
export type StrategyOverlayPane = "price" | "oscillator";
export type StrategyToolName =
  | "list_strategy_capabilities"
  | "analyze_market_context"
  | "compile_strategy_source"
  | "list_strategy_templates"
  | "create_strategy_draft"
  | "update_strategy_draft"
  | "validate_strategy_draft"
  | "run_strategy_backtest"
  | "get_backtest_summary"
  | "get_backtest_trades"
  | "get_backtest_chart_overlay"
  | "save_strategy"
  | "list_user_strategies"
  | "get_strategy"
  | "clone_strategy_template";

export type StrategyIndicatorParams = {
  period?: number;
  fastPeriod?: number;
  slowPeriod?: number;
  signalPeriod?: number;
  smoothK?: number;
  smoothD?: number;
  stdDev?: number;
  lookback?: number;
  source?: StrategyPriceField;
};

export type StrategyOperand =
  | {
      type: "price_field";
      field: StrategyPriceField;
      barsAgo?: number;
    }
  | {
      type: "indicator_output";
      indicator: StrategyIndicatorKind;
      output: StrategyIndicatorOutput;
      params?: StrategyIndicatorParams;
      barsAgo?: number;
    }
  | {
      type: "constant";
      value: number;
    };

export type StrategyRule = {
  id: string;
  left: StrategyOperand;
  operator: StrategyRuleOperator;
  right: StrategyOperand;
};

export type StrategyRuleGroup = {
  id: string;
  rules: StrategyRule[];
};

export type StrategyRuleSet = {
  long: StrategyRuleGroup[];
  short: StrategyRuleGroup[];
};

export type StrategySizing =
  | {
      mode: "percent_of_equity";
      value: number;
    }
  | {
      mode: "fixed_quote_notional";
      value: number;
    };

export type StrategyRiskRules = {
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  maxBarsInTrade?: number;
};

export type StrategyCostModel = {
  feeBps: number;
  slippageBps: number;
  startingEquity: number;
};

export type StrategyDefinition = {
  id: string;
  ownerAddress: HexString;
  name: string;
  marketId: HexString;
  timeframe: StrategyTimeframe;
  enabledSides: StrategyEnabledSide[];
  entryRules: StrategyRuleSet;
  exitRules: StrategyRuleSet;
  sizing: StrategySizing;
  riskRules: StrategyRiskRules;
  costModel: StrategyCostModel;
  status: StrategyStatus;
  engine?: StrategyEngineDefinition;
  schemaVersion: string;
  createdAt: string;
  updatedAt: string;
};

export type StrategyValidationIssue = {
  path: string;
  code: string;
  message: string;
  suggestion?: string;
};

export type StrategyValidationResult = {
  ok: boolean;
  issues: StrategyValidationIssue[];
};

export type StrategyBacktestTrade = {
  id: string;
  strategyId: string;
  runId: string;
  side: "long" | "short";
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  netPnl: number;
  feesPaid: number;
  slippagePaid: number;
  exitReason: StrategyExitReason;
  barsHeld: number;
};

export type StrategyEquityPoint = {
  time: number;
  equity: number;
};

export type StrategyBacktestSummary = {
  runId: string;
  strategyId: string;
  marketId: HexString;
  timeframe: StrategyTimeframe;
  candleCount: number;
  startingEquity: number;
  endingEquity: number;
  netPnl: number;
  netPnlPct: number;
  grossPnl: number;
  feesPaid: number;
  slippagePaid: number;
  winRate: number;
  maxDrawdownPct: number;
  profitFactor: number;
  tradeCount: number;
  longTradeCount: number;
  shortTradeCount: number;
  avgTradeNetPnl: number;
  avgWinningTradeNetPnl: number;
  avgLosingTradeNetPnl: number;
  avgBarsHeld: number;
  expectancy: number;
  exposurePct: number;
  createdAt: string;
  equityCurve: StrategyEquityPoint[];
};

export type StrategyOverlayPoint = {
  time: number;
  value: number;
};

export type StrategyOverlaySeries = {
  id: string;
  label: string;
  color: string;
  seriesType: StrategyOverlaySeriesType;
  pane: StrategyOverlayPane;
  values: StrategyOverlayPoint[];
};

export type StrategyOverlayMarker = {
  id: string;
  time: number;
  position: StrategyMarkerPosition;
  shape: StrategyMarkerShape;
  color: string;
  text?: string;
};

export type StrategyChartOverlay = {
  runId: string;
  strategyId: string;
  marketId: HexString;
  timeframe: StrategyTimeframe;
  indicators: StrategyOverlaySeries[];
  markers: StrategyOverlayMarker[];
};

export type StrategyTemplate = {
  id: string;
  name: string;
  description: string;
  strategy: StrategyDefinition;
};

export type StrategyCapabilities = {
  apiVersion: string;
  strategySchemaVersion: string;
  capabilitiesVersion: string;
  timeframes: StrategyTimeframe[];
  operators: StrategyRuleOperator[];
  priceFields: StrategyPriceField[];
  supportedSides: StrategyEnabledSide[];
  sourceLanguages: StrategySourceType[];
  sourceFeatures: string[];
  indicatorCatalog: Array<{
    kind: StrategyIndicatorKind;
    label: string;
    outputs: StrategyIndicatorOutput[];
    params: Array<{
      name: keyof StrategyIndicatorParams;
      label: string;
      type: "integer" | "number" | "source";
      required: boolean;
      defaultValue?: number;
      min?: number;
      max?: number;
      options?: StrategyPriceField[];
    }>;
  }>;
  sizingModes: Array<{
    mode: StrategySizing["mode"];
    label: string;
    defaultValue: number;
  }>;
  riskRules: Array<{
    key: keyof StrategyRiskRules;
    label: string;
    min?: number;
    max?: number;
  }>;
  defaults: {
    backtestBars: number;
    maxRuleGroupsPerSide: number;
    maxRulesPerGroup: number;
    maxIndicatorLookback: number;
  };
};

export type StrategySourceCompilation = {
  engine: StrategyEngineDefinition;
  preview: StrategyCompilationPreview;
};

export type StrategyMarketLevel = {
  kind: "support" | "resistance";
  price: number;
  distancePct: number;
  touches: number;
  strength: number;
  sourceTimeframe: StrategyTimeframe;
};

export type StrategyTimeframeAnalysis = {
  timeframe: StrategyTimeframe;
  candleCount: number;
  latestClose: number;
  atrPct: number;
  windowRangePct: number;
  trendBias: StrategyTrendBias;
  trendStrength: number;
  marketRegime: StrategyMarketRegime;
  nearestSupport?: number;
  nearestResistance?: number;
  breakoutRoomUpPct?: number;
  breakoutRoomDownPct?: number;
  suitabilityScore: number;
  emaSuggestion: {
    fastPeriod: number;
    slowPeriod: number;
    preferred: boolean;
    sideBias: StrategySideBias;
  };
  rationale: string;
};

export type StrategyMarketAnalysis = {
  marketId: HexString;
  generatedAt: string;
  latestPrice: number;
  overallRegime: StrategyMarketRegime;
  recommendedTimeframe: StrategyTimeframe;
  recommendedStrategyKinds: StrategyIdeaKind[];
  supportLevels: StrategyMarketLevel[];
  resistanceLevels: StrategyMarketLevel[];
  emaSuggestion: {
    timeframe: StrategyTimeframe;
    fastPeriod: number;
    slowPeriod: number;
    preferred: boolean;
    sideBias: StrategySideBias;
    rationale: string;
  };
  timeframes: StrategyTimeframeAnalysis[];
  summary: string;
};
