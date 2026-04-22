import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HexString, StrategyDefinition } from "@sinergy/shared";
import { privateKeyToAccount } from "viem/accounts";
import { StateStore } from "./services/state.js";
import { StrategyService } from "./services/strategyService.js";
import { StrategyExecutionService } from "./services/strategyExecution.js";
import type { ResolvedMarket, ResolvedToken } from "./types.js";
import { StrategyToolError } from "./services/strategyToolSecurity.js";

function makeToken(symbol: string, address: HexString): ResolvedToken {
  return {
    symbol,
    name: symbol,
    address,
    decimals: 6,
    kind: symbol === "cUSDC" ? "quote" : "crypto"
  };
}

test("approved live strategy execution consumes approval and routes a long entry through the router", async () => {
  const root = mkdtempSync(join(tmpdir(), "sinergy-strategy-exec-"));
  const ownerPk = "0x00000000000000000000000000000000000000000000000000000000000000c3";
  const ownerAccount = privateKeyToAccount(ownerPk);
  const ownerAddress = ownerAccount.address as HexString;
  const base = makeToken("cINIT", "0x00000000000000000000000000000000000000a1");
  const quote = makeToken("cUSDC", "0x00000000000000000000000000000000000000b2");
  const market: ResolvedMarket = {
    id: "0x0000000000000000000000000000000000000000000000000000000000000111",
    symbol: "cINIT/cUSDC",
    baseToken: base,
    quoteToken: quote,
    routeable: true,
    routePolicy: "router-enabled"
  };
  const priceService = {
    getCandles: () => [
      { ts: 1, open: 9.8, high: 10.1, low: 9.7, close: 9.9, volume: 10 },
      { ts: 2, open: 9.9, high: 10.4, low: 9.8, close: 10.2, volume: 11 },
      { ts: 3, open: 10.2, high: 11.2, low: 10.1, close: 11.0, volume: 12 },
      { ts: 4, open: 11.0, high: 12.2, low: 10.9, close: 12.0, volume: 13 }
    ],
    getReferencePrice: () => "12",
    getSparkline: () => []
  };

  const strategyService = new StrategyService({
    dbFile: join(root, "strategies.sqlite"),
    markets: [market],
    chainId: 1716124615666775,
    strategyExecutorAddress: "0x0000000000000000000000000000000000000e11",
    priceService: priceService as any
  });

  const stateStore = new StateStore(join(root, "state.json"));
  stateStore.mutate((state) => {
    state.balances[ownerAddress.toLowerCase()] = {
      [quote.address.toLowerCase()]: "1000000000",
      [base.address.toLowerCase()]: "0"
    };
  });

  const routerCalls: Array<Record<string, unknown>> = [];
  const executionService = new StrategyExecutionService({
    strategyService,
    priceService: priceService as any,
    store: stateStore,
    liquidityRouter: {
      execute: async (input: Record<string, unknown>) => {
        routerCalls.push(input);
        return {
          status: "completed",
          mode: "instant_local",
          jobId: null,
          settledOutAtomic: "12000000000000000000",
          quote: {
            quotedOutAtomic: "12000000000000000000",
            minOutAtomic: "11900000000000000000"
          }
        };
      }
    } as any,
    inventoryService: {
      getSwapJob: () => null,
      listJobs: () => ({ swaps: [], rebalances: [] })
    } as any,
    matchingService: {
      placeOrder: () => {
        throw new Error("should not place order in routeable market");
      }
    } as any,
    vaultService: {
      consumeStrategyApproval: async () => "0xfeed"
    } as any,
    markets: [market]
  });

  try {
    const created = strategyService.createDraft({
      ownerAddress,
      marketId: market.id,
      name: "Live Long Strategy"
    });

    const preparedStrategy: StrategyDefinition = {
      ...created,
      enabledSides: ["long"],
      entryRules: {
        long: [
          {
            id: "entry-1",
            rules: [
              {
                id: "entry-rule-1",
                left: { type: "price_field", field: "close" },
                operator: ">",
                right: { type: "constant", value: 10 }
              }
            ]
          }
        ],
        short: []
      },
      exitRules: {
        long: [],
        short: []
      },
      costModel: {
        ...created.costModel,
        startingEquity: 1000,
        feeBps: 0,
        slippageBps: 0
      },
      riskRules: {},
      sizing: {
        mode: "fixed_quote_notional",
        value: 100
      }
    };

    strategyService.updateDraft({
      ownerAddress,
      strategy: preparedStrategy
    });
    const saved = strategyService.saveStrategy({
      ownerAddress,
      strategyId: created.id
    });
    assert.equal(saved.validation.ok, true);

    const intent = strategyService.createExecutionIntent({
      ownerAddress,
      strategyId: created.id
    });
    const signature = await ownerAccount.signTypedData({
      domain: intent.domain,
      types: intent.types,
      primaryType: intent.primaryType,
      message: {
        owner: intent.message.owner,
        strategyIdHash: intent.message.strategyIdHash,
        strategyHash: intent.message.strategyHash,
        marketId: intent.message.marketId,
        maxSlippageBps: BigInt(intent.message.maxSlippageBps),
        nonce: BigInt(intent.message.nonce),
        deadline: BigInt(intent.message.deadline)
      }
    });

    await strategyService.saveExecutionApproval({
      ownerAddress,
      strategyId: created.id,
      message: intent.message,
      signature
    });

    const result = await executionService.executeApprovedStrategy({
      ownerAddress,
      strategyId: created.id
    });
    assert.ok(result);

    assert.equal(result.action, "router_swap");
    assert.equal(result.approvalTxHash, "0xfeed");
    assert.equal(routerCalls.length, 1);
    assert.equal(routerCalls[0]?.fromToken, quote.address);

    assert.throws(
      () => strategyService.getExecutionApproval(created.id, ownerAddress),
      (error: unknown) =>
        error instanceof StrategyToolError &&
        error.code === "strategy_approval_not_found"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live inspection suppresses long exit when no base position is open", async () => {
  const root = mkdtempSync(join(tmpdir(), "sinergy-strategy-exec-"));
  const ownerPk = "0x00000000000000000000000000000000000000000000000000000000000000c4";
  const ownerAccount = privateKeyToAccount(ownerPk);
  const ownerAddress = ownerAccount.address as HexString;
  const base = makeToken("cBTC", "0x00000000000000000000000000000000000000c1");
  const quote = makeToken("cUSDC", "0x00000000000000000000000000000000000000c2");
  const market: ResolvedMarket = {
    id: "0x0000000000000000000000000000000000000000000000000000000000000222",
    symbol: "cBTC/cUSDC",
    baseToken: base,
    quoteToken: quote,
    routeable: false,
    routePolicy: "dark-pool-only"
  };
  const priceService = {
    getCandles: () => [
      { ts: 1, open: 10, high: 10, low: 10, close: 10, volume: 1 },
      { ts: 2, open: 10, high: 10, low: 10, close: 10, volume: 1 },
      { ts: 3, open: 10, high: 10, low: 10, close: 10, volume: 1 }
    ],
    getReferencePrice: () => "10",
    getSparkline: () => []
  };

  const strategyService = new StrategyService({
    dbFile: join(root, "strategies.sqlite"),
    markets: [market],
    chainId: 1716124615666775,
    strategyExecutorAddress: "0x0000000000000000000000000000000000000e11",
    priceService: priceService as any
  });

  const stateStore = new StateStore(join(root, "state.json"));
  stateStore.mutate((state) => {
    state.balances[ownerAddress.toLowerCase()] = {
      [quote.address.toLowerCase()]: "100000000",
      [base.address.toLowerCase()]: "0"
    };
  });

  const executionService = new StrategyExecutionService({
    strategyService,
    priceService: priceService as any,
    store: stateStore,
    liquidityRouter: {
      execute: async () => {
        throw new Error("should not route for this test");
      }
    } as any,
    inventoryService: {
      getSwapJob: () => null,
      listJobs: () => ({ swaps: [], rebalances: [] })
    } as any,
    matchingService: {
      placeOrder: () => {
        throw new Error("should not place order for this test");
      }
    } as any,
    vaultService: {
      consumeStrategyApproval: async () => "0xfeed"
    } as any,
    markets: [market]
  });

  try {
    const created = strategyService.createDraft({
      ownerAddress,
      marketId: market.id,
      name: "Live Exit Suppression"
    });

    const preparedStrategy: StrategyDefinition = {
      ...created,
      enabledSides: ["long"],
      entryRules: {
        long: [
          {
            id: "entry-1",
            rules: [
              {
                id: "entry-rule-1",
                left: { type: "price_field", field: "close" },
                operator: ">",
                right: { type: "constant", value: 1000 }
              }
            ]
          }
        ],
        short: []
      },
      exitRules: {
        long: [
          {
            id: "exit-1",
            rules: [
              {
                id: "exit-rule-1",
                left: { type: "price_field", field: "close" },
                operator: ">=",
                right: { type: "constant", value: 10 }
              }
            ]
          }
        ],
        short: []
      },
      costModel: {
        ...created.costModel,
        startingEquity: 1000,
        feeBps: 0,
        slippageBps: 0
      },
      riskRules: {},
      sizing: {
        mode: "fixed_quote_notional",
        value: 100
      }
    };

    strategyService.updateDraft({
      ownerAddress,
      strategy: preparedStrategy
    });
    const saved = strategyService.saveStrategy({
      ownerAddress,
      strategyId: created.id
    });
    assert.equal(saved.validation.ok, true);

    const intent = strategyService.createExecutionIntent({
      ownerAddress,
      strategyId: created.id
    });
    const signature = await ownerAccount.signTypedData({
      domain: intent.domain,
      types: intent.types,
      primaryType: intent.primaryType,
      message: {
        owner: intent.message.owner,
        strategyIdHash: intent.message.strategyIdHash,
        strategyHash: intent.message.strategyHash,
        marketId: intent.message.marketId,
        maxSlippageBps: BigInt(intent.message.maxSlippageBps),
        nonce: BigInt(intent.message.nonce),
        deadline: BigInt(intent.message.deadline)
      }
    });

    await strategyService.saveExecutionApproval({
      ownerAddress,
      strategyId: created.id,
      message: intent.message,
      signature
    });

    const inspection = executionService.inspectApprovedStrategy({
      ownerAddress,
      strategyId: created.id
    });
    assert.equal(inspection.signal, "none");

    const result = await executionService.executeApprovedStrategy({
      ownerAddress,
      strategyId: created.id,
      consumeApproval: false
    });
    assert.ok(result);
    assert.equal(result.action, "no_action");
    assert.equal(result.reason, "No executable live signal was produced on the latest candle.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live execution on a non-routeable market does not place dark-pool strategy orders", async () => {
  const root = mkdtempSync(join(tmpdir(), "sinergy-strategy-exec-"));
  const ownerPk = "0x00000000000000000000000000000000000000000000000000000000000000c5";
  const ownerAccount = privateKeyToAccount(ownerPk);
  const ownerAddress = ownerAccount.address as HexString;
  const base = makeToken("cBTC", "0x00000000000000000000000000000000000000d1");
  const quote = makeToken("cUSDC", "0x00000000000000000000000000000000000000d2");
  const market: ResolvedMarket = {
    id: "0x0000000000000000000000000000000000000000000000000000000000000333",
    symbol: "cBTC/cUSDC",
    baseToken: base,
    quoteToken: quote,
    routeable: false,
    routePolicy: "dark-pool-only"
  };
  const priceService = {
    getCandles: () => [
      { ts: 1, open: 9.8, high: 10.1, low: 9.7, close: 9.9, volume: 10 },
      { ts: 2, open: 9.9, high: 10.4, low: 9.8, close: 10.2, volume: 11 },
      { ts: 3, open: 10.2, high: 11.2, low: 10.1, close: 11.0, volume: 12 },
      { ts: 4, open: 11.0, high: 12.2, low: 10.9, close: 12.0, volume: 13 }
    ],
    getReferencePrice: () => "12",
    getSparkline: () => []
  };

  const strategyService = new StrategyService({
    dbFile: join(root, "strategies.sqlite"),
    markets: [market],
    chainId: 1716124615666775,
    strategyExecutorAddress: "0x0000000000000000000000000000000000000e11",
    priceService: priceService as any
  });

  const stateStore = new StateStore(join(root, "state.json"));
  stateStore.mutate((state) => {
    state.balances[ownerAddress.toLowerCase()] = {
      [quote.address.toLowerCase()]: "1000000000",
      [base.address.toLowerCase()]: "0"
    };
  });

  const executionService = new StrategyExecutionService({
    strategyService,
    priceService: priceService as any,
    store: stateStore,
    liquidityRouter: {
      execute: async () => {
        throw new Error("should not route on non-routeable market");
      }
    } as any,
    inventoryService: {
      getSwapJob: () => null,
      listJobs: () => ({ swaps: [], rebalances: [] })
    } as any,
    matchingService: {
      placeOrder: () => {
        throw new Error("should not place dark-pool orders for live strategy execution");
      }
    } as any,
    vaultService: {
      consumeStrategyApproval: async () => "0xfeed"
    } as any,
    markets: [market]
  });

  try {
    const created = strategyService.createDraft({
      ownerAddress,
      marketId: market.id,
      name: "Non-routeable Live Strategy"
    });

    const preparedStrategy: StrategyDefinition = {
      ...created,
      enabledSides: ["long"],
      entryRules: {
        long: [
          {
            id: "entry-1",
            rules: [
              {
                id: "entry-rule-1",
                left: { type: "price_field", field: "close" },
                operator: ">",
                right: { type: "constant", value: 10 }
              }
            ]
          }
        ],
        short: []
      },
      exitRules: {
        long: [],
        short: []
      },
      costModel: {
        ...created.costModel,
        startingEquity: 1000,
        feeBps: 0,
        slippageBps: 0
      },
      riskRules: {},
      sizing: {
        mode: "fixed_quote_notional",
        value: 100
      }
    };

    strategyService.updateDraft({
      ownerAddress,
      strategy: preparedStrategy
    });
    const saved = strategyService.saveStrategy({
      ownerAddress,
      strategyId: created.id
    });
    assert.equal(saved.validation.ok, true);

    const intent = strategyService.createExecutionIntent({
      ownerAddress,
      strategyId: created.id
    });
    const signature = await ownerAccount.signTypedData({
      domain: intent.domain,
      types: intent.types,
      primaryType: intent.primaryType,
      message: {
        owner: intent.message.owner,
        strategyIdHash: intent.message.strategyIdHash,
        strategyHash: intent.message.strategyHash,
        marketId: intent.message.marketId,
        maxSlippageBps: BigInt(intent.message.maxSlippageBps),
        nonce: BigInt(intent.message.nonce),
        deadline: BigInt(intent.message.deadline)
      }
    });

    await strategyService.saveExecutionApproval({
      ownerAddress,
      strategyId: created.id,
      message: intent.message,
      signature
    });

    const result = await executionService.executeApprovedStrategy({
      ownerAddress,
      strategyId: created.id,
      consumeApproval: false
    });
    assert.ok(result);
    assert.equal(result.action, "no_action");
    assert.equal(result.reason, "Live strategy execution only supports router-enabled markets with routed liquidity.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution history values open strategy PnL from the live DEX quote instead of the chart reference price", async () => {
  const root = mkdtempSync(join(tmpdir(), "sinergy-strategy-exec-"));
  const ownerPk = "0x00000000000000000000000000000000000000000000000000000000000000c6";
  const ownerAccount = privateKeyToAccount(ownerPk);
  const ownerAddress = ownerAccount.address as HexString;
  const base = makeToken("cINIT", "0x00000000000000000000000000000000000000e1");
  const quote = makeToken("cUSDC", "0x00000000000000000000000000000000000000e2");
  const market: ResolvedMarket = {
    id: "0x0000000000000000000000000000000000000000000000000000000000000444",
    symbol: "cINIT/cUSDC",
    baseToken: base,
    quoteToken: quote,
    routeable: true,
    routePolicy: "router-enabled"
  };
  const priceService = {
    getCandles: () => [
      { ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { ts: 2, open: 1, high: 1, low: 1, close: 1, volume: 1 }
    ],
    getReferencePrice: () => "0.8",
    getSparkline: () => []
  };

  const strategyService = new StrategyService({
    dbFile: join(root, "strategies.sqlite"),
    markets: [market],
    chainId: 1716124615666775,
    strategyExecutorAddress: "0x0000000000000000000000000000000000000e11",
    priceService: priceService as any
  });

  const created = strategyService.createDraft({
    ownerAddress,
    marketId: market.id,
    name: "DEX Mark To Market"
  });

  strategyService.recordExecution({
    ownerAddress,
    strategyId: created.id,
    strategyName: created.name,
    marketId: market.id,
    signal: "long_entry",
    action: "router_swap",
    approvalCreatedAt: new Date("2026-04-22T12:00:00.000Z").toISOString(),
    approvalNonce: "1",
    status: "completed",
    fromToken: quote.address,
    toToken: base.address,
    amountInAtomic: "100000000",
    quotedOutAtomic: "100000000",
    actualOutAtomic: "100000000",
    executionPrice: 1,
    routePreference: "dex"
  });

  const executionService = new StrategyExecutionService({
    strategyService,
    priceService: priceService as any,
    store: new StateStore(join(root, "state.json")),
    liquidityRouter: {
      quote: async (input: Record<string, unknown>) => {
        assert.equal(input.marketId, market.id);
        assert.equal(input.fromToken, base.address);
        assert.equal(input.routePreference, "dex");
        assert.equal(input.amount, "100");
        return {
          mode: "async_rebalance_required",
          requestedRoute: "dex",
          executionPath: "dex",
          expiry: new Date("2026-04-22T12:01:00.000Z").toISOString(),
          routeable: true,
          quotedOutAtomic: "105000000",
          minOutAtomic: "104000000",
          sourceBreakdown: {
            localInventoryAtomic: "0",
            l1DexAtomic: "105000000",
            inventoryStatus: "low"
          },
          bridge: {
            relayer: true,
            opinit: true,
            ready: true,
            checkedAt: new Date("2026-04-22T12:00:30.000Z").toISOString(),
            details: []
          },
          marketSymbol: market.symbol,
          fromSymbol: base.symbol,
          toSymbol: quote.symbol
        };
      }
    } as any,
    inventoryService: {
      getSwapJob: () => null,
      listJobs: () => ({ swaps: [], rebalances: [] })
    } as any,
    matchingService: {
      placeOrder: () => {
        throw new Error("should not place order for history valuation");
      }
    } as any,
    vaultService: {
      consumeStrategyApproval: async () => "0xfeed"
    } as any,
    markets: [market]
  });

  try {
    const history = await executionService.listExecutionHistory(ownerAddress);
    assert.equal(history.strategies.length, 1);
    assert.equal(history.strategies[0]?.currentPrice, 1.05);
    assert.equal(history.strategies[0]?.currentPnlQuote, 5);
    assert.equal(history.strategies[0]?.currentPnlPct, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live inspection ignores wallet base inventory for exit decisions when the strategy never opened a position", async () => {
  const root = mkdtempSync(join(tmpdir(), "sinergy-strategy-exec-"));
  const ownerPk = "0x00000000000000000000000000000000000000000000000000000000000000c6";
  const ownerAccount = privateKeyToAccount(ownerPk);
  const ownerAddress = ownerAccount.address as HexString;
  const base = makeToken("cINIT", "0x00000000000000000000000000000000000000e1");
  const quote = makeToken("cUSDC", "0x00000000000000000000000000000000000000e2");
  const market: ResolvedMarket = {
    id: "0x0000000000000000000000000000000000000000000000000000000000000444",
    symbol: "cINIT/cUSDC",
    baseToken: base,
    quoteToken: quote,
    routeable: true,
    routePolicy: "router-enabled"
  };
  const priceService = {
    getCandles: () => [
      { ts: 1, open: 10, high: 10, low: 10, close: 10, volume: 1 },
      { ts: 2, open: 10, high: 10, low: 10, close: 10, volume: 1 },
      { ts: 3, open: 10, high: 10, low: 10, close: 10, volume: 1 }
    ],
    getReferencePrice: () => "10",
    getSparkline: () => []
  };

  const strategyService = new StrategyService({
    dbFile: join(root, "strategies.sqlite"),
    markets: [market],
    chainId: 1716124615666775,
    strategyExecutorAddress: "0x0000000000000000000000000000000000000e11",
    priceService: priceService as any
  });

  const stateStore = new StateStore(join(root, "state.json"));
  stateStore.mutate((state) => {
    state.balances[ownerAddress.toLowerCase()] = {
      [quote.address.toLowerCase()]: "100000000",
      [base.address.toLowerCase()]: "50000000"
    };
  });

  const executionService = new StrategyExecutionService({
    strategyService,
    priceService: priceService as any,
    store: stateStore,
    liquidityRouter: {
      execute: async () => {
        throw new Error("should not route an exit without a managed live position");
      }
    } as any,
    inventoryService: {
      getSwapJob: () => null,
      listJobs: () => ({ swaps: [], rebalances: [] })
    } as any,
    matchingService: {
      placeOrder: () => {
        throw new Error("should not place orders in this test");
      }
    } as any,
    vaultService: {
      consumeStrategyApproval: async () => "0xfeed"
    } as any,
    markets: [market]
  });

  try {
    const created = strategyService.createDraft({
      ownerAddress,
      marketId: market.id,
      name: "Wallet Inventory Is Not Strategy Position"
    });

    const preparedStrategy: StrategyDefinition = {
      ...created,
      enabledSides: ["long"],
      entryRules: {
        long: [
          {
            id: "entry-1",
            rules: [
              {
                id: "entry-rule-1",
                left: { type: "price_field", field: "close" },
                operator: ">",
                right: { type: "constant", value: 1000 }
              }
            ]
          }
        ],
        short: []
      },
      exitRules: {
        long: [
          {
            id: "exit-1",
            rules: [
              {
                id: "exit-rule-1",
                left: { type: "price_field", field: "close" },
                operator: ">=",
                right: { type: "constant", value: 10 }
              }
            ]
          }
        ],
        short: []
      },
      costModel: {
        ...created.costModel,
        startingEquity: 1000,
        feeBps: 0,
        slippageBps: 0
      },
      riskRules: {},
      sizing: {
        mode: "fixed_quote_notional",
        value: 100
      }
    };

    strategyService.updateDraft({
      ownerAddress,
      strategy: preparedStrategy
    });
    const saved = strategyService.saveStrategy({
      ownerAddress,
      strategyId: created.id
    });
    assert.equal(saved.validation.ok, true);

    const intent = strategyService.createExecutionIntent({
      ownerAddress,
      strategyId: created.id
    });
    const signature = await ownerAccount.signTypedData({
      domain: intent.domain,
      types: intent.types,
      primaryType: intent.primaryType,
      message: {
        owner: intent.message.owner,
        strategyIdHash: intent.message.strategyIdHash,
        strategyHash: intent.message.strategyHash,
        marketId: intent.message.marketId,
        maxSlippageBps: BigInt(intent.message.maxSlippageBps),
        nonce: BigInt(intent.message.nonce),
        deadline: BigInt(intent.message.deadline)
      }
    });

    await strategyService.saveExecutionApproval({
      ownerAddress,
      strategyId: created.id,
      message: intent.message,
      signature
    });

    const inspection = executionService.inspectApprovedStrategy({
      ownerAddress,
      strategyId: created.id
    });
    assert.equal(inspection.signal, "none");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live entry is not blocked by unrelated wallet base inventory", async () => {
  const root = mkdtempSync(join(tmpdir(), "sinergy-strategy-exec-"));
  const ownerPk = "0x00000000000000000000000000000000000000000000000000000000000000c7";
  const ownerAccount = privateKeyToAccount(ownerPk);
  const ownerAddress = ownerAccount.address as HexString;
  const base = makeToken("cINIT", "0x00000000000000000000000000000000000000f1");
  const quote = makeToken("cUSDC", "0x00000000000000000000000000000000000000f2");
  const market: ResolvedMarket = {
    id: "0x0000000000000000000000000000000000000000000000000000000000000555",
    symbol: "cINIT/cUSDC",
    baseToken: base,
    quoteToken: quote,
    routeable: true,
    routePolicy: "router-enabled"
  };
  const priceService = {
    getCandles: () => [
      { ts: 1, open: 9.8, high: 10.1, low: 9.7, close: 9.9, volume: 10 },
      { ts: 2, open: 9.9, high: 10.4, low: 9.8, close: 10.2, volume: 11 },
      { ts: 3, open: 10.2, high: 11.2, low: 10.1, close: 11.0, volume: 12 },
      { ts: 4, open: 11.0, high: 12.2, low: 10.9, close: 12.0, volume: 13 }
    ],
    getReferencePrice: () => "12",
    getSparkline: () => []
  };

  const strategyService = new StrategyService({
    dbFile: join(root, "strategies.sqlite"),
    markets: [market],
    chainId: 1716124615666775,
    strategyExecutorAddress: "0x0000000000000000000000000000000000000e11",
    priceService: priceService as any
  });

  const stateStore = new StateStore(join(root, "state.json"));
  stateStore.mutate((state) => {
    state.balances[ownerAddress.toLowerCase()] = {
      [quote.address.toLowerCase()]: "1000000000",
      [base.address.toLowerCase()]: "50000000"
    };
  });

  const routerCalls: Array<Record<string, unknown>> = [];
  const executionService = new StrategyExecutionService({
    strategyService,
    priceService: priceService as any,
    store: stateStore,
    liquidityRouter: {
      execute: async (input: Record<string, unknown>) => {
        routerCalls.push(input);
        return {
          status: "completed",
          mode: "instant_local",
          jobId: null,
          settledOutAtomic: "120000000",
          quote: {
            quotedOutAtomic: "120000000",
            minOutAtomic: "119000000"
          }
        };
      }
    } as any,
    inventoryService: {
      getSwapJob: () => null,
      listJobs: () => ({ swaps: [], rebalances: [] })
    } as any,
    matchingService: {
      placeOrder: () => {
        throw new Error("should not place order in routeable market");
      }
    } as any,
    vaultService: {
      consumeStrategyApproval: async () => "0xfeed"
    } as any,
    markets: [market]
  });

  try {
    const created = strategyService.createDraft({
      ownerAddress,
      marketId: market.id,
      name: "Managed Entry Ignores External Holdings"
    });

    const preparedStrategy: StrategyDefinition = {
      ...created,
      enabledSides: ["long"],
      entryRules: {
        long: [
          {
            id: "entry-1",
            rules: [
              {
                id: "entry-rule-1",
                left: { type: "price_field", field: "close" },
                operator: ">",
                right: { type: "constant", value: 10 }
              }
            ]
          }
        ],
        short: []
      },
      exitRules: {
        long: [],
        short: []
      },
      costModel: {
        ...created.costModel,
        startingEquity: 1000,
        feeBps: 0,
        slippageBps: 0
      },
      riskRules: {},
      sizing: {
        mode: "fixed_quote_notional",
        value: 100
      }
    };

    strategyService.updateDraft({
      ownerAddress,
      strategy: preparedStrategy
    });
    const saved = strategyService.saveStrategy({
      ownerAddress,
      strategyId: created.id
    });
    assert.equal(saved.validation.ok, true);

    const intent = strategyService.createExecutionIntent({
      ownerAddress,
      strategyId: created.id
    });
    const signature = await ownerAccount.signTypedData({
      domain: intent.domain,
      types: intent.types,
      primaryType: intent.primaryType,
      message: {
        owner: intent.message.owner,
        strategyIdHash: intent.message.strategyIdHash,
        strategyHash: intent.message.strategyHash,
        marketId: intent.message.marketId,
        maxSlippageBps: BigInt(intent.message.maxSlippageBps),
        nonce: BigInt(intent.message.nonce),
        deadline: BigInt(intent.message.deadline)
      }
    });

    await strategyService.saveExecutionApproval({
      ownerAddress,
      strategyId: created.id,
      message: intent.message,
      signature
    });

    const result = await executionService.executeApprovedStrategy({
      ownerAddress,
      strategyId: created.id,
      consumeApproval: false
    });

    assert.ok(result);
    assert.equal(result.action, "router_swap");
    assert.equal(routerCalls.length, 1);
    assert.equal(routerCalls[0]?.fromToken, quote.address);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live chart overlay uses the latest candles instead of a frozen backtest window", async () => {
  const root = mkdtempSync(join(tmpdir(), "sinergy-strategy-exec-"));
  const ownerPk = "0x00000000000000000000000000000000000000000000000000000000000000c8";
  const ownerAccount = privateKeyToAccount(ownerPk);
  const ownerAddress = ownerAccount.address as HexString;
  const base = makeToken("cINIT", "0x0000000000000000000000000000000000000aa1");
  const quote = makeToken("cUSDC", "0x0000000000000000000000000000000000000bb2");
  const market: ResolvedMarket = {
    id: "0x0000000000000000000000000000000000000000000000000000000000000666",
    symbol: "cINIT/cUSDC",
    baseToken: base,
    quoteToken: quote,
    routeable: true,
    routePolicy: "router-enabled"
  };
  const priceService = {
    getCandles: () => Array.from({ length: 30 }, (_, index) => {
      const ts = (index + 1) * 100;
      const close = 9.5 + index * 0.12;
      return {
        ts,
        open: Number((close - 0.05).toFixed(4)),
        high: Number((close + 0.12).toFixed(4)),
        low: Number((close - 0.1).toFixed(4)),
        close: Number(close.toFixed(4)),
        volume: 10 + index
      };
    }),
    getReferencePrice: () => "12",
    getSparkline: () => []
  };

  const strategyService = new StrategyService({
    dbFile: join(root, "strategies.sqlite"),
    markets: [market],
    chainId: 1716124615666775,
    strategyExecutorAddress: "0x0000000000000000000000000000000000000e11",
    priceService: priceService as any
  });

  const stateStore = new StateStore(join(root, "state.json"));
  stateStore.mutate((state) => {
    state.balances[ownerAddress.toLowerCase()] = {
      [quote.address.toLowerCase()]: "1000000000",
      [base.address.toLowerCase()]: "0"
    };
  });

  const executionService = new StrategyExecutionService({
    strategyService,
    priceService: priceService as any,
    store: stateStore,
    liquidityRouter: {
      execute: async () => {
        throw new Error("should not route for overlay test");
      }
    } as any,
    inventoryService: {
      getSwapJob: () => null,
      listJobs: () => ({ swaps: [], rebalances: [] })
    } as any,
    matchingService: {
      placeOrder: () => {
        throw new Error("should not place order for overlay test");
      }
    } as any,
    vaultService: {
      consumeStrategyApproval: async () => "0xfeed"
    } as any,
    markets: [market]
  });

  try {
    const created = strategyService.createDraft({
      ownerAddress,
      marketId: market.id,
      name: "Live Overlay EMA"
    });

    const preparedStrategy: StrategyDefinition = {
      ...created,
      enabledSides: ["long"],
      entryRules: {
        long: [
          {
            id: "entry-1",
            rules: [
              {
                id: "entry-rule-1",
                left: { type: "indicator_output", indicator: "ema", output: "value", params: { period: 9 } },
                operator: ">",
                right: { type: "indicator_output", indicator: "ema", output: "value", params: { period: 24 } }
              }
            ]
          }
        ],
        short: []
      },
      exitRules: {
        long: [],
        short: []
      },
      costModel: {
        ...created.costModel,
        startingEquity: 1000,
        feeBps: 0,
        slippageBps: 0
      },
      riskRules: {},
      sizing: {
        mode: "fixed_quote_notional",
        value: 100
      }
    };

    strategyService.updateDraft({
      ownerAddress,
      strategy: preparedStrategy
    });
    const saved = strategyService.saveStrategy({
      ownerAddress,
      strategyId: created.id
    });
    assert.equal(saved.validation.ok, true);

    const overlay = executionService.getLiveChartOverlay({
      ownerAddress,
      strategyId: created.id,
      candleLookback: 30
    });

    assert.equal(overlay.timeframe, created.timeframe);
    assert.equal(overlay.markers.length, 0);
    assert.equal(overlay.indicators.length >= 2, true);
    const latestOverlayTime = Math.max(
      ...overlay.indicators.flatMap((indicator) => indicator.values.map((value) => value.time))
    );
    assert.equal(latestOverlayTime, 3000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
