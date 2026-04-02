#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
DEPLOYMENT_FILE="${DEPLOYMENT_FILE:-$ROOT_DIR/deployments/local.json}"
TMP_DIR="$ROOT_DIR/.tmp/deploy-zk"
FROM_KEY="${FROM_KEY:-gas-station}"
KEYRING_BACKEND="${KEYRING_BACKEND:-test}"
ROLLUP_CHAIN_ID="${ROLLUP_CHAIN_ID:-Sinergy-2}"
TENDERMINT_RPC_URL="${TENDERMINT_RPC_URL:-http://127.0.0.1:26657}"
DEPLOY_GAS="${DEPLOY_GAS:-7000000}"
CALL_GAS="${CALL_GAS:-1000000}"
PROOF_PACKAGE_FILE="${PROOF_PACKAGE_FILE:-$ROOT_DIR/.tmp/zk/withdrawal/proof-package.json}"
VKEY_CALLDATA_FILE="${VKEY_CALLDATA_FILE:-$ROOT_DIR/.tmp/zk/withdrawal/vkey-calldata.json}"
MATCHER_PRIVATE_KEY="${MATCHER_PRIVATE_KEY:-0x59c6995e998f97a5a0044966f0945382d7dd2f0d5b0ce3f4bfefd4dc2621c4d6}"

mkdir -p "$TMP_DIR"

if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
  echo "Missing deployment file: $DEPLOYMENT_FILE" >&2
  exit 1
fi

if [[ ! -f "$VKEY_CALLDATA_FILE" ]]; then
  echo "Missing vkey calldata file: $VKEY_CALLDATA_FILE" >&2
  exit 1
fi

MATCHER_ADDRESS="$(cast wallet address --private-key "$MATCHER_PRIVATE_KEY")"
GAS_STATION_BECH32="$(minitiad keys show "$FROM_KEY" -a --keyring-backend "$KEYRING_BACKEND")"
GAS_STATION_HEX="$(
  node -e "const { bech32 } = require('@scure/base'); const out=bech32.decodeToBytes(process.argv[1]); console.log('0x'+Buffer.from(out.bytes).toString('hex'));" \
    "$GAS_STATION_BECH32"
)"

echo "Building contracts..."
(
  cd "$CONTRACTS_DIR"
  forge build
)

deploy_contract() {
  local contract_name="$1"
  local constructor_sig="$2"
  shift 2

  local artifact_path="$CONTRACTS_DIR/out/${contract_name}.sol/${contract_name}.json"
  local bin_file="$TMP_DIR/${contract_name}.bin"
  local bytecode
  bytecode="$(jq -r '.bytecode.object' "$artifact_path")"
  bytecode="${bytecode#0x}"
  printf "%s" "$bytecode" > "$bin_file"

  local input="0x"
  if [[ "$constructor_sig" != "()" ]]; then
    input="$(cast abi-encode "constructor${constructor_sig}" "$@")"
  fi

  echo "Deploying ${contract_name}..." >&2
  local tx_json
  tx_json="$(
    minitiad tx evm create "$bin_file" \
      --input "$input" \
      --from "$FROM_KEY" \
      --keyring-backend "$KEYRING_BACKEND" \
      --chain-id "$ROLLUP_CHAIN_ID" \
      --node "$TENDERMINT_RPC_URL" \
      --gas "$DEPLOY_GAS" \
      --broadcast-mode sync \
      --yes \
      --output json
  )"

  local tx_hash
  tx_hash="$(echo "$tx_json" | jq -r '.txhash // .tx_response.txhash')"
  minitiad query tx "$tx_hash" --node "$TENDERMINT_RPC_URL" --output json |
    jq -r '.events[] | select(.type=="contract_created") | .attributes[] | select(.key=="contract") | .value' |
    tail -n 1
}

call_as_gas_station() {
  local to="$1"
  local signature="$2"
  shift 2
  local calldata
  calldata="$(cast calldata "$signature" "$@")"

  minitiad tx evm call "$to" "$calldata" \
    --from "$FROM_KEY" \
    --keyring-backend "$KEYRING_BACKEND" \
    --chain-id "$ROLLUP_CHAIN_ID" \
    --node "$TENDERMINT_RPC_URL" \
    --gas "$CALL_GAS" \
    --broadcast-mode sync \
    --yes \
    --output json >/dev/null
}

QUOTE_TOKEN="$(jq -r '.contracts.quoteToken' "$DEPLOYMENT_FILE")"
TOKENS=($(jq -r '.tokens[].address' "$DEPLOYMENT_FILE"))

if [[ -f "$PROOF_PACKAGE_FILE" ]]; then
  GENESIS_ROOT="$(jq -r '.root' "$PROOF_PACKAGE_FILE")"
