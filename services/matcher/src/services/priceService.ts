import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
type FeedSource = "twelve-data" | "initia-connect";

type StoredBarRow = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type AssetFeedConfig = {
  source: FeedSource;
  providerSymbol: string;
  fallbackPrice: string;
  supportsBackfill: boolean;
  coingeckoId?: string;
};

type TwelveDataValue = {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
};

type TwelveDataResponse = {
  status?: "ok" | "error";
  message?: string;
  code?: number;
  values?: TwelveDataValue[];
};

type CoinGeckoMarketChartRangeResponse = {
  prices?: Array<[number, number]>;
  total_volumes?: Array<[number, number]>;
};

type PriceServiceOptions = {
  dbFile: string;
  pollIntervalMs: number;
  providerApiKey?: string;
  coingeckoDemoApiKey?: string;
  bondProxySymbol: string;
  initiaConnectRestUrl: string;
};

type BackfillOptions = {
  days?: number;
  chunkDays?: number;
};

const DEFAULT_INTERVAL: CandleInterval = "1m";

function normalizeInterval(input?: string): CandleInterval {
  switch ((input ?? DEFAULT_INTERVAL).toLowerCase()) {
    case "1m":
    case "1min":
      return "1m";
    case "5m":
    case "5min":
      return "5m";
    case "15m":
    case "15min":
      return "15m";
    case "1h":
    case "60m":
      return "1h";
    case "4h":
    case "240m":
      return "4h";
    case "1d":
    case "1day":
      return "1d";
    default:
      return DEFAULT_INTERVAL;
  }
}

function intervalSeconds(interval: CandleInterval) {
  switch (interval) {
    case "1m":
      return 60;
    case "5m":
      return 300;
    case "15m":
      return 900;
    case "1h":
      return 3_600;
    case "4h":
      return 14_400;
    case "1d":
      return 86_400;
  }
}

function parseProviderTime(datetime: string) {
  const normalized = datetime.includes("T") ? datetime : `${datetime.replace(" ", "T")}Z`;
  return Math.floor(Date.parse(normalized) / 1000);
}

function formatProviderDate(date: Date) {
  return date.toISOString().slice(0, 19);
}

function formatFallbackBar(price: string): StoredBarRow {
  const close = Number(price);
  const ts = Math.floor(Date.now() / 60_000) * 60;

  return {
    ts,
    open: close,
    high: close,
    low: close,
    close,
    volume: 0
  };
}

export class PriceService {
  private readonly db: DatabaseSync;
  private readonly latestPrices = new Map<string, string>();
  private readonly assetConfigs: Record<string, AssetFeedConfig>;
  private readonly providerApiKey?: string;
  private readonly coingeckoDemoApiKey?: string;
  private readonly pollIntervalMs: number;
  private readonly initiaConnectRestUrl: string;
  private lastSyncAt: string | null = null;
  private providerRequestTimestamps: number[] = [];

  constructor(options: PriceServiceOptions) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseSync(options.dbFile);
    this.providerApiKey = options.providerApiKey?.trim() || undefined;
    this.coingeckoDemoApiKey = options.coingeckoDemoApiKey?.trim() || undefined;
    this.pollIntervalMs = options.pollIntervalMs;
    this.initiaConnectRestUrl = options.initiaConnectRestUrl.replace(/\/$/, "");
    this.assetConfigs = {
      tAAPL: {
        source: "twelve-data",
        providerSymbol: "AAPL",
        fallbackPrice: "191.25",
        supportsBackfill: true
      },
      tNVDA: {
        source: "twelve-data",
        providerSymbol: "NVDA",
        fallbackPrice: "893.50",
        supportsBackfill: true
      },
      tBOND: {
        source: "twelve-data",
        providerSymbol: options.bondProxySymbol.toUpperCase(),
        fallbackPrice: "102.40",
        supportsBackfill: true
      },
      cBTC: {
        source: "initia-connect",
        providerSymbol: "BTC/USD",
        fallbackPrice: "85000.00",
        supportsBackfill: true,
        coingeckoId: "bitcoin"
      },
      cETH: {
        source: "initia-connect",
        providerSymbol: "ETH/USD",
        fallbackPrice: "1900.00",
        supportsBackfill: true,
        coingeckoId: "ethereum"
      },
      cSOL: {
        source: "initia-connect",
        providerSymbol: "SOL/USD",
        fallbackPrice: "120.00",
        supportsBackfill: true,
        coingeckoId: "solana"
      },
      cINIT: {
        source: "initia-connect",
        providerSymbol: "INIT/USD",
        fallbackPrice: "1.00",
        supportsBackfill: true,
        coingeckoId: "initia"
      }
    };

