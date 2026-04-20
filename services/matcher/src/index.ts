import Fastify from "fastify";
import cors from "@fastify/cors";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { isAddress, parseUnits } from "viem";
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
import { BridgeClaimService } from "./services/bridgeClaims.js";
import { ZkProofService } from "./services/zkProofs.js";
import { StrategyService } from "./services/strategyService.js";
import { StrategyExecutionService } from "./services/strategyExecution.js";
import { StrategyToolApi } from "./services/strategyToolApi.js";
import { makeStrategyToolMeta, toStrategyToolErrorPayload } from "./services/strategyToolSecurity.js";
import { MatcherAuthService } from "./services/auth.js";
import type {
  CanonicalAssetConfig,
  RoutePreference,
  RouterMarketConfig
} from "./types.js";
import { strategyToolDefinitions, type StrategyToolName } from "@sinergy/shared";

const deployment = loadDeployment(env.DEPLOYMENT_FILE);
const tokens = resolveTokens(deployment);
const rawMarkets = resolveMarkets(deployment);
const { publicClient, walletClient, account } = createClients(
  env.MATCHER_PRIVATE_KEY as Hex,
  deployment
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
  keyringHome: env.L1_ROUTER_HOME ?? resolve(homedir(), ".opinit", env.L1_CHAIN_ID),
  gasStationKeyName: env.L1_GAS_STATION_KEY_NAME,
  gasStationKeyringBackend: env.L1_GAS_STATION_KEYRING_BACKEND,
  gasStationKeyringHome: env.L1_GAS_STATION_KEYRING_HOME ?? resolve(homedir(), ".minitia")
});
const bridgeHealthService = new BridgeHealthService({
  relayerHealthUrl: env.RELAYER_HEALTH_URL,
  opinitHealthUrl: env.OPINIT_HEALTH_URL
});
const bridgeClaimService = new BridgeClaimService({
  store,
  publicClient,
  walletClient,
  deployment,
  tokens,
  rollupRestUrl: deployment.network.restUrl
});
const liquidityRouter = new LiquidityRouter({
  store,
  markets,
  priceService,
  inventoryService,
  initiaDexClient,
  bridgeHealthService,
  vaultService,
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
const zkProofService = new ZkProofService({
  store,
  publicClient,
  proofPackageFile: env.ZK_WITHDRAWAL_PACKAGE_FILE,
  wasmFile: env.ZK_WITHDRAWAL_WASM_FILE,
  zkeyFile: env.ZK_WITHDRAWAL_ZKEY_FILE,
  stateAnchorAddress: deployment.contracts.stateAnchor
});
const strategyService = new StrategyService({
  dbFile: env.STRATEGY_DB_FILE,
  markets,
  priceService,
  chainId: deployment.network.chainId,
  strategyExecutorAddress: deployment.contracts.strategyExecutor
});
const strategyToolApi = new StrategyToolApi(strategyService);
const strategyExecutionService = new StrategyExecutionService({
  strategyService,
  priceService,
  store,
  liquidityRouter,
  inventoryService,
  matchingService,
  vaultService,
  markets
});
const authService = new MatcherAuthService({
  secret:
    env.AUTH_TOKEN_SECRET ??
    createHash("sha256")
      .update(`${env.MATCHER_PRIVATE_KEY}:sinergy-matcher-auth-v1`)
      .digest("hex"),
  nonceTtlMs: env.AUTH_NONCE_TTL_MS,
  tokenTtlMs: env.AUTH_TOKEN_TTL_MS
});

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

function normalizeAddressCandidate(value: unknown): Address | undefined {
  if (typeof value !== "string" || !isAddress(value)) {
    return undefined;
  }

  return value.toLowerCase() as Address;
}

function resolveProtectedAddress(request: {
  method: string;
  routeOptions: { url?: string };
  params: unknown;
  query: unknown;
  body: unknown;
}): Address | undefined {
  const params = (request.params ?? {}) as Record<string, unknown>;
  const query = (request.query ?? {}) as Record<string, unknown>;
  const body = (request.body ?? {}) as Record<string, unknown>;
  const route = request.routeOptions.url;
  const method = request.method.toUpperCase();

  if (!route) {
    return undefined;
  }

  switch (`${method} ${route}`) {
    case "POST /orders":
    case "POST /orders/:id/cancel":
    case "POST /swap/execute":
    case "POST /vault/sync-deposit":
    case "POST /vault/withdrawal-quote":
    case "POST /vault/zk-withdrawal-package":
    case "POST /vault/sync-withdrawal":
    case "POST /vault/cancel-withdrawal":
    case "POST /vault/cancel-zk-withdrawal":
      return normalizeAddressCandidate(body.userAddress);
    case "POST /bridge/claim-cinit":
    case "POST /bridge/claim":
    case "POST /bridge/redeem-cinit":
    case "POST /bridge/redeem":
      return normalizeAddressCandidate(body.evmAddress);
    case "POST /strategy/execution/intent":
    case "POST /strategy/execution/approve":
    case "POST /strategy/execution/execute":
      return normalizeAddressCandidate(body.ownerAddress);
    default:
      return undefined;
  }
}

app.addHook("preHandler", async (request, reply) => {
  const protectedAddress = resolveProtectedAddress(request);
  if (!protectedAddress) {
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    reply.code(401);
    void reply.send({
      ok: false,
      error: {
        message: "Authentication required."
      }
    });
    return reply;
  }

  try {
    const session = authService.verifyToken(authHeader.slice("Bearer ".length).trim());
    if (session.address !== protectedAddress.toLowerCase()) {
      reply.code(403);
      void reply.send({
        ok: false,
        error: {
          message: "Authenticated wallet does not match this request."
        }
      });
      return reply;
    }
  } catch (error) {
    reply.code(401);
    void reply.send({
      ok: false,
      error: {
        message: error instanceof Error ? error.message : "Authentication failed."
      }
    });
    return reply;
  }
});

app.post("/auth/nonce", async (request, reply) => {
  const { address } = (request.body ?? {}) as { address?: string };
  const normalizedAddress = normalizeAddressCandidate(address);
  if (!normalizedAddress) {
    reply.code(422);
    return {
      ok: false,
      error: {
        message: "A valid wallet address is required."
      }
    };
  }

  return {
    ok: true,
    result: authService.createChallenge(normalizedAddress)
  };
});

app.post("/auth/verify", async (request, reply) => {
  const { address, nonce, signature } = (request.body ?? {}) as {
    address?: string;
    nonce?: string;
    signature?: `0x${string}`;
  };
  const normalizedAddress = normalizeAddressCandidate(address);
  if (!normalizedAddress || typeof nonce !== "string" || typeof signature !== "string") {
    reply.code(422);
    return {
      ok: false,
      error: {
        message: "address, nonce, and signature are required."
      }
    };
  }

  try {
    return {
      ok: true,
      result: await authService.verifyChallenge({
        address: normalizedAddress,
        nonce,
        signature
      })
    };
  } catch (error) {
    reply.code(401);
    return {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : "Authentication failed."
      }
    };
  }
});

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

app.get("/strategy/openapi.json", async () => strategyService.getOpenApiSpec());

app.get("/strategy/capabilities", async () => ({
  capabilities: strategyService.listCapabilities()
}));

app.get("/strategy-tools/catalog", async () => ({
  ok: true,
  meta: makeStrategyToolMeta("catalog"),
  result: {
    tools: strategyToolDefinitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      endpoint: definition.endpoint
    }))
  }
}));

