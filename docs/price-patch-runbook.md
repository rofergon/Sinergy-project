# Price Patch Runbook

This runbook restores recent gaps in the local matcher price database when the price matcher has been offline for a few hours or days.

It uses a two-step flow:

1. Run the normal historical backfill for the recent window.
2. Patch any remaining recent crypto gaps in `prices.sqlite` with synthetic minute bars so charts and strategies regain continuity.

The patch is local-only and writes synthetic rows with `source='patched-local'`.

## When To Use It

Use this when:

- `services/matcher/data/prices.sqlite` has a recent gap because the matcher was down.
- the app is showing stale prices or broken recent candles;
- you want the local DB repaired without rebuilding all price history from scratch.

Do not use this as a replacement for a full historical rebuild.

## Command

From the repo root:

```bash
npm run patch:prices:recent
```

From the matcher workspace:

```bash
cd services/matcher
set -a
. ./.env
set +a
npm run patch-recent
```

## Environment Variables

The command reads the normal matcher env file and also supports these optional overrides:

```bash
PATCH_LOOKBACK_DAYS=7
PATCH_BACKFILL_DAYS=7
PATCH_BACKFILL_CHUNK_DAYS=2
PATCH_MIN_GAP_SECONDS=300
PATCH_ONLY_SYMBOLS=cINIT,cSOL
```

You can also pass market aliases for USDC-quoted pairs:

```bash
PATCH_ONLY_SYMBOLS=cINIT/cUSDC,cETH/cUSDC
```

Meaning:

- `PATCH_LOOKBACK_DAYS`: only patch crypto gaps whose start point is within this recent window.
- `PATCH_BACKFILL_DAYS`: how many recent days to request from upstream providers before synthetic patching.
- `PATCH_BACKFILL_CHUNK_DAYS`: upstream fetch window size.
- `PATCH_MIN_GAP_SECONDS`: only patch gaps larger than this threshold.
- `PATCH_ONLY_SYMBOLS`: optional comma-separated filter for selected crypto symbols.

For `cINIT/cUSDC`, the matcher does not store a separate pair history table. The market reference price comes from the `cINIT` price series, so patching `cINIT` is what repairs the `cINIT/cUSDC` market price.

## Current Behavior

- The normal backfill tries to recover recent history from the configured providers.
- If Twelve Data returns an empty window for a non-trading range, the backfill now skips that window instead of aborting the whole run.
- Any remaining recent crypto gaps first try a Binance 1-minute repair path for supported assets (`cBTC`, `cETH`, `cSOL`, `cINIT`).
- If no exchange candles are available, the script falls back to linear minute interpolation between the last known bar before the gap and the first known bar after the gap.
- Synthetic rows are inserted with `source='patched-local'`.

## Recommended Checks

Latest bars per asset:

```bash
sqlite3 services/matcher/data/prices.sqlite \
  "SELECT asset_symbol, datetime(MAX(ts),'unixepoch') AS last_bar_utc, COUNT(*) AS rows FROM price_bars GROUP BY asset_symbol ORDER BY asset_symbol;"
```

Recent large gaps:

```bash
sqlite3 services/matcher/data/prices.sqlite \
  "WITH ordered AS (SELECT asset_symbol, ts, LAG(ts) OVER (PARTITION BY asset_symbol ORDER BY ts) AS prev_ts FROM price_bars), gaps AS (SELECT asset_symbol, prev_ts, ts, ts - prev_ts AS gap_seconds FROM ordered WHERE prev_ts IS NOT NULL) SELECT asset_symbol, datetime(prev_ts,'unixepoch') AS gap_start, datetime(ts,'unixepoch') AS gap_end, gap_seconds FROM gaps WHERE gap_seconds > 300 ORDER BY asset_symbol, gap_start DESC;"
```

Patched synthetic rows:

```bash
sqlite3 services/matcher/data/prices.sqlite \
  "SELECT asset_symbol, source, COUNT(*) FROM price_bars WHERE source='patched-local' GROUP BY asset_symbol, source ORDER BY asset_symbol;"
```

## Notes

- This runbook is aimed at the local DB configured by `PRICE_DB_FILE`.
- Crypto assets patch cleanly because they should be continuous minute series.
- RWA symbols such as `tAAPL`, `tNVDA`, and `tBOND` are not synthetically patched here because market closures are expected gaps, not outages.
