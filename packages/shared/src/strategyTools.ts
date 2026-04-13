import { z } from "zod";
import type {
  HexString,
  StrategyCapabilities,
  StrategyDefinition,
  StrategySourceCompilation,
  StrategyTemplate,
  StrategyToolName,
  StrategyValidationResult,
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyChartOverlay,
  StrategyMarketAnalysis
} from "./strategy";

export const STRATEGY_TOOL_LIMITS = {
  maxNameLength: 80,
  minNameLength: 3,
  maxBarsPerBacktest: 200_000,
  defaultBacktestBars: 8_640,
  maxSerializedStrategyBytes: 100_000,
  requestsPerMinutePerOwnerPerTool: 60
} as const;

export const strategyOwnerAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "ownerAddress must be a 20-byte hex address.") as z.ZodType<HexString>;

export const strategyMarketIdSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "marketId must be a 32-byte hex identifier.") as z.ZodType<HexString>;

export const strategyToolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean().default(false)
});

export const strategyToolMetaSchema = z.object({
  apiVersion: z.string(),
  tool: z.string(),
  requestId: z.string(),
  timestamp: z.string()
});

export const strategyToolEnvelopeSchema = <T extends z.ZodTypeAny>(resultSchema: T) =>
  z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      meta: strategyToolMetaSchema,
      result: resultSchema
    }),
    z.object({
      ok: z.literal(false),
      meta: strategyToolMetaSchema,
      error: strategyToolErrorSchema
    })
  ]);

const strategyCoreSchema = z.object({
  id: z.string().min(1),
  ownerAddress: strategyOwnerAddressSchema,
  name: z.string().min(1).max(STRATEGY_TOOL_LIMITS.maxNameLength),
  marketId: strategyMarketIdSchema
});

export const strategyDraftPayloadSchema = strategyCoreSchema
  .extend({
    timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]),
    enabledSides: z.array(z.enum(["long", "short"])).min(1),
    entryRules: z.unknown(),
    exitRules: z.unknown(),
    sizing: z.unknown(),
    riskRules: z.unknown(),
    costModel: z.unknown(),
    status: z.enum(["draft", "saved", "archived"]),
    schemaVersion: z.string(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .passthrough() as z.ZodType<StrategyDefinition>;

export const strategyToolInputSchemas = {
  list_strategy_capabilities: z
    .object({
      ownerAddress: strategyOwnerAddressSchema
    })
    .strict(),
  analyze_market_context: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      marketId: strategyMarketIdSchema,
      bars: z
        .number()
        .int()
        .positive()
        .max(STRATEGY_TOOL_LIMITS.maxBarsPerBacktest)
        .optional(),
      fromTs: z.number().int().positive().optional(),
      toTs: z.number().int().positive().optional()
    })
    .refine((value) => {
      if (value.fromTs === undefined && value.toTs === undefined) return true;
      return value.fromTs !== undefined && value.toTs !== undefined && value.fromTs <= value.toTs;
    }, {
      message: "Provide fromTs and toTs together, with fromTs <= toTs."
    })
    .strict(),
  compile_strategy_source: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      marketId: strategyMarketIdSchema,
      name: z
        .string()
        .trim()
        .min(STRATEGY_TOOL_LIMITS.minNameLength)
        .max(STRATEGY_TOOL_LIMITS.maxNameLength)
        .optional(),
      timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional(),
      enabledSides: z.array(z.enum(["long", "short"])).min(1).optional(),
      engine: z.unknown()
    })
    .strict(),
  list_strategy_templates: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      marketId: strategyMarketIdSchema.optional()
    })
    .strict(),
  create_strategy_draft: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      marketId: strategyMarketIdSchema,
      name: z
        .string()
        .trim()
        .min(STRATEGY_TOOL_LIMITS.minNameLength)
        .max(STRATEGY_TOOL_LIMITS.maxNameLength)
        .optional(),
      engine: z.unknown().optional()
    })
    .strict(),
  update_strategy_draft: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      strategy: strategyDraftPayloadSchema
    })
    .strict(),
  validate_strategy_draft: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      strategyId: z.string().uuid().optional(),
      strategy: strategyDraftPayloadSchema.optional()
    })
    .strict()
    .refine((value) => Boolean(value.strategyId || value.strategy), {
      message: "Provide strategyId or strategy."
    }),
  run_strategy_backtest: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      strategyId: z.string().uuid(),
      bars: z
        .number()
        .int()
        .positive()
        .max(STRATEGY_TOOL_LIMITS.maxBarsPerBacktest)
        .optional(),
      fromTs: z.number().int().positive().optional(),
      toTs: z.number().int().positive().optional()
    })
    .refine((value) => {
      if (value.fromTs === undefined && value.toTs === undefined) return true;
      return value.fromTs !== undefined && value.toTs !== undefined && value.fromTs <= value.toTs;
    }, {
      message: "Provide fromTs and toTs together, with fromTs <= toTs."
    })
    .strict(),
  get_backtest_summary: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      runId: z.string().uuid()
    })
    .strict(),
  get_backtest_trades: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      runId: z.string().uuid()
    })
    .strict(),
  get_backtest_chart_overlay: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      runId: z.string().uuid()
    })
    .strict(),
  save_strategy: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      strategyId: z.string().uuid()
    })
    .strict(),
  list_user_strategies: z
    .object({
      ownerAddress: strategyOwnerAddressSchema
    })
    .strict(),
  get_strategy: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      strategyId: z.string().uuid()
    })
    .strict(),
  clone_strategy_template: z
    .object({
      ownerAddress: strategyOwnerAddressSchema,
      marketId: strategyMarketIdSchema,
      templateId: z.string().min(1)
    })
    .strict()
} satisfies Record<StrategyToolName, z.ZodTypeAny>;

