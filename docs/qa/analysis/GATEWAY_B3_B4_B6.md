# Gateway: reevaluación de B3, B4 y B6 en la cabeza `cd0e05f`

Análisis, sin cambios de producción. Los hallazgos vienen de
[`../SECURITY_REVIEW.md`](../SECURITY_REVIEW.md) (informe histórico sobre `5aebc7c8`).
Nada de lo que dice ese informe se ha dado por bueno: cada afirmación de abajo
sale de leer el código de esta cabeza o de un test sintético que se ejecutó.
Las referencias `fichero:línea` son de `cd0e05f`; las rutas son relativas a
`openbinding-gateway/src/openbinding_gateway/` salvo que se diga otra cosa.

## 1. Resumen

| Hallazgo | Estado actual | Qué está cerrado | Qué sigue abierto |
|---|---|---|---|
| **B3** lease perdido | **Parcialmente cerrado** | El fencing: un resultado tardío de un intento superado no puede escribir sobre el nuevo (test normal). Existe `DELETE` remoto best-effort en tres caminos (fallo del motor, resultado tardío descartado, cancelación vista tras el solve) | Ningún camino cancela el intento perdido cuando lo recupera el reconciliador; un worker muerto deja el trabajo corriendo en el motor; el id remoto del intento perdido se pierde cuando el siguiente intento escribe el suyo; el worker lento sigue esperando hasta `engine_solve_timeout_s`; el `DELETE` se envía a cualquier motor, declare o no la capacidad |
| **B4** reevaluación BIM | **Abierto** (con una parte cerrada) | Lo no evaluado nunca se guarda como válido: el job queda `FAILED`, `termination=UNKNOWN`, `solutions=[]` | El resultado bruto del motor solo existe en una variable local y se pierde; el fallo no tiene código de diagnóstico propio; no hay forma autorizada de reintentar solo la evaluación (`retry` vuelve a ejecutar el motor) |
| **B6** errores | **Parcialmente cerrado** | VIEWER ve una frase fija en lugar de `result.error` (B1); un 500 no gestionado devuelve el cuerpo fijo de Starlette; los `BimError` de rutas salen por `problem_for` con frases estables | `result.error` del dueño es `str(exc)` crudo (host del motor, texto de excepciones, texto del motor); 503 de pricing repiten el motivo de SPACE/SPHERE (uno a anónimos); el gateway no tiene `correlationId` (solo `bim-service` lo tiene) |

Los tests de análisis: 4 pasan (lo cerrado) y 13 son `xfail(strict=True)` (lo
abierto). Ver §6.

## 2. B3 — el intento que pierde el lease sigue ejecutándose

### 2.1 Qué hace el código hoy

**Dónde se registra el id remoto.** `Job.engine_job_id` (`String(128)`, `db/models.py:204`) y
`Job.service_url` (`db/models.py:205`). Al crear el job `engine_job_id` es el id del
propio job del gateway (`services/job_submission.py:691`, `routes/jobs.py:134,145`);
`service_url` es el endpoint de la registración (`job_submission.py:692`). Cuando
el motor acepta (202 + recibo), `solve_remote` llama a `on_remote_id`
(`v1/remote.py:362-364`) y `record_engine_job_id` sobrescribe `engine_job_id` y hace
commit (`services/execution.py:76-103`, el `UPDATE` en 91-96). Es **una sola columna**: no hay
un registro por intento. Una respuesta síncrona (200) no tiene id remoto.
Un id de más de 128 caracteres no se guarda (`execution.py:84-86`).

**Cancelación remota hoy.** `cancel_engine_job` (`execution.py:106-113`) → `cancel_remote`
(`v1/remote.py:399-445`): `DELETE` sobre el recurso `job` de la registración, timeout 3 s,
nunca lanza, devuelve `bool` (200/202/204). Se llama en tres sitios, siempre con el
id **local** del worker (`engine["job_id"]`, `execution.py:291-295`), no con el de la fila:

| Camino | Línea | Se cancela |
|---|---|---|
| `RemoteEngineError` tras aceptar (error, timeout, JSON inválido) | `execution.py:309-313` | sí, antes de fallar el job |
| Resultado llegado tras perder el lease (`hold_lease` falla) | `execution.py:316-322` | sí, pero solo cuando el solve **termina** |
| `cancellation_requested` visto tras el solve | `execution.py:324-334` | sí, tras el commit |

**El barrido de leases no cancela nada.** `sweep_abandoned` (`jobs/reconciler.py:198-267`)
decide con `lease_until` (246-252): `_requeue` (83-100) o `_fail_abandoned` (103-124),
ambos `UPDATE` condicionados, sin red y sin tocar `engine_job_id`. Nadie en el
reconciliador llama a `cancel_remote` (`grep` de `cancel_remote|cancel_engine_job` en `src/`:
solo `execution.py`).

**Consecuencias de leer ambos lados juntos:**

1. *Worker muerto* (proceso caído): su `engine_job_id` queda en la fila, nadie lo cancela. El
   trabajo corre en el motor hasta que termine solo.
2. *Worker vivo pero lento* (pausa larga, latidos perdidos): `leases.beat` termina cuando
   `renew_lease` dice que ya no es el dueño (`jobs/leases.py:119-130`, `return` en 125) pero
   **nada interrumpe** `solve_remote`. Espera hasta que el motor responda o hasta el timeout
   (`request["timeout"]` o `engine_solve_timeout_s`, **1800 s** por defecto, `core/settings.py:93`).
   Durante todo ese tiempo corren dos solves en paralelo (esto ya lo declara G2 en
   [`../IDEMPOTENCY.md`](../IDEMPOTENCY.md)). Solo cuando vuelve se cancela su id remoto.
3. *El id del intento perdido se olvida*: el siguiente intento ejecuta `record_engine_job_id`
   con su propio id (`execution.py:91-96`), que sobrescribe el anterior. Si el segundo
   intento también se pierde y el job falla (`_fail_abandoned`), en la fila solo queda el id
   del segundo.
