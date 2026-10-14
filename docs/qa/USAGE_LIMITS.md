# Límites de uso medibles: plan de integración con SPACE

Fecha: 2026-10-14. Complementa [USAGE_LIMITS_MATRIX.md](USAGE_LIMITS_MATRIX.md) (qué límites hay, dónde se aplican y su
estado). Este documento dice cómo se conecta con SPACE cuando se reactive, qué no se puede comprobar hoy y qué cambia en el
frontend.

## Declaración

**CU, créditos, moneda ponderada y saldo siguen fuera.** La decisión humana de 2026-10-14 permite límites sujetos a número
de tareas, complejidad del espacio de binding, tiempo de ejecución, número de jobs y concurrencia, y excluye unidades de
capacidad o créditos. Nada de lo implementado reserva, cobra, descuenta, pondera ni mantiene un saldo; un rechazo no deja
rastro que revertir. No se ha tocado `bim-toolchain`, `compose` ni el frontend, y no se ha llamado, escrito ni configurado
SPACE ni SPHERE: todo se verificó con dobles sintéticos. **No se afirma nada end-to-end real.**

Quién hace qué:

| | SPACE (nativo) | OpenBinding |
|---|---|---|
| Planes, versiones de pricing, contratos | Fuente. | Los lee (`caps`), crea/novate contratos con el cliente oficial. No los edita ni los duplica. |
| Techos por job y por cuenta (`maxInstanceComplexityLog10`, `maxTimeoutSeconds`, `maxIterations`, `maxPayloadBytes`, `apiKeys`, estructura) | Los declara en el plan; llegan en el token. | Los **aplica** en los puntos de la matriz. |
| Contadores acumulados por periodo (`taskStarts`, `solverSeconds`, `studyRuns`, `federatedTaskStarts`) | Candidato a fuente nativa (clase B). **Sin verificar.** | No los implementa hoy. Ver «Plan de integración». |
| Medidas locales (espacio de binding de una instancia, jobs simultáneos, tiempo de reloj) | — | Las mide y las compara. Son facts del trabajo, no consumo. |
| Salvaguardas técnicas (`MAX_BINDING_SPACE_LOG10`, `MAX_CONCURRENT_JOBS_PER_USER`, timeouts) | — | Propias; ningún plan las supera. |

## Qué se implementó en esta tarea

1. **Límite del espacio de binding exacto y con casos definidos** (`domain/binding_space.py`). Compara la cardinalidad como
   string decimal contra el techo del plan (`maxInstanceComplexityLog10`) y/o `MAX_BINDING_SPACE_LOG10`. Cuatro rechazos
   estables: `instance_complexity_too_large` (402, ya existía), `binding_space_over_technical_limit` (422),
   `binding_space_limit_unknown` (403) y `binding_space_unmeasured` (422). Ver tabla de decisión en la matriz, §3.3.
2. **Se aplica en**: envío de job, `/v1/validate`, retry y **run de estudio** (nuevo: se rechaza el run entero antes de
   crearlo; antes se aceptaba y fallaba celda a celda).
3. **Desbordamiento corregido**: un espacio de más de 4300 dígitos ya no levanta `ValueError` en `ir_analysis` ni en
   `Compilation`.
4. **Límite desconocido ya no es «0 s»**: un plan sin `maxTimeoutSeconds` daba un timeout de 0 s; ahora es `503
   pricing_misconfigured` (`access/policy.py:155`), igual que un plan con timeout ilimitado.
5. **Concurrencia**: el `429` nombra su límite (`limit_id`, `used`, `unit`, `source`) como un `402`, de modo que el frontend
   actual ya lo puede leer. `active` se conserva.
6. **Telemetría**: los cuatro códigos se categorizan como `pricing_quota` en los eventos de error que lee la
   administración (`telemetry.py:79`, consumido en `routes/admin.py:946` y `:1017`) en vez de `auth` o `validation`.
