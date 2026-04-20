import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  HexString,
  StrategyApprovalIntent,
  StrategyApprovalMessage,
  StrategyApprovalRecord,
  StrategyExecutionRecord,
  StrategyDefinition,
  StrategyBacktestSummary,
  StrategyBacktestTrade,
  StrategyCapabilities,
  StrategyChartOverlay,
  StrategyCompilationPreview,
  StrategyEngineDefinition,
  StrategyMarketAnalysis,
  StrategySourceCompilation,
  StrategyTimeframe,
  StrategyTemplate,
  StrategyValidationResult
} from "@sinergy/shared";
import {
  STRATEGY_APPROVAL_PRIMARY_TYPE,
  STRATEGY_EXECUTION_DOMAIN_NAME,
  STRATEGY_EXECUTION_DOMAIN_VERSION,
  STRATEGY_TOOL_LIMITS,
  hashStrategyId,
  hashStrategyPayload,
  strategyApprovalTypes
} from "@sinergy/shared";
import { hashTypedData, isAddressEqual, recoverTypedDataAddress, zeroAddress } from "viem";
import {
  buildStrategyCapabilities,
  buildStrategyTemplates,
  createEmptyStrategyDraft
} from "./strategyCatalog.js";
import { runStrategyBacktest } from "./strategyBacktest.js";
import { analyzeMarketContext } from "./strategyMarketAnalysis.js";
import { normalizeStrategyDefinition, validateStrategyDefinition, ensureSavedStrategy } from "./strategyValidation.js";
import { buildCompilationPreview, normalizeStrategyEngine } from "./strategySourceCompiler.js";
import type { PriceService } from "./priceService.js";
import type { ResolvedMarket } from "../types.js";
import { StrategyToolError } from "./strategyToolSecurity.js";

type StrategyServiceOptions = {
  dbFile: string;
  markets: ResolvedMarket[];
  priceService: PriceService;
  chainId: number;
  strategyExecutorAddress?: HexString;
};

function keyOf(value: string) {
  return value.toLowerCase();
}

function isoNow() {
  return new Date().toISOString();
}

function normalizeBacktestSummary(summary: StrategyBacktestSummary): StrategyBacktestSummary {
  return {
    ...summary,
    feesPaid: 0,
    slippagePaid: 0
  };
}