4. *Sin comprobación de capacidad*: `cancel_engine_job` no consulta nada de la registración. Se
   envía `DELETE` a cualquier motor. `verify_registration` solo valida el `GET` del job
   asíncrono (`services/engine_registry.py:378-397`); el `DELETE` no está descrito ni
   verificado en ninguna parte. El protocolo `bim-engine/v1` no define cancelación
   (`v1/remote.py:408`), y el único motor en el árbol (`engines/minizinc-csp/src/index.ts`) solo
   tiene `GET /health`, `POST /internal/v1/binding-problems` y `GET /internal/v1/jobs/:id`:
   para él, el `DELETE` es un 404.

### 2.2 Fencing que existe

* **Token de lease** (`jobs/leases.py:50-73`): `claim_job` escribe un `uuid4` nuevo en cada
  claim, y `attempt = attempt + 1` (66). `_requeue` pone `lease_token=None` (87-92), de modo
  que el token del intento anterior no vuelve a coincidir con nada.
* **Comparación en cada escritura**: `hold_lease` (`leases.py:80-101`) es un
  `UPDATE ... WHERE state='running' AND lease_token=:token` que además bloquea la fila y
  adelanta el plazo. Lo llaman `record_engine_job_id` (88), `fail_persisted_job` (43),
  el camino de resultado (316), el de cancelación (misma transacción) y el fallo de
  `run_persisted_job` (383). Un worker sin token no escribe nada y hace `rollback`.
* **El reconciliador no actúa sobre un job con escritura en curso**: sus `UPDATE` exigen
  `lease_token == leído AND lease_until < now()` (`reconciler.py:68-80`) y `hold_lease` adelanta
  `lease_until`. En PostgreSQL esto lo cubren los tests de lab de
  `tests/concurrency/test_job_leases_pg.py` (no se ejecutaron aquí).
* El `attempt` no se compara en la escritura: el token ya es único por claim. El contador sirve para
  `MAX_ATTEMPTS = 2` (`leases.py:37`) y como cabecera `X-Openbinding-Attempt`
  (`v1/remote.py:285,327-328`), que es una pista, no un fence en el motor.

**¿Puede un resultado tardío del intento viejo pisar al nuevo? No en el gateway** — test
`test_the_late_result_of_a_superseded_attempt_cannot_overwrite_the_new_attempt` (normal, pasa):
tras requeue y nuevo claim, el resultado del intento 1 no escribe, el job sigue `RUNNING` con el
token del intento 2, `attempt == 2`, sin `result`. **En el motor sí puede haber doble ejecución**
(at-least-once, G4): eso es lo que B3 pide mitigar.

### 2.3 Riesgos

**Reales (reproducidos o deducibles sin ambigüedad del código):**

* R-B3-1. Un worker muerto deja su trabajo corriendo en el motor sin cancelar. Test
  `test_requeueing_a_lost_attempt_cancels_its_remote_job` (xfail estricto).
* R-B3-2. Tras dos pérdidas, el id del primer intento no se puede cancelar porque no consta.
  Test `test_failing_an_abandoned_job_cancels_every_lost_attempt` (xfail estricto).
* R-B3-3. Un worker lento espera hasta 1800 s a un motor cuyo resultado ya no se usará. Test
  `test_a_worker_whose_lease_was_lost_stops_waiting_for_the_engine` (xfail estricto; el test
  fuerza que `renew_lease` diga «perdido»).
* R-B3-4. `DELETE` a motores que no declaran la capacidad (tráfico inútil, y a un motor
  cualquiera, una operación que no prometió). Test
  `test_cancellation_is_not_sent_to_an_engine_that_does_not_declare_it` (xfail estricto).

**Hipotéticos (dependen de un motor o de un entorno no vistos):**

* H-B3-1. *Cancelar la ejecución vigente.* Si un motor usa `X-Openbinding-Job-Id` para deduplicar
  (las cabeceras están documentadas como pista para eso), el intento 2 podría recibir el **mismo**
  id remoto que el 1. Entonces el `DELETE` tardío del worker 1 (`execution.py:321`, que hoy
  cancela sin mirar la fila) mataría al intento vigente. El motor del árbol ignora las cabeceras
  (no aparecen en `engines/minizinc-csp/src/index.ts`); no hay motor real que lo demuestre.
  El diseño de §2.4 lo evita igualmente porque es barato.
* H-B3-2. Un motor que acepta `DELETE` pero lo trata como «borrar el resultado» en lugar de «parar».
  No se ha visto ninguno.
* H-B3-3. El gateway cae entre el 202 del motor y el commit del id (`IDEMPOTENCY.md`, fila «Gateway
  crashes after the Engine accepted»): el id nunca consta y no hay nada que cancelar. No se puede
  cerrar con este diseño; se queda en las pistas de idempotencia.

### 2.4 Diseño: cancelación remota best-effort del intento perdido

Principios: solo si el motor lo declara; el fencing por token no cambia; un resultado tardío se
sigue descartando; nunca se cancela un id que haya registrado un intento más nuevo; no se promete
exactly-once (la cancelación es una mitigación de coste, no una garantía).

**D-1. Capacidad declarada.** `bim-engine/v1` no tiene operación de cancelación y su digest está
fijado, así que no se toca el protocolo. La registración ya tiene un hueco abierto:
`spec.extensions` (`schemas/bim/v1/engine-registration.schema.json:60`,
`additionalProperties: true`), mientras que `spec.mappings` está cerrado (`:33`,
`additionalProperties: false`) y por tanto no admite una clave nueva sin tocar el esquema (existe en
dos copias: `schemas/` y `bim-toolchain/packages/bim-core/.../resources/schemas/`).

* Declaración: `spec.extensions["cancellation"] = {"operation": "delete-job"}`.
* Verificación en `verify_registration`: un check nuevo `cancellation` que exige que el OpenAPI
  fijado de la registración (el de `openapi_digest`) describa `delete` en `mappings.job` con una
  respuesta 2xx y la misma auth (patrón de `engine_registry.py:381-389`). Sin declaración no hay check.
