# Proceso de trabajo con IA y decisiones técnicas

## Qué pide la evaluación

El PDF permite y espera el uso de un agente de IA. Evalúa el criterio para dar especificaciones, revisar resultados y corregir decisiones deficientes. La rúbrica asigna 20% a arquitectura, 20% a idempotencia y concurrencia, 15% al uso crítico de IA, 15% a código y pruebas, 15% a errores y resiliencia, y el 15% restante a datos, observabilidad y README. El puntaje mínimo indicado para avanzar es 75/100.

El enunciado plantea diez situaciones: doble envío, retry automático, varios pods, timeout del proveedor, webhook duplicado, webhook fuera de orden, webhook antes de la respuesta síncrona, falla temporal de base de datos, reinicio durante una operación y carrera al actualizar el saldo. También pide endpoints `POST /cash-in` y `POST /webhooks/payment`, pruebas, README de decisiones y explicar qué se pidió a la IA y qué se revisó.

## Cómo se trabajó

1. **Aclarar el alcance antes de escribir código.** Primero se pidió esperar a que la especificación estuviera lista. Después se revisaron el PDF y el repositorio para fijar los requisitos y respetar el stack existente.
2. **Convertir los fallos financieros en invariantes.** Una clave por usuario y operación; un pago externo con identidad estable; una única acreditación; dinero en unidades menores enteras; un timeout se conserva como incierto y pendiente.
3. **Diseñar el flujo antes de implementarlo.** Se eligió una API modular con PostgreSQL como fuente de verdad, un outbox durable para despachar pagos después del commit, un adaptador de proveedor simulado y una máquina de estados compartida por respuestas y webhooks.
4. **Implementar y revisar por capas.** Se añadieron contratos HTTP, migraciones, repositorios, transacciones de ledger, firma HMAC, deduplicación de webhooks, reintentos y recuperación.
5. **Validar en más de una forma.** Se ejecutaron 15 pruebas de integración sobre PostgreSQL, además de typecheck, build y auditoría de dependencias. Se comprobó manualmente un rechazo en Postman y su efecto financiero consultando PostgreSQL.
6. **Preparar el uso local en Windows.** Se creó un lanzador autocontenido para Windows x64 que inicia PostgreSQL con Docker Compose, aplica migraciones y seed, y arranca la API.

## Dificultades y cómo se resolvieron

| Dificultad o riesgo | Decisión o corrección | Evidencia |
| --- | --- | --- |
| Una caché en memoria no coordina varios pods ni sobrevive a reinicios. | Idempotencia persistente con restricción única `(user_id, idempotency_key)`, huella del request y `INSERT ... ON CONFLICT`. | Pruebas de repetición, conflicto y concurrencia. |
| Un timeout no indica si el proveedor cobró. | Mantener `PENDING`, guardar trabajo en outbox y reintentar con la misma clave `cashin:<operation_id>`. | Prueba de respuesta perdida después del cobro y recuperación. |
| Respuesta síncrona y webhook pueden competir o repetirse. | Estado persistente, evento deduplicado y ledger/saldo/estado dentro de una transacción; unicidad por operación. | Pruebas de webhook duplicado, tardío y carrera de confirmaciones. |
| La primera configuración de pruebas podía apuntar a datos de desarrollo. | Separar `TEST_DATABASE_URL` y usar una base de pruebas dedicada antes de limpiar tablas. | README y pruebas de integración. |
| `npm audit` detectó una vulnerabilidad alta en la versión inicial de Zod. | Actualizar Zod y volver a auditar las dependencias. | `npm audit` terminó sin vulnerabilidades. |
| En Windows PowerShell, llamar a `npm.ps1` desde el lanzador produjo `Unknown command: pm`. | Invocar `npm.cmd` explícitamente y volver a probar migración, seed y arranque. | El `.exe` completó los tres pasos y levantó la API. |
| El primer nombre publicado del ejecutable no coincidía con el documentado. | Fijar `AssemblyName=LigoCashIn` y volver a publicar el binario. | `artifacts/windows/LigoCashIn.exe`. |
| El puerto 3000 estaba ocupado por otra aplicación local. | Usar `PORT` configurable, probar con 3001 y añadir aviso si el puerto configurado ya está ocupado. | La API respondió `{"status":"ok"}` en `/health` por el puerto 3001. |
| Abrir `/` devolvía 404 y parecía un error. | Aclarar que es una API sin página web: `/health` es la comprobación y `/cash-in` el endpoint de recarga. | Prueba HTTP de `/health`. |
| El `422 PAYMENT_DECLINED` de Postman podía confundirse con un fallo del sistema. | Revisar la respuesta y consultar la operación y el ledger en PostgreSQL. | La operación quedó `FAILED` y el conteo del ledger fue `0`. |

