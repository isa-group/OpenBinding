# Límites de uso medibles: plan de integración con SPACE

Fecha: 2026-10-14. Complementa [USAGE_LIMITS_MATRIX.md](USAGE_LIMITS_MATRIX.md) (qué límites hay, dónde se aplican y su
estado). Este documento dice cómo se conecta con SPACE cuando se reactive, qué no se puede comprobar hoy y qué cambia en el
frontend.

## Declaración

**Estado vigente (2026-10-14, cabeza `c2d46151`).** Decisiones humanas ya resueltas, no pendientes: los límites de uso
medibles **sí** (jobs, tareas y estudios, tiempo, concurrencia y complejidad del espacio de binding); CU y créditos **no**;
los contadores de clase B **no se retiran por ser contadores**, y SPACE es su fuente nativa, hoy en espera (cero llamadas). Lo
que queda abierto de verdad: SPACE nunca se ha probado, y los contadores de clase B y `federatedEngines` **no están medidos
contra un SPACE real** (el puerto `UsageCounterSource` solo tiene una fuente sintética). Integrado: J en `e979f12b`, L en
`e1090c22`. Las frases de este documento que dicen «decisión pendiente» o «el humano decide» (p. ej. el paso 3 del plan) son
el estado histórico en que se escribieron: la decisión sobre clase B ya está tomada (SPACE nativo, en espera), pero cada
contador sigue sin integrarse hasta verificar el cliente de SPACE.

**CU, créditos, moneda ponderada y saldo siguen fuera.** La decisión humana de 2026-10-14 permite límites sujetos a número
de tareas, complejidad del espacio de binding, tiempo de ejecución, número de jobs y concurrencia, y excluye unidades de
capacidad o créditos. Nada de lo implementado reserva, cobra, descuenta, pondera ni mantiene un saldo; un rechazo no deja
rastro que revertir. No se ha tocado `bim-toolchain` ni `compose`, y no se ha llamado, escrito ni configurado SPACE ni
SPHERE: todo se verificó con dobles sintéticos. **No se afirma nada end-to-end real.** La tarea J no tocó el frontend; la
tarea L sí (ver [FRONTEND_USAGE_LIMITS.md](FRONTEND_USAGE_LIMITS.md)).

Quién hace qué:

| | SPACE (nativo) | OpenBinding |
|---|---|---|
| Planes, versiones de pricing, contratos | Fuente. | Los lee (`caps`), crea/novate contratos con el cliente oficial. No los edita ni los duplica. |
| Techos por job y por cuenta (`maxInstanceComplexityLog10`, `maxTimeoutSeconds`, `maxIterations`, `maxPayloadBytes`, `apiKeys`, estructura) | Los declara en el plan; llegan en el token. | Los **aplica** en los puntos de la matriz. |
| Contadores acumulados por periodo (`taskStarts`, `solverSeconds`, `studyRuns`, `federatedTaskStarts`) | Candidato a fuente nativa (clase B). **Sin verificar.** | No los implementa hoy. Ver «Plan de integración». |
| Medidas locales (espacio de binding de una instancia, jobs simultáneos, tiempo de reloj) | — | Las mide y las compara. Son facts del trabajo, no consumo. |
| Salvaguardas técnicas (`MAX_BINDING_SPACE_LOG10`, `MAX_CONCURRENT_JOBS_PER_USER`, timeouts) | — | Propias; ningún plan las supera. |

## Tarea L: concurrencia del plan, salvaguardas locales y puerto de contadores

Pendiente decidible localmente que dejó J. Sin ledger, sin saldo y sin contabilidad paralela: todo es un tope sobre algo que
se cuenta en el momento (filas) o una pregunta de solo lectura.

