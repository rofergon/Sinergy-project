import Fastify from "fastify";
import cors from "@fastify/cors";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parseUnits } from "viem";
import type { Address, Hex } from "viem";
import { env } from "./config/env.js";
import { loadDeployment, resolveMarkets, resolveTokens } from "./services/deployment.js";
import { StateStore } from "./services/state.js";
import { PriceService } from "./services/priceService.js";
import { MatchingService } from "./services/matcher.js";
import { VaultService, createClients } from "./services/vault.js";
import { InventoryService } from "./services/inventory.js";
import { InitiaDexClient } from "./services/initiaDex.js";
import { BridgeHealthService } from "./services/bridgeHealth.js";
import { LiquidityRouter } from "./services/router.js";
import { RebalanceWorker } from "./services/rebalanceWorker.js";
import type { CanonicalAssetConfig, RouterMarketConfig } from "./types.js";

const deployment = loadDeployment(env.DEPLOYMENT_FILE);
const tokens = resolveTokens(deployment);
const rawMarkets = resolveMarkets(deployment);
const { publicClient, walletClient, account } = createClients(
  env.MATCHER_PRIVATE_KEY as Hex,
  deployment.network.rpcUrl
);
const store = new StateStore();
const priceService = new PriceService({
  dbFile: env.PRICE_DB_FILE,
  pollIntervalMs: env.PRICE_POLL_INTERVAL_MS,
  providerApiKey: env.TWELVE_DATA_API_KEY,
  coingeckoDemoApiKey: env.COINGECKO_DEMO_API_KEY,
  bondProxySymbol: env.T_BOND_PROXY_SYMBOL,
  initiaConnectRestUrl: env.INITIA_CONNECT_REST_URL
});
await priceService.start();

