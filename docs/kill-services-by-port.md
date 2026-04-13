# Sinergy Project - Kill Services by Port

Commands to stop the most commonly used services in the Sinergy project.

## Quick Kill All Services

```bash
# Kill all project services at once
lsof -ti:8787,8790,5173,5174,26657,1317,8545,8546,3000,8080,8443 | xargs kill -9 2>/dev/null || true
```

## Individual Service Ports

| Service | Port | Command |
|---------|------|---------|
| **Matcher** | `8787` | `lsof -ti:8787 \| xargs kill -9` |
| **Strategy Agent** | `8790` | `lsof -ti:8790 \| xargs kill -9` |
| **Web App (dev)** | `5173` | `lsof -ti:5173 \| xargs kill -9` |
| **Bridge App (dev)** | `5174` | `lsof -ti:5174 \| xargs kill -9` |
| **Rollup (Tendermint)** | `26657` | `lsof -ti:26657 \| xargs kill -9` |
| **Rollup (REST API)** | `1317` | `lsof -ti:1317 \| xargs kill -9` |
| **Rollup (JSON-RPC)** | `8545` | `lsof -ti:8545 \| xargs kill -9` |
| **Rollup (WebSocket)** | `8546` | `lsof -ti:8546 \| xargs kill -9` |
| **Executor** | `3000` | `lsof -ti:3000 \| xargs kill -9` |
| **Nginx (HTTP)** | `8080` | `lsof -ti:8080 \| xargs kill -9` |
| **Nginx (HTTPS)** | `8443` | `lsof -ti:8443 \| xargs kill -9` |

## Common Scenarios

### Stop Matcher (to run backfill)
```bash
lsof -ti:8787 | xargs kill -9
```

### Stop Web App
```bash
lsof -ti:5173 | xargs kill -9
```

### Stop All Frontends
```bash
lsof -ti:5173,5174 | xargs kill -9
```

### Stop Blockchain/Rollup
```bash
# Via weave CLI
weave rollup stop

# Or force kill ports
lsof -ti:26657,1317,8545,8546 | xargs kill -9
```

### Stop Executor
```bash
# Via weave CLI
weave opinit stop executor

# Or force kill
lsof -ti:3000 | xargs kill -9
```

### Stop Nginx (Public Gateway)
```bash
./scripts/public-nginx.sh stop

# Or force kill
lsof -ti:8080,8443 | xargs kill -9
```

### Stop Docker Containers
```bash
docker stop sinergy-public-nginx sinergy-cloudflare-tunnel weave-relayer 2>/dev/null || true
```

## Check What's Running

```bash
# Check listening ports
lsof -i -P -n | grep LISTEN

# Check specific port
lsof -ti:8787

# Check all project ports
lsof -ti:8787,8790,5173,5174,26657,1317,8545,8546,3000,8080,8443
```

## Systemd Services

```bash
# Stop matcher service
systemctl --user stop sinergy-matcher.service

# Stop rollup service
systemctl --user stop minitiad.service

# Stop executor service
systemctl --user stop opinitd.executor.service

# Check status
systemctl --user list-units | grep sinergy
systemctl --user list-units | grep minitiad
systemctl --user list-units | grep opinitd
```
