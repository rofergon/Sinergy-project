# Plan de Implementación

## Fase 1: MVP desplegable sobre `Sinergy-2`

### Smart contracts

1. `MockUSDC`
2. `RwaShareToken`
3. `DarkPoolVault`
4. `DarkPoolMarket`

### Backend

1. catálogo de mercados;
2. balances internos por usuario;
3. sync de depósitos vía receipt/logs;
4. order entry;
5. matching precio-tiempo;
6. retiro firmado EIP-712.

### Frontend

1. conexión de wallet;
2. panel de mercado y precios;
3. depósito y sincronización;
4. envío de órdenes;
5. balance interno;
6. retiro.

### Deploy local

1. compilar Foundry;
2. desplegar con `minitiad tx evm create`;
3. registrar mercados;
4. exportar direcciones a `deployments/local.json`;
5. cablear frontend/backend con esas direcciones.

## Fase 2: Privacidad más fuerte

1. cifrado de órdenes con clave pública del matcher;
2. ordenes firmadas EIP-712;
3. order storage durable con SQLite/Postgres;
4. snapshot Merkle del ledger interno;
5. anclaje periódico del batch root en `DarkPoolMarket`.

## Fase 3: Compliance y oracle productivo

1. price adapters con Finnhub / Polygon / TwelveData;
2. policy engine propio;
3. listas sancionadas / regiones / KYC hooks;
4. watchers de eventos y reconciliación.

## Fase 4: Settlement confidencial serio

1. stealth addresses por trade;
2. retiro a cuentas efímeras;
3. execution worker aislado;
4. TEE o zk settlement proofs.