* En ejecución: `declares_cancellation(registration)` es verdadero solo si hay declaración **y** el
  check pasó en `verification_report`. Las registraciones built-in (`BUILTIN_ENGINE_MAPPINGS`,
  `services/engines.py:57-62`) no declaran: no se cancela.
* **Decisión D1 (humano):** puerta única (todos los caminos de §2.1 pasan a exigir la declaración,
  cambia el comportamiento actual y los tests `tests/test_job_leases.py:782-841`) o solo el camino
  nuevo. La recomendación es la puerta única: es lo que expresa el test xfail de R-B3-4 y evita
  mandar `DELETE` a ciegas. Cambiaría el texto de `IDEMPOTENCY.md:197-201`.
* **Decisión D2 (humano):** si la capacidad debe vivir en el *manifiesto del motor* (el
  `EngineManifest` de `bim-toolchain`, vocabulario de capacidades por perfil) en vez de en la
  registración. Eso es un cambio del toolchain (versión MAJOR del contrato, digests). Aquí se propone la
  registración porque no exige tocar `bim-toolchain` y el OpenAPI fijado ya es la fuente que el gateway
  verifica hoy.

**D-2. Registro por intento.** Tabla nueva `job_remote_attempts`: `id`, `job_id` (FK, `ON DELETE
CASCADE`), `attempt` (int), `engine_job_id` (`String(128)`), `state`
(`running|cancel_pending|cancelled|cancel_unsupported|cancel_failed|finished`), `cancel_attempts`
(int), `next_cancel_at`, `created_at`; `UNIQUE(job_id, attempt)`. `record_engine_job_id` hace el
upsert de `(job_id, attempt)` en la misma transacción y bajo el mismo `hold_lease`, y sigue
actualizando `jobs.engine_job_id` (compatibilidad). El `attempt` ya está disponible
(`execution.py:289`).

**D-3. El barrido solo marca; no hace red.** En `_requeue` y `_fail_abandoned`, después de que el
`UPDATE` condicionado haya ganado (así el intento perdido es exactamente `job.attempt` leído, porque
el token no cambió), un `UPDATE job_remote_attempts SET state='cancel_pending' WHERE job_id=:id AND
attempt<=:lost AND state='running'` en la misma transacción (outbox transaccional). El barrido no
puede esperar a un motor con filas bloqueadas.

**D-4. Paso de cancelación separado.** `cancel_lost_attempts(session)` se ejecuta en
`_reconcile_cycle` después del commit (como `redeliver_queued_jobs`, `reconciler.py:286-288`):

1. Reclama un lote acotado con `UPDATE ... cancel_attempts=cancel_attempts+1, next_cancel_at=now()+backoff`
   (mismo patrón que `jobs/publisher.py`), `commit`, y solo entonces sale a la red.
2. Resuelve el transporte de la registración del job (la lógica de `execution.py:196-285`, extraída a una
   función reutilizable, incluido el descifrado de la credencial). Si la registración ya no está activa o
   no declara la capacidad: `cancel_unsupported`, sin red.
3. **Guarda**: si existe otra fila de `job_remote_attempts` del mismo job con `attempt` mayor y el mismo
   `engine_job_id`, **no se cancela** (H-B3-1) y se marca `cancel_unsupported` con motivo `shared_id`.
4. `cancel_remote` pasa a devolver el código HTTP (o `None`): 2xx → `cancelled`; 404/405/501 →
   `cancel_unsupported` (no se reintenta); error de red/5xx → reintento con backoff hasta 3 → `cancel_failed`.
   Todo con logging interno; nada de ello llega a respuestas.

**D-5. El worker lento deja de esperar.** `start_heartbeat` recibe un `on_lost` opcional; cuando
`renew_lease` devuelve `False` (solo ocurre si el token ya no coincide, `leases.py:104-116`; una excepción
no cuenta como pérdida) se cancela la tarea de `solve_remote`. `run_claimed_job` ejecuta el solve como
`asyncio.Task` y, si gana la señal de pérdida: `rollback`, cancelación remota del **propio** id con la guarda
de D-4.3 (leyendo la fila, no la variable local) y vuelve sin escribir. Los caminos de §2.1 pasan por la
misma función guardada.

**D-6. Fencing y resultados tardíos: sin cambios.** El token sigue siendo el fence, `hold_lease` sigue
precediendo a cada escritura y un resultado tardío se descarta. No se almacena nada de un intento
superado. Opcional: añadir `AND attempt = :attempt` a `hold_lease` como segunda barrera (no necesario).

**Qué no promete.** Un motor que ignora `DELETE` o ya terminó seguirá habiendo gastado cómputo. Dos
solves pueden solaparse hasta que llega la señal. La cancelación solo reduce el coste. Se mantiene la
frase de `IDEMPOTENCY.md`: end to end *not exactly once*.

## 3. B4 — falla la reevaluación canónica por BIM

### 3.1 Qué hace el código hoy

* `run_claimed_job` obtiene `remote_result` de `solve_remote` (`execution.py:297-308`; ya validado en
  forma por `validate_engine_result`, `services/engines.py:375-383`), pasa `hold_lease` (316) y el
  chequeo de cancelación, y llama a `bim.abim().reevaluate(...)` (335-340). **`remote_result` es una
  variable local**: no se escribe en ninguna parte antes de la reevaluación.
* Si `reevaluate` lanza (`BimServiceError`: servicio caído, timeout, 429/503; `ContractError`; un bug),
  cae al `except Exception` general (355-357) → `fail_persisted_job(job, session, f"Execution failed: {exc}")`
  (37-66) → `Job.state = FAILED`, `termination = UNKNOWN`, `result = {termination, solutions: [], error, provenance}`
  (52-58). El resultado bruto no consta en ningún sitio. Se pierde el trabajo del motor (hasta 1800 s de solve).
* `reevaluate_result` de `bim-core` **no lanza ante un resultado del motor inválido** (lo marca
  `UNKNOWN`: `bim-toolchain/packages/bim-core/src/bim_core/reevaluate.py:78-84`). Por eso una excepción
  aquí es un fallo de infraestructura o de contrato, no un veredicto sobre el motor.
