import { formatUnits, parseUnits } from "viem";
import type {
  HexString,
  StrategyChartOverlay,
  StrategyDefinition,
  StrategyExecutionRecord,
  StrategyExecutionStrategySummary
} from "@sinergy/shared";
import {
  buildRuntimeIndicatorSeriesMap,
  collectIndicatorReferencesFromRuntime,
  compileStrategyToRuntime,
  evaluateRuntimeCondition,
  runtimeEntryConditionForSide,
  runtimeExitConditionForSide
} from "./strategyRuntime.js";
import { compileEngineToRuntime } from "./strategySourceCompiler.js";
import { buildIndicatorOverlays, type StrategyCandle } from "./indicatorEngine.js";
import type { LiquidityRouter } from "./router.js";
import type { MatchingService } from "./matcher.js";
import type { VaultService } from "./vault.js";
import type { PriceService } from "./priceService.js";
import type { StateStore } from "./state.js";
import type { ResolvedMarket } from "../types.js";
import { StrategyService } from "./strategyService.js";
import { StrategyToolError } from "./strategyToolSecurity.js";
import { InventoryService } from "./inventory.js";

type StrategyExecutionDeps = {
  strategyService: StrategyService;
  priceService: PriceService;
  store: StateStore;
  liquidityRouter: LiquidityRouter;
  inventoryService: InventoryService;
  matchingService: MatchingService;
  vaultService: VaultService;
  markets: ResolvedMarket[];
};

type StrategySignal =
  | "long_entry"
  | "long_exit"
  | "short_entry"
  | "short_exit"
  | "none";

function keyOf(value: string) {
  return value.toLowerCase();
}

function readAtomicBalance(
  balances: Record<string, Record<string, string>>,
  ownerAddress: HexString,
  tokenAddress: HexString
) {
  return BigInt(balances[keyOf(ownerAddress)]?.[keyOf(tokenAddress)] ?? "0");
}

function normalizeDecimalAmount(value: number, decimals: number) {
  const safe = Number.isFinite(value) ? Math.max(value, 0) : 0;
  return safe.toFixed(Math.min(decimals, 8));
}

type StrategyManagedPosition = {
  basePositionAtomic: bigint;
  quoteCashFlow: number;
};

export class StrategyExecutionService {
  constructor(private readonly deps: StrategyExecutionDeps) {}

  getLiveChartOverlay(input: {
    ownerAddress: HexString;
    strategyId: string;
    candleLookback?: number;
  }): StrategyChartOverlay {
    const strategy = this.deps.strategyService.getStrategy(input.strategyId, input.ownerAddress);
    const market = this.resolveMarket(strategy.marketId);
    const candles = this.loadCandles(
      market.baseToken.symbol,
      strategy,
      input.candleLookback ?? this.liveOverlayLookback(strategy.timeframe)
    );
    const runtime = strategy.engine
      ? compileEngineToRuntime(strategy, strategy.engine)
      : compileStrategyToRuntime(strategy);
    const seriesMap = buildRuntimeIndicatorSeriesMap(candles, runtime);

    return {
      runId: `live-${strategy.id}-${candles[candles.length - 1]?.ts ?? Date.now()}`,
      strategyId: strategy.id,
      marketId: strategy.marketId,
      timeframe: strategy.timeframe,
      indicators: buildIndicatorOverlays(
        candles,
        strategy,
        seriesMap,
        collectIndicatorReferencesFromRuntime(runtime)
      ),
      markers: []
    };
  }

  inspectApprovedStrategy(input: {
    ownerAddress: HexString;
    strategyId: string;
    candleLookback?: number;
  }) {
    const strategy = this.deps.strategyService.getStrategy(input.strategyId, input.ownerAddress);
    const approval = this.deps.strategyService.getExecutionApproval(input.strategyId, input.ownerAddress);
    const market = this.resolveMarket(strategy.marketId);
    const candles = this.loadCandles(market.baseToken.symbol, strategy, input.candleLookback ?? 240);
    const balances = this.deps.store.get().balances;
    const baseBalanceAtomic = readAtomicBalance(balances, input.ownerAddress, market.baseToken.address);
    const quoteBalanceAtomic = readAtomicBalance(balances, input.ownerAddress, market.quoteToken.address);
    const managedPosition = this.getManagedPosition(input.ownerAddress, input.strategyId, market);
    const signal = this.resolveSignal(strategy, candles, {
      hasManagedLongPosition: managedPosition.basePositionAtomic > 0n
    });

    return {
      strategy,
      approval,
      market,
      candles,
      signal,
      baseBalanceAtomic,
      quoteBalanceAtomic,
      managedBasePositionAtomic: managedPosition.basePositionAtomic,
      lastCandleTs: candles[candles.length - 1]?.ts
    };
  }

