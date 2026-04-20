#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
DEPLOYMENTS_DIR="$ROOT_DIR/deployments"
TMP_DIR="$ROOT_DIR/.tmp/deploy"

ENV_NAME="${ENV_NAME:-local}"
DEPLOYMENT_FILE="${DEPLOYMENT_FILE:-$DEPLOYMENTS_DIR/${ENV_NAME}.json}"
NETWORK_NAME="${NETWORK_NAME:-Sinergy Local}"
ROLLUP_CHAIN_ID="${ROLLUP_CHAIN_ID:-${CHAIN_ID:-Sinergy-2}}"
L1_CHAIN_ID="${L1_CHAIN_ID:-initiation-2}"
TENDERMINT_RPC_URL="${TENDERMINT_RPC_URL:-${NODE_URL:-http://127.0.0.1:26657}}"
JSON_RPC_URL="${JSON_RPC_URL:-${RPC_URL:-http://127.0.0.1:8545}}"
WS_URL="${WS_URL:-ws://127.0.0.1:8546}"
REST_URL="${REST_URL:-http://127.0.0.1:1317}"
EVM_CHAIN_ID="${EVM_CHAIN_ID:-1716124615666775}"
EVM_CHAIN_ID_HEX="${EVM_CHAIN_ID_HEX:-0x618ce661b6c57}"
GAS_DENOM="${GAS_DENOM:-GAS}"
NATIVE_CURRENCY_NAME="${NATIVE_CURRENCY_NAME:-Gas}"
NATIVE_CURRENCY_SYMBOL="${NATIVE_CURRENCY_SYMBOL:-$GAS_DENOM}"
NATIVE_CURRENCY_DECIMALS="${NATIVE_CURRENCY_DECIMALS:-18}"
EXPLORER_URL="${EXPLORER_URL:-$JSON_RPC_URL}"
FROM_KEY="${FROM_KEY:-gas-station}"
KEYRING_BACKEND="${KEYRING_BACKEND:-test}"
MATCHER_PRIVATE_KEY="${MATCHER_PRIVATE_KEY:-0x59c6995e998f97a5a0044966f0945382d7dd2f0d5b0ce3f4bfefd4dc2621c4d6}"
DEPLOY_GAS="${DEPLOY_GAS:-5000000}"
CALL_GAS="${CALL_GAS:-800000}"
MATCHER_ENV_FILE="${MATCHER_ENV_FILE:-$ROOT_DIR/services/matcher/.env}"
QUOTE_TOKEN_NAME="${QUOTE_TOKEN_NAME:-Connected USD Coin}"
QUOTE_TOKEN_SYMBOL="${QUOTE_TOKEN_SYMBOL:-cUSDC}"
QUOTE_TOKEN_DECIMALS="${QUOTE_TOKEN_DECIMALS:-6}"
QUOTE_TOKEN_INITIAL_SUPPLY="${QUOTE_TOKEN_INITIAL_SUPPLY:-10000000000000}"
QUOTE_TOKEN_L1_SYMBOL="${QUOTE_TOKEN_L1_SYMBOL:-USDC}"
QUOTE_TOKEN_BRIDGE_DENOM="${QUOTE_TOKEN_BRIDGE_DENOM:-uusdc}"
QUOTE_TOKEN_BRIDGE_SOURCE_DECIMALS="${QUOTE_TOKEN_BRIDGE_SOURCE_DECIMALS:-6}"
QUOTE_TOKEN_BRIDGE_DESTINATION_DENOM="${QUOTE_TOKEN_BRIDGE_DESTINATION_DENOM:-}"

mkdir -p "$TMP_DIR" "$DEPLOYMENTS_DIR" "$(dirname "$DEPLOYMENT_FILE")"

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
minitiad tx bank send "$GAS_STATION_BECH32" "$MATCHER_BECH32" "1000000000000000000${GAS_DENOM}" \
  --from "$FROM_KEY" \
  --keyring-backend "$KEYRING_BACKEND" \
  --chain-id "$ROLLUP_CHAIN_ID" \
  --node "$TENDERMINT_RPC_URL" \
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
      --chain-id "$ROLLUP_CHAIN_ID" \
      --node "$TENDERMINT_RPC_URL" \
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
    minitiad query tx "$tx_hash" --node "$TENDERMINT_RPC_URL" --output json |
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
    --chain-id "$ROLLUP_CHAIN_ID" \
    --node "$TENDERMINT_RPC_URL" \
    --gas "$CALL_GAS" \
    --broadcast-mode sync \
    --yes \
    --output json >/dev/null
}

