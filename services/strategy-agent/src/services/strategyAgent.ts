import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import {
  createHttpStrategyToolTransport,
  strategyToolDefinitions,
  type HexString,
  type StrategyToolName,
  type StrategyDefinition,
  type StrategyIdeaKind,
  type StrategyMarketAnalysis,
  type StrategySideBias
} from "@sinergy/shared";
import { STRATEGY_AGENT_SYSTEM_PROMPT, buildUserPrompt, buildValidationCorrectionPrompt, buildOptimizationPlanPrompt, buildCreationPlanPrompt } from "../prompts.js";
import type {
  AgentPlanResponse,
  AgentResponse,
  AgentStrategyRequest,
  AgentStrategySummary,
  AgentStreamEvent,
  AgentToolTraceEntry
} from "../types.js";
import { createTrackedStrategyLangChainTools } from "./matcherTools.js";
import { probeModel } from "./modelProbe.js";
import { runFallbackJsonLoop } from "./fallbackRuntime.js";
import { createEmptyMetrics, finalizeMetrics, finalMessageMentionsRealArtifacts, summarizeToolProgress } from "./runtimePolicy.js";
import { StrategyAgentSessionStore } from "./sessionStore.js";
import { attemptValidationRepair } from "./validationRepairLoop.js";

type BasicFastPathConfig = {
  kind: "ema" | "template";
  name: string;
  templateId?: "rsi-mean-reversion" | "range-breakout" | "bollinger-reversion";
};

type BasicStrategyKind = "ema" | "rsi-mean-reversion" | "range-breakout" | "bollinger-reversion";
type OptimizationCandidate = {
  label?: string;
  params?: Record<string, unknown>;
};
type CreationPlan = {
  analysis?: string;
  mode?: "clone_template" | "create_custom";
  templateId?: string;
  name?: string;
  strategyPatch?: Partial<StrategyDefinition>;
};

type AgentRunStreamCallbacks = {
  emit: (event: AgentStreamEvent) => void;
};

function defaultRiskRulesForTimeframe(timeframe: StrategyDefinition["timeframe"]) {
  switch (timeframe) {
    case "1m":
      return { stopLossPct: 0.8, takeProfitPct: 1.6, trailingStopPct: 0.5, maxBarsInTrade: 24 };
    case "5m":
      return { stopLossPct: 1.2, takeProfitPct: 2.4, trailingStopPct: 0.8, maxBarsInTrade: 30 };
    case "15m":
      return { stopLossPct: 2, takeProfitPct: 4, trailingStopPct: 1, maxBarsInTrade: 40 };
    case "1h":
      return { stopLossPct: 2.8, takeProfitPct: 5.6, trailingStopPct: 1.5, maxBarsInTrade: 28 };
    case "4h":
    case "1d":
      return { stopLossPct: 3.5, takeProfitPct: 7, trailingStopPct: 2, maxBarsInTrade: 20 };
  }
}

function buildTemporaryStrategy(input: {
  ownerAddress: HexString;
  marketId: HexString;
  name: string;
  timeframe: StrategyDefinition["timeframe"];
}) {
  return {
    id: "temp",
    ownerAddress: input.ownerAddress,
    marketId: input.marketId,
    name: input.name,
    timeframe: input.timeframe,
    enabledSides: ["long", "short"],
    entryRules: { long: [], short: [] } as StrategyDefinition["entryRules"],
    exitRules: { long: [], short: [] } as StrategyDefinition["exitRules"],
    sizing: { mode: "percent_of_equity", value: 25 },
    riskRules: defaultRiskRulesForTimeframe(input.timeframe),
    costModel: { feeBps: 10, slippageBps: 5, startingEquity: 10_000 },
    status: "draft",
    schemaVersion: "1.0.0",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  } satisfies StrategyDefinition;
}

function resolvePreferredTimeframe(
  preferredTimeframe?: StrategyDefinition["timeframe"],
  marketAnalysis?: StrategyMarketAnalysis
) {
  return preferredTimeframe ?? marketAnalysis?.recommendedTimeframe ?? "15m";
}

function resolveBacktestBars(input: { chartBars?: number }) {
  return typeof input.chartBars === "number" && input.chartBars > 0 ? input.chartBars : undefined;
}

function resolveChartRange(input: { chartFromTs?: number; chartToTs?: number }) {
  if (typeof input.chartFromTs === "number" && typeof input.chartToTs === "number" && input.chartFromTs <= input.chartToTs) {
    return {
      fromTs: input.chartFromTs,
      toTs: input.chartToTs
    };
  }
  return undefined;
}

function extractRequestedSideBias(goal: string): StrategySideBias | undefined {
  if (/(long only|only long|solo long|solo compras)/i.test(goal)) return "long_only";
  if (/(short only|only short|solo short|solo ventas)/i.test(goal)) return "short_only";
  if (/(long and short|both sides|ambos lados|long\/short|largos y cortos)/i.test(goal)) return "both";
  return undefined;
}