* También hay un defecto de bloqueo relacionado: la fila queda bloqueada desde `hold_lease` (316) y la
  llamada a BIM (hasta `bim_service_timeout_s`, 30 s por defecto, `core/settings.py:120`) se hace con esa
  transacción abierta. En PostgreSQL, `POST /v1/jobs/{id}/cancel` (`routes/jobs.py:87`, `FOR UPDATE`) espera a
  que termine. No reproducible con SQLite (sin bloqueos de fila); es una lectura del código.

### 3.2 Qué se persiste hoy, con qué permisos y retención

| Dato | Dónde | Quién lo ve | Retención |
|---|---|---|---|
| `Job.result` del job fallido: `{termination: UNKNOWN, solutions: [], error: "Execution failed: <exc>", provenance}` | `jobs.result` | Dueño: `GET /v1/jobs/{id}` (`routes/v1.py:1190-1194`) y lista (`routes/jobs.py:76`, sin redacción). Miembros de la organización: ruta de organización con `redact` si no son MEMBER (`routes/organizations.py:1410-1417`, `models/platform.py:518-522`). VIEWER: `error` sustituido por `GENERIC_ERROR` (`security/redaction.py:177-210`) | Mientras exista el job (sin caducidad, `IDEMPOTENCY.md` §Scope) |
| `reason` = el mismo texto | `api_error_events.detail` (`telemetry.py:204-225`) | Administración | 90 días, purga del reconciliador (`reconciler.py:293-300`, `telemetry.py:147-151`) |
| El resultado bruto del motor | **En ningún sitio** | — | — |
| `provenance.engineReported` | Solo se escribe en el camino feliz (`execution.py:341-346`) | — | — |

Test normal: `test_an_unevaluated_result_is_never_recorded_as_valid` (pasa). Test xfail estricto, con
búsqueda ciega a esquema de un marcador en todas las tablas:
`test_a_bim_failure_during_reevaluation_keeps_the_engines_raw_result`.

### 3.3 Riesgos

**Reales:** R-B4-1 pérdida del trabajo del motor ante un fallo transitorio de BIM (coste de cómputo y de plazo; el usuario
debe reencolar y pagar otro solve); R-B4-2 el diagnóstico es texto libre sin código estable (test xfail
`test_a_failed_reevaluation_has_an_explicit_diagnostic_code`); R-B4-3 no hay reintento solo de la evaluación (test
xfail `test_there_is_an_authorized_way_to_retry_the_evaluation`); R-B4-4 el solve con BIM bajo bloqueo de fila
(lectura del código).

**Hipotéticos / a medir:** H-B4-1 volumen y coste de almacenar el bruto (tope duro 4 MiB por respuesta, `v1/remote.py:46`; el tamaño
real típico no se ha medido); H-B4-2 un fallo de BIM que dure más que la retención.

### 3.4 Diseño: preservar evidencia, estado explícito y reintento autorizado

**E-1. Tabla `job_engine_evidence`.** `id`, `job_id` (FK `ON DELETE CASCADE`), `attempt`, `raw_result` (JSON, tal
como llegó, ya validado en forma), `raw_digest` (digest canónico, `bim_core.canonical.digest`), `size_bytes`,
`received_at`, `expires_at`, `reevaluation_attempts` (int), `UNIQUE(job_id, attempt)`.

**E-2. Orden.** Tras `hold_lease` y el chequeo de cancelación y **antes** de llamar a BIM: insertar la evidencia y
`commit` (libera el bloqueo de fila; defecto R-B4-4). Se llama a BIM sin transacción abierta. Después, nuevo
`hold_lease`; si el lease se perdió, se descarta (también la evidencia del intento superado, que no se escribe
si `hold_lease` falla antes). Si BIM responde: la escritura de `COMPLETED` **y el borrado de la evidencia** van en la
misma transacción, de modo que solo los fallos conservan el bruto. *Alternativa más barata:* escribir la evidencia
solo en el `except` (el bruto sigue en memoria); no sobrevive a una caída durante la llamada a BIM.
**Decisión D3 (humano):** evidencia previa (recomendada) o solo en el fallo.

**E-3. Estado del job.** `FAILED`, no un estado nuevo (un valor nuevo de `JobState` se propaga a cupos de
concurrencia, informes, estudios y al esquema). `termination=UNKNOWN`, `solutions=[]` (se mantiene el cierre actual).
`result` lleva `code` = `reevaluation_unavailable` (`BimServiceError` con código en el conjunto «no ahora» de
`integrations/bim.py:47-49` o `status` 429/503/504: reintentable) o `reevaluation_failed` (cualquier otro), una frase
fija en `error`, `correlationId` (§4.4) y `evidence = {"id", "digest", "expiresAt"}`. El detalle de la excepción solo va a
logs con el mismo `correlationId`.

**E-4. Permisos de la evidencia.** El bruto puede llevar texto escrito por el motor y `provenance` con direcciones.
Nunca va en `JobView`, en `GET /v1/jobs/{id}`, en el export portable (`routes/artifacts.py:621-634`) ni en
las listas. Se lee solo por `GET /v1/jobs/{id}/evidence`, dueño del job **y** `require_work_role` (MEMBER;
`routes/jobs.py:42-65`, `security/roles.py`); VIEWER → 403 `insufficient_role`; una API key necesita el alcance
`jobs:read` y no ser de solo lectura (`must_redact_jobs` verdadero → 403). Es el mismo nivel que ya tiene el
`provenance` sin redactar.

**E-5. Retención acotada.** Ajuste `ENGINE_EVIDENCE_RETENTION_DAYS` (propuesta 14, máximo 90, `core/settings.py`);
borrado por lotes en `_reconcile_cycle` junto a `purge_old_error_events` (`reconciler.py:293-300`). Caducada la
evidencia, el reintento responde 410 `evidence_expired` y el job sigue `FAILED`. Tope de tamaño igual a
`MAX_REMOTE_RESPONSE`.