  async executeApprovedStrategy(input: {
    ownerAddress: HexString;
    strategyId: string;
    routePreference?: "auto" | "local" | "dex";
    candleLookback?: number;
    consumeApproval?: boolean;
  }) {
    const inspection = this.inspectApprovedStrategy(input);
    const { strategy, approval, market, signal, lastCandleTs, managedBasePositionAtomic } = inspection;
    const balances = this.deps.store.get().balances;
    const baseBalanceAtomic = readAtomicBalance(balances, input.ownerAddress, market.baseToken.address);
    const quoteBalanceAtomic = readAtomicBalance(balances, input.ownerAddress, market.quoteToken.address);

    if (signal === "short_entry" || signal === "short_exit") {
      throw new StrategyToolError(
        "Short execution is not supported yet for live strategy execution.",
        "short_execution_not_supported",
        409
      );
    }

    const plan = this.buildExecutionPlan({
      signal,
      strategy,
      market,
      managedBasePositionAtomic,
      baseBalanceAtomic,
      quoteBalanceAtomic,
      routePreference: input.routePreference ?? "auto"
    });

    if (plan.kind === "no_action") {
      const record = this.deps.strategyService.recordExecution({
        ownerAddress: input.ownerAddress,
        strategyId: strategy.id,
        strategyName: strategy.name,
        marketId: market.id,
        signal,
        action: "no_action",
        approvalCreatedAt: approval.createdAt,
        approvalNonce: approval.nonce,
        status: "no_action",
        reason: plan.reason
      });
      return {
        strategyId: strategy.id,
        signal,
        action: "no_action" as const,
        reason: plan.reason,
        marketId: market.id,
        executionId: record.id,
        candleTs: lastCandleTs
      };
    }

    let approvalTxHash: HexString | undefined;
    if (input.consumeApproval !== false) {
      approvalTxHash = await this.deps.vaultService.consumeStrategyApproval({
        approval,
        ownerAddress: input.ownerAddress,
        marketId: market.id
      });
      this.deps.strategyService.consumeExecutionApproval({
        strategyId: strategy.id,
        ownerAddress: input.ownerAddress,
        nonce: approval.nonce
      });
    }

    if (plan.kind === "router_swap") {
      const result = await this.deps.liquidityRouter.execute({
        userAddress: input.ownerAddress,
        marketId: market.id,
        fromToken: plan.fromToken,
        amount: plan.amount,
        routePreference: plan.routePreference
      });

      const executionPrice = this.computeExecutionPrice({
        market,
        fromToken: plan.fromToken,
        amountInAtomic: parseUnits(plan.amount, this.resolveTokenDecimals(market, plan.fromToken)),
        outAtomic: BigInt(result.quote.quotedOutAtomic)
      });
      const record = this.deps.strategyService.recordExecution({
        ownerAddress: input.ownerAddress,
        strategyId: strategy.id,
        strategyName: strategy.name,
        marketId: market.id,
        signal,
        action: "router_swap",
        approvalCreatedAt: approval.createdAt,
        approvalNonce: approval.nonce,
        approvalTxHash,
        status: result.status,
        fromToken: plan.fromToken,
        toToken: plan.fromToken.toLowerCase() === market.baseToken.address.toLowerCase()
          ? market.quoteToken.address
          : market.baseToken.address,
        amountInAtomic: parseUnits(plan.amount, this.resolveTokenDecimals(market, plan.fromToken)).toString(),
        quotedOutAtomic: result.quote.quotedOutAtomic,
        actualOutAtomic: result.settledOutAtomic ?? undefined,
        executionPrice,
        routePreference: plan.routePreference,
        swapJobId: result.jobId ?? undefined
      });

      return {
        strategyId: strategy.id,
        signal,
        action: "router_swap" as const,
        executionId: record.id,
        approvalTxHash,
        marketId: market.id,
        fromToken: plan.fromToken,
        amount: plan.amount,
        result,
        candleTs: lastCandleTs
      };
    }
  }

