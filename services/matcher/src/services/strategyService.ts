import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  HexString,
  StrategyDefinition,
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyCapabilities,
  StrategyChartOverlay,
  StrategyMarketAnalysis,
  StrategyTimeframe,
  StrategyTemplate,
  StrategyValidationResult
} from "@sinergy/shared";
import { STRATEGY_TOOL_LIMITS } from "@sinergy/shared";
import {
  buildStrategyCapabilities,
  buildStrategyTemplates,
  createEmptyStrategyDraft
} from "./strategyCatalog.js";
import { runStrategyBacktest } from "./strategyBacktest.js";
import { analyzeMarketContext } from "./strategyMarketAnalysis.js";
import { normalizeStrategyDefinition, validateStrategyDefinition, ensureSavedStrategy } from "./strategyValidation.js";
import type { PriceService } from "./priceService.js";
import type { ResolvedMarket } from "../types.js";
import { StrategyToolError } from "./strategyToolSecurity.js";

type StrategyServiceOptions = {
  dbFile: string;
  markets: ResolvedMarket[];
  priceService: PriceService;
};

function keyOf(value: string) {
  return value.toLowerCase();
}

function isoNow() {
  return new Date().toISOString();
}

function defaultBacktestBarsForTimeframe(timeframe: StrategyTimeframe) {
  switch (timeframe) {
    case "1m":
      return 129_600;
    case "5m":
      return 25_920;
    case "15m":
      return 8_640;
    case "1h":
      return 2_160;
    case "4h":
      return 540;
    case "1d":
      return 90;
  }
}

export class StrategyService {
  private readonly db: DatabaseSync;
  private readonly capabilities: StrategyCapabilities;
  private readonly marketsById: Map<string, ResolvedMarket>;

