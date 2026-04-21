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
import { AutoStrategyWorker } from "./services/autoStrategyWorker.js";
import type { ResolvedMarket, ResolvedToken } from "./types.js";

function makeToken(symbol: string, address: HexString): ResolvedToken {
  return {
    symbol,
    name: symbol,
    address,
    decimals: 6,
    kind: symbol === "cUSDC" ? "quote" : "crypto"
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHarness(options?: { candles?: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }> }) {
  const root = mkdtempSync(join(tmpdir(), "sinergy-strategy-dashboard-"));
  const ownerPk = "0x00000000000000000000000000000000000000000000000000000000000000d4";
  const ownerAccount = privateKeyToAccount(ownerPk);
  const ownerAddress = ownerAccount.address as HexString;
  const base = makeToken("cINIT", "0x00000000000000000000000000000000000000a1");
  const quote = makeToken("cUSDC", "0x00000000000000000000000000000000000000b2");
  const market: ResolvedMarket = {
    id: "0x0000000000000000000000000000000000000000000000000000000000000222",
    symbol: "cINIT/cUSDC",
    baseToken: base,
    quoteToken: quote,
    routeable: true,
    routePolicy: "router-enabled"
  };
  const candles = options?.candles ?? [
    { ts: 1, open: 9.8, high: 10.1, low: 9.7, close: 9.9, volume: 10 },
    { ts: 2, open: 9.9, high: 10.4, low: 9.8, close: 10.2, volume: 11 },
    { ts: 3, open: 10.2, high: 11.2, low: 10.1, close: 11.0, volume: 12 },
    { ts: 4, open: 11.0, high: 12.2, low: 10.9, close: 12.0, volume: 13 }
  ];
  const priceService = {
    getCandles: () => candles,
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

  function cleanup() {
    rmSync(root, { recursive: true, force: true });
  }

  return {
    cleanup,
    ownerAccount,
    ownerAddress,
    market,
    strategyService,
    executionService,
    routerCalls
  };
}

async function createSavedStrategy(harness: ReturnType<typeof buildHarness>) {
  const created = harness.strategyService.createDraft({
    ownerAddress: harness.ownerAddress,
    marketId: harness.market.id,
    name: "Dashboard Strategy"
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

  harness.strategyService.updateDraft({
    ownerAddress: harness.ownerAddress,
    strategy: preparedStrategy
  });
  harness.strategyService.saveStrategy({
    ownerAddress: harness.ownerAddress,
    strategyId: created.id
  });

  return created.id;
}

async function createApproval(harness: ReturnType<typeof buildHarness>, strategyId: string, validForSeconds = 3600) {
  const intent = harness.strategyService.createExecutionIntent({
    ownerAddress: harness.ownerAddress,
    strategyId,
    validForSeconds
  });
  const signature = await harness.ownerAccount.signTypedData({
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

  await harness.strategyService.saveExecutionApproval({
    ownerAddress: harness.ownerAddress,
    strategyId,
    message: intent.message,
    signature
  });
}

test("dashboard returns latest backtest preview and active auto execution state", async () => {
  const harness = buildHarness();
  try {
    const strategyId = await createSavedStrategy(harness);
    await createApproval(harness, strategyId);

    const backtest = harness.strategyService.runBacktest({
      ownerAddress: harness.ownerAddress,
      strategyId
    });
    harness.strategyService.activateAutoExecution({
      ownerAddress: harness.ownerAddress,
      strategyId,
      mode: "until_disabled"
    });

    const dashboard = harness.strategyService.getStrategyDashboard(harness.ownerAddress);
    assert.equal(dashboard.cards.length, 1);
    assert.equal(dashboard.cards[0]?.latestBacktest?.runId, backtest.summary.runId);
    assert.equal(dashboard.cards[0]?.autoExecution.status, "active");
  } finally {
    harness.cleanup();
  }
});

test("editing an activated strategy marks auto execution as needs_reactivation", async () => {
  const harness = buildHarness();
  try {
    const strategyId = await createSavedStrategy(harness);
    await createApproval(harness, strategyId);
    harness.strategyService.activateAutoExecution({
      ownerAddress: harness.ownerAddress,
      strategyId,
      mode: "until_disabled"
    });

    const current = harness.strategyService.getStrategy(strategyId, harness.ownerAddress);
    harness.strategyService.updateDraft({
      ownerAddress: harness.ownerAddress,
      strategy: {
        ...current,
        name: "Dashboard Strategy Updated"
      }
    });

    const autoState = harness.strategyService.getAutoExecutionState(strategyId, harness.ownerAddress);
    assert.equal(autoState.status, "needs_reactivation");
  } finally {
    harness.cleanup();
  }
});

test("auto strategy worker expires timed activations and avoids duplicate execution on the same candle", async () => {
  const harness = buildHarness();
  const worker = new AutoStrategyWorker({
    strategyService: harness.strategyService,
    executionService: harness.executionService,
    intervalMs: 20
  });

  try {
    const strategyId = await createSavedStrategy(harness);
    await createApproval(harness, strategyId, 7200);
    harness.strategyService.activateAutoExecution({
      ownerAddress: harness.ownerAddress,
      strategyId,
      mode: "until_disabled"
    });

    worker.start();
    await wait(120);
    worker.stop();

    assert.equal(harness.routerCalls.length, 1);
    const autoState = harness.strategyService.getAutoExecutionState(strategyId, harness.ownerAddress);
    assert.equal(autoState.lastExecutedCandleTs, 4);

    harness.strategyService.activateAutoExecution({
      ownerAddress: harness.ownerAddress,
      strategyId,
      mode: "until_timestamp",
      expiresAt: new Date(Date.now() + 50).toISOString()
    });

    worker.start();
    await wait(120);
    worker.stop();

    const expiredState = harness.strategyService.getAutoExecutionState(strategyId, harness.ownerAddress);
    assert.equal(expiredState.status, "expired");
  } finally {
    worker.stop();
    harness.cleanup();
  }
});
