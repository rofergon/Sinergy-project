import type {
  CanonicalAssetConfig,
  RebalanceJobState,
  ResolvedMarket,
  ResolvedToken,
  RebalanceJob,
  RouterInventoryPosition,
  RouterMarketConfig,
  SwapJob
} from "../types.js";
import { StateStore } from "./state.js";
import {
  addAtomic,
  addInventoryAtomic,
  getAtomic,
  keyOf,
  nowIso,
  readInventoryAtomic,
  setInventoryAtomic
} from "./routerUtils.js";

type InventoryDeps = {
  store: StateStore;
  tokens: Map<string, ResolvedToken>;
  markets: ResolvedMarket[];
  canonicalAssets: Map<string, CanonicalAssetConfig>;
  routerMarkets: Map<string, RouterMarketConfig>;
  bootstrapInventory: Record<string, string>;
};

export class InventoryService {
  constructor(private readonly deps: InventoryDeps) {
    this.bootstrap();
  }

  getMarketPolicy(market: ResolvedMarket) {
    const config = this.deps.routerMarkets.get(keyOf(market.symbol));
    const base = this.deps.canonicalAssets.get(keyOf(market.baseToken.symbol));
    const quote = this.deps.canonicalAssets.get(keyOf(market.quoteToken.symbol));
    const routeable = Boolean(config && base && quote);
    return {
      routeable,
      routePolicy: routeable ? "router-enabled" : "dark-pool-only"
    } as const;
  }

