#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Rango específico: 10 al 13 de abril 2026
export BACKFILL_FROM="${BACKFILL_FROM:-2026-04-10T00:00:00Z}"
export BACKFILL_TO="${BACKFILL_TO:-2026-04-13T23:59:59Z}"
export BACKFILL_CHUNK_DAYS="${BACKFILL_CHUNK_DAYS:-1}"

cd "$ROOT_DIR"

echo "[backfill-gap] Filling price data from Apr 10 to Apr 13, 2026..."
npm run backfill -w @sinergy/matcher

echo ""
echo "[backfill-gap] Done."
echo "  To verify, check the database at: services/matcher/data/prices.sqlite"