7. **Setting nuevo** `MAX_BINDING_SPACE_LOG10` (`core/settings.py:105`): float finito ≥ 0, sin valor por defecto (apagado).
   No existe en el contrato de SPACE un campo para «tope técnico de este despliegue», así que **no se inventa ningún
   campo remoto**: el tope técnico es solo local.

Qué **no** se hizo, y por qué:

- No se aplica `concurrentJobs` **del plan**: el diseño actual lo declara independiente del plan
  (`tests/test_concurrency_limit.py::test_the_limit_does_not_depend_on_the_plan`). Hacerlo cambia el comportamiento de cada
  plan y exige decidir qué pasa cuando el plan no lo declara (con la regla de «desconocido», denegaría todo). **Decisión
  humana pendiente.** Propuesta si se acepta: límite efectivo = `min(concurrentJobs del plan, MAX_CONCURRENT_JOBS_PER_USER)`;
  plan sin dato → solo el tope técnico (nunca «sin límite»).
- No se aplica el límite numérico `federatedEngines` (solo la *feature*), ni un tope de celdas por run: serían cantidades
  comerciales.
- No se cuentan arranques, segundos ni runs por periodo (clase B). Eso es contabilidad.
- No se amplía `GET /v1/users/me/usage` con el techo efectivo: cambiaría el contrato (`docs/openapi.json`, fuera del alcance
  de esta tarea).

## Capacidades nativas de SPACE que NO se pueden verificar ahora

Todas están en espera. Ninguna se ha comprobado y el código no depende de ellas, salvo el punto 1, que es lo que hoy lee.

1. **Que el token real entregue** `maxInstanceComplexityLog10` (y los demás) con esos nombres y unidades. Se lee de
   `pricingContext.usageLimits`, sin prefijo de servicio (`space_client/space.py:106-138`).
2. **Qué significa «no declarado» en SPACE.** El código trata la clave ausente, `NaN`, negativa o no numérica como
   *desconocida* (deniega o aplica el tope técnico) y `null` como *ilimitado* (`space.py:130-133`). Si SPACE enviase `null`
   para un límite sin declarar, se concedería sin límite. **Hay que confirmarlo antes de producción.**
3. **Unidad y escala** del límite de complejidad: log10 de combinaciones (`UNIT` en `domain/binding_space.py:48`). Si SPACE
   lo definiera en otra unidad, `check` rechazaría o aceptaría mal.
4. **Add-ons**: si `usageLimits` ya incluye `usageLimitsExtensions` multiplicadas por cantidad (la fake sí lo hace).
5. **Medición nativa de uso**: contadores, ventanas, reinicio, y si la fuente es el evento que OpenBinding informa o algo que
   SPACE observa. El cliente 1.x no expone ninguna llamada de uso que el gateway use.
6. **Evaluación de expresiones de features** con `subscriptionContext` (la fixture `solve` referencia
   `subscriptionContext['concurrentJobs']`). El gateway no la evalúa; lo hace SPACE/el navegador. No se sabe si SPACE
   deniega `solve` por concurrencia por su lado, y entonces habría dos aplicaciones del mismo límite.
7. **Caché, invalidación y socket** de cambios de pricing del cliente.
8. **La firma del token** (se descodifica sin verificar a propósito).
9. **Concurrencia real de la creación de jobs**: depende de `FOR UPDATE` en PostgreSQL. Las pruebas que lo demuestran
   (`tests/concurrency/*_pg.py`) se omiten sin `TEST_DATABASE_URL`: 40 omitidas en esta ejecución.
10. **Toolchain con >4300 dígitos**: `bim-toolchain` también convierte la cardinalidad a texto (`operations.py:118`); en
    modo `inproc` podría fallar dentro del toolchain antes de que el gateway la vea. No se tocó (fuera de alcance).

## Plan de integración cuando SPACE se reactive

Orden pensado para no recrear nada y para poder parar en cualquier paso. Cada paso empieza con una comprobación de solo
lectura.

