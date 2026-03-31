# Sinergy: Onboarding para Hackathon

## 1. Qué es Sinergy

**Sinergy** es un mercado privado de activos tokenizados y cripto construido sobre la appchain `Sinergy-2` de Initia.

El proyecto combina:

- una **vault on-chain** para custodiar fondos;
- un **matcher off-chain** para mantener órdenes privadas y ejecutar matching;
- una **interfaz web** para depositar, tradear y retirar;
- un **router híbrido** que usa inventario local y, cuando aplica, liquidez conectada a `InitiaDEX`.

En pocas palabras: **Sinergy permite tradear activos tokenizados y cripto con menos exposición on-chain, mejor experiencia de usuario y una arquitectura lista para evolucionar hacia mayor privacidad.**

## 2. Problema que resuelve

Hoy, muchos mercados on-chain tienen tres fricciones fuertes:

1. **Las órdenes quedan expuestas públicamente**, lo que revela intención de trading, tamaño y precio.
2. **Los activos del mundo real tokenizados y la liquidez cripto suelen vivir en flujos separados**, lo que fragmenta la experiencia.
3. **Entrar a una appchain y mover fondos entre capas sigue siendo complejo**, especialmente para usuarios que vienen desde EVM.

Sinergy resuelve esto con un enfoque MVP muy claro:

- las órdenes se manejan **fuera de cadena**;
- la cadena sólo ve **depósitos, retiros y anclajes de estado**;
- el sistema soporta tanto **RWAs** como **cripto**;
- el onboarding usa **InterwovenKit** y un flujo de bridge dedicado para reducir fricción.

## 3. A quién ayuda

### Traders

- obtienen más privacidad que en un DEX completamente público;
- pueden operar sin exponer todas sus intenciones al mercado;
- tienen una experiencia unificada para cripto y activos tokenizados.

### Equipos que tokenizan activos reales

- consiguen una base de mercado más parecida a un venue privado;
- pueden listar activos tokenizados sin depender de un order book totalmente público;
- tienen una arquitectura compatible con futuras capas de compliance.

### Ecosistema Initia

- demuestra un caso de uso real para `MiniEVM`, `InterwovenKit` y conectividad con `InitiaDEX`;
- aporta una pieza de infraestructura orientada a mercados privados y RWAs;
- crea un puente entre UX de appchain, trading y liquidez híbrida.

## 4. Propuesta de valor

La propuesta de valor de Sinergy para el hackathon es:

**“Un mercado privado de RWAs y cripto sobre Initia, donde el settlement crítico vive on-chain, pero la intención de trading y el matching permanecen fuera de cadena.”**

Esto lo hace atractivo porque mezcla:

- **utilidad real**: trading y settlement;
- **mejor UX**: onboarding con wallet + bridge;
- **arquitectura defendible**: vault, matcher y market separados;
- **visión de producto**: empieza como MVP funcional y escala hacia privacidad y compliance más robustos.

## 5. Qué incluye el MVP actual

El MVP ya implementa los componentes principales:

### Smart contracts

- `DarkPoolVault`: custodia depósitos y permite retiros con tickets firmados `EIP-712`.
- `DarkPoolMarket`: registra mercados y ancla batches (`stateRoot`, `settlementRoot`).
- `MockUSDC`: stablecoin mock para el entorno local.
- `RwaShareToken`: token base para representar activos listados.

### Backend

- ledger interno por usuario y token;
- sincronización de depósitos desde la vault;
- order book privado;
- matching precio-tiempo;
- validaciones por bandas de precio;
- firma de tickets de retiro;
- pricing híbrido para RWA y cripto con oráculos de Initia y adaptadores custom;
- router privado con fills locales y rebalanceo asíncrono cuando se necesita liquidez externa.

### Frontend

- conexión de wallet con `InterwovenKit`;
- depósitos y retiros;
- visualización de mercado y precios;
- envío de órdenes privadas;
- panel para rutas tipo `Private Router`;
- separación entre mercados `Router-enabled` y `Dark-pool only`.

### Bridge onboarding

- una app dedicada para iniciar la sesión de wallet;
- flujo pensado para usuarios que llegan desde `Ethereum Sepolia`;
- transición clara desde bridge hacia el exchange.

## 6. Características diferenciales

### Privacidad práctica desde el MVP

Sinergy no publica el libro de órdenes on-chain. Eso reduce visibilidad para observadores externos y protege mejor la intención de trading.

### Arquitectura híbrida

No intenta poner toda la lógica en contrato. Usa on-chain para custodia y retiro seguro, y off-chain para matching y operación rápida.

### Mezcla de RWAs y cripto

El sistema ya contempla ambos mundos:

- RWAs como `tAAPL`, `tBOND`, `tNVDA`;
- cripto como `cBTC`, `cETH`, `cSOL`, `cINIT`.

### Integración real con Initia

El proyecto ya usa piezas nativas del ecosistema:

- `MiniEVM`
- `InterwovenKit`
- `Initia Connect`
- `InitiaDEX` para ciertos mercados habilitados