app.get("/strategy/templates", async (request) => {
  const { ownerAddress, marketId } = request.query as {
    ownerAddress?: `0x${string}`;
    marketId?: `0x${string}`;
  };

  if (!ownerAddress) {
    throw new Error("ownerAddress query param is required");
  }

  return {
    templates: strategyService.listTemplates(ownerAddress, marketId)
  };
});

app.post("/strategy-tools/:tool", async (request, reply) => {
  const { tool } = request.params as { tool: StrategyToolName };
  const input = (request.body ?? {}) as Record<string, unknown>;
  const meta = makeStrategyToolMeta(tool);

  try {
    const result = await strategyToolApi.execute(tool, input);
    return {
      ok: true,
      meta,
      result
    };
  } catch (error) {
    const payload = toStrategyToolErrorPayload(error, tool);
    reply.code(payload.statusCode);
    return payload.body;
  }
});

app.post("/strategy/execution/intent", async (request, reply) => {
  const body = (request.body ?? {}) as {
    ownerAddress?: `0x${string}`;
    strategyId?: string;
    maxSlippageBps?: number;
    validForSeconds?: number;
  };

  if (!body.ownerAddress || !body.strategyId) {
    reply.code(422);
    return {
      ok: false,
      error: {
        message: "ownerAddress and strategyId are required."
      }
    };
  }

  try {
    return {
      ok: true,
      result: strategyService.createExecutionIntent({
        ownerAddress: body.ownerAddress,
        strategyId: body.strategyId,
        maxSlippageBps: body.maxSlippageBps,
        validForSeconds: body.validForSeconds
      })
    };
  } catch (error) {
    const payload = toStrategyToolErrorPayload(error, "strategy_execution_intent");
    reply.code(payload.statusCode);
    return payload.body;
  }
});

