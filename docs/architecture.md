# Sinergy Dark RWA Market

## Objetivo

Construir un mercado RWA sobre `Sinergy-2` donde compradores y vendedores puedan:

- depositar liquidez en una vault común;
- negociar órdenes sin publicarlas on-chain;
- ejecutar matching fuera de cadena;
- retirar posiciones desde la vault mediante tickets firmados;
- reducir la huella visible en cadena a depósitos, retiros y anclajes periódicos del estado.

## Traducción de `ssl` a Initia

El proyecto de referencia `furqaannabi/ssl` depende de tres piezas que no podemos usar directamente en `Sinergy-2`:

1. `Chainlink CRE` para matching confidencial en TEE.
2. `Chainlink ACE / World ID` para enforcement de compliance.
3. `Convergence Vault` para settlement privado ya resuelto por terceros.

En este MVP las reemplazamos así:

| SSL | Sinergy MVP |
|---|---|
| CRE TEE | `matcher-service` propio |
| Confidential HTTP / Chainlink oracle | `price service` propio con adaptadores mock/manual/http |
| Convergence vault | `DarkPoolVault` |
| ACE / World ID | capa de compliance desacoplada en backend |
| Shield settlement fuera de nuestro control | settlement interno off-chain + retiros firmados |

## Componentes

### 1. `DarkPoolVault` on-chain

Contrato de custodia para `USDC` y tokens RWA.

- recibe depósitos ERC20;
- emite eventos `Deposit` y `Withdraw`;
- no expone libro de órdenes ni emparejamientos;
- sólo permite retiros con permisos EIP-712 firmados por el backend autorizado.

Esto hace que la actividad visible en cadena sea mínima:

- `approve + deposit`
- `withdraw`
- anclajes periódicos del estado del libro

### 2. `DarkPoolMarket` on-chain

Contrato de control ligero que:

- registra mercados listados;
- guarda batches anclados por el matcher (`stateRoot`, `settlementRoot`);
- permite auditar snapshots sin revelar cada orden.

### 3. `matcher-service`

Backend TypeScript responsable de:

- mantener balances internos por usuario y token;
- sincronizar depósitos desde la vault;
- validar saldos disponibles;
- almacenar órdenes limitadas;
- ejecutar matching precio-tiempo;
- aplicar slippage guards con un precio de referencia;
- firmar tickets de retiro para el frontend.

### 4. `web`

Frontend Vite + React + wagmi/viem para:

- conectar una wallet EVM;
- aprobar y depositar en la vault;
- sincronizar balances internos;
- enviar órdenes privadas al backend;
- solicitar tickets de retiro y ejecutar `withdraw`.

## Qué privacidad logramos en este primer corte

### Sí

- el libro y la intención de trading no viven on-chain;
- otros participantes no ven órdenes abiertas;
- los rebalanceos internos del matching no se publican on-chain;
- el settlement visible se concentra en la vault y en hashes de batches.

### No todavía

- el operador del backend sí puede ver órdenes en claro;
- no hay TEE ni zk para ocultar lógica al operador;
- no hay compliance fuerte en contrato;
- no hay stealth withdrawals completos todavía.

## Modelo de confianza

Este MVP prioriza velocidad de construcción sobre privacidad criptográfica total.

La confianza actual queda así:

1. El usuario confía en el `matcher-service` para mantener el libro interno.
2. El usuario confía en el firmante del backend para autorizar retiros correctos.
3. El contrato limita el daño porque sólo mueve fondos mediante depósitos explícitos y tickets firmados.

## Evolución recomendada

### Fase 2

- cifrado cliente -> backend con ECIES;
- persistencia SQL + auditoría completa;
- procesos separados para matcher, risk y oracle;
- snapshot Merkle del ledger interno;
- compliance por allowlists, KYC o attestations.

### Fase 3

- settlement privado con stealth addresses;
- pruebas de balance por usuario;
- ejecución del matcher en TEE o entorno confidencial;
- pruebas zk para lotes de settlement.