function extractRequestedStopLossPct(goal: string) {
  const match = goal.match(/(?:stop[\s-]?loss|sl)[^0-9]{0,12}(\d+(?:[.,]\d+)?)\s*%/i);
  if (!match) return undefined;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function goalRequestsNoStopLoss(goal: string) {
  return /(?:sin|no)\s+(?:stop[\s-]?loss|sl)|(?:stop[\s-]?loss|sl)\s+(?:off|none|ninguno)/i.test(goal);
}

function resolveRiskRulesForGoal(timeframe: StrategyDefinition["timeframe"], goal: string) {
  const defaults = defaultRiskRulesForTimeframe(timeframe);
  const requestedStopLossPct = extractRequestedStopLossPct(goal);

  if (requestedStopLossPct !== undefined) {
    return {
      ...defaults,
      stopLossPct: requestedStopLossPct
    };
  }

  if (goalRequestsNoStopLoss(goal)) {
    return {
      ...defaults,
      stopLossPct: undefined
    };
  }

  return defaults;
}

function goalRequestsBacktest(goal: string) {
  return /backtest|test|evaluat|probar|prueba|evaluar/i.test(goal);
}

function goalLooksLikeEmaCrossover(goal: string) {
  return /(ema).*(crossover|cross|cruce)|(crossover|cross|cruce).*(ema)/i.test(goal);
}

function goalLooksLikeRsiEmaHybrid(goal: string) {
  return /(rsi).*(ema)|(ema).*(rsi)|(rsi).*(filter|filtro|confirm|confirmacion|breakout|ruptura)|(breakout|ruptura).*(rsi)/i.test(goal);
}

function detectBasicFastPath(goal: string): BasicFastPathConfig | null {
  if (goalLooksLikeRsiEmaHybrid(goal)) {
    return null;
  }

  if (goalLooksLikeEmaCrossover(goal)) {
    return { kind: "ema", name: "EMA Crossover Strategy" };
  }

  if (/(rsi).*(mean reversion|reversion|revert|oversold|sobreventa)|(mean reversion|reversion|sobreventa).*(rsi)/i.test(goal)) {
    return {
      kind: "template",
      name: "RSI Mean Reversion",
      templateId: "rsi-mean-reversion"
    };
  }

  if (/(breakout|ruptura|range breakout|canal|rolling high|rolling low)/i.test(goal)) {
    return {
      kind: "template",
      name: "Range Breakout",
      templateId: "range-breakout"
    };
  }

  if (/(bollinger|banda).*(reversion|revert|mean reversion)|(reversion|mean reversion).*(bollinger|banda)/i.test(goal)) {
    return {
      kind: "template",
      name: "Bollinger Reversion",
      templateId: "bollinger-reversion"
    };
  }

  return null;
}

function goalLooksLikeOptimization(goal: string) {
  return /improve|optimi|positive pnl|positive|better pnl|make.*profit|mejor|optimiza|positivo|rentable/i.test(goal);
}

function goalLooksLikeFreshCreation(goal: string) {
  return /create|build|make|new strategy|from scratch|crea|construye|nueva estrategia/i.test(goal);
}

function goalLooksLikeAnalysisDrivenCreation(goal: string) {
  return /analy|analiza|analysis|support|resistance|soporte|resistencia|timeframe|periodicidad|periodicity/i.test(goal);
}

function classifyBasicStrategy(strategy: StrategyDefinition): BasicStrategyKind | null {
  const name = strategy.name.toLowerCase();

  if (name.includes("ema")) return "ema";
  if (name.includes("rsi")) return "rsi-mean-reversion";
  if (name.includes("breakout")) return "range-breakout";
  if (name.includes("bollinger")) return "bollinger-reversion";

  const firstLongEntry = strategy.entryRules.long[0]?.rules[0];
  if (
    firstLongEntry?.left.type === "indicator_output" &&
    firstLongEntry.left.indicator === "ema" &&
    firstLongEntry?.right.type === "indicator_output" &&
    firstLongEntry.right.indicator === "ema"
  ) {
    return "ema";
  }
  if (
    firstLongEntry?.left.type === "indicator_output" &&
    firstLongEntry.left.indicator === "rsi"
  ) {
    return "rsi-mean-reversion";
  }
  if (
    firstLongEntry?.right.type === "indicator_output" &&
    (firstLongEntry.right.indicator === "rolling_high" || firstLongEntry.right.indicator === "rolling_low")
  ) {
    return "range-breakout";
  }
  if (
    firstLongEntry?.right.type === "indicator_output" &&
    firstLongEntry.right.indicator === "bollinger"
  ) {
    return "bollinger-reversion";
  }

  return null;
}

function emaOperand(period: number): StrategyDefinition["entryRules"]["long"][number]["rules"][number]["left"] {
  return {
    type: "indicator_output",
    indicator: "ema",
    output: "value",
    params: { period }
  };
}

function rsiOperand(period: number): StrategyDefinition["entryRules"]["long"][number]["rules"][number]["left"] {
  return {
    type: "indicator_output",
    indicator: "rsi",
    output: "value",
    params: { period }
  };
}

function buildEmaCrossoverDraft(strategy: StrategyDefinition) {
  const strategyId = strategy.id;

  return {
    ...strategy,
    name: strategy.name && strategy.name !== "Strategy Draft" ? strategy.name : "EMA Crossover Strategy",
    timeframe: "15m",
    enabledSides: ["long", "short"],
    entryRules: {
      long: [
        {
          id: `${strategyId}-entry-long-1`,
          rules: [
            {
              id: `${strategyId}-entry-long-rule-1`,
              left: emaOperand(9),
              operator: "crosses_above",
              right: emaOperand(21)
            }
          ]
        }
      ],
      short: [
        {
          id: `${strategyId}-entry-short-1`,
          rules: [
            {
              id: `${strategyId}-entry-short-rule-1`,
              left: emaOperand(9),
              operator: "crosses_below",
              right: emaOperand(21)
            }
          ]
        }
      ]
    },
    exitRules: {
      long: [
        {
          id: `${strategyId}-exit-long-1`,
          rules: [
            {
              id: `${strategyId}-exit-long-rule-1`,
              left: emaOperand(9),
              operator: "crosses_below",
              right: emaOperand(21)
            }
          ]
        }
      ],
      short: [
        {
          id: `${strategyId}-exit-short-1`,
          rules: [
            {
              id: `${strategyId}-exit-short-rule-1`,
              left: emaOperand(9),
              operator: "crosses_above",
              right: emaOperand(21)
            }
          ]
        }
      ]
    },
    sizing: {
      mode: "percent_of_equity",
      value: 25
    },
    riskRules: {
      stopLossPct: 2,
      takeProfitPct: 4,
      trailingStopPct: 1,
      maxBarsInTrade: 40
    },
    costModel: {
      feeBps: 10,
      slippageBps: 5,
      startingEquity: 10_000
    }
  } satisfies StrategyDefinition;
}

function withStrategyName(strategy: StrategyDefinition, name: string) {
  return {
    ...strategy,
    name
  } satisfies StrategyDefinition;
}

function buildEmaVariant(strategy: StrategyDefinition, input: {
  fast: number;
  slow: number;
  timeframe?: StrategyDefinition["timeframe"];
  longOnly?: boolean;
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  maxBarsInTrade?: number;
}) {
  const base = buildEmaCrossoverDraft(strategy);
  const next = {
    ...base,
    timeframe: input.timeframe ?? base.timeframe,
    enabledSides: input.longOnly ? ["long"] : ["long", "short"],
    riskRules: {
      stopLossPct: input.stopLossPct ?? base.riskRules.stopLossPct,
      takeProfitPct: input.takeProfitPct ?? base.riskRules.takeProfitPct,
      trailingStopPct: input.trailingStopPct ?? base.riskRules.trailingStopPct,
      maxBarsInTrade: input.maxBarsInTrade ?? base.riskRules.maxBarsInTrade
    }
  } satisfies StrategyDefinition;

  next.entryRules.long[0].rules[0] = {
    ...next.entryRules.long[0].rules[0],
    left: emaOperand(input.fast),
    right: emaOperand(input.slow)
  };
  next.exitRules.long[0].rules[0] = {
    ...next.exitRules.long[0].rules[0],
    left: emaOperand(input.fast),
    right: emaOperand(input.slow)
  };

  if (input.longOnly) {
    next.entryRules.short = [];
    next.exitRules.short = [];
  } else {
    next.entryRules.short[0].rules[0] = {
      ...next.entryRules.short[0].rules[0],
      left: emaOperand(input.fast),
      right: emaOperand(input.slow)
    };
    next.exitRules.short[0].rules[0] = {
      ...next.exitRules.short[0].rules[0],
      left: emaOperand(input.fast),
      right: emaOperand(input.slow)
    };
  }

  return withStrategyName(next, `EMA Crossover ${input.fast}/${input.slow}${input.longOnly ? " Long Only" : ""}`);
}

function buildRsiVariant(strategy: StrategyDefinition, input: {
  timeframe?: StrategyDefinition["timeframe"];
  period: number;
  entry: number;
  exit: number;
  stopLossPct?: number;
  takeProfitPct?: number;
}) {
  const rule = strategy.entryRules.long[0]?.rules[0];
  const exitRule = strategy.exitRules.long[0]?.rules[0];
  if (!rule || !exitRule || rule.left.type !== "indicator_output" || exitRule.left.type !== "indicator_output") {
    return strategy;
  }

  return withStrategyName({
    ...strategy,
    timeframe: input.timeframe ?? strategy.timeframe,
    enabledSides: ["long"],
    entryRules: {
      long: [
        {
          ...strategy.entryRules.long[0],
          rules: [
            {
              ...rule,
              left: {
                ...rule.left,
                indicator: "rsi",
                output: "value",
                params: { period: input.period }
              },
              operator: "<=",
              right: { type: "constant", value: input.entry }
            }
          ]
        }
      ],
      short: []
    },
    exitRules: {
      long: [
        {
          ...strategy.exitRules.long[0],
          rules: [
            {
              ...exitRule,
              left: {
                ...exitRule.left,
                indicator: "rsi",
                output: "value",
                params: { period: input.period }
              },
              operator: ">=",
              right: { type: "constant", value: input.exit }
            }
          ]
        }
      ],
      short: []
    },
    riskRules: {
      ...strategy.riskRules,
      stopLossPct: input.stopLossPct ?? strategy.riskRules.stopLossPct,
      takeProfitPct: input.takeProfitPct ?? strategy.riskRules.takeProfitPct
    }
  }, `RSI Mean Reversion ${input.period}/${input.entry}-${input.exit}`);
}

function buildBreakoutVariant(strategy: StrategyDefinition, input: {
  timeframe?: StrategyDefinition["timeframe"];
  lookback: number;
  exitEma: number;
  stopLossPct?: number;
  takeProfitPct?: number;
}) {
  const longEntry = strategy.entryRules.long[0]?.rules[0];
  const shortEntry = strategy.entryRules.short[0]?.rules[0];
  const longExit = strategy.exitRules.long[0]?.rules[0];
  const shortExit = strategy.exitRules.short[0]?.rules[0];
  if (!longEntry || !shortEntry || !longExit || !shortExit) {
    return strategy;
  }

  return withStrategyName({
    ...strategy,
    timeframe: input.timeframe ?? strategy.timeframe,
    entryRules: {
      long: [
        {
          ...strategy.entryRules.long[0],
          rules: [
            {
              ...longEntry,
              right: { type: "indicator_output", indicator: "rolling_high", output: "value", params: { lookback: input.lookback } }
            }
          ]
        }
      ],
      short: [
        {
          ...strategy.entryRules.short[0],
          rules: [
            {
              ...shortEntry,
              right: { type: "indicator_output", indicator: "rolling_low", output: "value", params: { lookback: input.lookback } }
            }
          ]
        }
      ]
    },
    exitRules: {
      long: [
        {
          ...strategy.exitRules.long[0],
          rules: [
            {
              ...longExit,
              right: { type: "indicator_output", indicator: "ema", output: "value", params: { period: input.exitEma } }
            }
          ]
        }
      ],
      short: [
        {
          ...strategy.exitRules.short[0],
          rules: [
            {
              ...shortExit,
              right: { type: "indicator_output", indicator: "ema", output: "value", params: { period: input.exitEma } }
            }
          ]
        }
      ]
    },
    riskRules: {
      ...strategy.riskRules,
      stopLossPct: input.stopLossPct ?? strategy.riskRules.stopLossPct,
      takeProfitPct: input.takeProfitPct ?? strategy.riskRules.takeProfitPct
    }
  }, `Range Breakout ${input.lookback}/${input.exitEma}`);
}

function buildBollingerVariant(strategy: StrategyDefinition, input: {
  timeframe?: StrategyDefinition["timeframe"];
  period: number;
  stdDev: number;
  takeProfitPct?: number;
  stopLossPct?: number;
}) {
  const longEntry = strategy.entryRules.long[0]?.rules[0];
  const longExit = strategy.exitRules.long[0]?.rules[0];
  if (!longEntry || !longExit) {
    return strategy;
  }

  return withStrategyName({
    ...strategy,
    timeframe: input.timeframe ?? strategy.timeframe,
    enabledSides: ["long"],
    entryRules: {
      long: [
        {
          ...strategy.entryRules.long[0],
          rules: [
            {
              ...longEntry,
              right: { type: "indicator_output", indicator: "bollinger", output: "lower", params: { period: input.period, stdDev: input.stdDev } }
            }
          ]
        }
      ],
      short: []
    },
    exitRules: {
      long: [
        {
          ...strategy.exitRules.long[0],
          rules: [
            {
              ...longExit,
              right: { type: "indicator_output", indicator: "bollinger", output: "middle", params: { period: input.period, stdDev: input.stdDev } }
            }
          ]
        }
      ],
      short: []
    },
    riskRules: {
      ...strategy.riskRules,
      stopLossPct: input.stopLossPct ?? strategy.riskRules.stopLossPct,
      takeProfitPct: input.takeProfitPct ?? strategy.riskRules.takeProfitPct
    }
  }, `Bollinger Reversion ${input.period}/${input.stdDev}`);
}

function buildRsiEmaHybridDraft(strategy: StrategyDefinition, input: {
  timeframe?: StrategyDefinition["timeframe"];
  fast: number;
  slow: number;
  rsiPeriod: number;
  longRsiMin: number;
  shortRsiMax: number;
  longExitRsi: number;
  shortExitRsi: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  maxBarsInTrade?: number;
}) {
  const strategyId = strategy.id;

  return withStrategyName({
    ...strategy,
    timeframe: input.timeframe ?? strategy.timeframe,
    enabledSides: ["long", "short"],
    entryRules: {
      long: [
        {
          id: `${strategyId}-entry-long-1`,
          rules: [
            {
              id: `${strategyId}-entry-long-rule-1`,
              left: emaOperand(input.fast),
              operator: "crosses_above",
              right: emaOperand(input.slow)
            },
            {
              id: `${strategyId}-entry-long-rule-2`,
              left: rsiOperand(input.rsiPeriod),
              operator: ">=",
              right: { type: "constant", value: input.longRsiMin }
            }
          ]
        }
      ],
      short: [
        {
          id: `${strategyId}-entry-short-1`,
          rules: [
            {
              id: `${strategyId}-entry-short-rule-1`,
              left: emaOperand(input.fast),
              operator: "crosses_below",
              right: emaOperand(input.slow)
            },
            {
              id: `${strategyId}-entry-short-rule-2`,
              left: rsiOperand(input.rsiPeriod),
              operator: "<=",
              right: { type: "constant", value: input.shortRsiMax }
            }
          ]
        }
      ]
    },
    exitRules: {
      long: [
        {
          id: `${strategyId}-exit-long-1`,
          rules: [
            {
              id: `${strategyId}-exit-long-rule-1`,
              left: emaOperand(input.fast),
              operator: "crosses_below",
              right: emaOperand(input.slow)
            }
          ]
        },
        {
          id: `${strategyId}-exit-long-2`,
          rules: [
            {
              id: `${strategyId}-exit-long-rule-2`,
              left: rsiOperand(input.rsiPeriod),
              operator: "<=",
              right: { type: "constant", value: input.longExitRsi }
            }
          ]
        }
      ],
      short: [
        {
          id: `${strategyId}-exit-short-1`,
          rules: [
            {
              id: `${strategyId}-exit-short-rule-1`,
              left: emaOperand(input.fast),
              operator: "crosses_above",
              right: emaOperand(input.slow)
            }
          ]
        },
        {
          id: `${strategyId}-exit-short-2`,
          rules: [
            {
              id: `${strategyId}-exit-short-rule-2`,
              left: rsiOperand(input.rsiPeriod),
              operator: ">=",
              right: { type: "constant", value: input.shortExitRsi }
            }
          ]
        }
      ]
    },
    riskRules: {
      ...strategy.riskRules,
      stopLossPct: input.stopLossPct ?? strategy.riskRules.stopLossPct,
      takeProfitPct: input.takeProfitPct ?? strategy.riskRules.takeProfitPct,
      trailingStopPct: input.trailingStopPct ?? strategy.riskRules.trailingStopPct,
      maxBarsInTrade: input.maxBarsInTrade ?? strategy.riskRules.maxBarsInTrade
    }
  }, `RSI EMA Hybrid ${input.fast}/${input.slow} RSI${input.rsiPeriod}`);
}

function applyRequestedSidePreference(strategy: StrategyDefinition, goal: string) {
  const sideBias = extractRequestedSideBias(goal);
  if (sideBias === "long_only") {
    return {
      ...strategy,
      enabledSides: ["long"],
      entryRules: {
        ...strategy.entryRules,
        short: []
      },
      exitRules: {
        ...strategy.exitRules,
        short: []
      }
    } satisfies StrategyDefinition;
  }

  if (sideBias === "short_only") {
    return {
      ...strategy,
      enabledSides: ["short"],
      entryRules: {
        ...strategy.entryRules,
        long: []
      },
      exitRules: {
        ...strategy.exitRules,
        long: []
      }
    } satisfies StrategyDefinition;
  }

  return strategy;
}

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

type PromptStreamResult = {
  content: string;
  reasoning: string;
};

function consumeTaggedContentChunk(
  state: { mode: "content" | "thinking"; buffer: string },
  chunk: string,
  callbacks?: AgentRunStreamCallbacks
) {
  state.buffer += chunk;
  let contentDelta = "";
  let thinkingDelta = "";

  while (state.buffer.length > 0) {
    if (state.mode === "content") {
      const thinkIndex = state.buffer.indexOf("<think>");
      if (thinkIndex >= 0) {
        const before = state.buffer.slice(0, thinkIndex);
        if (before) {
          callbacks?.emit({ type: "content_delta", text: before });
          contentDelta += before;
        }
        state.buffer = state.buffer.slice(thinkIndex + "<think>".length);
        state.mode = "thinking";
        continue;
      }

      if (state.buffer.length > 16) {
        const safe = state.buffer.slice(0, -16);
        if (safe) {
          callbacks?.emit({ type: "content_delta", text: safe });
          contentDelta += safe;
        }
        state.buffer = state.buffer.slice(-16);
      }
      break;
    }

    const endThinkIndex = state.buffer.indexOf("</think>");
    if (endThinkIndex >= 0) {
      const thought = state.buffer.slice(0, endThinkIndex);
      if (thought) {
        callbacks?.emit({ type: "thinking_delta", text: thought });
        thinkingDelta += thought;
      }
      state.buffer = state.buffer.slice(endThinkIndex + "</think>".length);
      state.mode = "content";
      continue;
    }

    if (state.buffer.length > 16) {
      const safe = state.buffer.slice(0, -16);
      if (safe) {
        callbacks?.emit({ type: "thinking_delta", text: safe });
        thinkingDelta += safe;
      }
      state.buffer = state.buffer.slice(-16);
    }
    break;
  }

  return { contentDelta, thinkingDelta };
}

function parseOptimizationCandidates(text: string): OptimizationCandidate[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return [];
  const parsed = JSON.parse(text.slice(start, end + 1)) as { candidates?: OptimizationCandidate[] };
  return Array.isArray(parsed.candidates) ? parsed.candidates.slice(0, 3) : [];
}

function parseCreationPlan(text: string): CreationPlan | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  const parsed = JSON.parse(text.slice(start, end + 1)) as CreationPlan;
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.mode !== "clone_template" && parsed.mode !== "create_custom") return null;
  return parsed;
}