function parseJsonRecord<T>(label: string, raw: string): Record<string, T> {
  try {
    return JSON.parse(raw) as Record<string, T>;
  } catch (error) {
    throw new Error(
      `Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const canonicalAssets = new Map<string, CanonicalAssetConfig>(
  Object.entries(parseJsonRecord<Omit<CanonicalAssetConfig, "localSymbol">>(
    "ROUTER_CANONICAL_ASSETS_JSON",
    env.ROUTER_CANONICAL_ASSETS_JSON
  )).map(([localSymbol, config]) => [
    localSymbol.toLowerCase(),
    {
      localSymbol,
      ...config
    }
  ])
);
const routerMarkets = new Map<string, RouterMarketConfig>(
  Object.entries(
    parseJsonRecord<RouterMarketConfig>("ROUTER_MARKETS_JSON", env.ROUTER_MARKETS_JSON)
  ).map(([marketSymbol, config]) => [marketSymbol.toLowerCase(), config])
);
const bootstrapInventory = parseJsonRecord<string>(
  "ROUTER_BOOTSTRAP_INVENTORY_JSON",
  env.ROUTER_BOOTSTRAP_INVENTORY_JSON
);
const inventoryService = new InventoryService({
  store,
  tokens,
  markets: rawMarkets,
  canonicalAssets,
  routerMarkets,
  bootstrapInventory
});
const markets = rawMarkets.map((market) => ({
  ...market,
  ...inventoryService.getMarketPolicy(market)
}));
const matchingService = new MatchingService({
  store,
  markets,
  priceService,
  priceBandBps: env.PRICE_BAND_BPS,
  walletClient,
  publicClient,
  marketAddress: deployment.contracts.market
});
const vaultService = new VaultService(store, publicClient, walletClient, deployment, tokens, markets);
const initiaDexClient = new InitiaDexClient({
  restUrl: env.L1_REST_URL,
  rpcUrl: env.L1_RPC_URL,
  chainId: env.L1_CHAIN_ID,
  gasPrices: env.L1_GAS_PRICES,
  gasAdjustment: env.L1_GAS_ADJUSTMENT,
  mnemonic: env.L1_ROUTER_MNEMONIC,
  keyName: env.L1_ROUTER_KEY_NAME ?? "weave_bridge_executor",
  keyringBackend: env.L1_ROUTER_KEYRING_BACKEND ?? "test",
  keyringHome: env.L1_ROUTER_HOME ?? resolve(homedir(), ".opinit", env.L1_CHAIN_ID)
});
const bridgeHealthService = new BridgeHealthService({
  relayerHealthUrl: env.RELAYER_HEALTH_URL,
  opinitHealthUrl: env.OPINIT_HEALTH_URL
});
const liquidityRouter = new LiquidityRouter({
  store,
  markets,
  priceService,
  inventoryService,
  initiaDexClient,
  bridgeHealthService,
  quoteSpreadBps: env.ROUTER_QUOTE_SPREAD_BPS,
  maxLocalFillUsd: env.ROUTER_MAX_LOCAL_FILL_USD
});
const rebalanceWorker = new RebalanceWorker({
  inventoryService,
  bridgeHealthService,
  initiaDexClient,
  intervalMs: env.ROUTER_REBALANCE_INTERVAL_MS,
  markets
});
rebalanceWorker.start();

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get("/health", async () => ({
  ok: true,
  matcher: account.address,
  markets: markets.length,
  pricing: priceService.getStatus(),
  bridge: await bridgeHealthService.getStatus()
}));

app.get("/config", async () => ({
  deployment,
  markets,
  inventory: inventoryService.getInventory(),
  bridge: await bridgeHealthService.getStatus()
}));

app.get("/prices", async () => ({
  prices: priceService.getAll(),
  status: priceService.getStatus()
}));

app.get("/markets", async () => ({
  markets: markets.map((market) => ({
    ...market,
    referencePrice: priceService.getReferencePrice(market.baseToken.symbol),
    series: priceService.getSparkline(market.baseToken.symbol, 32)
  }))
}));

app.get("/inventory", async () => ({
  positions: inventoryService.getInventory(),
  jobs: inventoryService.listJobs()
}));

app.get("/bridge/status", async () => await bridgeHealthService.getStatus());

app.get("/prices/:symbol/candles", async (request) => {
  const { symbol } = request.params as { symbol: string };
  const { interval = "15m", limit = "200" } = request.query as {
    interval?: string;
    limit?: string;
  };

  return {
    symbol,
    interval,
    candles: priceService.getCandles(symbol, interval, Number(limit))
  };
});

app.get("/balances/:address", async (request) => {
  vaultService.releaseExpiredWithdrawals();
  const { address } = request.params as { address: Address };
  return matchingService.getBalances(address);
});

app.get("/orders/:address", async (request) => {
  const { address } = request.params as { address: Address };
  return {
    orders: matchingService.getOrders(address)
  };
});

app.post("/swap/quote", async (request) => {
  const body = request.body as {
    userAddress: Address;
    marketId: Hex;
    fromToken: Address;
    amount: string;
  };

  return {
    quote: await liquidityRouter.quote(body)
  };
});

app.post("/swap/execute", async (request) => {
  const body = request.body as {
    userAddress: Address;
    marketId: Hex;
    fromToken: Address;
    amount: string;
  };

  return await liquidityRouter.execute(body);
});

app.get("/swap/status/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const job = inventoryService.getSwapJob(id);
  if (!job) {
    reply.code(404);
    return {
      statusCode: 404,
      error: "Not Found",
      message: "Swap job not found"
    };
  }

  return { job };
});

app.post("/vault/sync-deposit", async (request) => {
  const { txHash, userAddress, logs } = request.body as {
    txHash: string;
    userAddress: Address;
    logs?: Array<{ address: Address; topics: Hex[]; data: Hex }>;
  };
  return await vaultService.syncDeposit(txHash, userAddress, logs);
});

app.post("/vault/withdrawal-quote", async (request) => {
  const { userAddress, token, amount, decimals } = request.body as {
    userAddress: Address;
    token: Address;
    amount: string;
    decimals: number;
  };

  return await vaultService.buildWithdrawalQuote({
    userAddress,
    token,
    amountAtomic: parseUnits(amount, decimals)
  });
});

app.post("/vault/sync-withdrawal", async (request) => {
  const { txHash, userAddress, logs } = request.body as {
    txHash: string;
    userAddress: Address;
    logs?: Array<{ address: Address; topics: Hex[]; data: Hex }>;
  };
  return await vaultService.syncWithdrawal(txHash, userAddress, logs);
});

app.post("/orders", async (request) => {
  const body = request.body as {
    userAddress: Address;
    marketId: Hex;
    side: "BUY" | "SELL";
    quantity: string;
    limitPrice: string;
  };

  return {
    order: matchingService.placeOrder(body)
  };
});

app.post("/orders/:id/cancel", async (request) => {
  const { id } = request.params as { id: string };
  const { userAddress } = request.body as { userAddress: Address };
  return {
    order: matchingService.cancelOrder(id, userAddress)
  };
});

app.listen({ host: "0.0.0.0", port: env.PORT });