USDC_ADDRESS="$(deploy_contract ConnectedQuoteToken '(string,string,address,uint256)' "$QUOTE_TOKEN_NAME" "$QUOTE_TOKEN_SYMBOL" "$GAS_STATION_HEX" "$QUOTE_TOKEN_INITIAL_SUPPLY")"
TAAPL_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Tokenized Apple" "tAAPL" "$GAS_STATION_HEX" "1000000000000000000000000")"
TBOND_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Tokenized Treasury Bond" "tBOND" "$GAS_STATION_HEX" "1000000000000000000000000")"
TNVDA_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Tokenized Nvidia" "tNVDA" "$GAS_STATION_HEX" "1000000000000000000000000")"
CBTC_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Connected Bitcoin" "cBTC" "$GAS_STATION_HEX" "1000000000000000000000000")"
CETH_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Connected Ether" "cETH" "$GAS_STATION_HEX" "1000000000000000000000000")"
CSOL_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Connected Solana" "cSOL" "$GAS_STATION_HEX" "1000000000000000000000000")"
CINIT_ADDRESS="$(deploy_contract RwaShareToken '(string,string,address,uint256)' "Connected Initia" "cINIT" "$GAS_STATION_HEX" "1000000000000000000000000")"
VAULT_ADDRESS="$(deploy_contract DarkPoolVault '(address,address)' "$GAS_STATION_HEX" "$MATCHER_ADDRESS")"
MARKET_ADDRESS="$(deploy_contract DarkPoolMarket '(address,address)' "$GAS_STATION_HEX" "$MATCHER_ADDRESS")"
STRATEGY_EXECUTOR_ADDRESS="$(deploy_contract StrategyExecutor '(address,address)' "$GAS_STATION_HEX" "$MATCHER_ADDRESS")"

echo "Configuring vault and listing markets..."
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$USDC_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$TAAPL_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$TBOND_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$TNVDA_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$CBTC_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$CETH_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$CSOL_ADDRESS" true
call_as_gas_station "$VAULT_ADDRESS" "setSupportedToken(address,bool)" "$CINIT_ADDRESS" true

call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "tAAPL/${QUOTE_TOKEN_SYMBOL}" "$TAAPL_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "tBOND/${QUOTE_TOKEN_SYMBOL}" "$TBOND_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "tNVDA/${QUOTE_TOKEN_SYMBOL}" "$TNVDA_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cBTC/${QUOTE_TOKEN_SYMBOL}" "$CBTC_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cETH/${QUOTE_TOKEN_SYMBOL}" "$CETH_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cSOL/${QUOTE_TOKEN_SYMBOL}" "$CSOL_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$MARKET_ADDRESS" "listMarket(string,address,address)" "cINIT/${QUOTE_TOKEN_SYMBOL}" "$CINIT_ADDRESS" "$USDC_ADDRESS"
call_as_gas_station "$USDC_ADDRESS" "transferOwnership(address)" "$MATCHER_ADDRESS"
call_as_gas_station "$CBTC_ADDRESS" "transferOwnership(address)" "$MATCHER_ADDRESS"
call_as_gas_station "$CETH_ADDRESS" "transferOwnership(address)" "$MATCHER_ADDRESS"
call_as_gas_station "$CSOL_ADDRESS" "transferOwnership(address)" "$MATCHER_ADDRESS"
call_as_gas_station "$CINIT_ADDRESS" "transferOwnership(address)" "$MATCHER_ADDRESS"

