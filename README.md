# Sinergy Dark RWA Market

Mercado RWA mínimo viable sobre la appchain Initia `Sinergy-2` usando:

- `Foundry` para contratos EVM
- `Vite + React + wagmi/viem` para frontend
- `Fastify + viem` para matcher backend
- `minitiad` para despliegue local en `MiniEVM`

## Contexto de red

- Rollup chain id: `Sinergy-2`
- L1: `initiation-2`
- Gas denom: `GAS`
- EVM RPC: `http://127.0.0.1:8545`
- EVM WS: `ws://127.0.0.1:8546`
- Tendermint RPC: `http://127.0.0.1:26657`
- REST: `http://127.0.0.1:1317`

## Estructura

```text
contracts/         Foundry contracts
apps/web/          Frontend Vite
services/matcher/  Backend de matching, pricing y tickets de retiro
packages/shared/   ABIs, chain config y tipos compartidos
docs/              Arquitectura y roadmap
deployments/       Direcciones locales desplegadas
scripts/           Utilidades de despliegue y export
```

## Contratos incluidos

- `MockUSDC`
- `RwaShareToken`
- `DarkPoolVault`
- `DarkPoolMarket`

## Direcciones desplegadas en local

Despliegue actual sobre `Sinergy-2`:

- `Matcher signer`: `0x6eC8AcC95Da5f752eCeAB1c214C1b62080023283`
- `DarkPoolVault`: `0x3fF37bE2C8B8179cBfd97CB1e75fEd91e5e38B19`
- `DarkPoolMarket`: `0xe1d9c4EcC2ba58274733C61Fb25919F0eA902575`
- `sUSDC`: `0xA0cf839E30789cBB13292B80727103105D971872`
- `tAAPL`: `0xc7bcA502bCeBb25b1CFf139aeD86DE2639a922D7`
- `tBOND`: `0x910a546A1763C38dcf352cfdB6e752b3DBDAb029`
- `tNVDA`: `0xCBA194D6576379CfebA944cB696Be34F20e8a987`

Fuente de verdad runtime:

- [deployments/local.json](/home/sari/Sinergy-project/deployments/local.json)

## Flujo MVP

1. El usuario aprueba y deposita tokens en `DarkPoolVault`.
2. El frontend sincroniza ese depósito con `matcher-service`.
3. El backend mantiene balances internos y un libro privado.
4. Las órdenes se emparejan fuera de cadena con guardas de precio.
5. Los retiros requieren un ticket EIP-712 firmado por el matcher.
6. Los batches de matching pueden anclarse en `DarkPoolMarket`.

## Arranque rápido

### 1. Instalar dependencias JS

```bash
npm install
```

### 2. Compilar contratos

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts
forge build
```

### 3. Desplegar en `Sinergy-2`

```bash
chmod +x scripts/deploy-local.sh
./scripts/deploy-local.sh
```

Esto actualiza:

- `deployments/local.json`
- `services/matcher/.env`

Si vuelves a ejecutar el deploy, estas direcciones pueden cambiar.

### 4. Levantar backend

```bash
npm run dev:matcher
```

### 5. Levantar frontend

```bash
npm run dev:web
```

## Documentación interna

- Arquitectura: [docs/architecture.md](/home/sari/Sinergy-project/docs/architecture.md)
- Plan detallado: [docs/implementation-plan.md](/home/sari/Sinergy-project/docs/implementation-plan.md)

## Notas importantes

- Este primer corte da privacidad frente al observador on-chain y frente a otros traders, no frente al operador del backend.
- El libro, matching y ledger interno viven fuera de cadena.
- La wallet del navegador debe estar configurada para la red local `Sinergy-2`.
- Si actualizas `deployments/local.json`, reinicia backend y frontend para recargar direcciones.
