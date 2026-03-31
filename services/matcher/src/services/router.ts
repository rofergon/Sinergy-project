import { parseUnits } from "viem";
import type {
  BridgeHealth,
  ResolvedMarket,
  ResolvedToken,
  RouteMode,
  SwapQuote
} from "../types.js";
import { PriceService } from "./priceService.js";
import { InventoryService } from "./inventory.js";
import { InitiaDexClient } from "./initiaDex.js";
import { BridgeHealthService } from "./bridgeHealth.js";
import { StateStore } from "./state.js";
import { addAtomic, getAtomic, keyOf, nowIso, scaleAtomic } from "./routerUtils.js";

type RouterDeps = {
  store: StateStore;
  markets: ResolvedMarket[];
  priceService: PriceService;
  inventoryService: InventoryService;
  initiaDexClient: InitiaDexClient;
  bridgeHealthService: BridgeHealthService;
  quoteSpreadBps: number;
  maxLocalFillUsd: number;
};

export class LiquidityRouter {
  constructor(private readonly deps: RouterDeps) {}

  async quote(input: {
    userAddress: `0x${string}`;
    marketId: `0x${string}`;
    fromToken: `0x${string}`;
    amount: string;
  }): Promise<SwapQuote> {
    const market = this.mustFindMarket(input.marketId);
    const fromToken = this.mustResolveToken(market, input.fromToken);
    const toToken = this.otherToken(market, fromToken.address);
    const routeConfig = this.deps.inventoryService.getRouteConfigForMarket(market);
    const routeable = Boolean(routeConfig);
    const bridge = await this.deps.bridgeHealthService.getStatus();
    const expiry = new Date(Date.now() + 30_000).toISOString();

    if (!routeable || !routeConfig) {
      return {
        mode: "unsupported_asset",
        expiry,
        routeable: false,
        quotedOutAtomic: "0",
        minOutAtomic: "0",
        sourceBreakdown: {
          localInventoryAtomic: "0",
          l1DexAtomic: "0",
          inventoryStatus: "unsupported"
        },
        bridge,
        marketSymbol: market.symbol,
        fromSymbol: fromToken.symbol,
        toSymbol: toToken.symbol
      };
    }

    const amountAtomic = parseUnits(input.amount, fromToken.decimals);
    const l1DexAtomic = await this.simulateOnL1(routeConfig, fromToken, toToken, amountAtomic);
    const spreadAdjusted = (l1DexAtomic * BigInt(10_000 - this.deps.quoteSpreadBps)) / 10_000n;
    const localInventoryAtomic = this.deps.inventoryService.getLocalCapacity(toToken.symbol);
    const withinNotional = this.withinMaxLocalFill(market, fromToken, amountAtomic);

    let mode: RouteMode = "async_rebalance_required";
    if (bridge.ready && localInventoryAtomic >= spreadAdjusted && withinNotional) {
      mode = "instant_local";
    }

    return {
      mode,
      expiry,
      routeable: true,
      quotedOutAtomic: l1DexAtomic.toString(),
      minOutAtomic: spreadAdjusted.toString(),
      sourceBreakdown: {
        localInventoryAtomic: localInventoryAtomic.toString(),
        l1DexAtomic: l1DexAtomic.toString(),
        inventoryStatus: localInventoryAtomic >= spreadAdjusted ? "healthy" : "low"
      },
      bridge,
      marketSymbol: market.symbol,
      fromSymbol: fromToken.symbol,
      toSymbol: toToken.symbol
    };
  }

