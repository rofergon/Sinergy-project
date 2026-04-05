import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/prices.sqlite');
db.exec('PRAGMA busy_timeout = 5000'); // Wait 5 seconds instead of dropping SQLITE_BUSY

const symbolsToFix = { 'cETH': 'ETHUSDC', 'cBTC': 'BTCUSDC' };
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchBinanceKlines(symbol, startTime, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1000`;
  let retries = 5;
  while (retries > 0) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (res.status === 429 || res.status === 418) {
        console.log(`[Rate Limit] Binance status ${res.status}. Waiting 2s...`);
        await wait(2000);
        continue;
      }
      if (!res.ok) throw new Error(`Binance error: ${res.statusText}`);
      return await res.json();
    } catch (e) {
      retries--;
      if (retries === 0) throw e;
      await wait(1000);
    }
  }
}

const insertStmt = db.prepare(`
  INSERT INTO price_bars (asset_symbol, provider_symbol, ts, open, high, low, close, volume, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'binance')
  ON CONFLICT(asset_symbol, ts) DO UPDATE SET
    open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume, source = excluded.source
`);

async function fillGapsFor(asset, binanceSymbol) {
  while (true) {
    const gaps = db.prepare(`
      WITH Gaps AS (
        SELECT asset_symbol, ts, LAG(ts) OVER (PARTITION BY asset_symbol ORDER BY ts) AS prev_ts,
        (ts - LAG(ts) OVER (PARTITION BY asset_symbol ORDER BY ts)) AS gap_seconds
        FROM price_bars WHERE asset_symbol = ?
      )
      SELECT prev_ts as start, ts as end, gap_seconds FROM Gaps WHERE gap_seconds > 60 ORDER BY gap_seconds DESC
    `).all(asset);
    
    if (gaps.length === 0) break;
    
    // Pick the largest gap
    const gap = gaps[0];
    console.log(`[${asset}] Outstanding gap: ${new Date(gap.start * 1000).toISOString()} to ${new Date(gap.end * 1000).toISOString()} (${gap.gap_seconds}s)`);
    
    let currentStart = gap.start * 1000;
    const gapEnd = gap.end * 1000;
    
    while (currentStart < gapEnd) {
      let currentEnd = currentStart + 1000 * 60 * 1000;
      if (currentEnd > gapEnd) currentEnd = gapEnd;
      
      const klines = await fetchBinanceKlines(binanceSymbol, currentStart, currentEnd);
      if (!klines || klines.length === 0) {
        currentStart += 60000;
        continue;
      }
      
      db.exec("BEGIN");
      let inserted = 0;
      for (const k of klines) {
        const ts = Math.floor(k[0] / 1000);
        if (ts > gap.start && ts < gap.end) {
          insertStmt.run(asset, binanceSymbol, ts, Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5]));
          inserted++;
        }
      }
      db.exec("COMMIT");
      console.log(`[${asset}] Inserted ${inserted} candles from ${new Date(klines[0][0]).toISOString()} to ${new Date(klines[klines.length-1][0]).toISOString()}`);
      
      currentStart = klines[klines.length - 1][0] + 60000;
      await wait(100);
    }
  }
}

async function main() {
  for (const [asset, binanceSymbol] of Object.entries(symbolsToFix)) {
    await fillGapsFor(asset, binanceSymbol);
  }
  console.log("ALL GAPS FILLED SUCCESSFULLY.");
}

main().catch(console.error);