app.post("/strategy/execution/approve", async (request, reply) => {
  const body = (request.body ?? {}) as {
    ownerAddress?: `0x${string}`;
    strategyId?: string;
    message?: import("@sinergy/shared").StrategyApprovalMessage;
    signature?: `0x${string}`;
  };

  if (!body.ownerAddress || !body.strategyId || !body.message || !body.signature) {
    reply.code(422);
    return {
      ok: false,
      error: {
        message: "ownerAddress, strategyId, message, and signature are required."
      }
    };
  }

  try {
    return {
      ok: true,
      result: await strategyService.saveExecutionApproval({
        ownerAddress: body.ownerAddress,
        strategyId: body.strategyId,
        message: body.message,
        signature: body.signature
      })
    };
  } catch (error) {
    const payload = toStrategyToolErrorPayload(error, "strategy_execution_approve");
    reply.code(payload.statusCode);
    return payload.body;
  }
});

app.get("/strategy/execution/:strategyId", async (request, reply) => {
  const { strategyId } = request.params as { strategyId: string };
  const { ownerAddress } = request.query as { ownerAddress?: `0x${string}` };

  if (!ownerAddress) {
    reply.code(422);
    return {
      ok: false,
      error: {
        message: "ownerAddress is required."
      }
    };
  }

  try {
    return {
      ok: true,
      result: strategyService.getExecutionApproval(strategyId, ownerAddress)
    };
  } catch (error) {
    const payload = toStrategyToolErrorPayload(error, "strategy_execution_get");
    reply.code(payload.statusCode);
    return payload.body;
  }
});

app.post("/strategy/execution/execute", async (request, reply) => {
  const body = (request.body ?? {}) as {
    ownerAddress?: `0x${string}`;
    strategyId?: string;
    routePreference?: RoutePreference;
    candleLookback?: number;
  };

  if (!body.ownerAddress || !body.strategyId) {
    reply.code(422);
    return {
      ok: false,
      error: {
        message: "ownerAddress and strategyId are required."
      }
    };
  }

  try {
    return {
      ok: true,
      result: await strategyExecutionService.executeApprovedStrategy({
        ownerAddress: body.ownerAddress,
        strategyId: body.strategyId,
        routePreference: body.routePreference,
        candleLookback: body.candleLookback
      })
    };
  } catch (error) {
    const payload = toStrategyToolErrorPayload(error, "strategy_execution_execute");
    reply.code(payload.statusCode);
    return payload.body;
  }
});

app.get("/strategy/execution/history/:ownerAddress", async (request, reply) => {
  const { ownerAddress } = request.params as { ownerAddress?: `0x${string}` };
  if (!ownerAddress) {
    reply.code(422);
    return {
      ok: false,
      error: {
        message: "ownerAddress is required."
      }
    };
  }

  try {
    return {
      ok: true,
      result: strategyExecutionService.listExecutionHistory(ownerAddress)
    };
  } catch (error) {
    const payload = toStrategyToolErrorPayload(error, "strategy_execution_history");
    reply.code(payload.statusCode);
    return payload.body;
  }
});

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

app.get("/bridge/assets", async () => ({
  assets: bridgeClaimService.listAssets()
}));

app.get("/bridge/claimable/:initiaAddress", async (request) => {
  const { initiaAddress } = request.params as { initiaAddress: string };
  const { evmAddress } = request.query as { evmAddress?: Address };
  return await bridgeClaimService.preview({ tokenSymbol: "cINIT", initiaAddress, evmAddress });
});