export type StrategyToolInput<TTool extends StrategyToolName> = z.infer<
  (typeof strategyToolInputSchemas)[TTool]
>;

export type StrategyToolResultMap = {
  list_strategy_capabilities: { capabilities: StrategyCapabilities };
  analyze_market_context: { analysis: StrategyMarketAnalysis };
  compile_strategy_source: StrategySourceCompilation;
  list_strategy_templates: { templates: StrategyTemplate[] };
  create_strategy_draft: { strategy: StrategyDefinition };
  update_strategy_draft: { strategy: StrategyDefinition };
  validate_strategy_draft: { validation: StrategyValidationResult };
  run_strategy_backtest: {
    summary: StrategyBacktestSummary;
    trades: StrategyBacktestTrade[];
    overlay: StrategyChartOverlay;
  };
  get_backtest_summary: { summary: StrategyBacktestSummary };
  get_backtest_trades: { trades: StrategyBacktestTrade[] };
  get_backtest_chart_overlay: { overlay: StrategyChartOverlay };
  save_strategy: { strategy: StrategyDefinition; validation: StrategyValidationResult };
  list_user_strategies: { strategies: StrategyDefinition[] };
  get_strategy: { strategy: StrategyDefinition };
  clone_strategy_template: { strategy: StrategyDefinition };
};

export type StrategyToolResult<TTool extends StrategyToolName> = StrategyToolResultMap[TTool];

export type StrategyToolDefinition<TTool extends StrategyToolName = StrategyToolName> = {
  name: TTool;
  description: string;
  inputSchema: (typeof strategyToolInputSchemas)[TTool];
  endpoint: `/strategy-tools/${TTool}`;
};

