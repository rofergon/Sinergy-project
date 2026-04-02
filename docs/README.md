# Documentacion de Sinergy

Esta carpeta explica el proyecto desde varios angulos. La idea de esta guia es que no tengas que abrir todos los archivos para entender por donde empezar.

## Si quieres entender el proyecto rapido

- Lee [onboarding-hackathon.md](/home/sari/Sinergy-project/docs/onboarding-hackathon.md). Es la mejor vista general de producto, problema y propuesta de valor.
- Luego lee [architecture.md](/home/sari/Sinergy-project/docs/architecture.md). Resume como se conectan contratos, backend y frontend.

## Si quieres entender la parte de privacidad

- Lee [privacy-architecture.md](/home/sari/Sinergy-project/docs/privacy-architecture.md) para entender que privacidad existe hoy y cual es el objetivo.
- Lee [privacy-engine-design.md](/home/sari/Sinergy-project/docs/privacy-engine-design.md) si necesitas ver la version mas tecnica de esa evolucion.
- Lee [zk-withdrawal-runbook.md](/home/sari/Sinergy-project/docs/zk-withdrawal-runbook.md) si vas a ejecutar pruebas reales de retiros con pruebas ZK.

## Si quieres operar la red o el entorno testnet

- Lee [implementation-plan.md](/home/sari/Sinergy-project/docs/implementation-plan.md) para ver el plan general de trabajo.
- Lee [testnet-runbook.md](/home/sari/Sinergy-project/docs/testnet-runbook.md) para levantar el stack en testnet.
- Lee [network-startup.md](/home/sari/Sinergy-project/docs/network-startup.md) para el arranque operativo del dia a dia.

## Si quieres entender integraciones o cambios puntuales

- Lee [initia-dex-liquidity-routing.md](/home/sari/Sinergy-project/docs/initia-dex-liquidity-routing.md) para entender cuando una operacion usa liquidez local y cuando sale a Initia DEX.
- Lee [cusdc-migration.md](/home/sari/Sinergy-project/docs/cusdc-migration.md) para entender la migracion de `sUSDC` a `cUSDC`.

## Lectura recomendada segun el perfil

- Producto o demo: [onboarding-hackathon.md](/home/sari/Sinergy-project/docs/onboarding-hackathon.md), [architecture.md](/home/sari/Sinergy-project/docs/architecture.md)
- Backend o smart contracts: [architecture.md](/home/sari/Sinergy-project/docs/architecture.md), [privacy-architecture.md](/home/sari/Sinergy-project/docs/privacy-architecture.md), [privacy-engine-design.md](/home/sari/Sinergy-project/docs/privacy-engine-design.md)
- DevOps o testnet: [implementation-plan.md](/home/sari/Sinergy-project/docs/implementation-plan.md), [testnet-runbook.md](/home/sari/Sinergy-project/docs/testnet-runbook.md), [network-startup.md](/home/sari/Sinergy-project/docs/network-startup.md)

## Idea general del proyecto en lenguaje simple

Sinergy busca que el trading de cripto y activos tokenizados no exponga demasiada informacion en cadena. Para eso:

- los fondos se custodian on-chain;
- las ordenes y el matching viven fuera de cadena;
- la interfaz web conecta al usuario con ese flujo;
- `Initia L1` aporta liquidez externa cuando el inventario local no alcanza.

En otras palabras: la cadena se usa para lo que necesita ser verificable, y el resto se mantiene lo mas privado y practico posible.
