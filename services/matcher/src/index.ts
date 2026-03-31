import Fastify from "fastify";
import cors from "@fastify/cors";
import { parseUnits } from "viem";
import type { Address, Hex } from "viem";
import { env } from "./config/env.js";
import { loadDeployment, resolveMarkets, resolveTokens } from "./services/deployment.js";
import { StateStore } from "./services/state.js";
import { PriceService } from "./services/priceService.js";
import { MatchingService } from "./services/matcher.js";
import { VaultService, createClients } from "./services/vault.js";

const deployment = loadDeployment(env.DEPLOYMENT_FILE);
const tokens = resolveTokens(deployment);
const markets = resolveMarkets(deployment);
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

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get("/health", async () => ({
  ok: true,
  matcher: account.address,
  markets: markets.length,
  pricing: priceService.getStatus()
}));

app.get("/config", async () => ({
  deployment,
  markets
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

app.post("/vault/sync-deposit", async (request) => {
  const { txHash, userAddress } = request.body as {
    txHash: Hex;
    userAddress: Address;
  };
  return await vaultService.syncDeposit(txHash, userAddress);
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
  const { txHash, userAddress } = request.body as {
    txHash: Hex;
    userAddress: Address;
  };
  return await vaultService.syncWithdrawal(txHash, userAddress);
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
