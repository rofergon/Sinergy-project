import { z } from "zod";
import type {
  HexString,
  StrategyCapabilities,
  StrategyDefinition,
  StrategyTemplate,
  StrategyToolName,
  StrategyValidationResult,
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyChartOverlay
} from "./strategy";

export const STRATEGY_TOOL_LIMITS = {
  maxNameLength: 80,
  minNameLength: 3,
  maxBarsPerBacktest: 1000,
  defaultBacktestBars: 250,
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
        .optional()
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
        .optional()
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
    description: "Return the machine-readable catalog of indicators, operators, limits and defaults.",
    inputSchema: strategyToolInputSchemas.list_strategy_capabilities,
    endpoint: "/strategy-tools/list_strategy_capabilities"
  },
  {
    name: "list_strategy_templates",
    description: "List built-in strategy templates available for cloning.",
    inputSchema: strategyToolInputSchemas.list_strategy_templates,
    endpoint: "/strategy-tools/list_strategy_templates"
  },
  {
    name: "create_strategy_draft",
    description: "Create a new strategy draft owned by a wallet address.",
    inputSchema: strategyToolInputSchemas.create_strategy_draft,
    endpoint: "/strategy-tools/create_strategy_draft"
  },
  {
    name: "update_strategy_draft",
    description: "Replace a strategy draft payload after local edits.",
    inputSchema: strategyToolInputSchemas.update_strategy_draft,
    endpoint: "/strategy-tools/update_strategy_draft"
  },
  {
    name: "validate_strategy_draft",
    description: "Validate a strategy payload or an existing strategy draft and return structured issues.",
    inputSchema: strategyToolInputSchemas.validate_strategy_draft,
    endpoint: "/strategy-tools/validate_strategy_draft"
  },
  {
    name: "run_strategy_backtest",
    description: "Run a server-side strategy backtest and return summary, trades and chart overlay.",
    inputSchema: strategyToolInputSchemas.run_strategy_backtest,
    endpoint: "/strategy-tools/run_strategy_backtest"
  },
  {
    name: "get_backtest_summary",
    description: "Read the summary metrics of a prior backtest run.",
    inputSchema: strategyToolInputSchemas.get_backtest_summary,
    endpoint: "/strategy-tools/get_backtest_summary"
  },
  {
    name: "get_backtest_trades",
    description: "Read the executed trade list of a prior backtest run.",
    inputSchema: strategyToolInputSchemas.get_backtest_trades,
    endpoint: "/strategy-tools/get_backtest_trades"
  },
  {
    name: "get_backtest_chart_overlay",
    description: "Read indicator overlays and buy/sell markers for a prior backtest run.",
    inputSchema: strategyToolInputSchemas.get_backtest_chart_overlay,
    endpoint: "/strategy-tools/get_backtest_chart_overlay"
  },
  {
    name: "save_strategy",
    description: "Validate and promote a draft into a saved strategy version.",
    inputSchema: strategyToolInputSchemas.save_strategy,
    endpoint: "/strategy-tools/save_strategy"
  },
  {
    name: "list_user_strategies",
    description: "List all strategies owned by the given wallet address.",
    inputSchema: strategyToolInputSchemas.list_user_strategies,
    endpoint: "/strategy-tools/list_user_strategies"
  },
  {
    name: "get_strategy",
    description: "Fetch one strategy by id for the given owner.",
    inputSchema: strategyToolInputSchemas.get_strategy,
    endpoint: "/strategy-tools/get_strategy"
  },
  {
    name: "clone_strategy_template",
    description: "Clone a built-in template into a new draft for a specific owner and market.",
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
