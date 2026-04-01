# Testnet Runbook

## Objetivo

Levantar `Sinergy` contra un rollup testnet operable sin tocar el flujo local.

## 1. Preparar archivos base

1. completar [deployments/testnet.json](/home/sari/Sinergy-project/deployments/testnet.json)
2. copiar templates:
   - `cp apps/web/.env.testnet.example apps/web/.env.testnet`
   - `cp apps/bridge/.env.testnet.example apps/bridge/.env.testnet`
   - `cp services/matcher/.env.testnet.example services/matcher/.env.testnet`
3. reemplazar todos los `TODO_*`

## 2. Desplegar contratos en el rollup testnet

Usar el wrapper:

```bash
./scripts/deploy-testnet.sh
```

Variables mínimas que deberías sobreescribir:

```bash
NETWORK_NAME="Sinergy Testnet"
ROLLUP_CHAIN_ID="TU_ROLLUP_CHAIN_ID"
TENDERMINT_RPC_URL="https://TU_TENDERMINT_RPC"
JSON_RPC_URL="https://TU_JSON_RPC"
WS_URL="wss://TU_EVM_WS"
REST_URL="https://TU_REST"
EVM_CHAIN_ID="TU_CHAIN_ID_NUMERICO"
EVM_CHAIN_ID_HEX="TU_CHAIN_ID_HEX"
EXPLORER_URL="https://TU_EXPLORER"
MATCHER_PRIVATE_KEY="0x..."
./scripts/deploy-testnet.sh
```

Esto actualiza:

1. [deployments/testnet.json](/home/sari/Sinergy-project/deployments/testnet.json)
2. `services/matcher/.env.testnet`

## 3. Arrancar servicios en testnet

### Matcher

```bash
npm run dev:matcher:testnet
```

### Web

```bash
npm run dev:web:testnet
```

### Bridge

```bash
npm run dev:bridge:testnet
```

## 4. Exponer la stack por internet

1. arrancar la stack base:

```bash
./scripts/start-testnet-stack.sh
```

2. arrancar el proxy Nginx en Docker:

```bash
./scripts/public-nginx.sh start
```

Ese script:

1. compila `web` y `bridge` en modo `testnet`
2. sirve esos builds estáticos desde Nginx
3. hace reverse proxy a `matcher`, `rpc`, `ws`, `rest` y `tm`

3. ver los hosts calculados:

```bash
./scripts/public-nginx.sh print-env
```

4. si la máquina está detrás de router/NAT, redirigir:
   - `80 -> 192.168.1.14:8080`
   - `443 -> 192.168.1.14:8443`

5. pedir certificado cuando el DNS ya resuelva a tu IP pública:

```bash
LETSENCRYPT_EMAIL=you@example.com ./scripts/request-public-cert.sh
```

6. actualizar tus envs de testnet para usar:
   - `https://app.<root>`
   - `https://bridge.<root>`
   - `https://api.<root>`
   - `https://rpc.<root>`
   - `wss://ws.<root>`
   - `https://rest.<root>`
   - `https://tm.<root>`
   - `https://indexer.<root>`

## 5. Exponer sin abrir puertos en el router

Si no quieres tocar el router, usa Cloudflare Tunnel:

```bash
./scripts/cloudflare-tunnel.sh quick
```

Eso crea una URL `https://<random>.trycloudflare.com` y publica:

1. app en `/`
2. matcher en `/api`
3. JSON-RPC EVM en `/rpc`
4. REST Cosmos en `/rest`
5. Tendermint RPC en `/tm`
6. indexer path en `/indexer`
7. websocket EVM en `/ws`

Comandos útiles:

```bash
./scripts/cloudflare-tunnel.sh status
./scripts/cloudflare-tunnel.sh stop
```

Si luego quieres dominio propio y hostnames estables en Cloudflare:

```bash
CF_TUNNEL_TOKEN=... ./scripts/cloudflare-tunnel.sh named
```

## 6. Verificaciones mínimas

1. el matcher arranca con `DEPLOYMENT_FILE=../../deployments/testnet.json`
2. `GET /health` responde
3. `GET /bridge/status` refleja OPinit/relayer reales
4. `web` conecta wallet y resuelve el `customChain`
5. `bridge` abre el flujo oficial con los defaults configurados

## 7. Criterio de salida

La testnet queda “operable” cuando:

1. puedes conectar wallet
2. puedes depositar en `DarkPoolVault`
3. puedes enviar órdenes o swaps
4. el matcher puede firmar retiros
5. el frontend ya no depende de `localhost`
6. MetaMask o Coinbase Wallet aceptan `https://rpc.<root>`