  async execute(input: {
    userAddress: `0x${string}`;
    marketId: `0x${string}`;
    fromToken: `0x${string}`;
    amount: string;
  }) {
    const market = this.mustFindMarket(input.marketId);
    const fromToken = this.mustResolveToken(market, input.fromToken);
    const toToken = this.otherToken(market, fromToken.address);
    const quote = await this.quote(input);
    const amountAtomic = parseUnits(input.amount, fromToken.decimals);
    const available = getAtomic(this.deps.store.get().balances, input.userAddress, fromToken.address);

    if (available < amountAtomic) {
      throw new Error("Insufficient available balance for router swap");
    }

    if (quote.mode === "unsupported_asset") {
      throw new Error("This market is dark-pool only");
    }

    if (quote.mode === "instant_local") {
      this.deps.store.mutate((state) => {
        addAtomic(state.balances, input.userAddress, fromToken.address, -amountAtomic);
        addAtomic(state.balances, input.userAddress, toToken.address, BigInt(quote.minOutAtomic));
      });

      this.deps.inventoryService.applyInstantSwap({
        inputSymbol: fromToken.symbol,
        outputSymbol: toToken.symbol,
        inputAmountAtomic: amountAtomic,
        outputAmountAtomic: BigInt(quote.minOutAtomic)
      });

      const rebalanceJob = this.deps.inventoryService.ensureRebalanceForDrift({
        market,
        inputSymbol: fromToken.symbol,
        outputSymbol: toToken.symbol,
        amountInAtomic: amountAtomic,
        minAmountOutAtomic: BigInt(quote.minOutAtomic)
      });

      return {
        mode: quote.mode,
        status: "completed" as const,
        quote,
        jobId: null,
        settledOutAtomic: quote.minOutAtomic,
        executedAt: nowIso()
      };
    }

    const job = this.deps.inventoryService.createAsyncSwapJob({
      userAddress: input.userAddress,
      marketId: market.id,
      marketSymbol: market.symbol,
      fromToken: fromToken.address,
      toToken: toToken.address,
      fromSymbol: fromToken.symbol,
      toSymbol: toToken.symbol,
      amountInAtomic: amountAtomic.toString(),
      quotedOutAtomic: quote.quotedOutAtomic,
      minOutAtomic: quote.minOutAtomic,
      mode: quote.mode
    });

    return {
      mode: quote.mode,
      status: "rebalancing" as const,
      quote,
      jobId: job.id,
      settledOutAtomic: null,
      executedAt: nowIso()
    };
  }

  private async simulateOnL1(
    routeConfig: NonNullable<ReturnType<InventoryService["getRouteConfigForMarket"]>>,
    fromToken: ResolvedToken,
    toToken: ResolvedToken,
    amountAtomic: bigint
  ) {
    const offerAsset =
      keyOf(fromToken.symbol) === keyOf(routeConfig.baseAsset.localSymbol)
        ? routeConfig.baseAsset
        : routeConfig.quoteAsset;
    const returnAsset =
      keyOf(toToken.symbol) === keyOf(routeConfig.baseAsset.localSymbol)
        ? routeConfig.baseAsset
        : routeConfig.quoteAsset;
    const l1OfferAtomic = scaleAtomic(
      amountAtomic,
      fromToken.decimals,
      offerAsset.l1Decimals
    );
    const l1OutAtomic = await this.deps.initiaDexClient.simulateSwap({
      market: routeConfig.market,
      offerAsset,
      offerAmountAtomic: l1OfferAtomic
    });
    return scaleAtomic(l1OutAtomic, returnAsset.l1Decimals, toToken.decimals);
  }

  private withinMaxLocalFill(
    market: ResolvedMarket,
    fromToken: ResolvedToken,
    amountAtomic: bigint
  ) {
    const price = Number(this.deps.priceService.getReferencePrice(market.baseToken.symbol));
    const amount = Number(amountAtomic) / 10 ** fromToken.decimals;
    const notional =
      keyOf(fromToken.address) === keyOf(market.quoteToken.address) ? amount : amount * price;
    return notional <= this.deps.maxLocalFillUsd;
  }

  private mustFindMarket(marketId: `0x${string}`) {
    const market = this.deps.markets.find((item) => item.id === marketId);
    if (!market) {
      throw new Error("Market not found");
    }

    return market;
  }

  private mustResolveToken(market: ResolvedMarket, token: `0x${string}`) {
    if (keyOf(market.baseToken.address) === keyOf(token)) return market.baseToken;
    if (keyOf(market.quoteToken.address) === keyOf(token)) return market.quoteToken;
    throw new Error("Token is not part of this market");
  }

  private otherToken(market: ResolvedMarket, token: `0x${string}`) {
    return keyOf(market.baseToken.address) === keyOf(token)
      ? market.quoteToken
      : market.baseToken;
  }
}
