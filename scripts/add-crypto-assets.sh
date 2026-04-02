#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
DEPLOYMENTS_DIR="$ROOT_DIR/deployments"
TMP_DIR="$ROOT_DIR/.tmp/add-crypto"
ENV_NAME="${ENV_NAME:-local}"
DEPLOYMENT_FILE="${DEPLOYMENT_FILE:-$DEPLOYMENTS_DIR/${ENV_NAME}.json}"

FROM_KEY="${FROM_KEY:-gas-station}"
KEYRING_BACKEND="${KEYRING_BACKEND:-test}"
DEPLOY_GAS="${DEPLOY_GAS:-5000000}"
CALL_GAS="${CALL_GAS:-800000}"

mkdir -p "$TMP_DIR" "$DEPLOYMENTS_DIR"

if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
  echo "Missing deployment file: $DEPLOYMENT_FILE" >&2
  exit 1
fi

ROLLUP_CHAIN_ID="${ROLLUP_CHAIN_ID:-${CHAIN_ID:-$(jq -r '.network.rollupChainId' "$DEPLOYMENT_FILE")}}"
TENDERMINT_RPC_URL="${TENDERMINT_RPC_URL:-${NODE_URL:-$(jq -r '.network.tendermintRpc' "$DEPLOYMENT_FILE")}}"

GAS_STATION_BECH32="$(minitiad keys show "$FROM_KEY" -a --keyring-backend "$KEYRING_BACKEND")"
GAS_STATION_HEX="$(
  node -e "const { bech32 } = require('@scure/base'); const out=bech32.decodeToBytes(process.argv[1]); console.log('0x'+Buffer.from(out.bytes).toString('hex'));" \
    "$GAS_STATION_BECH32"
)"

VAULT_ADDRESS="$(jq -r '.contracts.vault' "$DEPLOYMENT_FILE")"
MARKET_ADDRESS="$(jq -r '.contracts.market' "$DEPLOYMENT_FILE")"
QUOTE_TOKEN_ADDRESS="$(jq -r '.contracts.quoteToken' "$DEPLOYMENT_FILE")"
QUOTE_TOKEN_SYMBOL="$(jq -r '.tokens[] | select(.kind=="quote") | .symbol' "$DEPLOYMENT_FILE")"
MATCHER_ADDRESS="$(jq -r '.operator.matcherAddress' "$DEPLOYMENT_FILE")"

if [[ ! -d "$CONTRACTS_DIR/lib/openzeppelin-contracts" ]]; then
  (
    cd "$CONTRACTS_DIR"
    forge install OpenZeppelin/openzeppelin-contracts
  )
fi

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

deploy_crypto_token() {
  local name="$1"
  local symbol="$2"
  deploy_contract RwaShareToken '(string,string,address,uint256)' "$name" "$symbol" "$GAS_STATION_HEX" "1000000000000000000000000"
}

CBTC_ADDRESS="$(deploy_crypto_token "Connected Bitcoin" "cBTC")"
CETH_ADDRESS="$(deploy_crypto_token "Connected Ether" "cETH")"
CSOL_ADDRESS="$(deploy_crypto_token "Connected Solana" "cSOL")"
CINIT_ADDRESS="$(deploy_crypto_token "Connected Initia" "cINIT")"

for token in "$CBTC_ADDRESS" "$CETH_ADDRESS" "$CSOL_ADDRESS" "$CINIT_ADDRESS"; do
  call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$token" true
done

call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cBTC/${QUOTE_TOKEN_SYMBOL}" "$CBTC_ADDRESS" "$QUOTE_TOKEN_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cETH/${QUOTE_TOKEN_SYMBOL}" "$CETH_ADDRESS" "$QUOTE_TOKEN_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cSOL/${QUOTE_TOKEN_SYMBOL}" "$CSOL_ADDRESS" "$QUOTE_TOKEN_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cINIT/${QUOTE_TOKEN_SYMBOL}" "$CINIT_ADDRESS" "$QUOTE_TOKEN_ADDRESS"
call_as_gas_station "$CBTC_ADDRESS" "transferOwnership(address)" "$MATCHER_ADDRESS"
call_as_gas_station "$CETH_ADDRESS" "transferOwnership(address)" "$MATCHER_ADDRESS"
call_as_gas_station "$CSOL_ADDRESS" "transferOwnership(address)" "$MATCHER_ADDRESS"
call_as_gas_station "$CINIT_ADDRESS" "transferOwnership(address)" "$MATCHER_ADDRESS"

TMP_JSON="$TMP_DIR/local.updated.json"
jq \
  --arg cbtc "$CBTC_ADDRESS" \
  --arg ceth "$CETH_ADDRESS" \
  --arg csol "$CSOL_ADDRESS" \
  --arg cinit "$CINIT_ADDRESS" \
  '
  .tokens += [
    { symbol: "cBTC", name: "Connected Bitcoin", address: $cbtc, decimals: 18, kind: "crypto" },
    { symbol: "cETH", name: "Connected Ether", address: $ceth, decimals: 18, kind: "crypto" },
    { symbol: "cSOL", name: "Connected Solana", address: $csol, decimals: 18, kind: "crypto" },
    {
      symbol: "cINIT",
      name: "Connected Initia",
      address: $cinit,
      decimals: 18,
      kind: "crypto",
      bridge: {
        sourceChainId: .network.l1ChainId,
        sourceDenom: "uinit",
        sourceSymbol: "INIT",
        sourceDecimals: 6,
        destinationDenom: "l2/7835b9ce5f65720a12cd653306cfe00afb93dcf1b73e69eb5eeddc568fc455cf"
      }
    }
  ]
  | .tokens |= unique_by(.symbol)
  ' "$DEPLOYMENT_FILE" > "$TMP_JSON"
mv "$TMP_JSON" "$DEPLOYMENT_FILE"

echo "Added crypto assets:"
echo "cBTC  -> $CBTC_ADDRESS"
echo "cETH  -> $CETH_ADDRESS"
echo "cSOL  -> $CSOL_ADDRESS"
echo "cINIT -> $CINIT_ADDRESS"
