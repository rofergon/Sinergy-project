#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
DEPLOYMENTS_DIR="$ROOT_DIR/deployments"
TMP_DIR="$ROOT_DIR/.tmp/deploy"

CHAIN_ID="${CHAIN_ID:-Sinergy-2}"
NODE_URL="${NODE_URL:-http://127.0.0.1:26657}"
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
FROM_KEY="${FROM_KEY:-gas-station}"
KEYRING_BACKEND="${KEYRING_BACKEND:-test}"
MATCHER_PRIVATE_KEY="${MATCHER_PRIVATE_KEY:-0x59c6995e998f97a5a0044966f0945382d7dd2f0d5b0ce3f4bfefd4dc2621c4d6}"
DEPLOY_GAS="${DEPLOY_GAS:-5000000}"
CALL_GAS="${CALL_GAS:-800000}"

mkdir -p "$TMP_DIR" "$DEPLOYMENTS_DIR"

MATCHER_ADDRESS="$(cast wallet address --private-key "$MATCHER_PRIVATE_KEY")"
GAS_STATION_BECH32="$(minitiad keys show "$FROM_KEY" -a --keyring-backend "$KEYRING_BACKEND")"
GAS_STATION_HEX="$(
  node -e "const { bech32 } = require('@scure/base'); const out=bech32.decodeToBytes(process.argv[1]); console.log('0x'+Buffer.from(out.bytes).toString('hex'));" \
    "$GAS_STATION_BECH32"
)"
MATCHER_BECH32="$(
  node -e "const { bech32 } = require('@scure/base'); console.log(bech32.encodeFromBytes('init', Buffer.from(process.argv[1].slice(2), 'hex')));" \
    "$MATCHER_ADDRESS"
)"

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

echo "Funding matcher signer..."
minitiad tx bank send "$GAS_STATION_BECH32" "$MATCHER_BECH32" 1000000000000000000GAS \
  --from "$FROM_KEY" \
  --keyring-backend "$KEYRING_BACKEND" \
  --chain-id "$CHAIN_ID" \
  --node "$NODE_URL" \
  --gas 250000 \
  --yes \
  --output json >/dev/null

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
      --chain-id "$CHAIN_ID" \
      --node "$NODE_URL" \
      --gas "$DEPLOY_GAS" \
      --broadcast-mode sync \
      --yes \
      --output json
  )" || {
    echo "Deployment failed for ${contract_name}" >&2
    exit 1
  }

  local tx_hash
  tx_hash="$(echo "$tx_json" | jq -r '.txhash // .tx_response.txhash')"
  local contract_address
  contract_address="$(
    minitiad query tx "$tx_hash" --node "$NODE_URL" --output json |
      jq -r '.events[] | select(.type=="contract_created") | .attributes[] | select(.key=="contract") | .value' |
      tail -n 1
  )"
  echo "${contract_name} -> ${contract_address}" >&2
  printf "%s" "$contract_address"
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
    --chain-id "$CHAIN_ID" \
    --node "$NODE_URL" \
    --gas "$CALL_GAS" \
    --broadcast-mode sync \
    --yes \
    --output json >/dev/null
}

USDC_ADDRESS="$(deploy_contract MockUSDC '(address)' "$GAS_STATION_HEX")"
TAAPL_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Tokenized Apple" "tAAPL" "$GAS_STATION_HEX" "1000000000000000000000000")"
TBOND_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Tokenized Treasury Bond" "tBOND" "$GAS_STATION_HEX" "1000000000000000000000000")"
TNVDA_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Tokenized Nvidia" "tNVDA" "$GAS_STATION_HEX" "1000000000000000000000000")"
CBTC_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Connected Bitcoin" "cBTC" "$GAS_STATION_HEX" "1000000000000000000000000")"
CETH_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Connected Ether" "cETH" "$GAS_STATION_HEX" "1000000000000000000000000")"
CSOL_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Connected Solana" "cSOL" "$GAS_STATION_HEX" "1000000000000000000000000")"
CINIT_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Connected Initia" "cINIT" "$GAS_STATION_HEX" "1000000000000000000000000")"
VAULT_ADDRESS="$(deploy_contract DarkPoolVault '(address,address)' "$GAS_STATION_HEX" "$MATCHER_ADDRESS")"
MARKET_ADDRESS="$(deploy_contract DarkPoolMarket '(address,address)' "$GAS_STATION_HEX" "$MATCHER_ADDRESS")"

