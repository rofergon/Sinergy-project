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