**E-6. Reintento autorizado.** `POST /v1/jobs/{id}/reevaluate` (202/200), mismos controles que `retry_job`
(`routes/jobs.py:101-132`): `_owned(..., work_by=user)`, `caps_or_503` y `feature_refusal`. Condiciones: job
`FAILED` con `result.code` en los dos códigos y evidencia vigente, `reevaluation_attempts < 5` (si no, 409
`reevaluation_exhausted`). Se lee la evidencia, se llama a BIM **sin** bloqueo, y en una segunda transacción se bloquea
el job y se hace *compare-and-set* contra la fila de evidencia (si ya la consumió otra petición → 409). El éxito
escribe `COMPLETED` (nuevo `result`, `provenance` con `engineReported`), borra la evidencia, llama a
`lifecycle.sync_study_cell` y deja un `AuditEvent` `job.reevaluated`. Si BIM vuelve a fallar: 503 con
`problem_for` (`integrations/bim.py:377-414`), job y evidencia intactos, contador +1. Es idempotente: la
reevaluación es determinista.

**Riesgo del diseño (no verificado):** `FAILED → COMPLETED` es una transición que hoy no existe. `study_jobs`
asigna `cell.state` desde `job.state` sin condición salvo el caso de run cancelada (`study_jobs.py:521-541`), pero
una *run* que ya cerró `PARTIAL`/`FAILED` o lanzó celdas siguientes podría no recomputarse. Hace falta un test
con fixtures de estudio antes de aceptar el cambio.

## 4. B6 — errores internos en respuestas públicas

### 4.1 Lo que ya existe

* Redacción VIEWER (B1): `redact_result`/`redact_error` (`security/redaction.py:183-210`), aplicada en las rutas de
  organización y en el export. Test normal `test_a_viewers_view_of_a_failed_job_carries_a_fixed_sentence`.
* Los `BimError` de rutas salen por `problem_for` con frases fijas para 502/503 (`integrations/bim.py:398-400`) y
  el manejador global (`main.py:226-234,338`). Los 422 de validación pasan por `problem_response`
  (`models/problem.py:76-91`).
* 500 no gestionado: no hay manejador de `Exception`, pero Starlette devuelve el cuerpo fijo `Internal Server
  Error` y la traza va al log. Test normal `test_an_unhandled_exception_does_not_put_its_text_in_the_public_500`.
* `bim-service` tiene `correlationId` en sus 500 (`bim-toolchain/docs/SERVICE.md:148`,
  `bim_service/middleware.py:101-117`) con detalle solo en el log.
* **Lo que no existe:** un `correlationId` (o equivalente) **en el gateway**. `grep -i correlation` sobre
  `openbinding-gateway/src` no devuelve nada. Test `test_the_public_500_carries_a_correlation_id` (xfail estricto).
  El único id relacionado es el `id` de `ApiErrorEvent` (`telemetry.py:168`), que no llega al cliente.
* Un segundo defecto menor: `redact_error` solo mira `errorCode`/`error_code` (`redaction.py:179`), pero el
  reconciliador escribe `code` (`reconciler.py:137`), así que un VIEWER pierde la categoría de `queue_timeout`.

### 4.2 Puntos donde el texto interno puede llegar a una respuesta

Reales = reproducidos con test (xfail estricto salvo que se indique). Hipotéticos = deducidos del código, no reproducidos.

| # | Origen → destino | Audiencia | Estado |
|---|---|---|---|
| 1 | `v1/remote.py:53,90,92` meten host/IP en el mensaje; `execution.py:277,312` guardan `str(exc)` en `result.error`; `routes/v1.py:1190-1194` y `routes/jobs.py:76` lo devuelven sin redactar | Dueño del job. **Entre inquilinos:** quien ejecuta un motor *publicado* de otro dueño (`execution.py:225-231`) ve el host privado de ese dueño | **Real** (test `..._does_not_name_the_engine_host_in_the_jobs_error`); el cruce entre inquilinos es por lectura |
| 2 | `execution.py:355-357` `Execution failed: {exc}` y `execution.py:395-398` `Internal execution error: {exc}` | Dueño | **Real** (test `..._unexpected_exception_text_...`). Que SQLAlchemy incluye SQL y parámetros en `str(exc)` es comportamiento conocido de la librería; **no reproducido** |
| 3 | `v1/remote.py:263,323,346,378` `{exc}` de httpx; `:203-208` el texto de `error` del propio motor sin límite | Dueño | Mensajes de httpx: **hipotético** (el endpoint va fijado por IP, los textos habituales no llevan URL). Texto del motor sin límite (hasta 4 MiB): **real** (test `..._error_text_an_engine_writes_is_bounded`) |
| 4 | `execution.py:263` `str(SecretsUnavailable)` | Dueño | **Hipotético** (contenido del mensaje no leído) |
| 5 | `telemetry.py:216-221` guarda el mismo texto en `api_error_events` | Administración, 90 días | Por diseño; sanear y acotar |
| 6 | `space_client/space.py:77-78` `PricingUnavailable(f"SPACE is not reachable: {error}")` → `routes/users.py:572-577`, `:785-786`; `routes/admin.py:227,282,342,409-414,470`; `routes/cas.py:166-167,398-399,421-422`; `services/entitlements.py:41-49,64-65` → `services/instances.py:189-190`, `services/job_submission.py:512-513` | Usuario autenticado; admin en las de `admin.py` | **Real** el volcado de `str(error)` a 503 (test `..._pricing_503_does_not_repeat_...`, con un gate falso; no se contactó con SPACE). El texto real de `SpaceError` **no se ha visto** (la librería externa no se ha leído) |
| 7 | `routes/admin.py:403-408` el motivo con que SPACE rechaza una novación, en 422 `invalid_subscription` | Admin | **Hipotético**; es información de validación, pero es texto de SPACE sin acotar |
| 8 | `sphere_client.py:62,70-73` (`SPHERE is unavailable: {exc}`; hasta 300 caracteres del cuerpo de SPHERE) → `pricing_catalog.py:86,93,106` → `routes/pricing.py:42-45` | **Anónimo** (`public_router`, `GET /v1/pricing/current`) | **Real** (test `..._anonymous_pricing_503_...`, con SPHERE sustituido por una excepción) |
| 9 | `analysis_jobs.py:89,140` `error=str(getattr(exc,"detail",exc))[:512]` → `routes/analysis.py:351` | Dueño de la tarea | **Hipotético** (no reproducido) |
| 10 | `routes/v1.py:1251` `str(exc)[:300]` y los 422 con `str(exc)` (`routes/v1.py:169,216,377,417,439,1165`, `services/instances.py`, `routes/artifacts.py`, `services/job_submission.py:398-437`) | Quien envía la entrada | Fuera de «5xx de motor/BIM/SPACE». Mensajes de validación de la propia entrada; riesgo bajo, listados por completitud |
| 11 | `services/engine_registry.py:444` `str(exc)` en el informe de verificación | Quien registra (y quien lea el informe de una registración publicada) | **Hipotético**; no se verificó quién lo lee |
| 12 | Texto de `BimServiceError` por las rutas de ejecución | Dueño | **Hipotético/bajo**: el cliente lo construye con el nombre de la clase, sin URL (`bim_client/http.py:139-141`); el 500 de `bim-service` ya es fijo |

