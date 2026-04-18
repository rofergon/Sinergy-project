import { z } from "zod";
import type { HexString, StrategyDefinition, StrategyToolName } from "../strategy";
import { STRATEGY_TOOL_LIMITS } from "./constants";

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
