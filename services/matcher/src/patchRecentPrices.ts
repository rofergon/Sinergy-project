import { DatabaseSync } from "node:sqlite";
import { env } from "./config/env.js";
import { PriceService } from "./services/priceService.js";

type GapRow = {
  asset_symbol: string;
  provider_symbol: string;
  prev_ts: number;
  next_ts: number;
  prev_close: number;
  next_close: number;
  gap_seconds: number;
};

const BINANCE_SYMBOLS: Record<string, string> = {
  cBTC: "BTCUSDT",
  cETH: "ETHUSDT",
  cSOL: "SOLUSDT",
  cINIT: "INITUSDT"
};

function parsePositiveInt(input: string | undefined, fallback: number) {
  if (!input) return fallback;
  const value = Number.parseInt(input, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeSymbolFilter(value: string) {
  const normalized = value.trim();
  if (!normalized) return "";

  const marketMatch = normalized.match(/^([^/]+)\/([^/]+)$/);
  if (marketMatch) {
    const [, baseSymbol, quoteSymbol] = marketMatch;
    if (quoteSymbol === "cUSDC" || quoteSymbol === "USDC") {
      return baseSymbol;
    }
  }

  return normalized;
}

function parseOptionalSymbolFilter(input: string | undefined) {
  return new Set(
    (input ?? "")
      .split(",")
      .map((value) => normalizeSymbolFilter(value))
      .filter(Boolean)
  );
}

async function runBackfill(days: number, chunkDays: number) {
  const priceService = new PriceService({
    dbFile: env.PRICE_DB_FILE,
    pollIntervalMs: env.PRICE_POLL_INTERVAL_MS,
    providerApiKey: env.TWELVE_DATA_API_KEY,
    coingeckoDemoApiKey: env.COINGECKO_DEMO_API_KEY,
    bondProxySymbol: env.T_BOND_PROXY_SYMBOL,
    initiaConnectRestUrl: env.INITIA_CONNECT_REST_URL
  });

  console.log(`[patch-prices] Backfilling ${days}d history with ${chunkDays}d windows...`);
  await priceService.backfill({ days, chunkDays });
}

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

async function fetchBinanceKlines(symbol: string, startTimeMs: number, endTimeMs: number) {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", "1m");
  url.searchParams.set("startTime", String(startTimeMs));
  url.searchParams.set("endTime", String(endTimeMs));
  url.searchParams.set("limit", "1000");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching Binance klines for ${symbol}`);
  }

  return (await response.json()) as BinanceKline[];
}

async function backfillGapFromBinance(
  db: DatabaseSync,
  gap: GapRow
) {
  const binanceSymbol = BINANCE_SYMBOLS[gap.asset_symbol];
  if (!binanceSymbol) {
    return 0;
  }

  const insert = db.prepare(`
    INSERT INTO price_bars (
      asset_symbol,
      provider_symbol,
      ts,
      open,
      high,
      low,
      close,
      volume,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'binance')
    ON CONFLICT(asset_symbol, ts) DO UPDATE SET
      provider_symbol = excluded.provider_symbol,
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume,
      source = excluded.source
  `);

  let cursorMs = (gap.prev_ts + 60) * 1000;
  const endMs = gap.next_ts * 1000;
  let inserted = 0;

  while (cursorMs < endMs) {
    const chunkEndMs = Math.min(cursorMs + 1000 * 60 * 999, endMs);
    const klines = await fetchBinanceKlines(binanceSymbol, cursorMs, chunkEndMs);
    if (klines.length === 0) {
      cursorMs = chunkEndMs + 60_000;
      continue;
    }

    for (const kline of klines) {
      const ts = Math.floor(kline[0] / 1000);
      if (ts <= gap.prev_ts || ts >= gap.next_ts) continue;

      const result = insert.run(
        gap.asset_symbol,
        binanceSymbol,
        ts,
        Number(kline[1]),
        Number(kline[2]),
        Number(kline[3]),
        Number(kline[4]),
        Number(kline[5])
      ) as { changes?: number };

      inserted += result.changes ?? 0;
    }

    cursorMs = Number(klines[klines.length - 1][0]) + 60_000;
  }

  if (inserted > 0) {
    db.prepare(
      `
        DELETE FROM price_bars
        WHERE asset_symbol = ?
          AND source = 'patched-local'
          AND ts > ?
          AND ts < ?
      `
    ).run(gap.asset_symbol, gap.prev_ts, gap.next_ts);
  }

  return inserted;
}

async function fillRecentCryptoGaps(
  dbFile: string,
  lookbackDays: number,
  minGapSeconds: number,
  onlySymbols: Set<string>
) {
  const db = new DatabaseSync(dbFile);
  const cutoffTs = Math.floor(Date.now() / 1000) - lookbackDays * 24 * 60 * 60;

  const symbolClause = onlySymbols.size
    ? `AND current.asset_symbol IN (${[...onlySymbols].map(() => "?").join(", ")})`
    : "";

  const gaps = db
    .prepare(
      `
        WITH ordered AS (
          SELECT
            asset_symbol,
            provider_symbol,
            ts,
            close,
            LAG(ts) OVER (PARTITION BY asset_symbol ORDER BY ts) AS prev_ts,
            LAG(close) OVER (PARTITION BY asset_symbol ORDER BY ts) AS prev_close,
            LAG(provider_symbol) OVER (PARTITION BY asset_symbol ORDER BY ts) AS prev_provider_symbol
          FROM price_bars
          WHERE asset_symbol LIKE 'c%'
        )
        SELECT
          current.asset_symbol,
          COALESCE(current.prev_provider_symbol, current.provider_symbol) AS provider_symbol,
          current.prev_ts,
          current.ts AS next_ts,
          current.prev_close,
          current.close AS next_close,
          current.ts - current.prev_ts AS gap_seconds
        FROM ordered AS current
        WHERE current.prev_ts IS NOT NULL
          AND current.ts - current.prev_ts > ?
          AND current.prev_ts >= ?
          ${symbolClause}
        ORDER BY current.asset_symbol ASC, current.prev_ts ASC
      `
    )
    .all(minGapSeconds, cutoffTs, ...onlySymbols) as GapRow[];

  if (gaps.length === 0) {
    console.log("[patch-prices] No recent crypto gaps detected after backfill.");
    return {
      gapsPatched: 0,
      rowsInserted: 0
    };
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO price_bars (
      asset_symbol,
      provider_symbol,
      ts,
      open,
      high,
      low,
      close,
      volume,
      source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'patched-local')
  `);

  let gapsPatched = 0;
  let rowsInserted = 0;

  for (const gap of gaps) {
    const totalSteps = Math.floor((gap.next_ts - gap.prev_ts) / 60) - 1;
    if (totalSteps <= 0) continue;

    const binanceInserted = await backfillGapFromBinance(db, gap);
    if (binanceInserted > 0) {
      gapsPatched += 1;
      rowsInserted += binanceInserted;
      console.log(
        `[patch-prices] Patched ${gap.asset_symbol} gap ${new Date(gap.prev_ts * 1000).toISOString()} -> ${new Date(gap.next_ts * 1000).toISOString()} with ${binanceInserted} Binance bars.`
      );
      continue;
    }

    let previousClose = gap.prev_close;
    let insertedForGap = 0;

    db.exec("BEGIN");
    try {
      for (let step = 1; step <= totalSteps; step += 1) {
        const ts = gap.prev_ts + step * 60;
        const ratio = (ts - gap.prev_ts) / (gap.next_ts - gap.prev_ts);
        const close = gap.prev_close + (gap.next_close - gap.prev_close) * ratio;
        const open = previousClose;
        const high = Math.max(open, close);
        const low = Math.min(open, close);
        const result = insert.run(
          gap.asset_symbol,
          gap.provider_symbol,
          ts,
          open,
          high,
          low,
          close,
          0
        ) as { changes?: number };

        if ((result.changes ?? 0) > 0) {
          rowsInserted += 1;
          insertedForGap += 1;
        }

        previousClose = close;
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    if (insertedForGap > 0) {
      gapsPatched += 1;
      console.log(
        `[patch-prices] Patched ${gap.asset_symbol} gap ${new Date(gap.prev_ts * 1000).toISOString()} -> ${new Date(gap.next_ts * 1000).toISOString()} with ${insertedForGap} synthetic bars.`
      );
    }
  }

  return {
    gapsPatched,
    rowsInserted
  };
}

async function main() {
  const lookbackDays = parsePositiveInt(process.env.PATCH_LOOKBACK_DAYS, 7);
  const backfillDays = parsePositiveInt(process.env.PATCH_BACKFILL_DAYS, lookbackDays);
  const chunkDays = parsePositiveInt(process.env.PATCH_BACKFILL_CHUNK_DAYS, 2);
  const minGapSeconds = parsePositiveInt(process.env.PATCH_MIN_GAP_SECONDS, 300);
  const onlySymbols = parseOptionalSymbolFilter(process.env.PATCH_ONLY_SYMBOLS);

  await runBackfill(backfillDays, chunkDays);
  const summary = await fillRecentCryptoGaps(env.PRICE_DB_FILE, lookbackDays, minGapSeconds, onlySymbols);

  console.log("[patch-prices] Completed.");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("[patch-prices] Failed:", error);
  process.exitCode = 1;
});