1. **Confirmar el contrato del token** contra el SPACE de desarrollo (`SPACE_SERVICE_NAME=openbinding-dev`, nunca el de
   producción): leer un token de una cuenta de prueba y comprobar los puntos 1-4 de arriba. Dejarlo documentado aquí con
   la fecha y la versión de pricing. Es lectura (`generate_user_pricing_token`, `get_contract`).
2. **Fijar el significado de «no declarado»** con el equipo de SPACE. Mientras no esté fijado, dejar
   `MAX_BINDING_SPACE_LOG10` puesto en cualquier despliegue real: así un plan sin dato queda acotado por el tope técnico
   y no por lo que SPACE mande.
3. **Decidir los contadores de clase B.** Para cada uno, el humano decide: (a) se queda como informativo, (b) pasa a un
   tope instantáneo o por job que OpenBinding ya sabe medir (hecho para espacio, simultaneidad y tiempo por job), o (c) es
   un contador mensual nativo de SPACE. Solo (c) necesita integración de uso.
4. **Si (c)**: elegir quién mide. Opción preferida por no duplicar contabilidad: SPACE es la fuente del acumulado y
   OpenBinding **informa eventos idempotentes** (el job ya tiene identidad estable y clave de idempotencia; ver matriz §5:
   un reintento no debe contar dos veces) y **lee** el estado. Antes de escribir una línea hay que verificar que el cliente
   1.x ofrece esa operación y con qué semántica de reinicio. Si no la ofrece, no se improvisa un contador local: se pide a
   SPACE o se descarta.
5. **Aplicar `concurrentJobs` del plan** si se decide (propuesta arriba) y añadir su prueba junto a
   `tests/test_concurrency_limit.py`.
6. **Pruebas contra el SPACE de desarrollo**, con cuentas sintéticas, en este orden: lectura de `caps` de un plan de
   cada tipo → rechazo por complejidad → rechazo por «no declarado» → replay idempotente → estudio. Nada en producción.
7. **Ejecutar `tests/concurrency` con PostgreSQL** (`docs/qa/PG_HARNESS.md`) para ver la concurrencia real, que aquí se
   omite.

No se debe, en ningún paso: crear versiones de pricing desde OpenBinding, escribir contratos con cantidades distintas a las
del plan, ni guardar un saldo local.

## Cambios de frontend necesarios (no editados)

El frontend no se ha tocado. Lo que necesita para mostrar bien «límite agotado / desconocido»:

1. **`frontend/src/pages/Jobs/jobErrors.ts` (`refusalOf`)**
   - `402 instance_complexity_too_large` ya existe. Mejorar el texto con `quota.used` y `quota.limit` en log10 y, si hay,
     `binding_space.cardinality`/`digits` (hoy es una frase genérica). Leer `quota.source` (`plan` | `technical`).
   - **Nuevo `403 binding_space_limit_unknown`**: hoy cae en la rama `403` y se muestra como «This credential can’t start
     runs» (permiso de API key), que es falso. Debe decir: «Tu plan no indica el tamaño máximo de problema; contacta con el
     administrador. No se inició nada.» Sin botón de actualizar plan (no se arregla subiendo de plan: falta el dato).
   - **Nuevo `422 binding_space_over_technical_limit`**: debe decir que este despliegue limita el tamaño del problema y que
     un plan mayor no lo cambia; sugerir reducir candidatos.
   - **Nuevo `422 binding_space_unmeasured`**: mensaje de error del sistema («no se pudo medir el problema; reintenta o
     informa»), no de validación del usuario.
2. **`frontend/src/api/client.ts` (`errorFor`)**: para `403`/`422` con esos códigos, conservar `problem.quota` y
   `problem.binding_space` en el `HttpError` (hoy solo el `402` construye `QuotaError` y el `429` conserva `concurrency`).
   Recordar la doble forma en el cable: `quota` va **dentro de `detail`** en rutas de plataforma con estado distinto de 422 y
   **al nivel superior** en rutas BIM y en cualquier 422 (matriz §3.3); `rawQuota = detail?.quota ?? problemObject?.quota`
   (`client.ts:592`) ya cubre ambas.
