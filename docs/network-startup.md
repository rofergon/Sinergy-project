# Network Startup

## En pocas palabras

Este documento es una lista de arranque operativo. Sirve para levantar `Sinergy-2`, comprobar que los servicios criticos estan vivos y validar que el bridge realmente funciona antes de exponer la red a usuarios o demos.

## Cuando leer este documento

Leelo cuando ya tengas la infraestructura preparada y necesites encender la red, revisar salud minima y resolver bloqueos comunes del bridge.

## Que debes recordar

- Primero se levanta la base, luego se valida salud minima y despues se prueba el bridge.
- Si el bridge se atasca, normalmente hay que revisar saldo, secuencia o reiniciar el executor.
- Este doc es operativo: esta pensado para usarse mientras la red ya esta arrancando.

## Goal

Bring `Sinergy-2` up in the validated operating state:

1. rollup producing blocks
2. OPinit executor running
3. relayer and matcher up
4. bots funded with enough balance
5. `uinit -> Sinergy-2` bridge working
6. frontend ready to open the official bridge with `InterwovenKit`

## 1. Base Startup

Start the main stack:

```bash
./scripts/start-testnet-stack.sh
```

Check status:

```bash
./scripts/start-testnet-stack.sh status
```

## 2. Minimum Node Checks

Confirm that the rollup is producing blocks:

```bash
curl -s http://127.0.0.1:26657/status | jq '.result.sync_info'
curl -s http://127.0.0.1:1317/opinit/opchild/v1/bridge_info | jq
curl -s http://127.0.0.1:3000/status | jq
curl -s http://127.0.0.1:8787/health | jq
```

Expected state:

1. `bridge_info.bridge_id = 1735`
2. `bridge_disabled = false`
3. the rollup height keeps advancing
4. matcher responds

## 3. Fund Bots With Gas Station

The Weave-configured `Gas Station` on this machine is:

```text
init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e
```

Check balance:

```bash
initiad query bank balances init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e \
  --node https://rpc.testnet.initia.xyz:443 \
  -o json | jq
```

Important bot accounts:

1. `weave_output_submitter`
2. `weave_batch_submitter`
3. `weave_oracle_bridge_executor`
4. `weave_bridge_executor`
5. `weave_challenger`

Check addresses:

```bash
initiad keys show gas-station -a --home ~/.minitia --keyring-backend test
initiad keys show weave_output_submitter -a --home ~/.opinit/initiation-2 --keyring-backend test
initiad keys show weave_batch_submitter -a --home ~/.opinit/initiation-2 --keyring-backend test
initiad keys show weave_oracle_bridge_executor -a --home ~/.opinit/initiation-2 --keyring-backend test
initiad keys show weave_bridge_executor -a --home ~/.opinit/initiation-2 --keyring-backend test
initiad keys show weave_challenger -a --home ~/.opinit/initiation-2 --keyring-backend test
```

If you need to refill balances, do it serially, not in parallel.

Examples:

```bash
initiad tx bank send \
  init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e \
  init15yz3zduu85meywk0rnlv8el5wd7pn748aljqtq \
  800000uinit \
  --from gas-station \
  --home ~/.minitia \
  --keyring-backend test \
  --node https://rpc.testnet.initia.xyz:443 \
  --chain-id initiation-2 \
  --gas auto \
  --gas-adjustment 1.5 \
  --gas-prices 0.015uinit \
  -y

initiad tx bank send \
  init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e \
  init1rdyr92kq5atrr3gtnu67z4m3rurv4jmskpuq8k \
  300000uinit \
  --from gas-station \
  --home ~/.minitia \
  --keyring-backend test \
  --node https://rpc.testnet.initia.xyz:443 \
  --chain-id initiation-2 \
  --gas auto \
  --gas-adjustment 1.5 \
  --gas-prices 0.015uinit \
  -y

initiad tx bank send \
  init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e \
  init15xedymzcrmq7y3zh4c3pj7lhc303kr7ntq4ugw \
  200000uinit \
  --from gas-station \
  --home ~/.minitia \
  --keyring-backend test \
  --node https://rpc.testnet.initia.xyz:443 \
  --chain-id initiation-2 \
  --gas auto \
  --gas-adjustment 1.5 \
  --gas-prices 0.015uinit \
  -y
```

## 4. Restart The Executor If The Bridge Gets Stuck

If you see signs like:

1. `account sequence mismatch`
2. `output does not exist at index`
3. deposits that leave L1 but never land on L2

run this flow:

```bash
weave opinit stop executor
weave opinit start executor --detach
weave opinit log executor -n 80
curl -s http://127.0.0.1:3000/status | jq
```

If the issue was low balance or a stale sequence, fund from the `Gas Station` first and then start the executor again.

## 5. Test The Bridge For Real

Query the token pair:

```bash
initiad query ophost token-pairs --bridge-id 1735 \
  --node https://rpc.testnet.initia.xyz:443 \
  -o json | jq
```

The currently valid pair is:

1. L1: `uinit`
2. L2: `l2/7835b9ce5f65720a12cd653306cfe00afb93dcf1b73e69eb5eeddc568fc455cf`

Try a small deposit:

```bash
initiad tx ophost initiate-token-deposit \
  1735 \
  init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e \
  1000uinit \
  '' \
  --from gas-station \
  --home ~/.minitia \
  --keyring-backend test \
  --node https://rpc.testnet.initia.xyz:443 \
  --chain-id initiation-2 \
  --gas 250000 \
  --fees 4000uinit \
  -y
```

Verify that it lands on L2:

```bash
minitiad query bank balances init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e \
  --node http://127.0.0.1:26657 \
  -o json | jq
```

You should see a balance in the `l2/...` denom.

## 6. Publish The Stack

If you want to expose it publicly:

```bash
./scripts/public-nginx.sh start
./scripts/cloudflare-tunnel.sh quick
```

Status commands:

```bash
./scripts/public-nginx.sh status
./scripts/cloudflare-tunnel.sh status
```

## 7. Healthy Network Criteria

The network is in a good state when:

1. `26657` and `1317` respond
2. `bridge_info` responds
3. the executor is not stuck
4. bot accounts have `uinit`
5. `output proposals` keep advancing
6. a small `uinit -> Sinergy-2` deposit lands successfully
7. the frontend can open the official bridge with `InterwovenKit`

## 8. Minimum Startup Command

For daily use:

```bash
./scripts/start-testnet-stack.sh
```

To expose it afterwards:

```bash
./scripts/public-nginx.sh start
./scripts/cloudflare-tunnel.sh quick
```
