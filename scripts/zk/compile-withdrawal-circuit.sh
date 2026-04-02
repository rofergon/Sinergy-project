#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/.tmp/zk/withdrawal"

mkdir -p "$BUILD_DIR"
COMPILER=""
if command -v circom >/dev/null 2>&1; then
  COMPILER="circom"
elif command -v npx >/dev/null 2>&1; then
  COMPILER="npx circom2"
else
  echo "Neither circom nor npx circom2 is available." >&2
  exit 1
fi

$COMPILER "$ROOT_DIR/circuits/withdrawal.circom" \
  --r1cs \
  --wasm \
  --sym \
  -o "$BUILD_DIR"

echo "Withdrawal circuit compiled into $BUILD_DIR"
