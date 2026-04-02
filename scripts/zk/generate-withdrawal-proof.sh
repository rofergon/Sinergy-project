#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/.tmp/zk/withdrawal"
INPUT_JSON="${1:-$BUILD_DIR/input.json}"

if [ ! -f "$BUILD_DIR/withdrawal_js/withdrawal.wasm" ]; then
  echo "Missing circuit wasm. Run scripts/zk/compile-withdrawal-circuit.sh first." >&2
  exit 1
fi

if [ ! -f "$BUILD_DIR/withdrawal_final.zkey" ]; then
  echo "Missing final zkey. Run scripts/zk/setup-withdrawal-groth16.sh first." >&2
  exit 1
fi

if [ ! -f "$INPUT_JSON" ]; then
  echo "Missing input json: $INPUT_JSON" >&2
  exit 1
fi

node "$BUILD_DIR/withdrawal_js/generate_witness.js" \
  "$BUILD_DIR/withdrawal_js/withdrawal.wasm" \
  "$INPUT_JSON" \
  "$BUILD_DIR/witness.wtns"

npx snarkjs groth16 prove \
  "$BUILD_DIR/withdrawal_final.zkey" \
  "$BUILD_DIR/witness.wtns" \
  "$BUILD_DIR/proof.json" \
  "$BUILD_DIR/public.json"

echo "Generated proof.json and public.json in $BUILD_DIR"