app.get("/bridge/claimable/:tokenSymbol/:initiaAddress", async (request) => {
  const { tokenSymbol, initiaAddress } = request.params as {
    tokenSymbol: string;
    initiaAddress: string;
  };
  const { evmAddress } = request.query as { evmAddress?: Address };
  return await bridgeClaimService.preview({ tokenSymbol, initiaAddress, evmAddress });
});

app.post("/bridge/claim-cinit", async (request) => {
  const body = request.body as {
    initiaAddress: string;
    evmAddress: Address;
  };

  return await bridgeClaimService.claim({
    tokenSymbol: "cINIT",
    initiaAddress: body.initiaAddress,
    evmAddress: body.evmAddress
  });
});

app.post("/bridge/claim", async (request) => {
  const body = request.body as {
    tokenSymbol: string;
    initiaAddress: string;
    evmAddress: Address;
  };

  return await bridgeClaimService.claim({
    tokenSymbol: body.tokenSymbol,
    initiaAddress: body.initiaAddress,
    evmAddress: body.evmAddress
  });
});

app.post("/bridge/redeem-cinit", async (request) => {
  const body = request.body as {
    initiaAddress: string;
    evmAddress: Address;
    amountAtomic: string;
  };

  return await bridgeClaimService.redeem({
    tokenSymbol: "cINIT",
    initiaAddress: body.initiaAddress,
    evmAddress: body.evmAddress,
    amountAtomic: BigInt(body.amountAtomic)
  });
});

app.post("/bridge/redeem", async (request) => {
  const body = request.body as {
    tokenSymbol: string;
    initiaAddress: string;
    evmAddress: Address;
    amountAtomic: string;
  };

  return await bridgeClaimService.redeem({
    tokenSymbol: body.tokenSymbol,
    initiaAddress: body.initiaAddress,
    evmAddress: body.evmAddress,
    amountAtomic: BigInt(body.amountAtomic)
  });
});

app.get("/prices/:symbol/candles", async (request) => {
  const { symbol } = request.params as { symbol: string };
  const { interval = "15m", limit = "200", before } = request.query as {
    interval?: string;
    limit?: string;
    before?: string;
  };
  const page = priceService.getCandlesPage(
    symbol,
    interval,
    Number(limit),
    before ? { beforeTs: Number(before) } : undefined
  );

  return {
    symbol,
    interval,
    candles: page.candles,
    hasMore: page.hasMore
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
    routePreference?: RoutePreference;
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
    routePreference?: RoutePreference;
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
  const { txHash, userAddress, logs, zkNote } = request.body as {
    txHash: string;
    userAddress: Address;
    logs?: Array<{ address: Address; topics: Hex[]; data: Hex }>;
    zkNote?: {
      commitment: Hex;
      secret: string;
      blinding: string;
    };
  };
  return await vaultService.syncDeposit(txHash, userAddress, logs, zkNote);
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

app.post("/vault/zk-withdrawal-package", async (request) => {
  const { userAddress, token, amountAtomic } = request.body as {
    userAddress: Address;
    token: Address;
    amountAtomic: string;
  };

  const requestedAmountAtomic = BigInt(amountAtomic);
  if (vaultService.getAvailableBalance(userAddress, token) < requestedAmountAtomic) {
    throw new Error("Insufficient internal balance");
  }

  return zkProofService.prepareWithdrawalPackage({
    recipient: userAddress,
    token,
    amountAtomic: requestedAmountAtomic
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

app.post("/vault/cancel-withdrawal", async (request) => {
  const { userAddress, token, nonce } = request.body as {
    userAddress: Address;
    token: Address;
    nonce: number;
  };

  return vaultService.cancelPendingWithdrawal({
    userAddress,
    token,
    nonce
  });
});

app.post("/vault/cancel-zk-withdrawal", async (request) => {
  const { userAddress, token, amountAtomic, nullifier } = request.body as {
    userAddress: Address;
    token: Address;
    amountAtomic: string;
    nullifier?: Hex;
  };

  return zkProofService.cancelPendingWithdrawal({
    recipient: userAddress,
    token,
    amountAtomic: BigInt(amountAtomic),
    nullifier
  });
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