    this.ensureSchema();
    this.seedFallbackBars();
    this.refreshLatestCache();
  }

  async start() {
    await this.syncAll().catch((error) => {
      console.error("[pricing] Initial sync failed:", error);
    });

    const timer = setInterval(() => {
      void this.syncAll().catch((error) => {
        console.error("[pricing] Scheduled sync failed:", error);
      });
    }, this.pollIntervalMs);

    timer.unref?.();
  }

  async backfill(options: BackfillOptions = {}) {
    const days = options.days ?? 60;
    const chunkDays = options.chunkDays ?? 7;
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

    for (const [assetSymbol, config] of Object.entries(this.assetConfigs)) {
      if (!config.supportsBackfill) continue;

       if (config.source === "initia-connect") {
        if (!this.coingeckoDemoApiKey || !config.coingeckoId) {
          console.warn(`[pricing] Skipping crypto backfill for ${assetSymbol}; CoinGecko demo key is not configured.`);
          continue;
        }

        await this.backfillCoinGecko(assetSymbol, config, startDate, endDate, Math.max(chunkDays, 30));
        continue;
      }

      if (!this.providerApiKey) {
        console.warn(`[pricing] Skipping RWA backfill for ${assetSymbol}; Twelve Data API key is not configured.`);
        continue;
      }

      let cursor = new Date(startDate);
      while (cursor < endDate) {
        const chunkEnd = new Date(
          Math.min(cursor.getTime() + chunkDays * 24 * 60 * 60 * 1000, endDate.getTime())
        );

        await this.runRateLimited(() =>
          this.syncSymbol(assetSymbol, config, {
            startDate: cursor,
            endDate: chunkEnd,
            outputsize: 5000,
            order: "asc"
          })
        );

        cursor = new Date(chunkEnd.getTime() + 60_000);
      }
    }

    this.lastSyncAt = new Date().toISOString();
    this.refreshLatestCache();
  }

  getReferencePrice(symbol: string): string {
    return this.latestPrices.get(symbol) ?? this.assetConfigs[symbol]?.fallbackPrice ?? "100.00";
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(
      Object.keys(this.assetConfigs).map((symbol) => [symbol, this.getReferencePrice(symbol)])
    );
  }

  getSparkline(symbol: string, limit = 28) {
    return this.getCandles(symbol, "1m", limit).map((bar) => Number(bar.close.toFixed(2)));
  }

  getCandles(symbol: string, inputInterval?: string, limit = 200) {
    const interval = normalizeInterval(inputInterval);
    const bucketSeconds = intervalSeconds(interval);
    const fetchLimit = Math.max(limit * Math.max(bucketSeconds / 60, 1), limit);
    const hasLiveRows = this.hasLiveRows(symbol);

    const rows = this.db
      .prepare(
        `
          SELECT ts, open, high, low, close, volume
          FROM price_bars
          WHERE asset_symbol = ?
            AND (? = 0 OR source != 'fallback')
          ORDER BY ts DESC
          LIMIT ?
        `
      )
      .all(symbol, hasLiveRows ? 1 : 0, fetchLimit) as StoredBarRow[];

    const ascending = rows.reverse();
    if (ascending.length === 0) {
      return [formatFallbackBar(this.getReferencePrice(symbol))];
    }

    if (interval === "1m") {
      // Post-process: synthesize OHLC for flat bars (where open==high==low==close)
      // by using the previous bar's close as the open
      const result = ascending.slice(-limit);
      for (let i = 1; i < result.length; i++) {
        const bar = result[i];
        const prevClose = result[i - 1].close;
        if (bar.open === bar.high && bar.open === bar.low && bar.open === bar.close) {
          // Flat bar from legacy data: synthesize OHLC
          bar.open = prevClose;
          bar.high = Math.max(prevClose, bar.close);
          bar.low = Math.min(prevClose, bar.close);
        } else if (bar.open === bar.close && bar.high === bar.close && bar.low === bar.close) {
          // Another flat bar pattern
          bar.open = prevClose;
          bar.high = Math.max(prevClose, bar.close);
          bar.low = Math.min(prevClose, bar.close);
        }
      }
      return result;
    }

    const aggregated: StoredBarRow[] = [];
    let current: StoredBarRow | null = null;
    let currentBucket = -1;

    for (const row of ascending) {
      const bucket = Math.floor(row.ts / bucketSeconds) * bucketSeconds;
      if (bucket !== currentBucket) {
        if (current) aggregated.push(current);
        currentBucket = bucket;
        current = {
          ts: bucket,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume
        };
        continue;
      }

      current = {
        ts: current!.ts,
        open: current!.open,
        high: Math.max(current!.high, row.high),
        low: Math.min(current!.low, row.low),
        close: row.close,
        volume: current!.volume + row.volume
      };
    }

    if (current) aggregated.push(current);
    return aggregated.slice(-limit);
  }

  getStatus() {
    return {
      provider: "hybrid",
      configured: {
        twelveData: Boolean(this.providerApiKey),
        coingeckoDemo: Boolean(this.coingeckoDemoApiKey),
        initiaConnect: true
      },
      pollIntervalMs: this.pollIntervalMs,
      lastSyncAt: this.lastSyncAt,
      connectOracleRestUrl: this.initiaConnectRestUrl,
      providerSymbols: Object.fromEntries(
        Object.entries(this.assetConfigs).map(([symbol, config]) => [symbol, config.providerSymbol])
      )
    };
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_bars (
        asset_symbol TEXT NOT NULL,
        provider_symbol TEXT NOT NULL,
        ts INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'fallback',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (asset_symbol, ts)
      );

      CREATE INDEX IF NOT EXISTS idx_price_bars_symbol_ts
      ON price_bars(asset_symbol, ts DESC);
    `);
  }

  private seedFallbackBars() {
    const insert = this.db.prepare(`
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fallback')
      ON CONFLICT(asset_symbol, ts) DO NOTHING
    `);

    for (const [assetSymbol, config] of Object.entries(this.assetConfigs)) {
      const countRow = this.db
        .prepare("SELECT COUNT(*) AS count FROM price_bars WHERE asset_symbol = ?")
        .get(assetSymbol) as { count: number };

      if (countRow.count > 0) continue;

      const bar = formatFallbackBar(config.fallbackPrice);
      insert.run(
        assetSymbol,
        config.providerSymbol,
        bar.ts,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume
      );
    }
  }

  private refreshLatestCache() {
    this.latestPrices.clear();

    for (const assetSymbol of Object.keys(this.assetConfigs)) {
      const row = this.db
        .prepare(
          `
            SELECT close
            FROM price_bars
            WHERE asset_symbol = ?
            ORDER BY CASE WHEN source = 'fallback' THEN 1 ELSE 0 END ASC, ts DESC
            LIMIT 1
          `
        )
        .get(assetSymbol) as { close: number } | undefined;

      if (row) {
        this.latestPrices.set(assetSymbol, Number(row.close).toFixed(2));
      }
    }
  }

  private async syncAll() {
    await Promise.all(
      Object.entries(this.assetConfigs).map(([assetSymbol, config]) =>
        this.syncSymbol(assetSymbol, config)
      )
    );

    this.lastSyncAt = new Date().toISOString();
    this.refreshLatestCache();
  }

  private async syncSymbol(
    assetSymbol: string,
    config: AssetFeedConfig,
    options?: {
      startDate?: Date;
      endDate?: Date;
      outputsize?: number;
      order?: "asc" | "desc";
    }
  ) {
    if (config.source === "initia-connect") {
      return await this.syncConnectSymbol(assetSymbol, config);
    }

    if (!this.providerApiKey) {
      return;
    }

    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol", config.providerSymbol);
    url.searchParams.set("interval", "1min");
    url.searchParams.set("outputsize", String(options?.outputsize ?? 180));
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("order", options?.order ?? "desc");
    url.searchParams.set("apikey", this.providerApiKey);

    if (options?.startDate) {
      url.searchParams.set("start_date", formatProviderDate(options.startDate));
    }
    if (options?.endDate) {
      url.searchParams.set("end_date", formatProviderDate(options.endDate));
    }

    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${config.providerSymbol}`);
    }

    const payload = (await response.json()) as TwelveDataResponse;
    if (payload.status === "error") {
      throw new Error(payload.message ?? `Provider error for ${config.providerSymbol}`);
    }

    const values = Array.isArray(payload.values) ? payload.values : [];
    if (values.length === 0) {
      throw new Error(`No values returned for ${config.providerSymbol}`);
    }

    const insert = this.db.prepare(`
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'twelve-data')
      ON CONFLICT(asset_symbol, ts) DO UPDATE SET
        provider_symbol = excluded.provider_symbol,
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        source = excluded.source
    `);

    const transaction = (rows: TwelveDataValue[]) => {
      this.db.exec("BEGIN");

      for (const row of rows) {
        insert.run(
          assetSymbol,
          config.providerSymbol,
          parseProviderTime(row.datetime),
          Number(row.open),
          Number(row.high),
          Number(row.low),
          Number(row.close),
          Number(row.volume ?? "0")
        );
      }

      this.db.prepare("DELETE FROM price_bars WHERE asset_symbol = ? AND source = 'fallback'").run(assetSymbol);
      this.db.exec("COMMIT");
    };

    try {
      transaction(values);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async syncConnectSymbol(assetSymbol: string, config: AssetFeedConfig) {
    const url = new URL(`${this.initiaConnectRestUrl}/connect/oracle/v2/get_price`);
    url.searchParams.set("currency_pair", config.providerSymbol);

    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${config.providerSymbol} from Connect`);
    }

    const payload = (await response.json()) as {
      price?: {
        price?: string;
        block_timestamp?: string;
      };
      decimals?: string;
    };

    const priceRaw = payload.price?.price;
    const blockTimestamp = payload.price?.block_timestamp;
    const decimals = Number(payload.decimals ?? "0");
    if (!priceRaw || !blockTimestamp) {
      throw new Error(`Invalid Connect response for ${config.providerSymbol}`);
    }

    const close = Number(priceRaw) / 10 ** decimals;
    const ts = Math.floor(parseProviderTime(blockTimestamp) / 60) * 60;

    // Look up previous bar's close to use as this bar's open
    const prevRow = this.db
      .prepare(
        `SELECT close FROM price_bars
         WHERE asset_symbol = ? AND ts < ? AND source != 'fallback'
         ORDER BY ts DESC LIMIT 1`
      )
      .get(assetSymbol, ts) as { close: number } | undefined;

    const open = prevRow ? prevRow.close : close;
    const high = Math.max(open, close);
    const low = Math.min(open, close);

    // Check if a bar already exists for this minute so we can merge high/low
    const existingRow = this.db
      .prepare(
        `SELECT open, high, low FROM price_bars
         WHERE asset_symbol = ? AND ts = ? AND source != 'fallback'`
      )
      .get(assetSymbol, ts) as { open: number; high: number; low: number } | undefined;

    if (existingRow) {
      // Merge: keep the original open, extend high/low, update close
      this.db
        .prepare(
          `UPDATE price_bars SET
             high = MAX(high, ?),
             low = MIN(low, ?),
             close = ?,
             source = 'initia-connect'
           WHERE asset_symbol = ? AND ts = ?`
        )
        .run(Math.max(high, existingRow.high), Math.min(low, existingRow.low), close, assetSymbol, ts);
    } else {
      this.db
        .prepare(
          `INSERT INTO price_bars (
            asset_symbol, provider_symbol, ts, open, high, low, close, volume, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'initia-connect')
          ON CONFLICT(asset_symbol, ts) DO UPDATE SET
            provider_symbol = excluded.provider_symbol,
            open = excluded.open,
            high = excluded.high,
            low = excluded.low,
            close = excluded.close,
            volume = excluded.volume,
            source = excluded.source`
        )
        .run(assetSymbol, config.providerSymbol, ts, open, high, low, close, 0);
    }

    this.db.prepare("DELETE FROM price_bars WHERE asset_symbol = ? AND source = 'fallback'").run(assetSymbol);
  }

  private async backfillCoinGecko(
    assetSymbol: string,
    config: AssetFeedConfig,
    startDate: Date,
    endDate: Date,
    chunkDays: number
  ) {
    let cursor = new Date(startDate);

    while (cursor < endDate) {
      const chunkEnd = new Date(
        Math.min(cursor.getTime() + chunkDays * 24 * 60 * 60 * 1000, endDate.getTime())
      );

      await this.syncCoinGeckoRange(assetSymbol, config, cursor, chunkEnd);
      cursor = new Date(chunkEnd.getTime() + 60_000);
    }
  }

  private async syncCoinGeckoRange(
    assetSymbol: string,
    config: AssetFeedConfig,
    startDate: Date,
    endDate: Date
  ) {
    if (!this.coingeckoDemoApiKey || !config.coingeckoId) {
      return;
    }

    const url = new URL(`https://api.coingecko.com/api/v3/coins/${config.coingeckoId}/market_chart/range`);
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("from", String(Math.floor(startDate.getTime() / 1000)));
    url.searchParams.set("to", String(Math.floor(endDate.getTime() / 1000)));

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "x-cg-demo-api-key": this.coingeckoDemoApiKey
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${config.coingeckoId} from CoinGecko`);
    }

    const payload = (await response.json()) as CoinGeckoMarketChartRangeResponse;
    const prices = Array.isArray(payload.prices) ? payload.prices : [];
    if (prices.length === 0) {
      throw new Error(`No CoinGecko prices returned for ${config.coingeckoId}`);
    }

    const volumeByTs = new Map<number, number>();
    for (const point of payload.total_volumes ?? []) {
      const ts = Math.floor(point[0] / 1000 / 60) * 60;
      volumeByTs.set(ts, Number(point[1]));
    }

    const insert = this.db.prepare(`
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'coingecko-demo')
      ON CONFLICT(asset_symbol, ts) DO UPDATE SET
        provider_symbol = excluded.provider_symbol,
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        source = excluded.source
    `);

    const rows = [...prices].sort((a, b) => a[0] - b[0]);

    const transaction = () => {
      this.db.exec("BEGIN");

      let previousClose = Number(rows[0][1]);
      for (const [timestampMs, price] of rows) {
        const ts = Math.floor(timestampMs / 1000 / 60) * 60;
        const close = Number(price);
        const open = previousClose;
        const high = Math.max(open, close);
        const low = Math.min(open, close);
        const volume = volumeByTs.get(ts) ?? 0;

        insert.run(
          assetSymbol,
          config.providerSymbol,
          ts,
          open,
          high,
          low,
          close,
          volume
        );

        previousClose = close;
      }

      this.db.prepare("DELETE FROM price_bars WHERE asset_symbol = ? AND source = 'fallback'").run(assetSymbol);
      this.db.exec("COMMIT");
    };

    try {
      transaction();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private hasLiveRows(symbol: string) {
    const row = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM price_bars
          WHERE asset_symbol = ?
            AND source != 'fallback'
        `
      )
      .get(symbol) as { count: number };

    return row.count > 0;
  }

  private async runRateLimited<T>(task: () => Promise<T>) {
    while (true) {
      await this.waitForApiCreditWindow();

      try {
        return await task();
      } catch (error) {
        if (!this.isProviderRateLimitError(error)) {
          throw error;
        }

        await this.delay(65_000);
      }
    }
  }

  private async waitForApiCreditWindow() {
    while (true) {
      const now = Date.now();
      this.providerRequestTimestamps = this.providerRequestTimestamps.filter(
        (timestamp) => now - timestamp < 60_000
      );

      if (this.providerRequestTimestamps.length < 7) {
        this.providerRequestTimestamps.push(now);
        return;
      }

      const oldest = this.providerRequestTimestamps[0];
      const waitMs = Math.max(60_000 - (now - oldest) + 500, 1_000);
      await this.delay(waitMs);
    }
  }

  private isProviderRateLimitError(error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return message.includes("api credits") || message.includes("rate limit");
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