### 4.3 Diseño: errores públicos estables

**P-1. Catálogo de códigos públicos y clasificación.** Módulo nuevo `core/public_errors.py`:
`classify(exc) -> PublicFailure(code, message, retryable)` con una tabla cerrada. Códigos mínimos:
`engine_unreachable`, `engine_timeout`, `engine_rejected`, `engine_protocol_error`, `engine_failed`,
`reevaluation_unavailable`, `reevaluation_failed`, `credential_unavailable`, `pricing_unavailable`,
`internal_error`. Cada código tiene una frase fija (p. ej. «El motor no respondió. Reintenta más tarde.»).
`RemoteEngineError` gana un atributo `code` (por defecto `engine_error`) y los puntos de `v1/remote.py` lo fijan; el
texto con host/IP/`{exc}` se queda solo en el mensaje interno, que va a logs.

**P-2. `correlationId` en el gateway.** El middleware ASGI existente (`ErrorTelemetryMiddleware`,
`telemetry.py:228-300`) genera un UUID por petición (no se confía en uno entrante), lo deja en `scope["state"]`, lo devuelve
en la cabecera `X-Correlation-Id` y los manejadores de `main.py` lo añaden al cuerpo como miembro `correlationId` (junto a
`type,title,status,code,detail`; el cuerpo `{"detail": {"code","error"}}` de `main.py:259-271` se conserva). Un
manejador de `Exception` devuelve `application/problem+json` 500 `internal_error` con ese id. Los logs llevan
`correlation_id=<id>` en el mensaje (como `bim-service`), sin el texto de la excepción en la respuesta. Para trabajos de
fondo (sin petición), `fail_persisted_job` genera su id, lo registra con el `job_id` y lo guarda en `result`.

**P-3. `result.error` de un job fallido.** `{"error": <frase fija>, "code": <código>, "correlationId": <id>}`; el texto crudo
solo a logs (con `core.logging.redact`) y, acotado a 512 caracteres y saneado, a `ApiErrorEvent.detail`. El texto del
motor (`payload["error"]`, `v1/remote.py:208`) se trunca a 1 KiB y nunca se muestra tal cual al usuario. `redact_error` lee
también `code`.

**P-4. Pricing y proveedores.** Todos los puntos 6-8 devuelven una frase fija con `code=pricing_unavailable`
y `correlationId`; `PricingUnavailable`, `SphereError` y `PricingCatalogError` conservan su texto para el log. El 422 de
novación (punto 7) conserva la clasificación `invalid_subscription` con una frase fija. **Decisión D4 (humano):** si las
rutas de administración pueden seguir mostrando el motivo de SPACE a un administrador; la recomendación es no, y que el
administrador lo consulte por `correlationId` en los logs.

**P-5. Sin llamar a SPACE.** El diseño y los tests son offline: los gates y errores de SPACE/SPHERE son dobles locales, y
las pruebas de contrato nuevas deben seguir usándolos.

## 5. Contratos de implementación (listos para delegar)

Orden: **C1 → C2 → C4 → C5**; C3 es independiente de C2 y puede ir en paralelo con C4. Comparten `services/execution.py`,
`db/models.py` y la cadena de migraciones Alembic (C4 y C5 deben ir en serie). Cada contrato debe dar la vuelta a los
`xfail` que cierra: quitar la marca y que pase. Un `xfail` que empiece a pasar sin quitar la marca rompe la suite
(`strict=True`), por diseño.

### C1 — `correlationId` y manejador de 500

* **Dueño de ficheros:** `core/public_errors.py` (nuevo), `telemetry.py`, `main.py` (manejadores 226-274, registro 337-352),
  `models/problem.py` (miembro opcional), `core/logging.py` solo si hace falta un campo; `docs/openapi.json` si el contrato
  lo exige (ver «No verificado»).
* **Tests:** voltear `test_the_public_500_carries_a_correlation_id`; nuevos: id presente en 4xx/5xx de problem+json y en
  `{"detail":{...}}`; cabecera `X-Correlation-Id`; un id entrante no se refleja; el log del mismo id contiene la excepción y la
  respuesta no.
* **Aceptación:** todo 4xx/5xx del gateway lleva `correlationId`; el cuerpo de un 500 es `internal_error` fijo; ningún campo
  de respuesta contiene `str(exc)`; forma anterior de `detail` intacta (tests de contrato existentes).
* **Checks:** el check 1 (`tests/analysis_b3_b4_b6`); suite completa del gateway (mitades `a-m` y `n-z` como en
  `SECURITY_REVIEW.md`); `ruff`; `git diff --check`.

### C2 — Texto de error de jobs y del transporte

* **Dueño de ficheros:** `services/execution.py` (37-66, 263, 277, 312, 355-357, 395-404), `v1/remote.py` (53, 90, 92, 203-208,
  263, 323, 346, 378; `RemoteEngineError.code`), `security/redaction.py` (`redact_error` lee `code`), `core/public_errors.py`.
