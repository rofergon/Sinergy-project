# Sinergy-2 Appchain Infrastructure Runbook

This runbook outlines the operational procedures to bootstrap, validate, and troubleshoot the `Sinergy-2` MiniEVM rollup. It is intended for node operators and developers evaluating the Sinergy infrastructure to ensure that critical services (including the OPinit bridge and Weave bots) are healthy before exposing the network to clients.

---

## 1. Stack Initialization

To orchestrate the rollup, relayer, matcher, and frontend services simultaneously, utilize the provided initialization script:

```bash
./scripts/start-testnet-stack.sh
```

To verify the status of the local stack daemon:

```bash
./scripts/start-testnet-stack.sh status
```

---

## 2. Infrastructure Health Checks

Before executing cross-chain transactions, validate that the `Sinergy-2` rollup is advancing and the `OPinit` bridge is active.

**Block Production Check:**
```bash
curl -s http://127.0.0.1:26657/status | jq '.result.sync_info'
```

**Bridge Health Check:**
```bash
curl -s http://127.0.0.1:1317/opinit/opchild/v1/bridge_info | jq
```

**Matcher & Service Endpoints:**
```bash
curl -s http://127.0.0.1:3000/status | jq
curl -s http://127.0.0.1:8787/health | jq
```

**Expected Criteria:**
1. `bridge_info.bridge_id = 1735`
2. `bridge_disabled = false`
3. Block height is actively advancing.
4. Matcher API returns `200 OK`.

---

## 3. Funding Weave OPinit Bots

The Sinergy-2 bridge depends on an array of Weave validator and relayer bots. The primary `Gas Station` on this environment is configured as:
`init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e`

**Check Gas Station Balance:**
```bash
initiad query bank balances init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e \
  --node https://rpc.testnet.initia.xyz:443 \
  -o json | jq
```

**Operational OPinit Bots:**
These bots manage layer transitions and must maintain a healthy `uinit` balance:
1. `weave_output_submitter`
2. `weave_batch_submitter`
3. `weave_oracle_bridge_executor`
4. `weave_bridge_executor`
5. `weave_challenger`

To extract their L1 addresses from the keyring:
```bash
initiad keys show gas-station -a --home ~/.minitia --keyring-backend test
initiad keys show weave_output_submitter -a --home ~/.opinit/initiation-2 --keyring-backend test
initiad keys show weave_batch_submitter -a --home ~/.opinit/initiation-2 --keyring-backend test
initiad keys show weave_oracle_bridge_executor -a --home ~/.opinit/initiation-2 --keyring-backend test
initiad keys show weave_bridge_executor -a --home ~/.opinit/initiation-2 --keyring-backend test
initiad keys show weave_challenger -a --home ~/.opinit/initiation-2 --keyring-backend test
```

*Note: Execute funding sequentially to prevent sequence mismatches.*

Example manual funding command via `initiad`:
```bash
initiad tx bank send \
  init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e \
  <TARGET_BOT_ADDRESS> \
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
```

---

## 4. Bridge Executor Troubleshooting

If the bridge stalls, look for symptoms such as `account sequence mismatch`, `output does not exist at index`, or stranded L1 deposits.

To force a reconciliation of the `OPinit` executor:

```bash
weave opinit stop executor
weave opinit start executor --detach
weave opinit log executor -n 80
curl -s http://127.0.0.1:3000/status | jq
```

*Note: Ensure the executor bots have sufficient balance before restarting the process.*

---

## 5. End-to-End Bridge Validation

Execute a trial deposit mapping `uinit` on L1 to its equivalent denomination on L2.

**Query Target Token Pair:**
```bash
initiad query ophost token-pairs --bridge-id 1735 \
  --node https://rpc.testnet.initia.xyz:443 \
  -o json | jq
```
*Current mappings define L1 `uinit` as L2 `l2/7835b9ce5f65720a12cd653306cfe00afb93dcf1b73e69eb5eeddc568fc455cf`.*

**Initiate Deposit (L1 -> Sinergy-2):**
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

**Verify L2 Settlement:**
Query the local `Sinergy-2` node to confirm arrival:
```bash
minitiad query bank balances init1m667d6pvwwqlgljv2qm2pmrs66t6g6ff0gjs7e \
  --node http://127.0.0.1:26657 \
  -o json | jq
```

---

## 6. Public Exposure (Optional)

If the environment needs to be demoed publicly over HTTP/HTTPS, expose the local endpoints via the provided proxy scripts:

```bash
./scripts/public-nginx.sh start
./scripts/cloudflare-tunnel.sh quick
```

Verify proxy status:
```bash
./scripts/public-nginx.sh status
./scripts/cloudflare-tunnel.sh status
```