### Capa de oráculos y pricing

Sinergy combina infraestructura del ecosistema Initia con una capa propia de pricing en el matcher.

Para cripto, usa **`Initia Connect Oracle`** como fuente de precio en vivo para:

- `cBTC -> BTC/USD`
- `cETH -> ETH/USD`
- `cSOL -> SOL/USD`
- `cINIT -> INIT/USD`

Además, el proyecto implementa un **price service custom** que:

- unifica las fuentes de datos para que el matcher trabaje con una sola interfaz;
- usa `Twelve Data` para RWAs como `tAAPL`, `tNVDA` y `tBOND`;
- usa `CoinGecko` para bootstrap histórico de cripto;
- guarda histórico y fallback en `SQLite` para resiliencia operativa;
- permite seguir operando incluso si una fuente externa falla temporalmente.

Esto es importante para el hackathon porque demuestra no sólo integración con Initia, sino también capacidad de construir infraestructura de mercado más robusta alrededor de esa base.

### Camino claro de evolución

El diseño ya deja abierta la siguiente etapa:

- cifrado de órdenes;
- snapshots Merkle;
- compliance desacoplado;
- TEE o zk para settlement más confidencial.

## 7. Mercados soportados en el estado actual

### Mercados con ruta conectada a `InitiaDEX`

- `cINIT/sUSDC`
- `cETH/sUSDC`

### Mercados dark-pool only

- `cBTC/sUSDC`
- `cSOL/sUSDC`
- `tAAPL/sUSDC`
- `tBOND/sUSDC`
- `tNVDA/sUSDC`

## 8. Cómo funciona el flujo del usuario

1. El usuario conecta su wallet con `InterwovenKit`.
2. Si necesita fondos, pasa por el flujo de bridge.
3. Deposita activos en `DarkPoolVault`.
4. El frontend sincroniza el estado con el `matcher-service`.
5. El usuario envía órdenes privadas.
6. El matcher ejecuta matching off-chain.
7. El usuario puede retirar con un ticket firmado por el backend.
8. El protocolo puede anclar batches en `DarkPoolMarket`.

## 9. Por qué este proyecto puede competir bien en un hackathon

Sinergy tiene varios puntos fuertes para jurados:

- **resuelve un problema real**: privacidad y UX en mercados de activos tokenizados;
- **muestra integración técnica con el ecosistema Initia**;
- **tiene arquitectura completa**, no sólo una pantalla o un contrato aislado;
- **es demoable**: wallet, depósito, trade, router, retiro;
- **tiene visión de roadmap**, sin vender humo sobre lo que aún no está implementado.

## 10. Limitaciones actuales del MVP

Es importante presentarlo con honestidad:

- el operador del backend todavía puede ver las órdenes;
- no hay TEE ni zk en esta versión;
- el compliance fuerte aún no está on-chain;
- parte del pricing sigue dependiendo de proveedores y adaptadores externos aunque ya exista una capa propia de agregación.

Esto no debilita el proyecto; al contrario, muestra una estrategia sensata de construcción:

**primero funcionalidad y adopción, luego privacidad criptográfica más profunda.**

## 11. Mensaje corto para presentar el proyecto

> Sinergy es un mercado privado de RWAs y cripto construido sobre Initia. Usamos una vault on-chain para custodia y retiros seguros, mientras el order book y el matching viven off-chain para reducir exposición pública. El MVP ya permite onboarding con wallet, depósitos, órdenes privadas, pricing híbrido con `Initia Connect Oracle` y un servicio de precios custom, además de retiros firmados y una evolución clara hacia mayor privacidad, compliance y settlement confidencial.

## 12. Pitch de 30 segundos

**Sinergy convierte Initia en una base para mercados privados de activos tokenizados. En lugar de exponer cada orden on-chain, movemos el matching fuera de cadena y dejamos en la appchain sólo la custodia, los retiros y el anclaje de estado. Combinamos `Initia Connect Oracle` para cripto con una capa propia de pricing para RWAs e histórico, lo que mejora privacidad, da resiliencia operativa y habilita un flujo real para RWAs y cripto dentro del ecosistema Initia.**

## 13. Stack del proyecto

- `Foundry` para contratos EVM
- `Vite + React` para frontend
- `InterwovenKit` para wallet UX
- `Fastify + TypeScript` para backend matcher
- `viem` para utilidades EVM
- `MiniEVM` / `minitiad` para despliegue local

## 14. Cómo leer el repo

- `contracts/`: contratos del protocolo
- `apps/web/`: interfaz principal de trading
- `apps/bridge/`: onboarding y bridge
- `services/matcher/`: matching, precios y tickets de retiro
- `packages/shared/`: ABIs, configuración de chain y tipos compartidos
- `docs/`: arquitectura, plan e información de producto

## 15. Conclusión

Sinergy no es sólo una idea de hackathon: ya tiene una base funcional, una narrativa clara y una necesidad concreta de mercado. Su valor está en conectar **privacidad práctica**, **activos tokenizados**, **liquidez híbrida** y **UX sobre Initia** en una sola experiencia.