  listExecutionHistory(ownerAddress: HexString) {
    const records = this.deps.strategyService.listExecutionRecords(ownerAddress).map((record) =>
      this.enrichExecutionRecord(ownerAddress, record)
    );

    const grouped = new Map<string, StrategyExecutionRecord[]>();
    for (const record of records) {
      const current = grouped.get(record.strategyId) ?? [];
      current.push(record);
      grouped.set(record.strategyId, current);
    }

    const strategies: StrategyExecutionStrategySummary[] = [...grouped.entries()].map(([strategyId, strategyRecords]) => {
      const sorted = [...strategyRecords].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      );
      const executableRecords = sorted.filter((record) => record.action !== "no_action");
      const market = this.resolveMarket(sorted[0]!.marketId);
      const managedPosition = this.getManagedPositionFromRecords(sorted, market);
      let hasPending = false;

      for (const record of sorted) {
        if (record.status !== "completed" && record.status !== "failed" && record.status !== "no_action") {
          hasPending = true;
        }
      }

      const currentPrice = Number(this.deps.priceService.getReferencePrice(market.baseToken.symbol));
      const currentPnlQuote =
        Number.isFinite(currentPrice)
          ? managedPosition.quoteCashFlow +
            (Number(formatUnits(managedPosition.basePositionAtomic, market.baseToken.decimals)) * currentPrice)
          : undefined;

      const summaryStatus: StrategyExecutionStrategySummary["status"] =
        hasPending ? "pending" : managedPosition.basePositionAtomic > 0n ? "active" : "idle";

      return {
        strategyId,
        strategyName: sorted[0]!.strategyName,
        marketId: sorted[0]!.marketId,
        marketSymbol: market.symbol,
        startedAt: sorted[0]!.approvalCreatedAt,
        lastTradeAt: executableRecords[executableRecords.length - 1]?.createdAt,
        status: summaryStatus,
        tradesCount: executableRecords.length,
        currentPositionBase: formatUnits(managedPosition.basePositionAtomic, market.baseToken.decimals),
        currentPnlQuote,
        currentPrice
      };
    }).sort((left, right) => right.startedAt.localeCompare(left.startedAt));