* **Tests:** voltear `..._does_not_name_the_engine_host_in_the_jobs_error`, `..._unexpected_exception_text_...`,
  `..._error_text_an_engine_writes_is_bounded`; nuevos: tabla de clasificación por tipo de excepción; el log interno conserva
  el motivo; VIEWER ve la categoría de `queue_timeout`; los tests de `tests/test_v1_remote.py` y `tests/test_job_leases.py`
  siguen pasando (comprueban mensajes: revisar cuáles asumen el texto actual).
* **Aceptación:** `result.error` es siempre una frase de catálogo; `result.code` y `result.correlationId` presentes; ninguna
  cadena de la excepción en la respuesta del dueño ni de otro usuario; el texto interno solo en logs/`ApiErrorEvent` acotado.
* **Checks:** igual que C1.

### C3 — Pricing, SPACE y SPHERE

* **Dueño de ficheros:** `routes/users.py` (572-577, 785-786), `routes/admin.py` (227, 282, 342, 403-414, 470), `routes/cas.py`
  (166-167, 398-399, 421-422), `routes/pricing.py` (40-45), `services/entitlements.py` (41-49, 64-65), `space_client/space.py`
  (77-78), `sphere_client.py` (62, 70-73), `pricing_catalog.py` (86, 93, 106); tests existentes que comparen el texto.
* **Tests:** voltear `..._pricing_503_...` y `..._anonymous_pricing_503_...`; los dobles no hacen red; el log conserva el motivo.
* **Aceptación:** 503/422 de pricing con código y frase fijos + `correlationId`; ninguna cadena de SPACE/SPHERE en respuestas;
  `GET /v1/pricing/current` anónimo sin texto de SPHERE.
* **Depende de:** C1 (id). **Decisión previa:** D4.

### C4 — Evidencia bruta, diagnóstico y reevaluación autorizada (B4)

* **Dueño de ficheros:** `db/models.py` (modelo `JobEngineEvidence`), nueva migración Alembic (la cabeza actual no se ha
  determinado; ver «No verificado»), `services/execution.py` (orden E-2), `services/reevaluation.py` (nuevo), `routes/jobs.py`
  (`POST /reevaluate`, `GET /evidence`), `core/settings.py` (retención), `jobs/reconciler.py` (purga), `routes/artifacts.py`
  (garantizar que el export no lleva evidencia), `docs/IDEMPOTENCY.md` (fila B4), `docs/openapi.json`.
* **Tests:** voltear `test_a_bim_failure_during_reevaluation_keeps_the_engines_raw_result`,
  `..._has_an_explicit_diagnostic_code`, `..._authorized_way_to_retry_the_evaluation`. Nuevos: el éxito borra la evidencia en la
  misma transacción; VIEWER y clave de solo lectura → 403 en `/evidence` y `/reevaluate`; evidencia caducada → 410; dos
  `reevaluate` concurrentes → uno escribe, otro 409; BIM sigue caído → 503 con job y evidencia intactos y contador +1; el
  lease perdido durante la llamada a BIM descarta; el bruto no aparece en `GET /v1/jobs/{id}`, listas ni export; una celda
  de estudio vuelve a `COMPLETED` tras el éxito (§3.4, riesgo); la fila no queda bloqueada durante la llamada a BIM
  (test de PostgreSQL en `tests/concurrency/`).
* **Aceptación:** un fallo de BIM no borra el resultado del motor; el job queda `FAILED` con `result.code` de catálogo y sin
  `solutions`; ningún job `COMPLETED` sin reevaluar; la evidencia solo la leen dueño con MEMBER; retención acotada y probada;
  el reintento no vuelve a ejecutar el motor.
* **Checks:** check 1; suite completa; migración `alembic upgrade head` y `downgrade -1`
  (patrón de `tests/test_job_leases.py:920`); `tests/concurrency` en PostgreSQL del lab.
* **Depende de:** C1, C2. **Decisión previa:** D3.

### C5 — Cancelación remota del intento perdido (B3)

* **Dueño de ficheros:** `db/models.py` (`JobRemoteAttempt`), nueva migración Alembic (después de la de C4),
  `services/execution.py` (`record_engine_job_id`, `cancel_engine_job`, esperar con tarea abortable), `jobs/reconciler.py`
  (`_requeue`, `_fail_abandoned`, paso `cancel_lost_attempts` en `_reconcile_cycle`), `jobs/leases.py` (`on_lost`),
  `v1/remote.py` (`cancel_remote` devuelve el código), `services/engine_registry.py` (check `cancellation`, `declares_cancellation`),
  `docs/IDEMPOTENCY.md` (G4, filas «Lease lost»), `docs/qa/SECURITY_REVIEW.md` (B3), y los tests `tests/test_job_leases.py:782-841`
  según D1.
* **Tests:** voltear `test_requeueing_a_lost_attempt_cancels_its_remote_job`,
  `test_failing_an_abandoned_job_cancels_every_lost_attempt`, `test_a_worker_whose_lease_was_lost_stops_waiting_for_the_engine`,
  `test_cancellation_is_not_sent_to_an_engine_that_does_not_declare_it` (el segundo y primero llaman hoy a
  `sweep_abandoned`; si el paso de cancelación vive en otro punto, la invocación del test cambia, no la aserción).
  Nuevos: no se cancela un id compartido con un intento más nuevo (H-B3-1); 404/405 → `cancel_unsupported` sin reintento; error de
  red → reintentos acotados y `cancel_failed`; registración sin declaración → sin red; el check `cancellation` falla si el OpenAPI
  no describe el `DELETE`; el barrido no hace red (test con transporte que falla si se llama); el test normal de fencing
  `test_the_late_result_of_a_superseded_attempt_cannot_overwrite_the_new_attempt` sigue pasando; PostgreSQL: dos réplicas
  reclaman lotes disjuntos del paso de cancelación.