else
  GENESIS_ROOT="0x0000000000000000000000000000000000000000000000000000000000000000"
fi

STATE_ANCHOR_ADDRESS="$(deploy_contract DarkStateAnchor '(address,address,bytes32)' "$GAS_STATION_HEX" "$MATCHER_ADDRESS" "$GENESIS_ROOT")"
WITHDRAWAL_VERIFIER_ADDRESS="$(deploy_contract Groth16WithdrawalVerifier '(address)' "$GAS_STATION_HEX")"
ZK_VAULT_ADDRESS="$(deploy_contract DarkVaultV2 '(address,address,address)' "$GAS_STATION_HEX" "$STATE_ANCHOR_ADDRESS" "$WITHDRAWAL_VERIFIER_ADDRESS")"

echo "Configuring withdrawal verifier..."
ALPHA1_A="$(jq -r '.alpha1[0]' "$VKEY_CALLDATA_FILE")"
ALPHA1_B="$(jq -r '.alpha1[1]' "$VKEY_CALLDATA_FILE")"
BETA2_00="$(jq -r '.beta2[0][0]' "$VKEY_CALLDATA_FILE")"
BETA2_01="$(jq -r '.beta2[0][1]' "$VKEY_CALLDATA_FILE")"
BETA2_10="$(jq -r '.beta2[1][0]' "$VKEY_CALLDATA_FILE")"
BETA2_11="$(jq -r '.beta2[1][1]' "$VKEY_CALLDATA_FILE")"
GAMMA2_00="$(jq -r '.gamma2[0][0]' "$VKEY_CALLDATA_FILE")"
GAMMA2_01="$(jq -r '.gamma2[0][1]' "$VKEY_CALLDATA_FILE")"
GAMMA2_10="$(jq -r '.gamma2[1][0]' "$VKEY_CALLDATA_FILE")"
GAMMA2_11="$(jq -r '.gamma2[1][1]' "$VKEY_CALLDATA_FILE")"
DELTA2_00="$(jq -r '.delta2[0][0]' "$VKEY_CALLDATA_FILE")"
DELTA2_01="$(jq -r '.delta2[0][1]' "$VKEY_CALLDATA_FILE")"
DELTA2_10="$(jq -r '.delta2[1][0]' "$VKEY_CALLDATA_FILE")"
DELTA2_11="$(jq -r '.delta2[1][1]' "$VKEY_CALLDATA_FILE")"
IC_ARGS=()
for i in 0 1 2 3 4 5; do
  IC_ARGS+=("[$(jq -r ".ic[$i][0]" "$VKEY_CALLDATA_FILE"),$(jq -r ".ic[$i][1]" "$VKEY_CALLDATA_FILE")]")
done

call_as_gas_station \
  "$WITHDRAWAL_VERIFIER_ADDRESS" \
  "setVerifyingKey(uint256[2],uint256[2][2],uint256[2][2],uint256[2][2],uint256[2][6])" \
  "[$ALPHA1_A,$ALPHA1_B]" \
  "[[$BETA2_00,$BETA2_01],[$BETA2_10,$BETA2_11]]" \
  "[[$GAMMA2_00,$GAMMA2_01],[$GAMMA2_10,$GAMMA2_11]]" \
  "[[$DELTA2_00,$DELTA2_01],[$DELTA2_10,$DELTA2_11]]" \
  "[${IC_ARGS[0]},${IC_ARGS[1]},${IC_ARGS[2]},${IC_ARGS[3]},${IC_ARGS[4]},${IC_ARGS[5]}]"

echo "Configuring supported tokens in zk vault..."
for token in "${TOKENS[@]}"; do
  call_as_gas_station "$ZK_VAULT_ADDRESS" "setSupportedToken(address,bool)" "$token" true
done

jq \
  --arg zkVault "$ZK_VAULT_ADDRESS" \
  --arg stateAnchor "$STATE_ANCHOR_ADDRESS" \
  --arg withdrawalVerifier "$WITHDRAWAL_VERIFIER_ADDRESS" \
  '.contracts.zkVault = $zkVault | .contracts.stateAnchor = $stateAnchor | .contracts.withdrawalVerifier = $withdrawalVerifier' \
  "$DEPLOYMENT_FILE" > "$TMP_DIR/deployment.zk.json"

mv "$TMP_DIR/deployment.zk.json" "$DEPLOYMENT_FILE"

echo "ZK stack configured."
echo "State anchor: $STATE_ANCHOR_ADDRESS"
echo "Withdrawal verifier: $WITHDRAWAL_VERIFIER_ADDRESS"
echo "ZK vault: $ZK_VAULT_ADDRESS"