1. **Concurrencia del plan** (`domain/entitlements.py` `concurrency_limit`, `jobs/limits.py` `enforce_concurrency_limit`).
   El límite efectivo de jobs simultáneos es el **menor** de `MAX_CONCURRENT_JOBS_PER_USER` y el `concurrentJobs` que declare
   el plan.
   - Plan **sin** `concurrentJobs`, con `null` (ilimitado), `NaN`, negativo, no numérico o booleano: manda solo el tope técnico.
     Desconocido no es «sin límite» ni «huecos libres».
   - `0` declarado es un límite de cero (nada puede correr), no desconocido. Una fracción se redondea hacia abajo.
   - Con plan y tope iguales, `source` es `technical`: el tope técnico se alcanza sea cual sea el plan.
   - Es un límite **simultáneo**, no un saldo: cuenta filas `queued`+`running`; al terminar un job se libera sin más.
   - Error estable `429 concurrency_limit_exceeded` con `Retry-After: 15` y
     `concurrency: {limit_id, limit, used, active, unit, source}` donde `source` es `plan` o `technical`.
   - Se aplica en `POST /v1/jobs`, retry y celdas de estudio (todas pasan por `enforce_concurrency_limit`, dentro de la
     transacción que inserta el job y tras descartar el replay idempotente).
   - **Tests viejos que fijaban el diseño anterior** (el plan no cuenta). Justificación explícita:
     - `tests/test_concurrency_limit.py::test_the_limit_does_not_depend_on_the_plan` pasó a
       `test_a_bigger_plan_does_not_raise_the_technical_cap`. Su afirmación («el límite no depende del plan») deja de ser
       cierta; lo que sigue siendo cierto, y ahora se afirma, es que un plan mayor no supera el tope técnico y que `source` es
       `technical`.
     - Cinco tests de **carrera de inserción** (`test_idempotency_jobs.py::test_losing_the_job_insert_race_returns_a_replay`,
       `test_job_submission_service.py::test_losing_the_insert_race_to_a_committed_winner_replays_it` y
       `::test_the_study_cell_race_returns_the_job_that_won_the_cell`,
       `test_launch_atomicity.py::test_a_second_launch_of_the_same_cell_returns_the_first_job` y
       `::test_a_retry_launch_after_detaching_the_old_job_creates_a_new_one`) creaban un segundo job con el plan por defecto de
       la fixture (`BASIC`, `concurrentJobs: 1`). Antes llegaban al `INSERT` porque el plan se ignoraba; ahora el segundo job
       recibe el `429` del plan antes de llegar a la carrera que esos tests quieren probar. No se tocó la fixture compartida
       (`pricing_test.yml`); cada test asigna a la cuenta un plan con holgura (`_pricing.roomy_plan()`, el de más
       `concurrentJobs`). Lo que prueban no cambia.
     - Ningún otro test cambió; el cuerpo del `429` ya incluía `source` desde J y los tests con `source: "technical"` siguen
       siendo ciertos (plan y tope iguales).
   - **Prueba PostgreSQL** (la exclusión real con `FOR UPDATE`): `tests/concurrency/test_plan_concurrency_pg.py`
     (3 tests, marcados para el harness `TEST_DATABASE_URL` como los demás `*_pg.py`). **No se ejecutó**: en el worker no hay
     PostgreSQL y las 3 se omiten (ver «Verificación»).
2. **`federatedEngines` numérico** (`services/engine_registry.py` `change_registration`, `routes/v1.py` `_change_registration`).
   El entitlement ya lo trae. Se aplica al **activar** un registro: si el dueño ya tiene tantos registros activos como el
   límite, `402 quota_exceeded` con `quota: {limit_id: "federatedEngines", state, unit: "engine", source: "plan", limit,
   used}`, antes de verificar el despliegue. Cuenta filas activas ahora (como `apiKeys`): desactivar libera sitio, no hay
   acumulado. Ausente = 0 (la convención de las cuotas de plan: desconocido nunca es cupo); ilimitado = sin tope. Activar uno
   ya activo no es un segundo sitio. Bajo `FOR UPDATE` de la fila del dueño; la carrera real tampoco se ejecutó aquí.
3. **Tope técnico de celdas por run**: setting `MAX_CELLS_PER_STUDY_RUN` (entero ≥ 1, **apagado por defecto**). Un run que se
   expande a más celdas se rechaza entero, antes de crear nada, con `422 study_run_too_large` y
   `quota: {limit_id: "maxCellsPerRun", unit: "cell", source: "technical", limit, used}`. Ningún plan lo sube. (Ya existía
   un máximo estructural de 10 000 celdas, `study_matrix_too_large`.)
