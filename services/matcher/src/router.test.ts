import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import type {
  BridgeHealth,
  CanonicalAssetConfig,
  ResolvedMarket,
  ResolvedToken,
  RouterMarketConfig
} from "./types.js";
import { StateStore } from "./services/state.js";
import { InventoryService } from "./services/inventory.js";
import { LiquidityRouter } from "./services/router.js";

function makeToken(symbol: string, address: Address, decimals = 6): ResolvedToken {
  return {
    symbol,
    name: symbol,
    address,
    decimals,
    kind: symbol === "sUSDC" ? "quote" : "crypto"
  };
}

function makeHarness(options?: {
  bridgeReady?: boolean;
  bootstrapInventory?: Record<string, string>;
  routeable?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "sinergy-router-test-"));
  const store = new StateStore(join(root, "state.json"));
  const base = makeToken("cINIT", "0x00000000000000000000000000000000000000a1");
  const quote = makeToken("sUSDC", "0x00000000000000000000000000000000000000b2");
  const market: ResolvedMarket = {
    id: "0x0000000000000000000000000000000000000000000000000000000000000111",
    symbol: "cINIT/sUSDC",
    baseToken: base,
    quoteToken: quote,
    routeable: false,
    routePolicy: "dark-pool-only"
  };

  const canonicalAssets = new Map<string, CanonicalAssetConfig>();
  const routerMarkets = new Map<string, RouterMarketConfig>();

  if (options?.routeable !== false) {
    canonicalAssets.set("cinit", {
      localSymbol: "cINIT",
      l1Symbol: "INIT",
      bridgeDenom: "uinit",
      metadataObjectId: "0x11",
      minInventoryAtomic: "5000000",
      targetInventoryAtomic: "10000000",
      maxInventoryAtomic: "20000000"
    });
    canonicalAssets.set("susdc", {
      localSymbol: "sUSDC",
      l1Symbol: "USDC",
      bridgeDenom: "uusdc",
      metadataObjectId: "0x22",
      minInventoryAtomic: "5000000",
      targetInventoryAtomic: "10000000",
      maxInventoryAtomic: "20000000"
    });
    routerMarkets.set("cinit/susdc", {
      pairObjectId: "0x33",
      baseSymbol: "cINIT",
      quoteSymbol: "sUSDC"
    });
  }

  const inventoryService = new InventoryService({
    store,
    tokens: new Map([
      [base.address.toLowerCase(), base],
      [quote.address.toLowerCase(), quote]
    ]),
    markets: [market],
    canonicalAssets,
    routerMarkets,
    bootstrapInventory: options?.bootstrapInventory ?? { cINIT: "20000000", sUSDC: "20000000" }
  });
  const routedMarket = { ...market, ...inventoryService.getMarketPolicy(market) };
  const bridge: BridgeHealth = {
    relayer: options?.bridgeReady ?? true,
    opinit: options?.bridgeReady ?? true,
    ready: options?.bridgeReady ?? true,
    checkedAt: new Date().toISOString(),
    details: []
  };
  const userAddress = "0x00000000000000000000000000000000000000c3" as Address;

  store.mutate((state) => {
    state.balances[userAddress.toLowerCase()] = {
      [quote.address.toLowerCase()]: "50000000",
      [base.address.toLowerCase()]: "5000000"
    };
    state.locked[userAddress.toLowerCase()] = {};
  });

  const router = new LiquidityRouter({
    store,
    markets: [routedMarket],
    priceService: {
      getReferencePrice: () => "1"
    } as any,
    inventoryService,
    initiaDexClient: {
      simulateSwap: async () => 10_000_000n
    } as any,
    bridgeHealthService: {
      getStatus: async () => bridge
    } as any,
    quoteSpreadBps: 50,
    maxLocalFillUsd: 100_000
  });

  return {
    root,
    store,
    router,
    market: routedMarket,
    base,
    quote,
    userAddress,
    inventoryService,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("router prefers instant local fill when bridge is healthy and inventory is sufficient", async () => {
  const harness = makeHarness();

  try {
    const result = await harness.router.quote({
      userAddress: harness.userAddress,
      marketId: harness.market.id,
      fromToken: harness.quote.address,
      amount: "10"
    });

    assert.equal(result.mode, "instant_local");
    assert.equal(result.routeable, true);
    assert.equal(result.sourceBreakdown.inventoryStatus, "healthy");
  } finally {
    harness.cleanup();
  }
});

test("router marks non-canonical markets as unsupported", async () => {
  const harness = makeHarness({ routeable: false });

  try {
    const result = await harness.router.quote({
      userAddress: harness.userAddress,
      marketId: harness.market.id,
      fromToken: harness.quote.address,
      amount: "10"
    });

    assert.equal(result.mode, "unsupported_asset");
    assert.equal(result.routeable, false);
  } finally {
    harness.cleanup();
  }
});

test("async execution locks user funds and creates rebalance work when bridge is degraded", async () => {
  const harness = makeHarness({ bridgeReady: false });

  try {
    const result = await harness.router.execute({
      userAddress: harness.userAddress,
      marketId: harness.market.id,
      fromToken: harness.quote.address,
      amount: "10"
    });

    assert.equal(result.status, "rebalancing");
    assert.ok(result.jobId);

    const snapshot = harness.store.get();
    assert.equal(
      snapshot.locked[harness.userAddress.toLowerCase()][harness.quote.address.toLowerCase()],
      "10000000"
    );
    assert.equal(snapshot.rebalanceJobs.length, 1);
    assert.equal(snapshot.swapJobs.length, 1);
  } finally {
    harness.cleanup();
  }
});