  getInventory() {
    const state = this.deps.store.get();
    const positions: RouterInventoryPosition[] = [];

    for (const token of this.deps.tokens.values()) {
      const config = this.deps.canonicalAssets.get(keyOf(token.symbol));
      positions.push({
        symbol: token.symbol,
        tokenAddress: token.address,
        amountAtomic: readInventoryAtomic(state.routerInventory, token.symbol).toString(),
        minAtomic: config?.minInventoryAtomic ?? "0",
        targetAtomic: config?.targetInventoryAtomic ?? "0",
        maxAtomic: config?.maxInventoryAtomic ?? "0",
        routeable: Boolean(config)
      });
    }

    return positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  getRouteConfigForMarket(market: ResolvedMarket) {
    const marketConfig = this.deps.routerMarkets.get(keyOf(market.symbol));
    const baseAsset = this.deps.canonicalAssets.get(keyOf(market.baseToken.symbol));
    const quoteAsset = this.deps.canonicalAssets.get(keyOf(market.quoteToken.symbol));

    if (!marketConfig || !baseAsset || !quoteAsset) {
      return null;
    }

    return {
      market: marketConfig,
      baseAsset,
      quoteAsset
    };
  }

  getLocalCapacity(symbol: string): bigint {
    return readInventoryAtomic(this.deps.store.get().routerInventory, symbol);
  }

  applyInstantSwap(input: {
    inputSymbol: string;
    outputSymbol: string;
    inputAmountAtomic: bigint;
    outputAmountAtomic: bigint;
  }) {
    this.deps.store.mutate((state) => {
      addInventoryAtomic(state.routerInventory, input.inputSymbol, input.inputAmountAtomic);
      addInventoryAtomic(state.routerInventory, input.outputSymbol, -input.outputAmountAtomic);
    });
  }

  ensureRebalanceForDrift(input: {
    market: ResolvedMarket;
    inputSymbol: string;
    outputSymbol: string;
    amountInAtomic: bigint;
    minAmountOutAtomic: bigint;
  }): RebalanceJob | null {
    const outputAsset = this.deps.canonicalAssets.get(keyOf(input.outputSymbol));
    const inputAsset = this.deps.canonicalAssets.get(keyOf(input.inputSymbol));
    if (!outputAsset || !inputAsset) {
      return null;
    }

    const outputNow = this.getLocalCapacity(input.outputSymbol);
    const outputTarget = BigInt(outputAsset.targetInventoryAtomic);
    const outputMin = BigInt(outputAsset.minInventoryAtomic);
    const inputNow = this.getLocalCapacity(input.inputSymbol);
    const inputMax = BigInt(inputAsset.maxInventoryAtomic);
    const inputTarget = BigInt(inputAsset.targetInventoryAtomic);

    if (outputNow >= outputMin && inputNow <= inputMax) {
      return null;
    }

    const deficit = outputNow < outputTarget ? outputTarget - outputNow : 0n;
    const excess = inputNow > inputMax ? inputNow - inputTarget : 0n;
    const amountInAtomic = deficit > 0n ? deficit : excess > 0n ? excess : input.amountInAtomic;

    return this.deps.store.mutate((state) => {
      const job: RebalanceJob = {
        id: crypto.randomUUID(),
        marketId: input.market.id,
        marketSymbol: input.market.symbol,
        state: "queued",
        reason: outputNow < outputMin ? "inventory_low" : "inventory_high",
        inputSymbol: input.inputSymbol,
        outputSymbol: input.outputSymbol,
        amountInAtomic: amountInAtomic.toString(),
        minAmountOutAtomic: input.minAmountOutAtomic.toString(),
        createdAt: nowIso(),
        updatedAt: nowIso()
      };

      state.rebalanceJobs.push(job);
      return job;
    });
  }

  createAsyncSwapJob(input: Omit<SwapJob, "id" | "createdAt" | "updatedAt" | "state" | "settleImmediately">) {
    return this.deps.store.mutate((state) => {
      const lockedAlready = getAtomic(state.balances, input.userAddress, input.fromToken);
      const amountInAtomic = BigInt(input.amountInAtomic);
      if (lockedAlready < amountInAtomic) {
        throw new Error("Insufficient available balance for async router swap");
      }

      addAtomic(state.balances, input.userAddress, input.fromToken, -amountInAtomic);
      addAtomic(state.locked, input.userAddress, input.fromToken, amountInAtomic);

      const job: SwapJob = {
        ...input,
        id: crypto.randomUUID(),
        state: "queued",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        settleImmediately: false
      };

      state.swapJobs.push(job);
      const rebalanceJob: RebalanceJob = {
        id: crypto.randomUUID(),
        marketId: input.marketId,
        marketSymbol: input.marketSymbol,
        state: "queued",
        reason: "user_async_swap",
        inputSymbol: input.fromSymbol,
        outputSymbol: input.toSymbol,
        amountInAtomic: input.amountInAtomic,
        minAmountOutAtomic: input.minOutAtomic,
        linkedSwapJobId: job.id,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      state.rebalanceJobs.push(rebalanceJob);
      return job;
    });
  }

  getSwapJob(jobId: string) {
    return this.deps.store.get().swapJobs.find((job) => job.id === jobId) ?? null;
  }

  listJobs() {
    const state = this.deps.store.get();
    return {
      swaps: state.swapJobs,
      rebalances: state.rebalanceJobs
    };
  }

  updateRebalanceJob(jobId: string, updater: (job: RebalanceJob) => void) {
    this.deps.store.mutate((state) => {
      const job = state.rebalanceJobs.find((item) => item.id === jobId);
      if (!job) return;
      updater(job);
      job.updatedAt = nowIso();
    });
  }

  updateSwapJob(jobId: string, updater: (job: SwapJob) => void) {
    this.deps.store.mutate((state) => {
      const job = state.swapJobs.find((item) => item.id === jobId);
      if (!job) return;
      updater(job);
      job.updatedAt = nowIso();
    });
  }

  settleAsyncSwap(jobId: string, outAmountAtomic: bigint) {
    this.deps.store.mutate((state) => {
      const job = state.swapJobs.find((item) => item.id === jobId);
      if (!job) return;

      addAtomic(state.locked, job.userAddress, job.fromToken, -BigInt(job.amountInAtomic));
      addAtomic(state.balances, job.userAddress, job.toToken, outAmountAtomic);
      job.state = "completed";
      job.quotedOutAtomic = outAmountAtomic.toString();
      job.updatedAt = nowIso();
    });
  }

  failSwap(jobId: string, message: string) {
    this.deps.store.mutate((state) => {
      const job = state.swapJobs.find((item) => item.id === jobId);
      if (!job) return;

      addAtomic(state.locked, job.userAddress, job.fromToken, -BigInt(job.amountInAtomic));
      addAtomic(state.balances, job.userAddress, job.fromToken, BigInt(job.amountInAtomic));
      job.state = "failed";
      job.error = message;
      job.updatedAt = nowIso();
    });
  }

  markSwapState(jobId: string, state: RebalanceJobState) {
    this.updateSwapJob(jobId, (job) => {
      job.state = state;
    });
  }

  settleRebalanceInventory(jobId: string) {
    this.deps.store.mutate((state) => {
      const job = state.rebalanceJobs.find((item) => item.id === jobId);
      if (!job) return;

      addInventoryAtomic(state.routerInventory, job.inputSymbol, -BigInt(job.amountInAtomic));
      addInventoryAtomic(
        state.routerInventory,
        job.outputSymbol,
        BigInt(job.actualAmountOutAtomic ?? job.minAmountOutAtomic)
      );
      job.state = "completed";
      job.updatedAt = nowIso();
    });
  }

  initializeInventoryFromBootstrap() {
    this.deps.store.mutate((state) => {
      for (const [symbol, value] of Object.entries(this.deps.bootstrapInventory)) {
        if (!(keyOf(symbol) in state.routerInventory)) {
          setInventoryAtomic(state.routerInventory, symbol, BigInt(value));
        }
      }
    });
  }

  private bootstrap() {
    this.initializeInventoryFromBootstrap();
  }
}