4. **Puerto de contadores de clase B** (`domain/usage_counters.py`): protocolo `UsageCounterSource` de **solo lectura**
   (`reading(user_id, counter) -> UsageReading`) para `taskStarts`, `federatedTaskStarts`, `solverSeconds` y `studyRuns`. **No
   hay ledger, ni tabla, ni evento, ni saldo.** Mientras no se instale una fuente (`set_usage_source`), no se pregunta nada y
   los contadores **no se aplican**: que un plan los declare no los hace efectivos. Comportamiento definido:
   - `available` (con hueco o sin límite) → sigue. Los números mandan sobre la etiqueta: `used >= limit` es agotado.
   - `exhausted` → `402 usage_limit_exceeded`, `quota: {limit_id, state: "exhausted", unit, source: "space", limit?, used?}`.
   - `unknown` (fuente caída, respuesta mal formada, `NaN`, negativo, otro contador, excepción) →
     `503 usage_limit_unknown` con `Retry-After: 15`; reintentable en celdas de estudio. **Desconocido nunca es cupo.**
   - Dónde se pregunta: antes de crear un job (`taskStarts`/`federatedTaskStarts` y `solverSeconds`; `POST /v1/jobs`, celdas
     de estudio y retry) y antes de crear un run de estudio (`studyRuns`). La pregunta se hace **antes** de bloquear la
     cuenta y se aplica **después** del replay carrera, de la feature y de la concurrencia.
   - **Reintentos y deduplicación**: el gateway nunca cuenta, así que no puede contar dos veces. Un replay idempotente
     (`Idempotency-Key`, que incluye el relanzamiento de una celda, cuya clave es `study-cell:<id>`) y el replay de un retry
     se resuelven **antes** de la pregunta: la fuente ni se consulta (test con la fuente sintética: tras el primer job, con
     el contador «gastado», el replay devuelve el job y `asked` no crece; una clave nueva sí recibe el `402`). Las carreras
     que solo se detectan en el `INSERT` (índice único de la celda, clave idéntica simultánea) sí hacen la pregunta, pero
     devuelven el job ganador y no registran nada: lo que cuenta es el evento que SPACE observe, no esta pregunta.
   - Fake sintético: `tests/test_usage_counters.py::SyntheticSpaceUsage`. Nada de eso es SPACE.
5. **`null` de SPACE** (`space_client/space.py`, setting `SPACE_NULL_LIMIT_IS_UNKNOWN`):
   - **Comportamiento actual, fijado en test** (`tests/test_space_null_limits.py`): `null` = **ilimitado** (`inf`).
   - Estrategia explícita, **apagada por defecto**: con `SPACE_NULL_LIMIT_IS_UNKNOWN=true`, `null` se trata como límite no
     declarado (se omite, igual que una clave ausente): el tamaño cae al tope técnico o rechaza (`403`), la concurrencia al
     tope técnico y las cuotas numéricas fallan cerradas en 0. Coste: un plan realmente ilimitado (`null` legítimo) pasa a
     fallar cerrado en las cuotas numéricas; por eso no es el valor por defecto. **No cambia el contrato remoto**, solo cómo
     se lee el token.
6. **Frontend**: ver [FRONTEND_USAGE_LIMITS.md](FRONTEND_USAGE_LIMITS.md).
7. **OpenAPI**: `QuotaBody` modela `state` y `source` (opcionales; el resto del contrato no cambia). `docs/openapi.json`
   regenerado; `binding_space` y los cuerpos `429` siguen sin modelar (los problemas de las rutas BIM no declaran miembros
   extra). No hay cliente ni tipos del frontend generados desde el OpenAPI (los tipos son manuales).

## Qué se implementó en la tarea J

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

Qué **no** se hizo en J, y qué pasó después:

- `concurrentJobs` **del plan** no se aplicaba (decisión pendiente). **Resuelto en L** (arriba, con la regla propuesta:
  `min(plan, tope técnico)`, plan sin dato → solo el tope técnico).
- El límite numérico `federatedEngines` y un tope de celdas por run no se aplicaban. **Resuelto en L** como salvaguardas
  locales (arriba); el tope de celdas es un setting apagado por defecto.
- No se cuentan arranques, segundos ni runs por periodo (clase B). Eso es contabilidad y **sigue sin hacerse**; L solo deja el
  puerto de lectura (arriba).