    return {
      strategies,
      trades: records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    };
  }

  private buildExecutionPlan(input: {
    signal: StrategySignal;
    strategy: StrategyDefinition;
    market: ResolvedMarket;
    managedBasePositionAtomic: bigint;
    baseBalanceAtomic: bigint;
    quoteBalanceAtomic: bigint;
    routePreference: "auto" | "local" | "dex";
  }) {
    const referencePrice = Number(
      this.deps.priceService.getReferencePrice(input.market.baseToken.symbol)
    );

    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
      throw new StrategyToolError("Reference price is unavailable for this market.", "reference_price_unavailable", 503);
    }

    if (input.signal === "none") {
      return {
        kind: "no_action" as const,
        reason: "No executable live signal was produced on the latest candle."
      };
    }

    if (!input.market.routeable) {
      return {
        kind: "no_action" as const,
        reason: "Live strategy execution only supports router-enabled markets with routed liquidity."
      };
    }

    if (input.signal === "long_entry") {
      if (input.managedBasePositionAtomic > 0n) {
        return {
          kind: "no_action" as const,
          reason: "This live strategy already has an open managed long position, so no new long entry was placed."
        };
      }

      const quoteAmountAtomic = this.resolveEntryQuoteAmountAtomic(
        input.strategy,
        input.market,
        input.quoteBalanceAtomic,
        referencePrice
      );

      if (quoteAmountAtomic <= 0n) {
        return {
          kind: "no_action" as const,
          reason: "The strategy signal is long, but there is not enough quote balance to execute it."
        };
      }

      return {
        kind: "router_swap" as const,
        fromToken: input.market.quoteToken.address,
        amount: formatUnits(quoteAmountAtomic, input.market.quoteToken.decimals),
        routePreference: input.routePreference
      };
    }

    if (input.signal === "long_exit") {
      if (input.managedBasePositionAtomic <= 0n) {
        return {
          kind: "no_action" as const,
          reason: "The strategy wants to exit long, but it does not have an open live position to close."
        };
      }

      if (input.baseBalanceAtomic < input.managedBasePositionAtomic) {
        return {
          kind: "no_action" as const,
          reason: "The strategy has an open live position, but the wallet no longer holds enough base inventory to close it."
        };
      }

      return {
        kind: "router_swap" as const,
        fromToken: input.market.baseToken.address,
        amount: formatUnits(input.managedBasePositionAtomic, input.market.baseToken.decimals),
        routePreference: input.routePreference
      };
    }

    return {
      kind: "no_action" as const,
      reason: "This signal is not executable in the current live execution mode."
    };
  }

  private resolveEntryQuoteAmountAtomic(
    strategy: StrategyDefinition,
    market: ResolvedMarket,
    quoteBalanceAtomic: bigint,
    referencePrice: number
  ) {
    if (strategy.sizing.mode === "fixed_quote_notional") {
      const desired = parseUnits(normalizeDecimalAmount(strategy.sizing.value, market.quoteToken.decimals), market.quoteToken.decimals);
      return desired < quoteBalanceAtomic ? desired : quoteBalanceAtomic;
    }

    const quoteBalance = Number(formatUnits(quoteBalanceAtomic, market.quoteToken.decimals));
    const totalEquityQuote = quoteBalance;
    const desiredQuote = totalEquityQuote * (strategy.sizing.value / 100);
    const desiredAtomic = parseUnits(
      normalizeDecimalAmount(desiredQuote, market.quoteToken.decimals),
      market.quoteToken.decimals
    );
    return desiredAtomic < quoteBalanceAtomic ? desiredAtomic : quoteBalanceAtomic;
  }

  private resolveSignal(
    strategy: StrategyDefinition,
    candles: StrategyCandle[],
    state?: {
      hasManagedLongPosition?: boolean;
    }
  ): StrategySignal {
    if (candles.length < 2) {
      throw new StrategyToolError("Not enough candles to evaluate a live strategy signal.", "insufficient_live_candles", 422);
    }

    const runtime = strategy.engine
      ? compileEngineToRuntime(strategy, strategy.engine)
      : compileStrategyToRuntime(strategy);
    const seriesMap = buildRuntimeIndicatorSeriesMap(candles, runtime);
    const index = candles.length - 1;

    const longEntry = strategy.enabledSides.includes("long")
      ? evaluateRuntimeCondition(runtimeEntryConditionForSide(runtime, "long"), candles, seriesMap, index)
      : false;
    const longExit = strategy.enabledSides.includes("long")
      ? evaluateRuntimeCondition(runtimeExitConditionForSide(runtime, "long"), candles, seriesMap, index)
      : false;
    const shortEntry = strategy.enabledSides.includes("short")
      ? evaluateRuntimeCondition(runtimeEntryConditionForSide(runtime, "short"), candles, seriesMap, index)
      : false;
    const shortExit = strategy.enabledSides.includes("short")
      ? evaluateRuntimeCondition(runtimeExitConditionForSide(runtime, "short"), candles, seriesMap, index)
      : false;
    const hasManagedLongPosition = Boolean(state?.hasManagedLongPosition);

    if (longEntry && !longExit && !shortEntry) return "long_entry";
    if (longExit && !longEntry && hasManagedLongPosition) return "long_exit";
    if (shortEntry && !shortExit && !longEntry) return "short_entry";
    if (shortExit && !shortEntry) return "short_exit";
    return "none";
  }

  private getManagedPosition(ownerAddress: HexString, strategyId: string, market: ResolvedMarket): StrategyManagedPosition {
    const records = this.deps.strategyService
      .listExecutionRecords(ownerAddress)
      .filter((record) => record.strategyId === strategyId)
      .map((record) => this.enrichExecutionRecord(ownerAddress, record));

    return this.getManagedPositionFromRecords(records, market);
  }

  private getManagedPositionFromRecords(
    records: StrategyExecutionRecord[],
    market: ResolvedMarket
  ): StrategyManagedPosition {
    let basePositionAtomic = 0n;
    let quoteCashFlow = 0;

    for (const record of records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      if (record.action !== "router_swap" || record.status !== "completed" || !record.amountInAtomic) {
        continue;
      }

      const fromToken = record.fromToken?.toLowerCase();
      const toToken = record.toToken?.toLowerCase();
      const baseToken = market.baseToken.address.toLowerCase();
      const quoteToken = market.quoteToken.address.toLowerCase();

      if (fromToken === quoteToken && toToken === baseToken) {
        const baseOutAtomic = BigInt(record.actualOutAtomic ?? record.quotedOutAtomic ?? "0");
        basePositionAtomic += baseOutAtomic;
        quoteCashFlow -= Number(formatUnits(BigInt(record.amountInAtomic), market.quoteToken.decimals));
        continue;
      }

      if (fromToken === baseToken && toToken === quoteToken) {
        const baseInAtomic = BigInt(record.amountInAtomic);
        if (basePositionAtomic <= 0n) {
          continue;
        }

        const normalizedBaseInAtomic = baseInAtomic > basePositionAtomic ? basePositionAtomic : baseInAtomic;
        const normalizedQuoteOutAtomic = this.scaleAtomicAmount(
          BigInt(record.actualOutAtomic ?? record.quotedOutAtomic ?? "0"),
          normalizedBaseInAtomic,
          baseInAtomic
        );

        basePositionAtomic -= normalizedBaseInAtomic;
        quoteCashFlow += Number(formatUnits(normalizedQuoteOutAtomic, market.quoteToken.decimals));
      }
    }

    return {
      basePositionAtomic,
      quoteCashFlow
    };
  }

  private scaleAtomicAmount(totalAtomicOut: bigint, partialAtomicIn: bigint, fullAtomicIn: bigint) {
    if (fullAtomicIn <= 0n) {
      return 0n;
    }
    return (totalAtomicOut * partialAtomicIn) / fullAtomicIn;
  }

  private loadCandles(symbol: string, strategy: StrategyDefinition, limit: number) {
    return this.deps.priceService.getCandles(symbol, strategy.timeframe, limit).map((bar) => ({
      ts: Number(bar.ts),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume)
    }));
  }

  private liveOverlayLookback(timeframe: StrategyDefinition["timeframe"]) {
    switch (timeframe) {
      case "1m":
        return 720;
      case "5m":
        return 1440;
      case "15m":
        return 1920;
      case "1h":
        return 1440;
      case "4h":
        return 1080;
      case "1d":
        return 730;
    }
  }

  private resolveMarket(marketId: HexString) {
    const market = this.deps.markets.find((entry) => entry.id.toLowerCase() === marketId.toLowerCase());
    if (!market) {
      throw new StrategyToolError("Strategy market is not available for live execution.", "invalid_strategy_execution_market", 422);
    }
    return market;
  }

  private resolveTokenDecimals(market: ResolvedMarket, tokenAddress: HexString) {
    if (tokenAddress.toLowerCase() === market.baseToken.address.toLowerCase()) {
      return market.baseToken.decimals;
    }
    return market.quoteToken.decimals;
  }

  private computeExecutionPrice(input: {
    market: ResolvedMarket;
    fromToken: HexString;
    amountInAtomic: bigint;
    outAtomic: bigint;
  }) {
    if (input.outAtomic <= 0n) {
      return undefined;
    }

    const fromIsQuote = input.fromToken.toLowerCase() === input.market.quoteToken.address.toLowerCase();
    if (fromIsQuote) {
      const quoteIn = Number(formatUnits(input.amountInAtomic, input.market.quoteToken.decimals));
      const baseOut = Number(formatUnits(input.outAtomic, input.market.baseToken.decimals));
      return baseOut > 0 ? quoteIn / baseOut : undefined;
    }

    const baseIn = Number(formatUnits(input.amountInAtomic, input.market.baseToken.decimals));
    const quoteOut = Number(formatUnits(input.outAtomic, input.market.quoteToken.decimals));
    return baseIn > 0 ? quoteOut / baseIn : undefined;
  }

  private enrichExecutionRecord(ownerAddress: HexString, record: StrategyExecutionRecord): StrategyExecutionRecord {
    if (record.action === "router_swap" && record.swapJobId) {
      const job = this.deps.inventoryService.getSwapJob(record.swapJobId);
      if (job) {
        const rebalance = this.deps.inventoryService
          .listJobs()
          .rebalances.find((item) => item.linkedSwapJobId === record.swapJobId);
        const market = this.resolveMarket(record.marketId);
        const actualOutAtomic = rebalance?.actualAmountOutAtomic ?? job.quotedOutAtomic ?? record.actualOutAtomic;
        return this.deps.strategyService.updateExecutionRecord(record.id, ownerAddress, {
          status: job.state,
          actualOutAtomic,
          quotedOutAtomic: job.quotedOutAtomic,
          executionPrice: record.amountInAtomic && actualOutAtomic
            ? this.computeExecutionPrice({
                market,
                fromToken: record.fromToken!,
                amountInAtomic: BigInt(record.amountInAtomic),
                outAtomic: BigInt(actualOutAtomic)
              })
            : record.executionPrice,
          l1TxHash: rebalance?.l1TxHash,
          reason: job.error
        });
      }
    }

    return record;
  }
}