function normalizeBacktestTrade(trade: StrategyBacktestTrade): StrategyBacktestTrade {
  return {
    ...trade,
    feesPaid: 0,
    slippagePaid: 0
  };
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

  compileStrategySource(input: {
    ownerAddress: HexString;
    marketId: HexString;
    name?: string;
    timeframe?: StrategyTimeframe;
    enabledSides?: Array<"long" | "short">;
    engine: unknown;
  }): StrategySourceCompilation {
    this.assertKnownMarket(input.marketId);
    this.assertOwnerAddress(input.ownerAddress);
    const strategy = createEmptyStrategyDraft(
      randomUUID(),
      input.ownerAddress,
      input.marketId,
      input.name?.trim() || "Compiled Strategy Draft"
    );
    if (input.timeframe) {
      strategy.timeframe = input.timeframe;
    }
    if (input.enabledSides?.length) {
      strategy.enabledSides = input.enabledSides;
    }
    const engine = normalizeStrategyEngine(input.engine);
    if (!engine) {
      throw new StrategyToolError("Strategy source compilation requires a valid engine payload.", "invalid_strategy_engine", 422);
    }
    strategy.engine = engine;
    return {
      engine,
      preview: buildCompilationPreview(strategy, engine)
    };
  }

  createDraft(input: { ownerAddress: HexString; marketId: HexString; name?: string; engine?: unknown }) {
    this.assertKnownMarket(input.marketId);
    this.assertOwnerAddress(input.ownerAddress);
    let strategy = createEmptyStrategyDraft(
      randomUUID(),
      input.ownerAddress,
      input.marketId,
      input.name?.trim() || "New Strategy Draft"
    );
    if (input.engine !== undefined) {
      strategy = normalizeStrategyDefinition({
        ...strategy,
        engine: input.engine
      });
    }
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

  createExecutionIntent(input: {
    ownerAddress: HexString;
    strategyId: string;
    maxSlippageBps?: number;
    validForSeconds?: number;
  }): StrategyApprovalIntent {
    this.assertOwnerAddress(input.ownerAddress);
    const strategy = this.getStrategy(input.strategyId, input.ownerAddress);
    if (strategy.status !== "saved") {
      throw new StrategyToolError(
        "Only saved strategies can be authorized for live execution.",
        "strategy_not_saved_for_execution",
        409
      );
    }
    const verifyingContract = this.getStrategyExecutorAddress();
    const maxSlippageBps = input.maxSlippageBps ?? 150;
    const nextNonce = this.nextApprovalNonce(input.ownerAddress);
    const deadline = Math.floor(Date.now() / 1000) + (input.validForSeconds ?? 15 * 60);
    const message: StrategyApprovalMessage = {
      owner: input.ownerAddress,
      strategyIdHash: hashStrategyId(strategy.id),
      strategyHash: this.computeStrategyHash(strategy),
      marketId: strategy.marketId,
      maxSlippageBps: String(maxSlippageBps),
      nonce: String(nextNonce),
      deadline: String(deadline)
    };
    const domain = {
      name: STRATEGY_EXECUTION_DOMAIN_NAME,
      version: STRATEGY_EXECUTION_DOMAIN_VERSION,
      chainId: this.options.chainId,
      verifyingContract
    } as const;

    const digest = hashTypedData({
      domain,
      types: strategyApprovalTypes,
      primaryType: STRATEGY_APPROVAL_PRIMARY_TYPE,
      message: this.toTypedApprovalMessage(message)
    });

    return {
      strategyId: strategy.id,
      strategyName: strategy.name,
      chainId: this.options.chainId,
      verifyingContract,
      primaryType: STRATEGY_APPROVAL_PRIMARY_TYPE,
      domain,
      types: strategyApprovalTypes,
      message,
      digest
    };
  }

  async saveExecutionApproval(input: {
    ownerAddress: HexString;
    strategyId: string;
    message: StrategyApprovalMessage;
    signature: HexString;
  }): Promise<StrategyApprovalRecord> {
    this.assertOwnerAddress(input.ownerAddress);
    const strategy = this.getStrategy(input.strategyId, input.ownerAddress);
    if (strategy.status !== "saved") {
      throw new StrategyToolError(
        "Only saved strategies can store a live execution approval.",
        "strategy_not_saved_for_execution",
        409
      );
    }
    const verifyingContract = this.getStrategyExecutorAddress();

    if (!isAddressEqual(input.ownerAddress, input.message.owner)) {
      throw new StrategyToolError("Approval owner does not match the connected owner.", "approval_owner_mismatch", 403);
    }
    if (input.message.marketId.toLowerCase() !== strategy.marketId.toLowerCase()) {
      throw new StrategyToolError("Approval market does not match the strategy market.", "approval_market_mismatch", 422);
    }
    if (input.message.strategyIdHash.toLowerCase() !== hashStrategyId(strategy.id).toLowerCase()) {
      throw new StrategyToolError("Approval strategy identifier does not match the current strategy.", "approval_strategy_id_mismatch", 422);
    }

    const strategyHash = this.computeStrategyHash(strategy);
    if (input.message.strategyHash.toLowerCase() !== strategyHash.toLowerCase()) {
      throw new StrategyToolError("Approval strategy hash is stale. Generate a fresh approval intent.", "stale_strategy_approval", 409);
    }

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: STRATEGY_EXECUTION_DOMAIN_NAME,
        version: STRATEGY_EXECUTION_DOMAIN_VERSION,
        chainId: this.options.chainId,
        verifyingContract
      },
      types: strategyApprovalTypes,
      primaryType: STRATEGY_APPROVAL_PRIMARY_TYPE,
      message: this.toTypedApprovalMessage(input.message),
      signature: input.signature
    });

    if (!isAddressEqual(recovered, input.ownerAddress)) {
      throw new StrategyToolError("Approval signature was not produced by the strategy owner.", "invalid_approval_signature", 403);
    }

    const now = isoNow();
    const deadlineUnix = BigInt(input.message.deadline);
    if (deadlineUnix <= BigInt(Math.floor(Date.now() / 1000))) {
      throw new StrategyToolError("Approval signature is already expired.", "expired_strategy_approval", 422);
    }

    this.db
      .prepare(
        `
          UPDATE strategy_execution_approvals
          SET status = 'superseded', updated_at = ?
          WHERE strategy_id = ? AND owner_address = ? AND status = 'active'
        `
      )
      .run(now, strategy.id, keyOf(input.ownerAddress));

    this.db
      .prepare(
        `
          INSERT INTO strategy_execution_approvals (
            id,
            strategy_id,
            owner_address,
            market_id,
            strategy_hash,
            max_slippage_bps,
            nonce,
            deadline,
            verifying_contract,
            chain_id,
            signature,
            status,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `
      )
      .run(
        randomUUID(),
        strategy.id,
        keyOf(input.ownerAddress),
        keyOf(strategy.marketId),
        strategyHash,
        Number(input.message.maxSlippageBps),
        input.message.nonce,
        input.message.deadline,
        verifyingContract,
        this.options.chainId,
        input.signature,
        now,
        now
      );

    return this.getExecutionApproval(strategy.id, input.ownerAddress);
  }

  getExecutionApproval(strategyId: string, ownerAddress: HexString): StrategyApprovalRecord {
    this.assertOwnerAddress(ownerAddress);
    const strategy = this.getStrategy(strategyId, ownerAddress);
    const row = this.db
      .prepare(
        `
          SELECT
            strategy_id,
            owner_address,
            market_id,
            strategy_hash,
            max_slippage_bps,
            nonce,
            deadline,
            verifying_contract,
          chain_id,
          signature,
          status,
          created_at,
            updated_at
          FROM strategy_execution_approvals
          WHERE strategy_id = ? AND owner_address = ? AND status = 'active'
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
      .get(strategyId, keyOf(ownerAddress)) as
      | {
          strategy_id: string;
          owner_address: string;
          market_id: string;
          strategy_hash: HexString;
          max_slippage_bps: number;
          nonce: string;
          deadline: string;
          verifying_contract: HexString;
          chain_id: number;
          signature: HexString;
          status: "active" | "superseded" | "consumed";
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      throw new StrategyToolError("No active execution approval found for this strategy.", "strategy_approval_not_found", 404);
    }

    const strategyHash = this.computeStrategyHash(strategy);
    if (row.strategy_hash.toLowerCase() !== strategyHash.toLowerCase()) {
      throw new StrategyToolError("Stored strategy approval is stale. Re-authorize the updated strategy.", "stale_strategy_approval", 409);
    }

    if (BigInt(row.deadline) <= BigInt(Math.floor(Date.now() / 1000))) {
      throw new StrategyToolError("Stored strategy approval has expired. Re-authorize the strategy.", "expired_strategy_approval", 409);
    }

    return {
      strategyId: row.strategy_id,
      ownerAddress,
      marketId: strategy.marketId,
      strategyHash: row.strategy_hash,
      maxSlippageBps: Number(row.max_slippage_bps),
      nonce: row.nonce,
      deadline: row.deadline,
      signature: row.signature,
      verifyingContract: row.verifying_contract,
      chainId: Number(row.chain_id),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  consumeExecutionApproval(input: {
    strategyId: string;
    ownerAddress: HexString;
    nonce: string;
  }) {
    this.assertOwnerAddress(input.ownerAddress);
    const now = isoNow();
    const result = this.db
      .prepare(
        `
          UPDATE strategy_execution_approvals
          SET status = 'consumed', updated_at = ?
          WHERE strategy_id = ? AND owner_address = ? AND nonce = ? AND status = 'active'
        `
      )
      .run(now, input.strategyId, keyOf(input.ownerAddress), input.nonce);

    if (Number(result.changes ?? 0) === 0) {
      throw new StrategyToolError(
        "Active execution approval not found or already consumed.",
        "strategy_approval_not_active",
        409
      );
    }
  }

  recordExecution(input: Omit<StrategyExecutionRecord, "id" | "createdAt" | "updatedAt">) {
    const now = isoNow();
    const id = randomUUID();
    this.db
      .prepare(
        `
          INSERT INTO strategy_execution_history (
            id,
            owner_address,
            strategy_id,
            strategy_name,
            market_id,
            signal,
            action,
            approval_created_at,
            approval_nonce,
            approval_tx_hash,
            status,
            from_token,
            to_token,
            amount_in_atomic,
            quoted_out_atomic,
            actual_out_atomic,
            execution_price,
            route_preference,
            swap_job_id,
            order_id,
            order_side,
            order_quantity,
            order_limit_price,
            l1_tx_hash,
            reason,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        keyOf(input.ownerAddress),
        input.strategyId,
        input.strategyName,
        keyOf(input.marketId),
        input.signal,
        input.action,
        input.approvalCreatedAt,
        input.approvalNonce,
        input.approvalTxHash ?? null,
        input.status,
        input.fromToken ? keyOf(input.fromToken) : null,
        input.toToken ? keyOf(input.toToken) : null,
        input.amountInAtomic ?? null,
        input.quotedOutAtomic ?? null,
        input.actualOutAtomic ?? null,
        input.executionPrice ?? null,
        input.routePreference ?? null,
        input.swapJobId ?? null,
        input.orderId ?? null,
        input.orderSide ?? null,
        input.orderQuantity ?? null,
        input.orderLimitPrice ?? null,
        input.l1TxHash ?? null,
        input.reason ?? null,
        now,
        now
      );

    return this.getExecutionRecord(id, input.ownerAddress);
  }

  updateExecutionRecord(
    executionId: string,
    ownerAddress: HexString,
    patch: Partial<Pick<
      StrategyExecutionRecord,
      "status" | "actualOutAtomic" | "quotedOutAtomic" | "executionPrice" | "l1TxHash" | "reason"
    >>
  ) {
    this.assertOwnerAddress(ownerAddress);
    const existing = this.getExecutionRecord(executionId, ownerAddress);
    const updatedAt = isoNow();
    this.db
      .prepare(
        `
          UPDATE strategy_execution_history
          SET
            status = ?,
            actual_out_atomic = ?,
            quoted_out_atomic = ?,
            execution_price = ?,
            l1_tx_hash = ?,
            reason = ?,
            updated_at = ?
          WHERE id = ? AND owner_address = ?
        `
      )
      .run(
        patch.status ?? existing.status,
        patch.actualOutAtomic ?? existing.actualOutAtomic ?? null,
        patch.quotedOutAtomic ?? existing.quotedOutAtomic ?? null,
        patch.executionPrice ?? existing.executionPrice ?? null,
        patch.l1TxHash ?? existing.l1TxHash ?? null,
        patch.reason ?? existing.reason ?? null,
        updatedAt,
        executionId,
        keyOf(ownerAddress)
      );

    return this.getExecutionRecord(executionId, ownerAddress);
  }

  listExecutionRecords(ownerAddress: HexString) {
    this.assertOwnerAddress(ownerAddress);
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            owner_address,
            strategy_id,
            strategy_name,
            market_id,
            signal,
            action,
            approval_created_at,
            approval_nonce,
            approval_tx_hash,
            status,
            from_token,
            to_token,
            amount_in_atomic,
            quoted_out_atomic,
            actual_out_atomic,
            execution_price,
            route_preference,
            swap_job_id,
            order_id,
            order_side,
            order_quantity,
            order_limit_price,
            l1_tx_hash,
            reason,
            created_at,
            updated_at
          FROM strategy_execution_history
          WHERE owner_address = ?
          ORDER BY created_at DESC
        `
      )
      .all(keyOf(ownerAddress)) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapExecutionRecordRow(row, ownerAddress));
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
      summary: normalizeBacktestSummary(result.summary),
      trades: result.trades.map(normalizeBacktestTrade),
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
    return normalizeBacktestSummary(JSON.parse(row.summary_json) as StrategyBacktestSummary);
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
    return rows.map((row) => normalizeBacktestTrade(JSON.parse(row.trade_json) as StrategyBacktestTrade));
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

    this.db
      .prepare(
        `
          UPDATE strategy_execution_approvals
          SET status = 'superseded', updated_at = ?
          WHERE strategy_id = ? AND status = 'active'
        `
      )
      .run(isoNow(), strategy.id);
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

  private computeStrategyHash(strategy: StrategyDefinition) {
    return hashStrategyPayload(JSON.stringify(normalizeStrategyDefinition(strategy)));
  }

  private nextApprovalNonce(ownerAddress: HexString) {
    const row = this.db
      .prepare(
        `
          SELECT COALESCE(MAX(CAST(nonce AS INTEGER)), -1) AS nonce
          FROM strategy_execution_approvals
          WHERE owner_address = ?
        `
      )
      .get(keyOf(ownerAddress)) as { nonce: number };
    return Number(row.nonce ?? -1) + 1;
  }

  private toTypedApprovalMessage(message: StrategyApprovalMessage) {
    return {
      owner: message.owner,
      strategyIdHash: message.strategyIdHash,
      strategyHash: message.strategyHash,
      marketId: message.marketId,
      maxSlippageBps: BigInt(message.maxSlippageBps),
      nonce: BigInt(message.nonce),
      deadline: BigInt(message.deadline)
    };
  }

  private getStrategyExecutorAddress() {
    const address = this.options.strategyExecutorAddress;
    if (!address || address.toLowerCase() === zeroAddress) {
      throw new StrategyToolError(
        "Strategy executor contract is not configured in this deployment.",
        "strategy_executor_not_configured",
        409
      );
    }
    return address;
  }

  private getExecutionRecord(executionId: string, ownerAddress: HexString) {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            owner_address,
            strategy_id,
            strategy_name,
            market_id,
            signal,
            action,
            approval_created_at,
            approval_nonce,
            approval_tx_hash,
            status,
            from_token,
            to_token,
            amount_in_atomic,
            quoted_out_atomic,
            actual_out_atomic,
            execution_price,
            route_preference,
            swap_job_id,
            order_id,
            order_side,
            order_quantity,
            order_limit_price,
            l1_tx_hash,
            reason,
            created_at,
            updated_at
          FROM strategy_execution_history
          WHERE id = ? AND owner_address = ?
        `
      )
      .get(executionId, keyOf(ownerAddress)) as Record<string, unknown> | undefined;

    if (!row) {
      throw new StrategyToolError("Strategy execution record not found.", "strategy_execution_not_found", 404);
    }

    return this.mapExecutionRecordRow(row, ownerAddress);
  }

  private mapExecutionRecordRow(row: Record<string, unknown>, ownerAddress: HexString): StrategyExecutionRecord {
    return {
      id: String(row.id),
      ownerAddress,
      strategyId: String(row.strategy_id),
      strategyName: String(row.strategy_name),
      marketId: row.market_id as HexString,
      signal: row.signal as StrategyExecutionRecord["signal"],
      action: row.action as StrategyExecutionRecord["action"],
      approvalCreatedAt: String(row.approval_created_at),
      approvalNonce: String(row.approval_nonce),
      approvalTxHash: (row.approval_tx_hash ?? undefined) as HexString | undefined,
      status: String(row.status),
      fromToken: (row.from_token ?? undefined) as HexString | undefined,
      toToken: (row.to_token ?? undefined) as HexString | undefined,
      amountInAtomic: (row.amount_in_atomic ?? undefined) as string | undefined,
      quotedOutAtomic: (row.quoted_out_atomic ?? undefined) as string | undefined,
      actualOutAtomic: (row.actual_out_atomic ?? undefined) as string | undefined,
      executionPrice: row.execution_price === null || row.execution_price === undefined ? undefined : Number(row.execution_price),
      routePreference: (row.route_preference ?? undefined) as "auto" | "local" | "dex" | undefined,
      swapJobId: (row.swap_job_id ?? undefined) as string | undefined,
      orderId: (row.order_id ?? undefined) as string | undefined,
      orderSide: (row.order_side ?? undefined) as "BUY" | "SELL" | undefined,
      orderQuantity: (row.order_quantity ?? undefined) as string | undefined,
      orderLimitPrice: (row.order_limit_price ?? undefined) as string | undefined,
      l1TxHash: (row.l1_tx_hash ?? undefined) as string | undefined,
      reason: (row.reason ?? undefined) as string | undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
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

      CREATE TABLE IF NOT EXISTS strategy_execution_approvals (
        id TEXT PRIMARY KEY,
        strategy_id TEXT NOT NULL,
        owner_address TEXT NOT NULL,
        market_id TEXT NOT NULL,
        strategy_hash TEXT NOT NULL,
        max_slippage_bps INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        deadline TEXT NOT NULL,
        verifying_contract TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        signature TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_strategy_execution_approvals_lookup
      ON strategy_execution_approvals(strategy_id, owner_address, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS strategy_execution_history (
        id TEXT PRIMARY KEY,
        owner_address TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        strategy_name TEXT NOT NULL,
        market_id TEXT NOT NULL,
        signal TEXT NOT NULL,
        action TEXT NOT NULL,
        approval_created_at TEXT NOT NULL,
        approval_nonce TEXT NOT NULL,
        approval_tx_hash TEXT,
        status TEXT NOT NULL,
        from_token TEXT,
        to_token TEXT,
        amount_in_atomic TEXT,
        quoted_out_atomic TEXT,
        actual_out_atomic TEXT,
        execution_price REAL,
        route_preference TEXT,
        swap_job_id TEXT,
        order_id TEXT,
        order_side TEXT,
        order_quantity TEXT,
        order_limit_price TEXT,
        l1_tx_hash TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_strategy_execution_history_owner
      ON strategy_execution_history(owner_address, created_at DESC);
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
