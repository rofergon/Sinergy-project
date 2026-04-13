import { env } from "./config/env.js";
import { PriceService } from "./services/priceService.js";

function parsePositiveInt(input: string | undefined, fallback: number) {
  if (!input) return fallback;
  const value = Number.parseInt(input, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseDate(input: string | undefined, fallback: Date) {
  if (!input) return fallback;
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

async function main() {
  const chunkDays = parsePositiveInt(process.env.BACKFILL_CHUNK_DAYS, 3);

  // Support either: days from now (BACKFILL_DAYS) OR exact date range (BACKFILL_FROM / BACKFILL_TO)
  const backfillFrom = process.env.BACKFILL_FROM;
  const backfillTo = process.env.BACKFILL_TO;

  let days: number;
  if (backfillFrom) {
    const fromDate = parseDate(backfillFrom, new Date());
    const toDate = backfillTo ? parseDate(backfillTo, new Date()) : new Date();
    days = Math.ceil((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000));
    console.log(`[backfill] Date range: ${fromDate.toISOString()} -> ${toDate.toISOString()} (${days} days)`);
  } else {
    days = parsePositiveInt(process.env.BACKFILL_DAYS, 90);
  }

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
