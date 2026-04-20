#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
TMP_DIR="$ROOT_DIR/.tmp/deploy"
DEPLOYMENT_FILE="${DEPLOYMENT_FILE:-$ROOT_DIR/deployments/local.json}"

if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
  echo "Deployment file not found: $DEPLOYMENT_FILE" >&2
  exit 1
fi

JSON_RPC_URL="${JSON_RPC_URL:-$(jq -r '.network.rpcUrl' "$DEPLOYMENT_FILE")}"
TENDERMINT_RPC_URL="${TENDERMINT_RPC_URL:-$(jq -r '.network.tendermintRpc' "$DEPLOYMENT_FILE")}"
ROLLUP_CHAIN_ID="${ROLLUP_CHAIN_ID:-$(jq -r '.network.rollupChainId' "$DEPLOYMENT_FILE")}"
MATCHER_ADDRESS="${MATCHER_ADDRESS:-$(jq -r '.operator.matcherAddress' "$DEPLOYMENT_FILE")}"
FROM_KEY="${FROM_KEY:-gas-station}"
KEYRING_BACKEND="${KEYRING_BACKEND:-test}"
DEPLOY_GAS="${DEPLOY_GAS:-5000000}"

mkdir -p "$TMP_DIR"

if [[ ! -d "$CONTRACTS_DIR/lib/openzeppelin-contracts" ]]; then
  echo "Installing OpenZeppelin dependency..."
  (
    cd "$CONTRACTS_DIR"
    forge install OpenZeppelin/openzeppelin-contracts
  )
fi

echo "Building contracts..."
(
  cd "$CONTRACTS_DIR"
  forge build
)

GAS_STATION_BECH32="$(minitiad keys show "$FROM_KEY" -a --keyring-backend "$KEYRING_BACKEND")"
GAS_STATION_HEX="$(
  node -e "const { bech32 } = require('@scure/base'); const out=bech32.decodeToBytes(process.argv[1]); console.log('0x'+Buffer.from(out.bytes).toString('hex'));" \
    "$GAS_STATION_BECH32"
)"

artifact_path="$CONTRACTS_DIR/out/StrategyExecutor.sol/StrategyExecutor.json"
bin_file="$TMP_DIR/StrategyExecutor.bin"
bytecode="$(jq -r '.bytecode.object' "$artifact_path")"
bytecode="${bytecode#0x}"
printf "%s" "$bytecode" > "$bin_file"

constructor_input="$(cast abi-encode "constructor(address,address)" "$GAS_STATION_HEX" "$MATCHER_ADDRESS")"

echo "Deploying StrategyExecutor..." >&2
tx_json="$(
  minitiad tx evm create "$bin_file" \
    --input "$constructor_input" \
    --from "$FROM_KEY" \
    --keyring-backend "$KEYRING_BACKEND" \
    --chain-id "$ROLLUP_CHAIN_ID" \
    --node "$TENDERMINT_RPC_URL" \
    --gas "$DEPLOY_GAS" \
    --broadcast-mode sync \
    --yes \
    --output json
)"

tx_hash="$(echo "$tx_json" | jq -r '.txhash // .tx_response.txhash')"
contract_address="$(
  minitiad query tx "$tx_hash" --node "$TENDERMINT_RPC_URL" --output json |
    jq -r '.events[] | select(.type=="contract_created") | .attributes[] | select(.key=="contract") | .value' |
    tail -n 1
)"

if [[ -z "$contract_address" || "$contract_address" == "null" ]]; then
  echo "Unable to resolve deployed StrategyExecutor address from tx $tx_hash" >&2
  exit 1
fi

tmp_json="$(mktemp)"
jq --arg strategyExecutor "$contract_address" '.contracts.strategyExecutor = $strategyExecutor' "$DEPLOYMENT_FILE" > "$tmp_json"
mv "$tmp_json" "$DEPLOYMENT_FILE"

rm -f "$bin_file"

echo "StrategyExecutor deployed at $contract_address"
echo "Deployment file updated: $DEPLOYMENT_FILE"
