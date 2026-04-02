#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/.tmp/zk/withdrawal"
PTAU_FILE="${1:-$ROOT_DIR/.tmp/zk/powersOfTau28_hez_final_14.ptau}"

if [ ! -f "$BUILD_DIR/withdrawal.r1cs" ]; then
  echo "Missing compiled circuit. Run scripts/zk/compile-withdrawal-circuit.sh first." >&2
  exit 1
fi

if [ ! -f "$PTAU_FILE" ]; then
  echo "Missing ptau file: $PTAU_FILE" >&2
  exit 1
fi

npx snarkjs groth16 setup \
  "$BUILD_DIR/withdrawal.r1cs" \
  "$PTAU_FILE" \
  "$BUILD_DIR/withdrawal_0000.zkey"

npx snarkjs zkey contribute \
  "$BUILD_DIR/withdrawal_0000.zkey" \
  "$BUILD_DIR/withdrawal_final.zkey" \
  --name="Sinergy Withdrawal Phase 1" \
  -v \
  -e="sinergy-withdrawal-phase-1"

npx snarkjs zkey export verificationkey \
  "$BUILD_DIR/withdrawal_final.zkey" \
  "$BUILD_DIR/verification_key.json"

echo "Groth16 setup complete in $BUILD_DIR"