3. **`429 concurrency_limit_exceeded`**: ya se lee ahora (`limit_id`, `limit`, `used`; `client.ts:602`). Revisar en
   `frontend/src/utils/limits.ts` las entradas existentes de `concurrentJobs` (grupo `capacity`) y
   `maxInstanceComplexityLog10` (`log10`): la palabra «capacity» no debe llegar a la interfaz como «unidades de capacidad».
4. **Lanzamiento de estudios** (`frontend/src/pages/Studies/StudyRun.tsx`, llamada `runStudy` en
   `frontend/src/api/platform.ts` ~l.661): un run rechazado por tamaño responde antes de crear nada (no hay run ni celdas).
   Debe mostrarse como el rechazo de un job, no como un run parcial.
5. **Vista de uso de la cuenta** (`frontend/src/pages/Account/AccountUsage.tsx`): hoy muestra solo `plan`, `features` y
   `capabilities`. Si se quiere enseñar el techo de tamaño efectivo y su origen (`plan`/`technical`), hace falta ampliar
   `GET /v1/users/me/usage` (cambio de contrato y de `docs/openapi.json`; no hecho).
6. **Administración de errores** (`frontend/src/pages/Admin/AdminErrors.tsx`): los cuatro códigos aparecen ahora bajo la
   categoría `pricing_quota`; el filtro no necesita cambios, pero su leyenda debe decir que incluye «límite desconocido» (es
   un fallo de configuración del plan, no del usuario).
7. **Copia**: no usar «créditos», «saldo» ni «unidades de capacidad». Los límites son techos («tu plan admite problemas de
   hasta 10^N combinaciones», «puedes tener N trabajos a la vez»).

## Riesgos conocidos

- **Estimación, no medida real**: un techo sobre `bindingSpaceCardinality` puede rechazar una instancia fácil con muchas
  combinaciones y aceptar una difícil con pocas. Es un techo de admisión, no una medida de coste.
- **Cambio de comportamiento en un plan sin dato**: antes, un plan sin `maxInstanceComplexityLog10` daba `402` (el límite
  se leía como 0); ahora da `403 binding_space_limit_unknown` (o se acota por `MAX_BINDING_SPACE_LOG10` si está puesto). El
  frontend actual lo mostraría como error de permisos de clave hasta aplicar el cambio de arriba.
- **Cambio de comportamiento del timeout**: un plan sin `maxTimeoutSeconds` ahora es `503 pricing_misconfigured` en vez de
  un job con timeout de 0 s.
- **Retry de jobs antiguos** sin tamaño guardado no se vuelve a medir (matriz §3.4).
- **OpenAPI**: los miembros nuevos de las respuestas (`quota.state`, `quota.source`, `binding_space`) no están modelados en
  `QuotaBody`; si se quieren en el contrato hay que modelarlos y regenerar `docs/openapi.json` (fuera del alcance de esta
  tarea). `tools/dump_openapi.py --check` pasa sin cambios.
- **Concurrencia**: ver arriba (PostgreSQL no disponible aquí).

## Verificación

Ejecutada con `qa_run` en esta rama; los resultados reales están en el informe de la tarea. Los tests nuevos están en
`openbinding-gateway/tests/test_usage_limits.py` (límite agotado, desconocido, ilimitado, igualdad exacta con el techo,
más de 4300 dígitos, reintento idempotente sin segundo slot, rechazo sin efecto lateral en job/estudio/retry/validación,
concurrencia como ranura que se libera, respuesta serializable). Los tests existentes que fijaban la forma antigua del
cuerpo `429` se actualizaron para el cuerpo ampliado (`tests/test_entitlements.py`, `test_admin_errors.py`,
`test_job_submission_service.py`, `test_concurrency_limit.py`).
