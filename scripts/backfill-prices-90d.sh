#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export BACKFILL_DAYS="${BACKFILL_DAYS:-90}"
export BACKFILL_CHUNK_DAYS="${BACKFILL_CHUNK_DAYS:-3}"

cd "$ROOT_DIR"
npm run backfill -w @sinergy/matcher