## Decisiones de diseño

1. La clave idempotente vive en PostgreSQL, no en `Map`, caché local ni una variable global. La unicidad se aplica en la base de datos para cubrir carreras entre instancias.
2. Crear la operación y su outbox es atómico. El proveedor se llama después del commit, sin mantener abierta una transacción SQL mientras se espera la red.
3. Los retries reutilizan la misma clave del proveedor. El simulador guarda pagos para demostrar la recuperación después de una respuesta perdida.
4. Los webhooks se validan con HMAC y timestamp. Un evento repetido no duplica el efecto; un evento terminal contradictorio se conserva para reconciliación.
5. El saldo se actualiza en la misma transacción que el movimiento de ledger y la transición a `SUCCEEDED`.
6. No se afirma exactamente una ejecución externa si el proveedor real no ofrece idempotencia durable y consulta/reconciliación.

## Alineación con la rúbrica del PDF

| Criterio | Evidencia en la solución |
| --- | --- |
| Arquitectura y criterio técnico (20%) | README, límites de módulos, PostgreSQL, outbox y adaptador del proveedor. |
| Idempotencia y concurrencia (20%) | Restricción única distribuida y prueba con dos aplicaciones/pools independientes. |
| Uso de IA (15%) | Especificación explícita, revisión del PDF, registro de riesgos, correcciones y resultados comprobados. |
| Código y pruebas (15%) | 15 pruebas de integración aprobadas; typecheck y build completados. |
| Errores y resiliencia (15%) | Timeout incierto, outbox con lease y retry, webhooks repetidos/atrasados y recuperación. |
| Persistencia y modelado (5%) | Migraciones PostgreSQL, wallets, operaciones, outbox, ledger y eventos. |
| Observabilidad (5%) | Logs estructurados y `x-correlation-id`/`request_id`. |
| README y comunicación (5%) | Arquitectura, contratos, estados, ejecución, pruebas y límites documentados. |

## Evidencia comprobada

- La captura de la suite muestra **15 tests passed**.
- Postman muestra el rechazo esperado `422 PAYMENT_DECLINED` para PEN 120.00.
- La consulta manual en PostgreSQL confirma `FAILED` y cero filas de ledger para esa operación.
- Docker Desktop muestra activo el grupo Compose `challenge-ligo-backend`.
- El ejecutable inició PostgreSQL, aplicó migraciones y seed, y la API respondió correctamente en `/health`.

El informe Word separado contiene las capturas y el resumen para compartir por correo. Las pruebas automatizadas usan `TEST_DATABASE_URL`; no apuntes esa variable a datos que quieras conservar.

## Límites conocidos y defensa técnica

El proveedor es un simulador local y comparte PostgreSQL para hacer reproducible su idempotencia. En producción se requiere que el proveedor garantice claves idempotentes durables y permita consultar o reconciliar pagos. El `user_id` también es una simulación; debe derivarse de autenticación real.

Para la defensa: PostgreSQL impide crear dos operaciones lógicas por clave aun con varios pods; el proveedor recibe una identidad estable para hacer seguro el retry externo; Redis podría acelerar lecturas, pero no reemplazaría las restricciones y transacciones financieras; a mayor volumen se medirían la cola, latencia y conexiones antes de escalar workers y particionar tablas.