- No se amplía `GET /v1/users/me/usage` con el techo efectivo: cambiaría el contrato (`docs/openapi.json`). **Sigue sin
  hacerse** en L: añadir el techo efectivo (y su origen) a ese endpoint es una decisión de contrato aparte.

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
   (`tests/concurrency/*_pg.py`) se omiten sin `TEST_DATABASE_URL`: 40 omitidas en J; **43 en L** (las 3 nuevas de
   `test_plan_concurrency_pg.py`). La activación de registros de motor bajo `FOR UPDATE` (`federatedEngines`) tampoco tiene
   prueba PostgreSQL.
10. **Toolchain con >4300 dígitos**: `bim-toolchain` también convierte la cardinalidad a texto (`operations.py:118`); en
    modo `inproc` podría fallar dentro del toolchain antes de que el gateway la vea. No se tocó (fuera de alcance).

### Lo que queda por verificar contra un SPACE real tras la tarea L (nada end-to-end)

Todo lo de L se probó con dobles sintéticos (`PlanCaps` a mano, la fake de la fixture, `SyntheticSpaceUsage`). Falta:

11. **`concurrentJobs` real**: que el token traiga `concurrentJobs` con ese nombre y significado (jobs `queued`+`running`
    simultáneos por cuenta, no por organización ni por periodo), y qué entrega SPACE cuando un plan no lo declara. Si SPACE
    **también** deniega `solve` por concurrencia (punto 6), el mismo límite se aplicaría dos veces (SPACE en el navegador, el
    gateway en el servidor) y el mensaje al usuario podría diferir.
12. **`federatedEngines` real**: qué cuenta SPACE (registros activos, revisiones distintas, motores distintos). El gateway
    cuenta registros **activos del dueño**; si SPACE entiende otra cosa, el número del plan no significa lo mismo.
13. **Los cuatro contadores de clase B**: nombre exacto (`taskStarts`, `federatedTaskStarts`, `solverSeconds`, `studyRuns`),
    unidad, periodo y reinicio, **qué evento cuenta** (p. ej. «arranque de tarea» = job que pasa a `running`, no un reintento
    ni una celda relanzada), quién lo observa, y si el cliente 1.x ofrece una **lectura** de uso con esa semántica. No existe
    hoy ninguna implementación de `UsageCounterSource` contra SPACE; si el cliente no ofrece la lectura, no se improvisa un
    contador local (ver «Plan de integración»).
14. **Latencia y fallo de la lectura de uso**: la pregunta se hace en la ruta caliente de creación de un job; el
    `Retry-After: 15`, el comportamiento reintentable de las celdas de estudio y el tiempo máximo de espera
    (`SPACE_TIMEOUT_MS`) se fijaron sin ver un SPACE real.
15. **`null`**: si SPACE manda `null` para «no declarado» además de para «ilimitado». Hasta confirmarlo, `null` = ilimitado
    (por defecto) y `SPACE_NULL_LIMIT_IS_UNKNOWN` sigue apagado. Si se enciende hay que comprobar el efecto en los planes
    realmente ilimitados (las cuotas numéricas fallan cerradas).
16. **Textos de `quota`** (`state`, `source`) con las respuestas reales: son los que emite el gateway; SPACE no los define.

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
5. **`concurrentJobs` del plan**: ya aplicado en L (`min(plan, tope técnico)`); contra el SPACE de desarrollo, comprobar el
   punto 11 de arriba.
6. **Pruebas contra el SPACE de desarrollo**, con cuentas sintéticas, en este orden: lectura de `caps` de un plan de
   cada tipo → rechazo por complejidad → rechazo por «no declarado» → replay idempotente → estudio. Nada en producción.
7. **Ejecutar `tests/concurrency` con PostgreSQL** (`docs/qa/PG_HARNESS.md`) para ver la concurrencia real, que aquí se
   omite.

No se debe, en ningún paso: crear versiones de pricing desde OpenBinding, escribir contratos con cantidades distintas a las
del plan, ni guardar un saldo local.

## Cambios de frontend

J los dejó listados; **L los implementó** salvo el punto 5. El detalle (qué código muestra qué, archivos, tests) está en
[FRONTEND_USAGE_LIMITS.md](FRONTEND_USAGE_LIMITS.md). Pendiente: la vista de uso de la cuenta
(`frontend/src/pages/Account/AccountUsage.tsx`) sigue mostrando solo `plan`, `features` y `capabilities`; enseñar el techo
efectivo de tamaño y su origen exige ampliar `GET /v1/users/me/usage` (cambio de contrato y de `docs/openapi.json`; no
hecho).