  constructor(private readonly options: StrategyServiceOptions) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseSync(options.dbFile);
    this.capabilities = buildStrategyCapabilities();
    this.marketsById = new Map(options.markets.map((market) => [market.id.toLowerCase(), market]));
    this.ensureSchema();
    this.seedTemplates();
  }

  listCapabilities() {
    return this.capabilities;
  }

  analyzeMarketContext(input: {
    ownerAddress: HexString;
    marketId: HexString;
    bars?: number;
    fromTs?: number;
    toTs?: number;
  }): StrategyMarketAnalysis {
    this.assertOwnerAddress(input.ownerAddress);
    this.assertKnownMarket(input.marketId);

    const market = this.marketsById.get(input.marketId.toLowerCase());
    if (!market) {
      throw new StrategyToolError("Strategy market not found", "strategy_market_not_found", 404, {
        marketId: input.marketId
      });
    }

    const timeframes: StrategyTimeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
    const bars = input.bars ?? 240;
    const candlesByTimeframe = Object.fromEntries(
      timeframes.map((timeframe) => [
        timeframe,
        this.options.priceService.getCandles(
          market.baseToken.symbol,
          timeframe,
          bars,
          input.fromTs !== undefined && input.toTs !== undefined
            ? { fromTs: input.fromTs, toTs: input.toTs }
            : undefined
        ).map((bar) => ({
          ts: Number(bar.ts),
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
          volume: Number(bar.volume)
        }))
      ])
    ) as Record<StrategyTimeframe, Array<{
      ts: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>>;

    return analyzeMarketContext({
      marketId: market.id,
      candlesByTimeframe
    });
  }

  listTemplates(ownerAddress: HexString, marketId?: HexString): StrategyTemplate[] {
    const rows = this.db
      .prepare(
        `
          SELECT id, name, description, body_json
          FROM strategy_templates
          ORDER BY name ASC
        `
      )
      .all() as Array<{ id: string; name: string; description: string; body_json: string }>;

    const resolvedMarketId = marketId ?? (this.options.markets[0]?.id as HexString | undefined);
    if (!resolvedMarketId) return [];
    this.assertKnownMarket(resolvedMarketId);

    return rows.map((row) => {
      const strategy = normalizeStrategyDefinition(JSON.parse(row.body_json));
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        strategy: {
          ...strategy,
          id: strategy.id,
          ownerAddress,
          marketId: resolvedMarketId,
          updatedAt: isoNow()
        }
      };
    });
  }

  createDraft(input: { ownerAddress: HexString; marketId: HexString; name?: string }) {
    this.assertKnownMarket(input.marketId);
    this.assertOwnerAddress(input.ownerAddress);
    const strategy = createEmptyStrategyDraft(
      randomUUID(),
      input.ownerAddress,
      input.marketId,
      input.name?.trim() || "New Strategy Draft"
    );
    this.assertStrategyWritable(strategy);
    this.writeStrategy(strategy);
    return strategy;
  }

  cloneTemplate(input: { ownerAddress: HexString; marketId: HexString; templateId: string }) {
    this.assertOwnerAddress(input.ownerAddress);
    this.assertKnownMarket(input.marketId);
    const template = this.listTemplates(input.ownerAddress, input.marketId).find(
      (entry) => entry.id === input.templateId
    );
    if (!template) {
      throw new StrategyToolError("Strategy template not found", "template_not_found", 404, {
        templateId: input.templateId
      });
    }

    const strategy: StrategyDefinition = {
      ...template.strategy,
      id: randomUUID(),
      ownerAddress: input.ownerAddress,
      marketId: input.marketId,
      name: `${template.name} Copy`,
      status: "draft",
      createdAt: isoNow(),
      updatedAt: isoNow()
    };
    this.assertStrategyWritable(strategy);
    this.writeStrategy(strategy);
    return strategy;
  }

  listUserStrategies(ownerAddress: HexString) {
    this.assertOwnerAddress(ownerAddress);
    const rows = this.db
      .prepare(
        `
          SELECT body_json
          FROM strategies
          WHERE owner_address = ?
          ORDER BY updated_at DESC
        `
      )
      .all(keyOf(ownerAddress)) as Array<{ body_json: string }>;

    return rows.map((row) => normalizeStrategyDefinition(JSON.parse(row.body_json)));
  }

  getStrategy(strategyId: string, ownerAddress: HexString) {
    this.assertOwnerAddress(ownerAddress);
    const row = this.db
      .prepare(
        `
          SELECT body_json
          FROM strategies
          WHERE id = ? AND owner_address = ?
        `
      )
      .get(strategyId, keyOf(ownerAddress)) as { body_json: string } | undefined;
    if (!row) {
      throw new StrategyToolError("Strategy not found", "strategy_not_found", 404, {
        strategyId
      });
    }
    return normalizeStrategyDefinition(JSON.parse(row.body_json));
  }

  updateDraft(input: { ownerAddress: HexString; strategy: unknown }) {
    this.assertOwnerAddress(input.ownerAddress);
    const normalized = normalizeStrategyDefinition(input.strategy);
    if (keyOf(normalized.ownerAddress) !== keyOf(input.ownerAddress)) {
      throw new StrategyToolError(
        "Draft ownerAddress must match the caller ownerAddress.",
        "owner_address_mismatch",
        403,
        {
          strategyOwnerAddress: normalized.ownerAddress,
          ownerAddress: input.ownerAddress
        }
      );
    }
    const existing = this.getStrategy(normalized.id, input.ownerAddress);
    if (keyOf(existing.ownerAddress) !== keyOf(input.ownerAddress)) {
      throw new StrategyToolError("Strategy owner mismatch", "strategy_owner_mismatch", 403);
    }

    const merged: StrategyDefinition = {
      ...normalized,
      ownerAddress: existing.ownerAddress,
      createdAt: existing.createdAt,
      updatedAt: isoNow(),
      status: normalized.status === "archived" ? "archived" : "draft"
    };
    this.assertKnownMarket(merged.marketId);
    this.assertStrategyWritable(merged);
    this.writeStrategy(merged);
    return merged;
  }

  validateDraft(input: { ownerAddress: HexString; strategy?: unknown; strategyId?: string }): StrategyValidationResult {
    this.assertOwnerAddress(input.ownerAddress);
    const strategy =
      input.strategyId !== undefined
        ? this.getStrategy(input.strategyId, input.ownerAddress)
        : normalizeStrategyDefinition(input.strategy);
    if (keyOf(strategy.ownerAddress) !== keyOf(input.ownerAddress)) {
      throw new StrategyToolError(
        "Strategy ownerAddress must match the caller ownerAddress.",
        "owner_address_mismatch",
        403
      );
    }
    return validateStrategyDefinition(
      strategy,
      new Set([...this.marketsById.keys()]),
      this.capabilities
    );
  }

  saveStrategy(input: { ownerAddress: HexString; strategyId: string }) {
    this.assertOwnerAddress(input.ownerAddress);
    const strategy = this.getStrategy(input.strategyId, input.ownerAddress);
    const validation = validateStrategyDefinition(
      strategy,
      new Set([...this.marketsById.keys()]),
      this.capabilities
    );
    if (!validation.ok) {
      return {
        strategy,
        validation
      };
    }

    const saved = ensureSavedStrategy(strategy);
    this.writeStrategy(saved);
    return {
      strategy: saved,
      validation
    };
  }

  runBacktest(input: {
    ownerAddress: HexString;
    strategyId: string;
    bars?: number;
    fromTs?: number;
    toTs?: number;
  }) {
    this.assertOwnerAddress(input.ownerAddress);
    const strategy = this.getStrategy(input.strategyId, input.ownerAddress);
    const validation = validateStrategyDefinition(
      strategy,
      new Set([...this.marketsById.keys()]),
      this.capabilities
    );
    if (!validation.ok) {
      throw new StrategyToolError(
        `Strategy validation failed: ${validation.issues.map((issue) => issue.message).join("; ")}`,
        "strategy_validation_failed",
        422,
        {
          issues: validation.issues
        }
      );
    }

    const market = this.marketsById.get(strategy.marketId.toLowerCase());
    if (!market) {
      throw new StrategyToolError("Strategy market not found", "strategy_market_not_found", 404, {
        marketId: strategy.marketId
      });
    }

    const bars = input.bars ?? defaultBacktestBarsForTimeframe(strategy.timeframe);
    if (!Number.isInteger(bars) || bars <= 0 || bars > STRATEGY_TOOL_LIMITS.maxBarsPerBacktest) {
      throw new StrategyToolError(
        "bars must be a positive integer within the supported backtest limit.",
        "invalid_backtest_bars",
        422,
        {
          bars,
          maxBarsPerBacktest: STRATEGY_TOOL_LIMITS.maxBarsPerBacktest
        }
      );
    }

    const candles = this.options.priceService
      .getCandles(
        market.baseToken.symbol,
        strategy.timeframe,
        bars,
        input.fromTs !== undefined && input.toTs !== undefined
          ? { fromTs: input.fromTs, toTs: input.toTs }
          : undefined
      )
      .map((bar) => ({
        ts: Number(bar.ts),
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: Number(bar.volume)
      }));
    if (candles.length < 2) {
      throw new StrategyToolError(
        "Not enough candle data to run a backtest.",
        "insufficient_candles",
        422,
        {
          candleCount: candles.length
        }
      );
    }

    const result = runStrategyBacktest(strategy, candles);

    this.db
      .prepare(
        `
          INSERT INTO backtest_runs (id, strategy_id, owner_address, created_at, summary_json, overlay_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        result.summary.runId,
        strategy.id,
        keyOf(input.ownerAddress),
        isoNow(),
        JSON.stringify(result.summary),
        JSON.stringify(result.overlay)
      );

    const insertTrade = this.db.prepare(
      `
        INSERT INTO backtest_trades (id, run_id, strategy_id, owner_address, trade_json)
        VALUES (?, ?, ?, ?, ?)
      `
    );
    for (const trade of result.trades) {
      insertTrade.run(trade.id, result.summary.runId, strategy.id, keyOf(input.ownerAddress), JSON.stringify(trade));
    }

    return {
      summary: result.summary,
      trades: result.trades,
      overlay: result.overlay
    };
  }

  getBacktestSummary(input: { ownerAddress: HexString; runId: string }) {
    this.assertOwnerAddress(input.ownerAddress);
    const row = this.db
      .prepare(
        `
          SELECT summary_json
          FROM backtest_runs
          WHERE id = ? AND owner_address = ?
        `
      )
      .get(input.runId, keyOf(input.ownerAddress)) as { summary_json: string } | undefined;
    if (!row) {
      throw new StrategyToolError("Backtest run not found", "backtest_run_not_found", 404, {
        runId: input.runId
      });
    }
    return JSON.parse(row.summary_json) as StrategyBacktestSummary;
  }

  getBacktestTrades(input: { ownerAddress: HexString; runId: string }) {
    this.assertOwnerAddress(input.ownerAddress);
    const rows = this.db
      .prepare(
        `
          SELECT trade_json
          FROM backtest_trades
          WHERE run_id = ? AND owner_address = ?
          ORDER BY id ASC
        `
      )
      .all(input.runId, keyOf(input.ownerAddress)) as Array<{ trade_json: string }>;
    return rows.map((row) => JSON.parse(row.trade_json) as StrategyBacktestTrade);
  }

  getBacktestChartOverlay(input: { ownerAddress: HexString; runId: string }) {
    this.assertOwnerAddress(input.ownerAddress);
    const row = this.db
      .prepare(
        `
          SELECT overlay_json
          FROM backtest_runs
          WHERE id = ? AND owner_address = ?
        `
      )
      .get(input.runId, keyOf(input.ownerAddress)) as { overlay_json: string } | undefined;
    if (!row) {
      throw new StrategyToolError("Backtest run not found", "backtest_run_not_found", 404, {
        runId: input.runId
      });
    }
    return JSON.parse(row.overlay_json) as StrategyChartOverlay;
  }

  getOpenApiSpec() {
    return {
      openapi: "3.1.0",
      info: {
        title: "Sinergy Strategy Tool API",
        version: this.capabilities.apiVersion
      },
      paths: {
        "/strategy-tools/list_strategy_capabilities": {
          post: {
            summary: "Machine-readable strategy capability catalog"
          }
        },
        "/strategy-tools/analyze_market_context": {
          post: {
            summary: "Analyze real candles to derive regime, supports, resistances, and timeframe guidance"
          }
        },
        "/strategy-tools/list_strategy_templates": {
          post: {
            summary: "List built-in templates"
          }
        },
        "/strategy-tools/create_strategy_draft": {
          post: {
            summary: "Create a strategy draft"
          }
        },
        "/strategy-tools/update_strategy_draft": {
          post: {
            summary: "Replace a strategy draft payload"
          }
        },
        "/strategy-tools/validate_strategy_draft": {
          post: {
            summary: "Validate a strategy draft"
          }
        },
        "/strategy-tools/run_strategy_backtest": {
          post: {
            summary: "Execute a backtest run"
          }
        },
        "/strategy-tools/get_backtest_summary": {
          post: {
            summary: "Read summary metrics for a backtest run"
          }
        },
        "/strategy-tools/get_backtest_trades": {
          post: {
            summary: "Read the trade list for a backtest run"
          }
        },
        "/strategy-tools/get_backtest_chart_overlay": {
          post: {
            summary: "Read chart overlays for a backtest run"
          }
        },
        "/strategy-tools/save_strategy": {
          post: {
            summary: "Validate and mark a strategy as saved"
          }
        },
        "/strategy-tools/list_user_strategies": {
          post: {
            summary: "List strategies for an owner"
          }
        },
        "/strategy-tools/get_strategy": {
          post: {
            summary: "Fetch a single strategy"
          }
        },
        "/strategy-tools/clone_strategy_template": {
          post: {
            summary: "Create a new draft from a built-in template"
          }
        }
      }
    };
  }

  private writeStrategy(strategy: StrategyDefinition) {
    const bodyJson = JSON.stringify(strategy);
    this.db
      .prepare(
        `
          INSERT INTO strategies (id, owner_address, market_id, status, schema_version, name, created_at, updated_at, body_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            owner_address = excluded.owner_address,
            market_id = excluded.market_id,
            status = excluded.status,
            schema_version = excluded.schema_version,
            name = excluded.name,
            updated_at = excluded.updated_at,
            body_json = excluded.body_json
        `
      )
      .run(
        strategy.id,
        keyOf(strategy.ownerAddress),
        keyOf(strategy.marketId),
        strategy.status,
        strategy.schemaVersion,
        strategy.name,
        strategy.createdAt,
        strategy.updatedAt,
        bodyJson
      );

    const latestVersion = this.db
      .prepare(
        `
          SELECT COALESCE(MAX(version), 0) AS version
          FROM strategy_versions
          WHERE strategy_id = ?
        `
      )
      .get(strategy.id) as { version: number };
    this.db
      .prepare(
        `
          INSERT INTO strategy_versions (id, strategy_id, version, created_at, body_json)
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(randomUUID(), strategy.id, Number(latestVersion.version ?? 0) + 1, isoNow(), bodyJson);
  }

  private assertOwnerAddress(ownerAddress: HexString) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
      throw new StrategyToolError("ownerAddress must be a 20-byte hex address.", "invalid_owner_address", 422);
    }
  }

  private assertKnownMarket(marketId: HexString) {
    if (!this.marketsById.has(marketId.toLowerCase())) {
      throw new StrategyToolError("Market is not available in this matcher deployment.", "invalid_market", 422, {
        marketId
      });
    }
  }

  private assertStrategyWritable(strategy: StrategyDefinition) {
    if (strategy.name.trim().length < STRATEGY_TOOL_LIMITS.minNameLength) {
      throw new StrategyToolError(
        `Strategy name must contain at least ${STRATEGY_TOOL_LIMITS.minNameLength} characters.`,
        "strategy_name_too_short",
        422
      );
    }
    if (strategy.name.length > STRATEGY_TOOL_LIMITS.maxNameLength) {
      throw new StrategyToolError(
        `Strategy name must be at most ${STRATEGY_TOOL_LIMITS.maxNameLength} characters.`,
        "strategy_name_too_long",
        422
      );
    }

    const serializedSize = Buffer.byteLength(JSON.stringify(strategy), "utf8");
    if (serializedSize > STRATEGY_TOOL_LIMITS.maxSerializedStrategyBytes) {
      throw new StrategyToolError(
        "Serialized strategy payload exceeds the supported size limit.",
        "strategy_payload_too_large",
        413,
        {
          serializedSize,
          maxSerializedStrategyBytes: STRATEGY_TOOL_LIMITS.maxSerializedStrategyBytes
        }
      );
    }
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        owner_address TEXT NOT NULL,
        market_id TEXT NOT NULL,
        status TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        body_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_strategies_owner ON strategies(owner_address, updated_at DESC);

      CREATE TABLE IF NOT EXISTS strategy_versions (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        body_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backtest_runs (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        owner_address TEXT NOT NULL,
        created_at TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        overlay_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_backtest_runs_owner ON backtest_runs(owner_address, created_at DESC);

      CREATE TABLE IF NOT EXISTS backtest_trades (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        owner_address TEXT NOT NULL,
        trade_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strategy_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        body_json TEXT NOT NULL
      );
    `);
  }

  private seedTemplates() {
    const count = this.db
      .prepare(
        `
          SELECT COUNT(*) as total
          FROM strategy_templates
        `
      )
      .get() as { total: number };
    if (Number(count.total ?? 0) > 0) {
      return;
    }

    const marketId = (this.options.markets[0]?.id ?? "0x0000000000000000000000000000000000000000") as HexString;
    const templates = buildStrategyTemplates(
      "0x0000000000000000000000000000000000000000",
      marketId
    );
    const statement = this.db.prepare(
      `
        INSERT INTO strategy_templates (id, name, description, updated_at, body_json)
        VALUES (?, ?, ?, ?, ?)
      `
    );

    for (const template of templates) {
      statement.run(
        template.id,
        template.name,
        template.description,
        isoNow(),
        JSON.stringify(template.strategy)
      );
    }
  }
}