export const strategyToolDefinitions = [
  {
    name: "list_strategy_capabilities",
    description: "Discovery tool. Use first when building from scratch to learn valid indicators, operators, limits, defaults, and schema-safe choices. Do not use for validation or backtesting. Produces capabilities.",
    inputSchema: strategyToolInputSchemas.list_strategy_capabilities,
    endpoint: "/strategy-tools/list_strategy_capabilities"
  },
  {
    name: "analyze_market_context",
    description: "Discovery tool. Use after capabilities and before creating or optimizing a strategy so choices are grounded in real candles. Produces support/resistance levels, regime detection, EMA guidance, and a recommended timeframe.",
    inputSchema: strategyToolInputSchemas.analyze_market_context,
    endpoint: "/strategy-tools/analyze_market_context"
  },
  {
    name: "compile_strategy_source",
    description: "Compilation tool. Use when the strategy is expressed as AST v2 or Pine-like script and you need parser/compiler feedback before saving or backtesting. Produces a normalized engine payload plus a compilation preview.",
    inputSchema: strategyToolInputSchemas.compile_strategy_source,
    endpoint: "/strategy-tools/compile_strategy_source"
  },
  {
    name: "list_strategy_templates",
    description: "Discovery tool. Use before creating a draft when a built-in template may match the user's goal or market. Do not use once a draft already exists. Produces template candidates.",
    inputSchema: strategyToolInputSchemas.list_strategy_templates,
    endpoint: "/strategy-tools/list_strategy_templates"
  },
  {
    name: "create_strategy_draft",
    description: "Mutation tool. Use to create a brand-new draft after capabilities are known and when no reusable strategy or template fits. Supports either legacy rule payloads or a new engine-backed source via the optional engine field. Do not use if an active strategyId already exists. Produces a strategy draft.",
    inputSchema: strategyToolInputSchemas.create_strategy_draft,
    endpoint: "/strategy-tools/create_strategy_draft"
  },
  {
    name: "update_strategy_draft",
    description: "Mutation tool. Use to replace the full strategy payload after editing rules, sizing, costs, repairs, or engine-backed source code. Do not send partial objects or root-level strategyId. Produces an updated strategy draft.",
    inputSchema: strategyToolInputSchemas.update_strategy_draft,
    endpoint: "/strategy-tools/update_strategy_draft"
  },
  {
    name: "validate_strategy_draft",
    description: "Verification tool. Use after creating or updating a strategy to confirm schema and logic correctness. Do not skip before backtesting or saving. Produces structured validation status and issues.",
    inputSchema: strategyToolInputSchemas.validate_strategy_draft,
    endpoint: "/strategy-tools/validate_strategy_draft"
  },
  {
    name: "run_strategy_backtest",
    description: "Terminal tool. Use only after validation succeeds or when the request explicitly requires testing an existing valid strategy. Do not use with a raw strategy payload. Produces backtest summary, trades, and overlay.",
    inputSchema: strategyToolInputSchemas.run_strategy_backtest,
    endpoint: "/strategy-tools/run_strategy_backtest"
  },
  {
    name: "get_backtest_summary",
    description: "Read-only terminal follow-up. Use after a prior backtest run when only summary metrics are needed. Do not use to start a test. Produces backtest summary.",
    inputSchema: strategyToolInputSchemas.get_backtest_summary,
    endpoint: "/strategy-tools/get_backtest_summary"
  },
  {
    name: "get_backtest_trades",
    description: "Read-only terminal follow-up. Use after a prior backtest run when trade-by-trade detail is needed. Do not use to start a test. Produces backtest trades.",
    inputSchema: strategyToolInputSchemas.get_backtest_trades,
    endpoint: "/strategy-tools/get_backtest_trades"
  },
  {
    name: "get_backtest_chart_overlay",
    description: "Read-only terminal follow-up. Use after a prior backtest run when chart markers or indicator overlays are needed. Do not use to start a test. Produces chart overlay.",
    inputSchema: strategyToolInputSchemas.get_backtest_chart_overlay,
    endpoint: "/strategy-tools/get_backtest_chart_overlay"
  },
  {
    name: "save_strategy",
    description: "Mutation tool. Use after validation passes when the user wants the draft promoted into a saved strategy. Do not use as a substitute for backtesting. Produces a saved strategy and validation result.",
    inputSchema: strategyToolInputSchemas.save_strategy,
    endpoint: "/strategy-tools/save_strategy"
  },
  {
    name: "list_user_strategies",
    description: "Discovery tool. Use when the user asks about existing saved or draft strategies for an owner. Do not use when a specific strategyId is already known. Produces a strategy list.",
    inputSchema: strategyToolInputSchemas.list_user_strategies,
    endpoint: "/strategy-tools/list_user_strategies"
  },
  {
    name: "get_strategy",
    description: "Discovery tool. Use when a specific strategyId already exists and you need the full stored payload before validation, edits, or explanation. Produces one strategy.",
    inputSchema: strategyToolInputSchemas.get_strategy,
    endpoint: "/strategy-tools/get_strategy"
  },
  {
    name: "clone_strategy_template",
    description: "Mutation tool. Use when a template already matches the request better than creating from scratch. Do not use without marketId and templateId. Produces a cloned strategy draft.",
    inputSchema: strategyToolInputSchemas.clone_strategy_template,
    endpoint: "/strategy-tools/clone_strategy_template"
  }
] satisfies StrategyToolDefinition[];

export type StrategyToolTransport = <TTool extends StrategyToolName>(
  tool: TTool,
  input: StrategyToolInput<TTool>
) => Promise<StrategyToolResult<TTool>>;

export function createHttpStrategyToolTransport(options: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): StrategyToolTransport {
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function transport<TTool extends StrategyToolName>(
    tool: TTool,
    input: StrategyToolInput<TTool>
  ): Promise<StrategyToolResult<TTool>> {
    const parsed = strategyToolInputSchemas[tool].parse(input);
    const response = await fetchImpl(`${options.baseUrl}/strategy-tools/${tool}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(parsed)
    });

    const payload = await response.json();
    if (!payload.ok) {
      const error = payload.error ?? { message: `Strategy tool '${tool}' failed.` };
      const next = new Error(error.message) as Error & {
        code?: string;
        details?: Record<string, unknown>;
        retryable?: boolean;
      };
      next.code = error.code;
      next.details = error.details;
      next.retryable = error.retryable;
      throw next;
    }

    return payload.result as StrategyToolResult<TTool>;
  };
}

export function createLangChainCompatibleStrategyTools(transport: StrategyToolTransport) {
  return strategyToolDefinitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    schema: definition.inputSchema,
    invoke: (input: unknown) =>
      transport(
        definition.name,
        definition.inputSchema.parse(input) as StrategyToolInput<typeof definition.name>
      )
  }));
}
