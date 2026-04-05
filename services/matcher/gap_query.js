import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('./data/prices.sqlite');
const rows = db.prepare(`
WITH Gaps AS (
  SELECT
    asset_symbol,
    ts,
    LAG(ts) OVER (PARTITION BY asset_symbol ORDER BY ts) AS prev_ts,
    (ts - LAG(ts) OVER (PARTITION BY asset_symbol ORDER BY ts)) AS gap_seconds
  FROM price_bars
  WHERE asset_symbol IN ('cETH', 'cBTC')
)
SELECT asset_symbol, datetime(prev_ts, 'unixepoch') as start, datetime(ts, 'unixepoch') as end, gap_seconds
FROM Gaps
WHERE gap_seconds > 300
ORDER BY gap_seconds DESC
LIMIT 10;
`).all();
console.log(rows);