jq -n \
  --arg matcherAddress "$MATCHER_ADDRESS" \
  --arg vault "$VAULT_ADDRESS" \
  --arg market "$MARKET_ADDRESS" \
  --arg strategyExecutor "$STRATEGY_EXECUTOR_ADDRESS" \
  --arg quote "$USDC_ADDRESS" \
  --arg networkName "$NETWORK_NAME" \
  --arg rollupChainId "$ROLLUP_CHAIN_ID" \
  --arg l1ChainId "$L1_CHAIN_ID" \
  --arg gasDenom "$GAS_DENOM" \
  --arg rpcUrl "$JSON_RPC_URL" \
  --arg wsUrl "$WS_URL" \
  --arg tendermintRpc "$TENDERMINT_RPC_URL" \
  --arg restUrl "$REST_URL" \
  --arg explorerUrl "$EXPLORER_URL" \
  --arg nativeCurrencyName "$NATIVE_CURRENCY_NAME" \
  --arg nativeCurrencySymbol "$NATIVE_CURRENCY_SYMBOL" \
  --arg taapl "$TAAPL_ADDRESS" \
  --arg tbond "$TBOND_ADDRESS" \
  --arg tnvda "$TNVDA_ADDRESS" \
  --arg cbtc "$CBTC_ADDRESS" \
  --arg ceth "$CETH_ADDRESS" \
  --arg csol "$CSOL_ADDRESS" \
  --arg cinit "$CINIT_ADDRESS" \
  --arg quoteSymbol "$QUOTE_TOKEN_SYMBOL" \
  --arg quoteName "$QUOTE_TOKEN_NAME" \
  --arg quoteL1Symbol "$QUOTE_TOKEN_L1_SYMBOL" \
  --arg quoteBridgeDenom "$QUOTE_TOKEN_BRIDGE_DENOM" \
  --arg quoteBridgeDest "$QUOTE_TOKEN_BRIDGE_DESTINATION_DENOM" \
  --argjson quoteDecimals "$QUOTE_TOKEN_DECIMALS" \
  --argjson quoteBridgeSourceDecimals "$QUOTE_TOKEN_BRIDGE_SOURCE_DECIMALS" \
  --argjson chainId "$EVM_CHAIN_ID" \
  --argjson nativeCurrencyDecimals "$NATIVE_CURRENCY_DECIMALS" \
  --arg chainIdHex "$EVM_CHAIN_ID_HEX" \
  '{
    network: {
      name: $networkName,
      chainId: $chainId,
      chainIdHex: $chainIdHex,
      rollupChainId: $rollupChainId,
      l1ChainId: $l1ChainId,
      gasDenom: $gasDenom,
      rpcUrl: $rpcUrl,
      wsUrl: $wsUrl,
      tendermintRpc: $tendermintRpc,
      restUrl: $restUrl,
      explorerUrl: $explorerUrl,
      nativeCurrency: {
        name: $nativeCurrencyName,
        symbol: $nativeCurrencySymbol,
        decimals: $nativeCurrencyDecimals
      }
    },
    operator: {
      matcherAddress: $matcherAddress
    },
    contracts: {
      vault: $vault,
      market: $market,
      strategyExecutor: $strategyExecutor,
      quoteToken: $quote
    },
    tokens: [
      ({
        symbol: $quoteSymbol,
        name: $quoteName,
        address: $quote,
        decimals: $quoteDecimals,
        kind: "quote"
      } + (if $quoteBridgeDest != "" then {
        bridge: {
          sourceChainId: $l1ChainId,
          sourceDenom: $quoteBridgeDenom,
          sourceSymbol: $quoteL1Symbol,
          sourceDecimals: $quoteBridgeSourceDecimals,
          destinationDenom: $quoteBridgeDest
        }
      } else {} end)),
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
        kind: "crypto",
        bridge: {
          sourceChainId: $l1ChainId,
          sourceDenom: "uinit",
          sourceSymbol: "INIT",
          sourceDecimals: 6,
          destinationDenom: "l2/7835b9ce5f65720a12cd653306cfe00afb93dcf1b73e69eb5eeddc568fc455cf"
        }
      }
    ]
  }' > "$DEPLOYMENT_FILE"

echo "Writing backend env example..."
cat > "$MATCHER_ENV_FILE" <<EOF
MATCHER_PRIVATE_KEY=$MATCHER_PRIVATE_KEY
PORT=8787
DEPLOYMENT_FILE=$DEPLOYMENT_FILE
PRICE_BAND_BPS=1000
PRICE_DB_FILE=./data/prices.sqlite
PRICE_POLL_INTERVAL_MS=60000
T_BOND_PROXY_SYMBOL=TLT
INITIA_CONNECT_REST_URL=https://rest.testnet.initia.xyz
ZK_WITHDRAWAL_PACKAGE_FILE=$ROOT_DIR/.tmp/zk/withdrawal/proof-package.json
EOF

echo "Deployment complete."
echo "Environment: $ENV_NAME"
echo "Deployment file: $DEPLOYMENT_FILE"
echo "Matcher signer: $MATCHER_ADDRESS"
echo "Vault: $VAULT_ADDRESS"
echo "Market: $MARKET_ADDRESS"
