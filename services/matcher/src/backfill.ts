import { env } from "./config/env.js";
import { PriceService } from "./services/priceService.js";

function parsePositiveInt(input: string | undefined, fallback: number) {
  if (!input) return fallback;
  const value = Number.parseInt(input, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main() {
  const days = parsePositiveInt(process.env.BACKFILL_DAYS, 60);
  const chunkDays = parsePositiveInt(process.env.BACKFILL_CHUNK_DAYS, 7);

  const priceService = new PriceService({
    dbFile: env.PRICE_DB_FILE,
    pollIntervalMs: env.PRICE_POLL_INTERVAL_MS,
    providerApiKey: env.TWELVE_DATA_API_KEY,
    coingeckoDemoApiKey: env.COINGECKO_DEMO_API_KEY,
    bondProxySymbol: env.T_BOND_PROXY_SYMBOL,
    initiaConnectRestUrl: env.INITIA_CONNECT_REST_URL
  });

  console.log(`[backfill] Starting ${days}d history sync with ${chunkDays}d windows...`);
  await priceService.backfill({ days, chunkDays });
  console.log("[backfill] Completed.");
  console.log(JSON.stringify(priceService.getStatus(), null, 2));
  console.log(JSON.stringify(priceService.getAll(), null, 2));
}

main().catch((error) => {
  console.error("[backfill] Failed:", error);
  process.exitCode = 1;
});