* **Aceptación:** un intento que pierde el lease y cuyo motor declara la capacidad recibe un `DELETE` best-effort sin que el
  barrido espere a la red; nunca se cancela el id del intento vigente; el fencing y el descarte de resultados tardíos no cambian;
  la documentación sigue diciendo que no hay exactly-once; sin declaración no se envía nada.
* **Checks:** check 1; suite completa; `ruff`; migración arriba y abajo; `tests/concurrency` en PostgreSQL.
* **Depende de:** C4 (migraciones y `execution.py`). **Decisiones previas:** D1 y D2.

## 6. Tests de análisis

`openbinding-gateway/tests/analysis_b3_b4_b6/` (SQLite en memoria, motor y BIM sustituidos, sin red). Los `xfail`
llevan `strict=True` y `raises=AssertionError`; las comprobaciones previas de cada escenario lanzan `RuntimeError`, de modo que un
escenario roto por otra causa falla de verdad en lugar de contar como «fallo esperado».

| Test | Resultado | Qué demuestra |
|---|---|---|
| `test_analysis_b3_lease_loss.py::test_the_late_result_of_a_superseded_attempt_cannot_overwrite_the_new_attempt` | pasa | Fencing cerrado (§2.2) |
| `…::test_requeueing_a_lost_attempt_cancels_its_remote_job` | xfail | R-B3-1 |
| `…::test_failing_an_abandoned_job_cancels_every_lost_attempt` | xfail | R-B3-2 |
| `…::test_a_worker_whose_lease_was_lost_stops_waiting_for_the_engine` | xfail | R-B3-3 |
| `…::test_cancellation_is_not_sent_to_an_engine_that_does_not_declare_it` | xfail | R-B3-4 |
| `test_analysis_b4_reevaluation_failure.py::test_an_unevaluated_result_is_never_recorded_as_valid` | pasa | Parte cerrada de B4 |
| `…::test_a_bim_failure_during_reevaluation_keeps_the_engines_raw_result` | xfail | R-B4-1 |
| `…::test_a_failed_reevaluation_has_an_explicit_diagnostic_code` | xfail | R-B4-2 |
| `…::test_there_is_an_authorized_way_to_retry_the_evaluation` | xfail | R-B4-3 |
| `test_analysis_b6_error_leaks.py::test_a_viewers_view_of_a_failed_job_carries_a_fixed_sentence` | pasa | B1 vigente |
| `…::test_an_unhandled_exception_does_not_put_its_text_in_the_public_500` | pasa | 500 sin texto interno |
| `…::test_the_transport_does_not_name_the_engine_host_in_the_jobs_error` | xfail | Punto 1 (transporte real, host `.invalid`) |
| `…::test_an_unexpected_exception_text_does_not_reach_the_jobs_error` | xfail | Punto 2 |
| `…::test_the_error_text_an_engine_writes_is_bounded` | xfail | Punto 3 (texto del motor) |
| `…::test_the_pricing_503_does_not_repeat_the_reason_of_the_pricing_client` | xfail | Punto 6 |
| `…::test_the_anonymous_pricing_503_does_not_repeat_what_sphere_said` | xfail | Punto 8 |
| `…::test_the_public_500_carries_a_correlation_id` | xfail | `correlationId` inexistente |

Ejecución con `qa_run` (índice 1, tras el `uv sync --locked` del índice 0): **4 passed, 13 xfailed, `diff-ok`**, sin cambios en
`uv.lock` ni `.venv`. Solo se ejecutó este directorio; no se corrió la suite completa del gateway.

## 7. Lo que no se ha podido verificar

* **PostgreSQL.** Todos los tests son SQLite. El comportamiento de bloqueo de fila (R-B4-4), `SKIP LOCKED` en los lotes
  propuestos y el reloj de la base se han tomado de la lectura y de `IDEMPOTENCY.md`, no de una ejecución.
* **Motores reales.** Ningún motor del árbol implementa `DELETE`; no se sabe cómo se comportaría uno real (H-B3-1, H-B3-2) ni si
  alguno deduplica por `X-Openbinding-Job-Id`.
* **Texto real de `SpaceError` y de los errores de SPHERE.** Solo se usaron dobles; la librería externa `space_client` no se leyó,
  ni se contactó con SPACE ni SPHERE.
* **El mensaje de `SecretsUnavailable`** (`execution.py:263`) y el contenido de `str()` de excepciones de SQLAlchemy/httpx en
  producción.
* **Consumidores de `result.error`** (frontend, informes, `reports.py`, `study_jobs.py`): no se revisó si alguno depende del texto
  actual; hay que hacerlo antes de C2.
* **Quién lee `verification_report`** (punto 11) y si la tarea de análisis (punto 9) llega a los usuarios con texto interno.
* **Transición `FAILED → COMPLETED` en estudios** (§3.4) y la reacción de una *run* ya cerrada.
* **Cabeza de Alembic y generación de `docs/openapi.json`**: no se ejecutó `alembic heads` ni el generador del contrato. El
  implementador de C1/C4/C5 debe localizarlos.
* **Frecuencia real** de pérdida de lease, tamaño típico del resultado bruto y coste de almacenarlo (H-B4-1).
* **`IDEMPOTENCY.md` es incoherente consigo mismo**: G4 y la fila «Worker is slow» (líneas 197-201, 212) dicen que el resultado
  descartado cancela el job remoto, y la fila «Lease lost (B3)…» (217) dice que no se cancela. El código confirma lo primero para
  el camino del worker que vuelve, y lo segundo para el barrido. La documentación debe corregirse en C5.

## 8. Decisiones que necesitan a una persona

* **D1.** Puerta de capacidad en todos los caminos de cancelación (recomendado) o solo en el nuevo.
* **D2.** Capacidad en la registración (`spec.extensions`, propuesto) o en el manifiesto del motor (cambio MAJOR del toolchain).
* **D3.** Evidencia escrita antes de reevaluar (recomendado) o solo en el fallo.
* **D4.** Si los administradores pueden seguir viendo el motivo textual de SPACE en las rutas de `admin.py`.
* **D5.** Retención por defecto de la evidencia (propuesta: 14 días, máximo 90).
