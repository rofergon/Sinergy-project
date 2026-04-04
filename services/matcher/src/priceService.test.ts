import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PriceService } from "./services/priceService.js";

function makeService() {
  const root = mkdtempSync(join(tmpdir(), "sinergy-price-test-"));
  const service = new PriceService({
    dbFile: join(root, "prices.sqlite"),
    pollIntervalMs: 60_000,
    bondProxySymbol: "IEF",
    initiaConnectRestUrl: "http://127.0.0.1:1"
  });

  return {
    root,
    service,
    db: (service as any).db as import("node:sqlite").DatabaseSync,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function insertBars(
  db: import("node:sqlite").DatabaseSync,
  assetSymbol: string,
  timestamps: number[]
) {
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'twelve-data')
    ON CONFLICT(asset_symbol, ts) DO UPDATE SET
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume,
      source = excluded.source
  `);

  let price = 100;
  for (const ts of timestamps) {
    insert.run(assetSymbol, "BTC/USD", ts, price, price + 1, price - 1, price, 10);
    price += 1;
  }
}

test("price service trims sparse historical gaps from 1m candles", () => {
  const harness = makeService();

  try {
    insertBars(harness.db, "cBTC", [60, 120, 180, 3_600, 3_660, 3_720]);

    const result = harness.service.getCandlesPage("cBTC", "1m", 6);

    assert.deepEqual(
      result.candles.map((bar) => bar.ts),
      [3_600, 3_660, 3_720]
    );
    assert.equal(result.hasMore, false);
  } finally {
    harness.cleanup();
  }
});

test("price service keeps paginating when 1m candles are continuous", () => {
  const harness = makeService();

  try {
    insertBars(harness.db, "cBTC", [60, 120, 180, 240, 300, 360, 420, 480, 540, 600]);

    const firstPage = harness.service.getCandlesPage("cBTC", "1m", 5);
    assert.deepEqual(
      firstPage.candles.map((bar) => bar.ts),
      [360, 420, 480, 540, 600]
    );
    assert.equal(firstPage.hasMore, true);

    const secondPage = harness.service.getCandlesPage("cBTC", "1m", 5, {
      beforeTs: firstPage.candles[0]?.ts
    });
    assert.deepEqual(
      secondPage.candles.map((bar) => bar.ts),
      [60, 120, 180, 240, 300]
    );
    assert.equal(secondPage.hasMore, false);
  } finally {
    harness.cleanup();
  }
});