echo "Configuring vault and listing markets..."
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$USDC_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$TAAPL_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$TBOND_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$TNVDA_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$CBTC_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$CETH_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$CSOL_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$CINIT_ADDRESS" true

call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "tAAPL/sUSDC" "$TAAPL_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "tBOND/sUSDC" "$TBOND_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "tNVDA/sUSDC" "$TNVDA_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cBTC/sUSDC" "$CBTC_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cETH/sUSDC" "$CETH_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cSOL/sUSDC" "$CSOL_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cINIT/sUSDC" "$CINIT_ADDRESS" "$USDC_ADDRESS"

jq -n \
  --arg matcherAddress "$MATCHER_ADDRESS" \
  --arg vault "$VAULT_ADDRESS" \
  --arg market "$MARKET_ADDRESS" \
  --arg quote "$USDC_ADDRESS" \
  --arg taapl "$TAAPL_ADDRESS" \
  --arg tbond "$TBOND_ADDRESS" \
  --arg tnvda "$TNVDA_ADDRESS" \
  --arg cbtc "$CBTC_ADDRESS" \
  --arg ceth "$CETH_ADDRESS" \
  --arg csol "$CSOL_ADDRESS" \
  --arg cinit "$CINIT_ADDRESS" \
  '{
    network: {
      name: "Sinergy Local",
      chainId: 1716124615666775,
      chainIdHex: "0x618ce661b6c57",
      rollupChainId: "Sinergy-2",
      l1ChainId: "initiation-2",
      gasDenom: "GAS",
      rpcUrl: "http://127.0.0.1:8545",
      wsUrl: "ws://127.0.0.1:8546",
      tendermintRpc: "http://127.0.0.1:26657",
      restUrl: "http://127.0.0.1:1317"
    },
    operator: {
      matcherAddress: $matcherAddress
    },
    contracts: {
      vault: $vault,
      market: $market,
      quoteToken: $quote
    },
    tokens: [
      {
        symbol: "sUSDC",
        name: "Sinergy Mock USD",
        address: $quote,
        decimals: 6,
        kind: "quote"
      },
      {
        symbol: "tAAPL",
        name: "Tokenized Apple",
        address: $taapl,
        decimals: 18,
        kind: "rwa"
      },
      {
        symbol: "tBOND",
        name: "Tokenized Treasury Bond",
        address: $tbond,
        decimals: 18,
        kind: "rwa"
      },
      {
        symbol: "tNVDA",
        name: "Tokenized Nvidia",
        address: $tnvda,
        decimals: 18,
        kind: "rwa"
      },
      {
        symbol: "cBTC",
        name: "Connected Bitcoin",
        address: $cbtc,
        decimals: 18,
        kind: "crypto"
      },
      {
        symbol: "cETH",
        name: "Connected Ether",
        address: $ceth,
        decimals: 18,
        kind: "crypto"
      },
      {
        symbol: "cSOL",
        name: "Connected Solana",
        address: $csol,
        decimals: 18,
        kind: "crypto"
      },
      {
        symbol: "cINIT",
        name: "Connected Initia",
        address: $cinit,
        decimals: 18,
        kind: "crypto"
      }
    ]
  }' > "$DEPLOYMENTS_DIR/local.json"

echo "Writing backend env example..."
cat > "$ROOT_DIR/services/matcher/.env" <<EOF
MATCHER_PRIVATE_KEY=$MATCHER_PRIVATE_KEY
PORT=8787
DEPLOYMENT_FILE=$ROOT_DIR/deployments/local.json
PRICE_BAND_BPS=1000
PRICE_DB_FILE=./data/prices.sqlite
PRICE_POLL_INTERVAL_MS=60000
T_BOND_PROXY_SYMBOL=TLT
INITIA_CONNECT_REST_URL=https://rest.testnet.initia.xyz
EOF

echo "Deployment complete."
echo "Matcher signer: $MATCHER_ADDRESS"
echo "Vault: $VAULT_ADDRESS"
echo "Market: $MARKET_ADDRESS"