function isStrategyMarketAnalysis(value: unknown): value is StrategyMarketAnalysis {
  return Boolean(
    value &&
      typeof value === "object" &&
      "recommendedTimeframe" in value &&
      "recommendedStrategyKinds" in value &&
      "emaSuggestion" in value
  );
}

function chooseFallbackKind(goal: string, marketAnalysis?: StrategyMarketAnalysis): StrategyIdeaKind {
  if (goalLooksLikeRsiEmaHybrid(goal)) return "ema";
  if (goalLooksLikeEmaCrossover(goal)) return "ema";
  const explicit = detectBasicFastPath(goal);
  if (explicit?.kind === "template" && explicit.templateId) {
    return explicit.templateId;
  }
  return marketAnalysis?.recommendedStrategyKinds[0] ?? "ema";
}

function buildAnalysisGuidedCreationPlan(input: {
  goal: string;
  ownerAddress: HexString;
  marketId: HexString;
  preferredTimeframe?: StrategyDefinition["timeframe"];
  marketAnalysis?: StrategyMarketAnalysis;
}) {
  const timeframe = resolvePreferredTimeframe(input.preferredTimeframe, input.marketAnalysis);
  const sideBias = extractRequestedSideBias(input.goal) ?? "both";
  const riskRules = resolveRiskRulesForGoal(timeframe, input.goal);
  if (goalLooksLikeRsiEmaHybrid(input.goal)) {
    const suggestion = input.marketAnalysis?.emaSuggestion;
    const base = buildTemporaryStrategy({
      ownerAddress: input.ownerAddress,
      marketId: input.marketId,
      name: "RSI EMA Hybrid Strategy",
      timeframe
    });
    const draft = buildRsiEmaHybridDraft(base, {
      fast: suggestion?.fastPeriod ?? 9,
      slow: suggestion?.slowPeriod ?? 21,
      rsiPeriod: 14,
      longRsiMin: 55,
      shortRsiMax: 45,
      longExitRsi: 45,
      shortExitRsi: 55,
      timeframe,
      ...riskRules
    });

    return {
      mode: "create_custom" as const,
      name: draft.name,
      strategyPatch: applyRequestedSidePreference(draft, input.goal)
    };
  }

  const preferredKind = chooseFallbackKind(input.goal, input.marketAnalysis);

  if (preferredKind === "ema") {
    const suggestion = input.marketAnalysis?.emaSuggestion;
    const base = buildTemporaryStrategy({
      ownerAddress: input.ownerAddress,
      marketId: input.marketId,
      name: "EMA Market-Aware Strategy",
      timeframe
    });
    const draft = buildEmaVariant(base, {
      fast: suggestion?.fastPeriod ?? 9,
      slow: suggestion?.slowPeriod ?? 21,
      timeframe,
      longOnly: sideBias === "long_only",
      ...riskRules
    });

    if (sideBias === "short_only") {
      draft.enabledSides = ["short"];
      draft.entryRules.long = [];
      draft.exitRules.long = [];
    }

    return {
      mode: "create_custom" as const,
      name: draft.name,
      strategyPatch: draft
    };
  }

  const nameByKind: Record<Exclude<StrategyIdeaKind, "ema">, string> = {
    "rsi-mean-reversion": "RSI Mean Reversion",
    "range-breakout": "Range Breakout",
    "bollinger-reversion": "Bollinger Reversion"
  };

  return {
    mode: "clone_template" as const,
    templateId: preferredKind,
    name: nameByKind[preferredKind as Exclude<StrategyIdeaKind, "ema">],
    strategyPatch: {
      timeframe,
      riskRules,
      enabledSides:
        sideBias === "long_only"
          ? ["long"]
          : sideBias === "short_only"
            ? ["short"]
            : ["long", "short"]
    } satisfies Partial<StrategyDefinition>
  };
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
  chartBars?: number;
  chartFromTs?: number;
  chartToTs?: number;
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
  const { ownerAddress, marketId, chartBars, goal, trace, artifacts, metrics, warnings, matcherTransport, model, capabilities } = options;
  let finalMessageAddition = "";
  let finalMessage = options.finalMessage;
  let currentStrategyId = artifacts.strategyId;
  const goalMentionsBacktest = goalRequestsBacktest(goal);

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
                warnings.push(`Auto-repair partial: ${fixableAttempts.length} fixed, ${remaining} remain. Skipping extra LLM repair loop to keep the workflow fast.`);
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
          warnings.push(`Auto-repair could not fix any of ${validation.issues.length} issues. Skipping LLM repair loop to avoid long retries.`);
          metrics.enforcementTriggered = true;
          metrics.finalizationGuardrailsApplied.push("fast_fail_on_invalid_strategy");
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
        input: {
          ownerAddress,
          strategyId: currentStrategyId,
          ...(typeof chartBars === "number" && chartBars > 0 ? { bars: chartBars } : {}),
          ...(resolveChartRange(options) ?? {})
        },
        reason: "Enforce requested backtest before finalization",
        expectedArtifact: "backtest summary",
        startedAt: new Date().toISOString()
      };
      trace.push(entry);
      try {
        const result = await matcherTransport("run_strategy_backtest", {
          ownerAddress: ownerAddress as HexString,
          strategyId: currentStrategyId,
          ...(typeof chartBars === "number" && chartBars > 0 ? { bars: chartBars } : {}),
          ...(resolveChartRange(options) ?? {})
        });
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
  private readonly planningModel: ChatOpenAI;
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
    this.planningModel = new ChatOpenAI({
      model: options.modelName,
      apiKey: options.modelApiKey,
      configuration: {
        baseURL: options.modelBaseUrl
      },
      timeout: Math.min(options.modelTimeoutMs, 12_000),
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

  private async invokePlanningModel(prompt: string, stream?: AgentRunStreamCallbacks) {
    if (!stream) {
      return await this.planningModel.invoke(prompt);
    }

    const result = await this.invokePromptViaStreaming(prompt, {
      stream,
      statusLabel: "Thinking with model..."
    });
    return { content: result.content };
  }

  private async invokePromptViaStreaming(
    prompt: string,
    options: {
      stream: AgentRunStreamCallbacks;
      statusLabel?: string;
      maxTokens?: number;
    }
  ): Promise<PromptStreamResult> {
    const normalizedBase = this.options.modelBaseUrl.replace(/\/+$/, "");
    const url = `${normalizedBase}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.modelApiKey}`
      },
      body: JSON.stringify({
        model: this.options.modelName,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: options.maxTokens ?? 2048,
        stream: true
      })
    });

    if (!response.ok || !response.body) {
      throw new Error(`Model streaming request failed with HTTP ${response.status}`);
    }

    options.stream.emit({
      type: "status",
      message: options.statusLabel ?? "Waiting for model..."
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let finalContent = "";
    let finalReasoning = "";
    const tagState: { mode: "content" | "thinking"; buffer: string } = {
      mode: "content",
      buffer: ""
    };

    const flushTaggedBuffer = () => {
      if (!tagState.buffer) return;
      if (tagState.mode === "thinking") {
        options.stream.emit({ type: "thinking_delta", text: tagState.buffer });
        finalReasoning += tagState.buffer;
      } else {
        options.stream.emit({ type: "content_delta", text: tagState.buffer });
        finalContent += tagState.buffer;
      }
      tagState.buffer = "";
    };

    while (true) {
      const { done, value } = await reader.read();
      sseBuffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      let boundaryIndex = sseBuffer.indexOf("\n\n");
      while (boundaryIndex >= 0) {
        const rawEvent = sseBuffer.slice(0, boundaryIndex);
        sseBuffer = sseBuffer.slice(boundaryIndex + 2);

        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");

        if (!data || data === "[DONE]") {
          boundaryIndex = sseBuffer.indexOf("\n\n");
          continue;
        }

        try {
          const payload = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string | null;
                reasoning_content?: string | null;
              };
              message?: {
                content?: string | null;
                reasoning_content?: string | null;
              };
            }>;
          };
          const choice = payload.choices?.[0];
          const delta = choice?.delta ?? choice?.message;
          const reasoningChunk = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
          const contentChunk = typeof delta?.content === "string" ? delta.content : "";

          if (reasoningChunk) {
            finalReasoning += reasoningChunk;
            options.stream.emit({ type: "thinking_delta", text: reasoningChunk });
          }

          if (contentChunk) {
            if (reasoningChunk) {
              finalContent += contentChunk;
              options.stream.emit({ type: "content_delta", text: contentChunk });
            } else {
              const tagged = consumeTaggedContentChunk(tagState, contentChunk, options.stream);
              finalContent += tagged.contentDelta;
              finalReasoning += tagged.thinkingDelta;
            }
          }
        } catch {
          // Ignore malformed non-JSON keepalive chunks.
        }

        boundaryIndex = sseBuffer.indexOf("\n\n");
      }

      if (done) {
        break;
      }
    }

    flushTaggedBuffer();

    return {
      content: finalContent,
      reasoning: finalReasoning
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
  preferredTimeframe: input.preferredTimeframe,
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

  async run(input: AgentStrategyRequest, stream?: AgentRunStreamCallbacks): Promise<AgentResponse> {
    const requestId = crypto.randomUUID();
    const trace: AgentToolTraceEntry[] = [];
    const warnings: string[] = [];
    let artifacts: AgentResponse["artifacts"] = {};
    let metrics = createEmptyMetrics();
    const session = this.sessions.getOrCreate(input);
    stream?.emit({ type: "status", message: "Starting agent workflow..." });
    this.sessions.addTurn(session, {
      role: "user",
      mode: "run",
      text: input.goal
    });
    const sessionSnapshot = this.sessions.snapshot(session);
    const preferFreshCreation = goalLooksLikeFreshCreation(input.goal) && !goalLooksLikeOptimization(input.goal);
    const preferAnalysisDrivenCreation =
      !goalLooksLikeOptimization(input.goal) &&
      goalLooksLikeAnalysisDrivenCreation(input.goal);
    const activeInput = {
      ...input,
      strategyId:
        preferFreshCreation || preferAnalysisDrivenCreation
          ? input.strategyId
          : (input.strategyId ?? sessionSnapshot.strategyId)
    };

    const fastPathResult = await this.tryRunFastPath(activeInput, trace, warnings, metrics, stream);
    if (fastPathResult) {
      artifacts = collectArtifactsFromTrace(trace, fastPathResult.artifacts);
      metrics = finalizeMetrics(metrics, trace);

      this.sessions.applyArtifacts(session, artifacts);
      this.sessions.applyRunDiagnostics(session, { mode: "fallback-json", metrics });
      this.sessions.appendTrace(session, trace);
      this.sessions.addTurn(session, {
        role: "assistant",
        mode: "run",
        text: fastPathResult.finalMessage,
        usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
        warnings
      });

      return {
        requestId,
        finalMessage: fastPathResult.finalMessage,
        usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
        toolTrace: trace,
        artifacts,
        session: this.sessions.snapshot(session),
        modelModeUsed: "fallback-json",
        warnings,
        metrics
      };
    }

    const optimizationFastPathResult = await this.tryRunOptimizationFastPath(activeInput, trace, warnings, metrics, stream);
    if (optimizationFastPathResult) {
      artifacts = collectArtifactsFromTrace(trace, optimizationFastPathResult.artifacts);
      metrics = finalizeMetrics(metrics, trace);

      this.sessions.applyArtifacts(session, artifacts);
      this.sessions.applyRunDiagnostics(session, { mode: "fallback-json", metrics });
      this.sessions.appendTrace(session, trace);
      this.sessions.addTurn(session, {
        role: "assistant",
        mode: "run",
        text: optimizationFastPathResult.finalMessage,
        usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
        warnings
      });

      return {
        requestId,
        finalMessage: optimizationFastPathResult.finalMessage,
        usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
        toolTrace: trace,
        artifacts,
        session: this.sessions.snapshot(session),
        modelModeUsed: "fallback-json",
        warnings,
        metrics
      };
    }

    if (!stream && !this.options.forceFallbackJson) {
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
            chartBars: activeInput.chartBars,
            chartFromTs: activeInput.chartFromTs,
            chartToTs: activeInput.chartToTs,
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

    let fallbackResult: Awaited<ReturnType<typeof runFallbackJsonLoop>>;
    try {
      fallbackResult = await runFallbackJsonLoop({
        model: this.model,
      goal: activeInput.goal,
      ownerAddress: activeInput.ownerAddress,
      marketId: activeInput.marketId,
      preferredTimeframe: activeInput.preferredTimeframe,
      chartBars: activeInput.chartBars,
      strategyId: activeInput.strategyId,
      session: sessionSnapshot,
        maxSteps: this.options.maxSteps,
        trace,
        metrics,
        invokeText: stream
          ? async (prompt) => {
              const result = await this.invokePromptViaStreaming(prompt, {
                stream,
                statusLabel: "Reasoning with model..."
              });
              return result.content;
            }
          : undefined,
        onStatus: stream ? (message) => stream.emit({ type: "status", message }) : undefined,
        onTool: stream
          ? (event) =>
              stream.emit({
                type: "tool",
                phase: event.phase,
                tool: event.tool,
                step: event.step,
                message: event.message
              })
          : undefined,
        invokeTool: async (toolName, rawInput) => {
          return this.matcherTransport(toolName, rawInput as never) as Promise<Record<string, unknown>>;
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Fallback planner failed: ${message}`);

      const emergencyFastPath = await this.tryRunFastPath(
        {
          ...activeInput,
          strategyId: input.strategyId
        },
        trace,
        warnings,
        metrics
      );

      if (emergencyFastPath) {
        artifacts = collectArtifactsFromTrace(trace, emergencyFastPath.artifacts);
        metrics = finalizeMetrics(metrics, trace);

        this.sessions.applyArtifacts(session, artifacts);
        this.sessions.applyRunDiagnostics(session, { mode: "fallback-json", metrics });
        this.sessions.appendTrace(session, trace);
        this.sessions.addTurn(session, {
          role: "assistant",
          mode: "run",
          text: emergencyFastPath.finalMessage,
          usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
          warnings
        });

        return {
          requestId,
          finalMessage: emergencyFastPath.finalMessage,
          usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
          toolTrace: trace,
          artifacts,
          session: this.sessions.snapshot(session),
          modelModeUsed: "fallback-json",
          warnings,
          metrics
        };
      }

      const finalMessage =
        "The planning model timed out before the agent could finish. Retrying should work, but if this keeps happening lower the model timeout pressure or start a fresh strategy request.";
      metrics = finalizeMetrics(metrics, trace);
      this.sessions.applyArtifacts(session, artifacts);
      this.sessions.applyRunDiagnostics(session, { mode: "fallback-json", metrics });
      this.sessions.appendTrace(session, trace);
      this.sessions.addTurn(session, {
        role: "assistant",
        mode: "run",
        text: finalMessage,
        usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
        warnings
      });

      return {
        requestId,
        finalMessage,
        usedTools: Array.from(new Set(trace.map((entry) => entry.tool))),
        toolTrace: trace,
        artifacts,
        session: this.sessions.snapshot(session),
        modelModeUsed: "fallback-json",
        warnings,
        metrics
      };
    }
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

  private async tryRunFastPath(
    input: AgentStrategyRequest,
    trace: AgentToolTraceEntry[],
    warnings: string[],
    metrics: AgentResponse["metrics"],
    stream?: AgentRunStreamCallbacks
  ): Promise<{ finalMessage: string; artifacts: AgentResponse["artifacts"] } | null> {
    if (!input.marketId || (input.strategyId && !goalLooksLikeFreshCreation(input.goal))) {
      return null;
    }

    warnings.push("Used model-guided creation fast path.");
    metrics.enforcementTriggered = true;
    metrics.finalizationGuardrailsApplied.push("model_creation_fast_path");

    const capabilitiesEntry: AgentToolTraceEntry = {
      step: trace.length + 1,
      tool: "list_strategy_capabilities",
      input: { ownerAddress: input.ownerAddress },
      reason: "Creation fast path: inspect available strategy capabilities first",
      expectedArtifact: "capabilities",
      startedAt: new Date().toISOString()
    };
    trace.push(capabilitiesEntry);

    const capabilitiesResult = await this.matcherTransport("list_strategy_capabilities", {
      ownerAddress: input.ownerAddress as HexString
    });
    capabilitiesEntry.output = capabilitiesResult as Record<string, unknown>;
    capabilitiesEntry.completedAt = new Date().toISOString();
    Object.assign(capabilitiesEntry, summarizeToolProgress(capabilitiesEntry));

    let marketAnalysis: StrategyMarketAnalysis | undefined;
    const marketAnalysisEntry: AgentToolTraceEntry = {
      step: trace.length + 1,
      tool: "analyze_market_context",
      input: {
        ownerAddress: input.ownerAddress,
        marketId: input.marketId,
        ...(resolveBacktestBars(input) ? { bars: resolveBacktestBars(input) } : {}),
        ...(resolveChartRange(input) ?? {})
      },
      reason: "Creation fast path: inspect supports, resistances, regime, and timeframe before drafting",
      expectedArtifact: "market analysis",
      startedAt: new Date().toISOString()
    };
    trace.push(marketAnalysisEntry);

    try {
      const marketAnalysisResult = await this.matcherTransport("analyze_market_context", {
        ownerAddress: input.ownerAddress as HexString,
        marketId: input.marketId as HexString,
        ...(resolveBacktestBars(input) ? { bars: resolveBacktestBars(input) } : {}),
        ...(resolveChartRange(input) ?? {})
      });
      marketAnalysisEntry.output = marketAnalysisResult as Record<string, unknown>;
      marketAnalysisEntry.completedAt = new Date().toISOString();
      Object.assign(marketAnalysisEntry, summarizeToolProgress(marketAnalysisEntry));
      marketAnalysis = isStrategyMarketAnalysis(marketAnalysisResult.analysis)
        ? marketAnalysisResult.analysis
        : undefined;
    } catch (error) {
      marketAnalysisEntry.error = { message: error instanceof Error ? error.message : String(error) };
      marketAnalysisEntry.completedAt = new Date().toISOString();
      marketAnalysisEntry.failureClass = "tool_error";
      marketAnalysisEntry.progressObserved = false;
      marketAnalysisEntry.resultSummary = marketAnalysisEntry.error.message;
      warnings.push(`Market analysis failed during creation fast path: ${marketAnalysisEntry.error.message}`);
    }

    const templatesEntry: AgentToolTraceEntry = {
      step: trace.length + 1,
      tool: "list_strategy_templates",
      input: { ownerAddress: input.ownerAddress, marketId: input.marketId },
      reason: "Creation fast path: inspect built-in templates before drafting",
      expectedArtifact: "template candidates",
      startedAt: new Date().toISOString()
    };
    trace.push(templatesEntry);

    const templatesResult = await this.matcherTransport("list_strategy_templates", {
      ownerAddress: input.ownerAddress as HexString,
      marketId: input.marketId as HexString
    });
    templatesEntry.output = templatesResult as Record<string, unknown>;
    templatesEntry.completedAt = new Date().toISOString();
    Object.assign(templatesEntry, summarizeToolProgress(templatesEntry));

    let creationPlan: CreationPlan | null = null;
    try {
      const creationPrompt = buildCreationPlanPrompt({
        goal: input.goal,
        capabilities: capabilitiesResult.capabilities as Record<string, unknown>,
        preferredTimeframe: input.preferredTimeframe,
        marketAnalysis: marketAnalysis as unknown as Record<string, unknown> | undefined,
        templates: Array.isArray(templatesResult.templates)
          ? templatesResult.templates.map((template) => ({
              id: typeof template?.id === "string" ? template.id : undefined,
              name: typeof template?.name === "string" ? template.name : undefined,
              description: typeof template?.description === "string" ? template.description : undefined
            }))
          : []
      });
      const response = await this.invokePlanningModel(creationPrompt, stream);
      creationPlan = parseCreationPlan(extractMessageText(response));
    } catch (error) {
      warnings.push(`Model-guided creation planning failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!creationPlan) {
      warnings.push("Creation planner did not return a usable plan. Falling back to market-aware deterministic guidance.");
      creationPlan = buildAnalysisGuidedCreationPlan({
        goal: input.goal,
        ownerAddress: input.ownerAddress as HexString,
        marketId: input.marketId as HexString,
        preferredTimeframe: input.preferredTimeframe,
        marketAnalysis
      });
    }

    let activeStrategy: StrategyDefinition;

    if (creationPlan.mode === "clone_template" && creationPlan.templateId) {
      const cloneEntry: AgentToolTraceEntry = {
        step: trace.length + 1,
        tool: "clone_strategy_template",
        input: {
          ownerAddress: input.ownerAddress,
          marketId: input.marketId,
          templateId: creationPlan.templateId
        },
        reason: "Creation fast path: clone the template selected by the model",
        expectedArtifact: "strategy draft",
        startedAt: new Date().toISOString()
      };
      trace.push(cloneEntry);

      const cloned = await this.matcherTransport("clone_strategy_template", {
        ownerAddress: input.ownerAddress as HexString,
        marketId: input.marketId as HexString,
        templateId: creationPlan.templateId
      });
      cloneEntry.output = cloned as Record<string, unknown>;
      cloneEntry.completedAt = new Date().toISOString();
      Object.assign(cloneEntry, summarizeToolProgress(cloneEntry));

      if (!cloned.strategy || typeof cloned.strategy !== "object") {
        return null;
      }
      activeStrategy = cloned.strategy as StrategyDefinition;
    } else {
      const createEntry: AgentToolTraceEntry = {
        step: trace.length + 1,
        tool: "create_strategy_draft",
        input: {
          ownerAddress: input.ownerAddress,
          marketId: input.marketId,
          name: creationPlan.name ?? "Strategy Draft"
        },
        reason: "Creation fast path: create a custom draft selected by the model",
        expectedArtifact: "strategy draft",
        startedAt: new Date().toISOString()
      };
      trace.push(createEntry);

      const created = await this.matcherTransport("create_strategy_draft", {
        ownerAddress: input.ownerAddress as HexString,
        marketId: input.marketId as HexString,
        name: creationPlan.name ?? "Strategy Draft"
      });
      createEntry.output = created as Record<string, unknown>;
      createEntry.completedAt = new Date().toISOString();
      Object.assign(createEntry, summarizeToolProgress(createEntry));

      if (!created.strategy || typeof created.strategy !== "object") {
        return null;
      }
      activeStrategy = created.strategy as StrategyDefinition;
    }

    const strategyPatch = creationPlan.strategyPatch ?? {};
    const nextStrategy: StrategyDefinition = {
      ...activeStrategy,
      ...(creationPlan.name ? { name: creationPlan.name } : {}),
      ...strategyPatch,
      timeframe:
        typeof strategyPatch.timeframe === "string"
          ? strategyPatch.timeframe
          : (input.preferredTimeframe ?? activeStrategy.timeframe),
      id: activeStrategy.id,
      ownerAddress: activeStrategy.ownerAddress,
      marketId: activeStrategy.marketId,
      status: activeStrategy.status,
      schemaVersion: activeStrategy.schemaVersion,
      createdAt: activeStrategy.createdAt,
      updatedAt: activeStrategy.updatedAt
    };

    const updateEntry: AgentToolTraceEntry = {
      step: trace.length + 1,
      tool: "update_strategy_draft",
      input: {
        ownerAddress: input.ownerAddress,
        strategy: nextStrategy
      },
      reason: "Creation fast path: apply the model-selected strategy structure",
      expectedArtifact: "updated strategy draft",
      startedAt: new Date().toISOString()
    };
    trace.push(updateEntry);

    const updated = await this.matcherTransport("update_strategy_draft", {
      ownerAddress: input.ownerAddress as HexString,
      strategy: nextStrategy
    });
    updateEntry.output = updated as Record<string, unknown>;
    updateEntry.completedAt = new Date().toISOString();
    Object.assign(updateEntry, summarizeToolProgress(updateEntry));

    activeStrategy = (updated.strategy && typeof updated.strategy === "object"
      ? updated.strategy
      : nextStrategy) as StrategyDefinition;

    const strategyId = activeStrategy.id;

    const validateEntry: AgentToolTraceEntry = {
      step: trace.length + 1,
      tool: "validate_strategy_draft",
      input: {
        ownerAddress: input.ownerAddress,
        strategyId
      },
      reason: "Fast path: validate once before finishing",
      expectedArtifact: "validation result",
      startedAt: new Date().toISOString()
    };
    trace.push(validateEntry);

    const validationResult = await this.matcherTransport("validate_strategy_draft", {
      ownerAddress: input.ownerAddress as HexString,
      strategyId
    });
    validateEntry.output = validationResult as Record<string, unknown>;
    validateEntry.completedAt = new Date().toISOString();
    Object.assign(validateEntry, summarizeToolProgress(validateEntry));

    let validationOk = (validationResult.validation as { ok?: boolean } | undefined)?.ok === true;
    let finalStrategy = activeStrategy;

    if (!validationOk && validationResult.validation) {
      const repair = attemptValidationRepair(
        activeStrategy,
        validationResult.validation as { ok: boolean; issues: Array<{ path: string; code: string; message: string; suggestion?: string }> },
        {
          ownerAddress: input.ownerAddress,
          marketId: input.marketId
        }
      );
      metrics.repairsAttempted += 1;

      if (repair.repaired) {
        const repairEntry: AgentToolTraceEntry = {
          step: trace.length + 1,
          tool: "update_strategy_draft",
          input: {
            ownerAddress: input.ownerAddress,
            strategy: repair.patchedStrategy
          },
          reason: "Fast path: apply one rule-based repair pass",
          expectedArtifact: "repaired strategy draft",
          startedAt: new Date().toISOString()
        };
        trace.push(repairEntry);

        const repaired = await this.matcherTransport("update_strategy_draft", {
          ownerAddress: input.ownerAddress as HexString,
          strategy: repair.patchedStrategy
        });
        repairEntry.output = repaired as Record<string, unknown>;
        repairEntry.completedAt = new Date().toISOString();
        Object.assign(repairEntry, summarizeToolProgress(repairEntry));

        finalStrategy = (repaired.strategy && typeof repaired.strategy === "object"
          ? repaired.strategy
          : repair.patchedStrategy) as StrategyDefinition;

        const revalidateEntry: AgentToolTraceEntry = {
          step: trace.length + 1,
          tool: "validate_strategy_draft",
          input: {
            ownerAddress: input.ownerAddress,
            strategyId: finalStrategy.id
          },
          reason: "Fast path: revalidate after repair",
          expectedArtifact: "validation result",
          startedAt: new Date().toISOString()
        };
        trace.push(revalidateEntry);

        const revalidated = await this.matcherTransport("validate_strategy_draft", {
          ownerAddress: input.ownerAddress as HexString,
          strategyId: finalStrategy.id
        });
        revalidateEntry.output = revalidated as Record<string, unknown>;
        revalidateEntry.completedAt = new Date().toISOString();
        Object.assign(revalidateEntry, summarizeToolProgress(revalidateEntry));

        validationOk = (revalidated.validation as { ok?: boolean } | undefined)?.ok === true;
        if (validationOk) {
          metrics.repairsSucceeded += 1;
        }
      }
    }

    const artifacts = collectArtifactsFromTrace(trace);

    if (goalRequestsBacktest(input.goal) && validationOk) {
      const backtestEntry: AgentToolTraceEntry = {
        step: trace.length + 1,
        tool: "run_strategy_backtest",
        input: {
          ownerAddress: input.ownerAddress,
          strategyId: finalStrategy.id,
          ...(resolveBacktestBars(input) ? { bars: resolveBacktestBars(input) } : {}),
          ...(resolveChartRange(input) ?? {})
        },
        reason: "Fast path: run requested backtest",
        expectedArtifact: "backtest summary",
        startedAt: new Date().toISOString()
      };
      trace.push(backtestEntry);

      const backtest = await this.matcherTransport("run_strategy_backtest", {
        ownerAddress: input.ownerAddress as HexString,
        strategyId: finalStrategy.id,
        ...(resolveBacktestBars(input) ? { bars: resolveBacktestBars(input) } : {}),
        ...(resolveChartRange(input) ?? {})
      });
      backtestEntry.output = backtest as Record<string, unknown>;
      backtestEntry.completedAt = new Date().toISOString();
      Object.assign(backtestEntry, summarizeToolProgress(backtestEntry));

      const summary = backtest.summary as { netPnl?: number; winRate?: number; tradeCount?: number; maxDrawdownPct?: number; profitFactor?: number } | undefined;

      return {
        finalMessage: summary
          ? `Created and validated ${activeStrategy.name}, then ran the backtest. Net PnL: ${summary.netPnl ?? "n/a"}, win rate: ${summary.winRate ?? "n/a"}, trades: ${summary.tradeCount ?? "n/a"}, max drawdown: ${summary.maxDrawdownPct ?? "n/a"}, profit factor: ${summary.profitFactor ?? "n/a"}.`
          : `Created, validated, and backtested ${activeStrategy.name}.`,
        artifacts: collectArtifactsFromTrace(trace, artifacts)
      };
    }

    return {
      finalMessage: validationOk
        ? `Created and validated ${activeStrategy.name}.`
        : `Created ${activeStrategy.name}, but validation still has issues after one quick repair pass.`,
      artifacts
    };
  }

  private async tryRunOptimizationFastPath(
    input: AgentStrategyRequest,
    trace: AgentToolTraceEntry[],
    warnings: string[],
    metrics: AgentResponse["metrics"],
    stream?: AgentRunStreamCallbacks
  ): Promise<{ finalMessage: string; artifacts: AgentResponse["artifacts"] } | null> {
    if (!input.strategyId || !goalLooksLikeOptimization(input.goal)) {
      return null;
    }

    const getEntry: AgentToolTraceEntry = {
      step: trace.length + 1,
      tool: "get_strategy",
      input: {
        ownerAddress: input.ownerAddress,
        strategyId: input.strategyId
      },
      reason: "Optimization fast path: inspect the current strategy before tuning",
      expectedArtifact: "strategy payload",
      startedAt: new Date().toISOString()
    };
    trace.push(getEntry);

    const existing = await this.matcherTransport("get_strategy", {
      ownerAddress: input.ownerAddress as HexString,
      strategyId: input.strategyId
    });
    getEntry.output = existing as Record<string, unknown>;
    getEntry.completedAt = new Date().toISOString();
    Object.assign(getEntry, summarizeToolProgress(getEntry));

    if (!existing.strategy || typeof existing.strategy !== "object") {
      return null;
    }

    const baseStrategy = existing.strategy as StrategyDefinition;
    const strategyKind = classifyBasicStrategy(baseStrategy);
    if (!strategyKind) {
      return null;
    }

    warnings.push(`Used model-guided optimization fast path for existing ${baseStrategy.name}.`);
    metrics.enforcementTriggered = true;
    metrics.finalizationGuardrailsApplied.push(`model_optimize_fast_path_${strategyKind}`);

    let marketAnalysis: StrategyMarketAnalysis | undefined;
    const marketAnalysisEntry: AgentToolTraceEntry = {
      step: trace.length + 1,
      tool: "analyze_market_context",
      input: {
        ownerAddress: input.ownerAddress,
        marketId: baseStrategy.marketId,
        ...(resolveBacktestBars(input) ? { bars: resolveBacktestBars(input) } : {}),
        ...(resolveChartRange(input) ?? {})
      },
      reason: "Optimization fast path: inspect regime and timeframe before parameter search",
      expectedArtifact: "market analysis",
      startedAt: new Date().toISOString()
    };
    trace.push(marketAnalysisEntry);

    try {
      const analysisResult = await this.matcherTransport("analyze_market_context", {
        ownerAddress: input.ownerAddress as HexString,
        marketId: baseStrategy.marketId,
        ...(resolveBacktestBars(input) ? { bars: resolveBacktestBars(input) } : {}),
        ...(resolveChartRange(input) ?? {})
      });
      marketAnalysisEntry.output = analysisResult as Record<string, unknown>;
      marketAnalysisEntry.completedAt = new Date().toISOString();
      Object.assign(marketAnalysisEntry, summarizeToolProgress(marketAnalysisEntry));
      marketAnalysis = isStrategyMarketAnalysis(analysisResult.analysis)
        ? analysisResult.analysis
        : undefined;
    } catch (error) {
      marketAnalysisEntry.error = { message: error instanceof Error ? error.message : String(error) };
      marketAnalysisEntry.completedAt = new Date().toISOString();
      marketAnalysisEntry.failureClass = "tool_error";
      marketAnalysisEntry.progressObserved = false;
      marketAnalysisEntry.resultSummary = marketAnalysisEntry.error.message;
      warnings.push(`Market analysis failed during optimization fast path: ${marketAnalysisEntry.error.message}`);
    }

    let currentSummary: Record<string, unknown> | undefined;
    try {
      const baselineEntry: AgentToolTraceEntry = {
        step: trace.length + 1,
        tool: "run_strategy_backtest",
        input: {
          ownerAddress: input.ownerAddress,
          strategyId: baseStrategy.id,
          ...(resolveBacktestBars(input) ? { bars: resolveBacktestBars(input) } : {}),
          ...(resolveChartRange(input) ?? {})
        },
        reason: "Optimization fast path: get current baseline before proposing changes",
        expectedArtifact: "backtest summary",
        startedAt: new Date().toISOString()
      };
      trace.push(baselineEntry);

      const baseline = await this.matcherTransport("run_strategy_backtest", {
        ownerAddress: input.ownerAddress as HexString,
        strategyId: baseStrategy.id,
        ...(resolveBacktestBars(input) ? { bars: resolveBacktestBars(input) } : {}),
        ...(resolveChartRange(input) ?? {})
      });
      baselineEntry.output = baseline as Record<string, unknown>;
      baselineEntry.completedAt = new Date().toISOString();
      Object.assign(baselineEntry, summarizeToolProgress(baselineEntry));
      currentSummary = baseline.summary as Record<string, unknown> | undefined;
    } catch (error) {
      warnings.push(`Baseline backtest for optimization failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let candidateConfigs: OptimizationCandidate[] = [];
    try {
      const optimizationPrompt = buildOptimizationPlanPrompt({
        goal: input.goal,
        strategyKind,
        strategy: baseStrategy as unknown as Record<string, unknown>,
        currentSummary,
        preferredTimeframe: input.preferredTimeframe,
        marketAnalysis: marketAnalysis as unknown as Record<string, unknown> | undefined
      });
      const response = await this.invokePlanningModel(optimizationPrompt, stream);
      candidateConfigs = parseOptimizationCandidates(extractMessageText(response));
    } catch (error) {
      warnings.push(`Model-guided optimization planning failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (candidateConfigs.length === 0) {
      warnings.push("Model did not return optimization candidates. Using market-aware deterministic fallback candidates.");
      const preferredTimeframe = resolvePreferredTimeframe(input.preferredTimeframe, marketAnalysis);
      const emaSuggestion = marketAnalysis?.emaSuggestion;
      const sideBias = extractRequestedSideBias(input.goal) ?? "both";
      const riskRules = resolveRiskRulesForGoal(preferredTimeframe, input.goal);
      candidateConfigs = (() => {
        switch (strategyKind) {
          case "ema":
            return [
              {
                label: "ema-primary",
                params: {
                  fast: emaSuggestion?.fastPeriod ?? 9,
                  slow: emaSuggestion?.slowPeriod ?? 21,
                  timeframe: preferredTimeframe,
                  longOnly: sideBias === "long_only",
                  ...riskRules
                }
              },
              {
                label: "ema-faster",
                params: {
                  fast: Math.max((emaSuggestion?.fastPeriod ?? 9) - 2, 5),
                  slow: Math.max((emaSuggestion?.slowPeriod ?? 21) - 5, 13),
                  timeframe: preferredTimeframe,
                  longOnly: sideBias === "long_only",
                  stopLossPct: riskRules.stopLossPct,
                  takeProfitPct: riskRules.takeProfitPct
                }
              },
              {
                label: "ema-slower",
                params: {
                  fast: (emaSuggestion?.fastPeriod ?? 9) + 2,
                  slow: (emaSuggestion?.slowPeriod ?? 21) + 8,
                  timeframe: preferredTimeframe,
                  longOnly: sideBias === "long_only",
                  stopLossPct: riskRules.stopLossPct,
                  takeProfitPct: riskRules.takeProfitPct
                }
              }
            ];
          case "rsi-mean-reversion":
            return [
              {
                label: "rsi-market-aware",
                params: {
                  timeframe: preferredTimeframe,
                  period: preferredTimeframe === "1m" || preferredTimeframe === "5m" ? 12 : 14,
                  entry: 28,
                  exit: 58,
                  stopLossPct: riskRules.stopLossPct,
                  takeProfitPct: riskRules.takeProfitPct
                }
              }
            ];
          case "range-breakout":
            return [
              {
                label: "breakout-market-aware",
                params: {
                  timeframe: preferredTimeframe,
                  lookback: preferredTimeframe === "1h" || preferredTimeframe === "4h" ? 24 : 20,
                  exitEma: emaSuggestion?.fastPeriod ?? 10,
                  stopLossPct: riskRules.stopLossPct,
                  takeProfitPct: riskRules.takeProfitPct
                }
              }
            ];
          case "bollinger-reversion":
            return [
              {
                label: "boll-market-aware",
                params: {
                  timeframe: preferredTimeframe,
                  period: preferredTimeframe === "1m" ? 18 : 20,
                  stdDev: marketAnalysis?.overallRegime === "high_noise" ? 2.2 : 2,
                  stopLossPct: riskRules.stopLossPct,
                  takeProfitPct: riskRules.takeProfitPct
                }
              }
            ];
        }
      })();
    }

    const candidates: StrategyDefinition[] = candidateConfigs.map((candidate) => {
      const params = candidate.params ?? {};
      const built = (() => {
        switch (strategyKind) {
        case "ema":
          return buildEmaVariant(baseStrategy, {
            fast: typeof params.fast === "number" ? params.fast : 9,
            slow: typeof params.slow === "number" ? params.slow : 21,
            timeframe: typeof params.timeframe === "string" ? params.timeframe as StrategyDefinition["timeframe"] : "15m",
            longOnly: Boolean(params.longOnly),
            stopLossPct: typeof params.stopLossPct === "number" ? params.stopLossPct : undefined,
            takeProfitPct: typeof params.takeProfitPct === "number" ? params.takeProfitPct : undefined,
            trailingStopPct: typeof params.trailingStopPct === "number" ? params.trailingStopPct : undefined,
            maxBarsInTrade: typeof params.maxBarsInTrade === "number" ? params.maxBarsInTrade : undefined
          });
        case "rsi-mean-reversion":
          return buildRsiVariant(baseStrategy, {
            timeframe: typeof params.timeframe === "string" ? params.timeframe as StrategyDefinition["timeframe"] : "15m",
            period: typeof params.period === "number" ? params.period : 14,
            entry: typeof params.entry === "number" ? params.entry : 30,
            exit: typeof params.exit === "number" ? params.exit : 55,
            stopLossPct: typeof params.stopLossPct === "number" ? params.stopLossPct : undefined,
            takeProfitPct: typeof params.takeProfitPct === "number" ? params.takeProfitPct : undefined
          });
        case "range-breakout":
          return buildBreakoutVariant(baseStrategy, {
            timeframe: typeof params.timeframe === "string" ? params.timeframe as StrategyDefinition["timeframe"] : "15m",
            lookback: typeof params.lookback === "number" ? params.lookback : 20,
            exitEma: typeof params.exitEma === "number" ? params.exitEma : 10,
            stopLossPct: typeof params.stopLossPct === "number" ? params.stopLossPct : undefined,
            takeProfitPct: typeof params.takeProfitPct === "number" ? params.takeProfitPct : undefined
          });
        case "bollinger-reversion":
          return buildBollingerVariant(baseStrategy, {
            timeframe: typeof params.timeframe === "string" ? params.timeframe as StrategyDefinition["timeframe"] : "15m",
            period: typeof params.period === "number" ? params.period : 20,
            stdDev: typeof params.stdDev === "number" ? params.stdDev : 2,
            stopLossPct: typeof params.stopLossPct === "number" ? params.stopLossPct : undefined,
            takeProfitPct: typeof params.takeProfitPct === "number" ? params.takeProfitPct : undefined
          });
        }
      })();

      return applyRequestedSidePreference(built, input.goal);
    });

    let bestStrategy = baseStrategy;
    let bestSummary: Record<string, unknown> | null = null;
    let bestPnl = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
      const updateEntry: AgentToolTraceEntry = {
        step: trace.length + 1,
        tool: "update_strategy_draft",
        input: {
          ownerAddress: input.ownerAddress,
          strategy: candidate
        },
        reason: "Optimization fast path: apply a candidate parameter set",
        expectedArtifact: "updated strategy draft",
        startedAt: new Date().toISOString()
      };
      trace.push(updateEntry);

      const updated = await this.matcherTransport("update_strategy_draft", {
        ownerAddress: input.ownerAddress as HexString,
        strategy: candidate
      });
      updateEntry.output = updated as Record<string, unknown>;
      updateEntry.completedAt = new Date().toISOString();
      Object.assign(updateEntry, summarizeToolProgress(updateEntry));

      const validateEntry: AgentToolTraceEntry = {
        step: trace.length + 1,
        tool: "validate_strategy_draft",
        input: {
          ownerAddress: input.ownerAddress,
          strategyId: candidate.id
        },
        reason: "Optimization fast path: validate candidate before backtest",
        expectedArtifact: "validation result",
        startedAt: new Date().toISOString()
      };
      trace.push(validateEntry);

      const validation = await this.matcherTransport("validate_strategy_draft", {
        ownerAddress: input.ownerAddress as HexString,
        strategyId: candidate.id
      });
      validateEntry.output = validation as Record<string, unknown>;
      validateEntry.completedAt = new Date().toISOString();
      Object.assign(validateEntry, summarizeToolProgress(validateEntry));

      if ((validation.validation as { ok?: boolean } | undefined)?.ok !== true) {
        continue;
      }

      const backtestEntry: AgentToolTraceEntry = {
        step: trace.length + 1,
        tool: "run_strategy_backtest",
        input: {
          ownerAddress: input.ownerAddress,
          strategyId: candidate.id,
          ...(resolveBacktestBars(input) ? { bars: resolveBacktestBars(input) } : {}),
          ...(resolveChartRange(input) ?? {})
        },
        reason: "Optimization fast path: score candidate by backtest result",
        expectedArtifact: "backtest summary",
        startedAt: new Date().toISOString()
      };
      trace.push(backtestEntry);

      const backtest = await this.matcherTransport("run_strategy_backtest", {
        ownerAddress: input.ownerAddress as HexString,
        strategyId: candidate.id,
        ...(resolveBacktestBars(input) ? { bars: resolveBacktestBars(input) } : {}),
        ...(resolveChartRange(input) ?? {})
      });
      backtestEntry.output = backtest as Record<string, unknown>;
      backtestEntry.completedAt = new Date().toISOString();
      Object.assign(backtestEntry, summarizeToolProgress(backtestEntry));

      const pnl = typeof backtest.summary?.netPnl === "number" ? backtest.summary.netPnl : Number.NEGATIVE_INFINITY;
      if (pnl > bestPnl) {
        bestPnl = pnl;
        bestStrategy = (updated.strategy && typeof updated.strategy === "object" ? updated.strategy : candidate) as StrategyDefinition;
        bestSummary = backtest.summary as Record<string, unknown>;
      }
      if (pnl > 0) {
        break;
      }
    }

    const artifacts = collectArtifactsFromTrace(trace);
    const best = bestSummary as { netPnl?: number; winRate?: number; tradeCount?: number; maxDrawdownPct?: number; profitFactor?: number } | null;

    if (!best) {
      return {
        finalMessage: `Reviewed ${baseStrategy.name}, but none of the quick tuning candidates completed with a usable backtest result.`,
        artifacts
      };
    }

    return {
      finalMessage:
        (typeof best.netPnl === "number" && best.netPnl > 0)
          ? `Optimized ${bestStrategy.name} and found a positive 15m result. Net PnL: ${best.netPnl}, win rate: ${best.winRate ?? "n/a"}, trades: ${best.tradeCount ?? "n/a"}, max drawdown: ${best.maxDrawdownPct ?? "n/a"}, profit factor: ${best.profitFactor ?? "n/a"}.`
          : `Optimized ${bestStrategy.name}, but none of the quick candidates reached positive PnL. Best result found: net PnL ${best.netPnl ?? "n/a"}, win rate ${best.winRate ?? "n/a"}, trades ${best.tradeCount ?? "n/a"}, max drawdown ${best.maxDrawdownPct ?? "n/a"}, profit factor ${best.profitFactor ?? "n/a"}.`,
      artifacts
    };
  }
}