## Riesgos conocidos

- **Estimación, no medida real**: un techo sobre `bindingSpaceCardinality` puede rechazar una instancia fácil con muchas
  combinaciones y aceptar una difícil con pocas. Es un techo de admisión, no una medida de coste.
- **Cambio de comportamiento en un plan sin dato**: antes, un plan sin `maxInstanceComplexityLog10` daba `402` (el límite
  se leía como 0); ahora da `403 binding_space_limit_unknown` (o se acota por `MAX_BINDING_SPACE_LOG10` si está puesto). El
  frontend lo muestra desde L como «tu plan no indica el límite» (no como error de permisos de clave).
- **Cambio de comportamiento por plan (L)**: el `concurrentJobs` de **cada plan** ahora se aplica. Con la fixture, el plan por
  defecto permite **1** job simultáneo; un despliegue cuyo plan declare menos que `MAX_CONCURRENT_JOBS_PER_USER` verá el `429`
  antes que antes. Un plan que declare `0` bloquea todo lanzamiento (con `429` reintentable, aunque reintentar no sirva).
- **`federatedEngines` (L)**: una cuenta con más registros activos que el límite del plan no puede activar otro; los ya
  activos siguen activos (no se desactiva nada). Un plan que no declara el límite lo deja en 0 (cierra la activación).
- **Contadores de clase B (L)**: mientras no haya fuente instalada **no se aplican** aunque el plan los declare. Es deliberado
  y es el estado de hoy, no un olvido.
- **Cambio de comportamiento del timeout**: un plan sin `maxTimeoutSeconds` ahora es `503 pricing_misconfigured` en vez de
  un job con timeout de 0 s.
- **Retry de jobs antiguos** sin tamaño guardado no se vuelve a medir (matriz §3.4).
- **OpenAPI**: en L `QuotaBody` modela `quota.state` y `quota.source` (opcionales). `binding_space` y el cuerpo `429` siguen
  sin modelar. `docs/openapi.json` se actualizó a mano con el orden del volcado y `tools/dump_openapi.py --check` (check 0)
  confirma que no hay deriva.
- **Concurrencia**: ver arriba (PostgreSQL no disponible aquí).

## Verificación

Ejecutada con `qa_run` en esta rama; los resultados reales están en el informe de la tarea. Los tests de J están en
`openbinding-gateway/tests/test_usage_limits.py` (límite agotado, desconocido, ilimitado, igualdad exacta con el techo,
más de 4300 dígitos, reintento idempotente sin segundo slot, rechazo sin efecto lateral en job/estudio/retry/validación,
concurrencia como ranura que se libera, respuesta serializable). Los tests existentes que fijaban la forma antigua del
cuerpo `429` se actualizaron para el cuerpo ampliado (`tests/test_entitlements.py`, `test_admin_errors.py`,
`test_job_submission_service.py`, `test_concurrency_limit.py`).

Tests de L:

| Qué | Dónde |
|---|---|
| Concurrencia del plan: menor gana, desconocido → tope técnico, `0`, fracción, replay, retry, celda, ranura que se libera | `tests/test_plan_concurrency.py` |
| Carrera real por la última ranura del plan (**PostgreSQL, no ejecutada aquí**) | `tests/concurrency/test_plan_concurrency_pg.py` |
| Puerto de contadores: agotado, desconocido, respuestas sin sentido, replay/retry no cuentan dos veces, run de estudio, tope de celdas | `tests/test_usage_counters.py` |
| `null` = ilimitado (hoy) y `SPACE_NULL_LIMIT_IS_UNKNOWN` | `tests/test_space_null_limits.py` |
| `federatedEngines` al activar (servicio y ruta) | `tests/test_federated_engines_limit.py` |
| Frontend | `frontend/src/api/client.test.ts`, `utils/limitRefusals.test.ts`, `pages/Jobs/jobErrors.test.ts`, `pages/Studies/studyErrors.test.ts`, `pages/Workbench/Workbench.test.tsx` |

Para ejecutar la prueba PostgreSQL con el harness (fuera del worker): `docs/qa/PG_HARNESS.md`, con `TEST_DATABASE_URL`
apuntando a una base `test*`, y `pytest tests/concurrency/test_plan_concurrency_pg.py`.
