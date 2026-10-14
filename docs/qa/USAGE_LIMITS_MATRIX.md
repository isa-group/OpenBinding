# Matriz de límites de uso medibles

Fecha: 2026-10-14. Base: decisión humana de 2026-10-14, vigente, que sustituye las notas antiguas que retiraban los
contadores mensuales:

> «Quiero limites de uso pero no sujetos a unidades de capacidad o creditos. SI pueden estar sujetos a numero de tareas,
> complejidad del espacio de binding, tiempo de ejecucion, numero de jobs, concurrencia, etc.»

Reglas que sigue este documento y el código que describe:

- **No hay CU, créditos, moneda ponderada ni saldo.** Un límite es un **tope sobre algo medible** (tamaño del espacio de
  binding, jobs simultáneos, segundos de reloj), no un saldo que se gasta y se renueva.
- Los contadores de clase B (`taskStarts`, `federatedTaskStarts`, `solverSeconds`, `studyRuns`, `concurrentJobs`) **no se
  retiran por defecto ni se asimilan a CU**. Ver [más abajo](#contadores-de-clase-b-taskstarts-solverseconds-studyruns-concurrentjobs).
- **SPACE es la fuente nativa de planes, uso y contratos.** OpenBinding consume y aplica los límites que SPACE entrega y
  mantiene salvaguardas técnicas propias. No recrea el ciclo de vida de pricing, ni contabilidad paralela, ni un ledger
  de saldo.
- **SPACE está en espera.** Nada de esto se ha comprobado contra un SPACE real: todo se verificó con dobles sintéticos
  (`tests/_fake_space.py`, `PlanCaps` construidos a mano). No se afirma nada end-to-end real.
- No se inventan cantidades comerciales. Los números que aparecen son valores de los tests sintéticos
  (`tests/fixtures/pricing_test.yml`, marcado «TEST FIXTURE, NOT A REAL PRICING») o los topes técnicos de
  `core/settings.py`.

Rutas relativas a `openbinding-gateway/src/openbinding_gateway/` salvo que se indique otra cosa. `fichero:línea` es el
punto de enforcement en el árbol de esta rama.

## 1. Lo que hace hoy el cliente SPACE (y lo que no puede verificarse)

Fichero: `space_client/space.py` (`SpacePricingGate`), contra `space-python-client` 1.0.0 (instalado por `uv sync`).
Protocolo: `space_client/gate.py:103` (`PricingGate`). La puerta abierta de desarrollo es `space_client/open.py`.

| Operación del gate | Llamada al cliente SPACE | Fichero:línea | Qué hace |
|---|---|---|---|
| `caps(user)` | `features.generate_user_pricing_token` + `contracts.get_contract` | `space.py:106` (usa `:86` y `:99`) | Descodifica **sin verificar firma** los claims del token (`:296`), lee `pricingContext.features` (booleanos) y `pricingContext.usageLimits` (números; `null` = ilimitado = `inf`), quita el prefijo `<servicio>-` y devuelve `PlanCaps`. Falla cerrado si no hay token, contrato o `pricingContext`. |
| `create_contract` | `contracts.add_contract` + lectura posterior | `space.py:142` | Crea el contrato con versión de pricing y plan; relee porque `add_contract` devuelve `None` también cuando falla. |
| `change_plan` / `change_subscription` | `contracts.update_contract_subscription` | `space.py:192`, `:213` | Novación de plan/add-ons contra la versión ya fijada. |
| `subscription` | `contracts.get_contract` | `space.py:200` | Plan, versión, add-ons, fin del periodo. |
| `pricing_token` | `features.generate_user_pricing_token` | `space.py:264` | Entrega el token al navegador. |
| `remove_contract` | `contracts.remove_contract` | `space.py:272` | Borra el contrato al borrar la cuenta. |

Lo que el cliente **no** hace, por diseño y comprobado por `tests/test_space_client.py::test_no_gate_offers_to_evaluate_or_consume`
(`:153`) y `tests/test_usage_endpoints.py::test_usage_reports_the_plan_and_its_features_and_no_consumption` (`:59`):

- no **informa** consumo a SPACE (no hay llamada de uso, ni de «usage level update»);
- no **lee** consumo de SPACE (ni `subscriptionContext`); el gateway no evalúa las expresiones de features de la pricing
  (`solve: ... && subscriptionContext['concurrentJobs'] < ...` en la fixture), solo los booleanos de `pricingContext.features`;
- no gestiona versiones de pricing ni publica nada (eso es SPHERE/SPACE).

**No puede verificarse sin un SPACE real** (todo queda como «desconocido» y se trata como tal, ver §2):

1. Que el token real traiga `maxInstanceComplexityLog10`, `maxTimeoutSeconds`, `maxPayloadBytes`, `concurrentJobs`… con el
   nombre y la unidad que las pruebas suponen. Las pruebas usan los nombres de la fixture sintética.
2. Qué entrega SPACE para un límite *no declarado* en el plan (¿clave ausente? ¿`null`? ¿`0`?). El código trata la clave
   ausente, `NaN`, negativa o no numérica como **desconocida**; `null` (→ `inf`) como **ilimitado**. Si SPACE usara `null`
   para «no declarado» se concedería ilimitado: hay que confirmarlo antes de reactivar (ver `USAGE_LIMITS.md`).
3. Que `usageLimits` de un contrato real incluya el efecto de los add-ons (la fake suma `usageLimitsExtensions`; el token real
   no se ha visto).
4. Cualquier capacidad nativa de **medir uso** en SPACE (contadores, ventanas, reinicios), y cualquier mecanismo para
   informarle de eventos.
5. El comportamiento de caché, invalidación y suscripción por socket del cliente 1.x ante un cambio de plan.
6. La firma del token (se descodifica sin verificar a propósito; el canal ya es autenticado).

## 2. Matriz

Leyenda de estado: **existe** (aplicado y con test) · **existe (nuevo)** (añadido en esta tarea) · **falta** (no se aplica
y se podría) · **desconocido** (depende de SPACE o de una decisión humana pendiente).
«Fuente» = *nativa SPACE* (el valor lo entrega el plan) o *medida local* (la mide el gateway).
Todos los límites de usuario se resuelven para la **cuenta** que llama (`caps_for(user.id)`); los de estructura
colaborativa, para el **patrocinador** (`sponsor`) de la organización y su subárbol.

### 2.1 Tamaño del trabajo

| Límite | Unidad | Periodo | Alcance | Rol / plan | Fuente | Enforcement | Estado | Tests |
|---|---|---|---|---|---|---|---|---|
| **Espacio de binding** `maxInstanceComplexityLog10` | log10 de combinaciones (techo), medido como cardinalidad en decimal | ninguno (techo por job) | cuenta que envía | el que declara el plan | techo: **nativa SPACE** (token). Medida: **local** (`analysis` de BIM) | `services/job_submission.py:523` (job, vía `domain/binding_space.py:212` `check`); `services/instances.py:193` (`/v1/validate`); `routes/jobs.py:146-151` (retry); `study_jobs.py:212` + `routes/studies.py:641` (estudio, antes de crear el run); `study_jobs.py:245` (cada celda pasa otra vez por `job_submission`) | **existe (nuevo)** el cálculo exacto y los casos desconocido/ilimitado; el techo del plan existía como `instance_complexity_too_large` con float | `tests/test_usage_limits.py`, `tests/test_v1_platform_contracts.py:947` |
| **Salvaguarda técnica del espacio** `MAX_BINDING_SPACE_LOG10` | log10 | ninguno | despliegue entero | todos | **local** (setting) | mismos puntos que arriba; se combina con el techo del plan (el menor) y sustituye al plan si este no declara valor | **existe (nuevo)**; apagada por defecto | `tests/test_usage_limits.py::test_the_safeguard_applies_when_the_plan_is_unknown_or_unlimited` |
| Tamaño de la petición `maxPayloadBytes` | bytes | ninguno | cuenta | plan | nativa SPACE | `access/policy.py:179` (`payload_ceiling_bytes`); `services/job_submission.py:519` (job, también `chunked`); `services/entitlements.py:140` (`upload_limit`, artefactos) | existe | `tests/test_chunked_payload_ceiling.py`, `tests/test_access_policy.py:158` |
| Tamaño máximo de cuerpo (técnico) | bytes | ninguno | despliegue | todos | local (setting `max_request_body_bytes` 512 MiB, `max_json_body_bytes` 16 MiB: `core/settings.py:187`, `:190`) | `security/bodylimit.py:93` | existe | `tests/test_chunked_payload_ceiling.py` |
| Almacenamiento `storageBytes` | bytes almacenados | acumulado | patrocinador | plan | tope: nativa SPACE; **uso: medida local** (suma de blobs) | `services/entitlements.py:160` (`enforce_storage_quota`); `routes/artifacts.py:179` | existe | `tests/test_entitlement_service.py::test_storage_quota_counts_the_incoming_bytes_but_reports_what_is_stored` |
| Estructura: `organizations`, `members`, `projects`, `privateProjects`, `collections`, `studies` (definiciones) | conteo | acumulado (no mensual) | patrocinador y subárbol | plan | tope: nativa SPACE; uso: medida local (filas) | `services/entitlements.py:148` (`enforce_sponsor_usage`) ← `collaboration.py:276`, `:284` | existe | `tests/test_entitlement_service.py:207-233` |
| `apiKeys` | conteo de claves activas | acumulado | cuenta | plan | tope: nativa SPACE; uso: medida local | `routes/users.py:314` | existe | `tests/test_api_keys.py` |
| `federatedEngines` (límite numérico de revisiones) | conteo | acumulado | cuenta | plan | nativa SPACE | **ninguno**: solo se lee la *feature* `federatedEngines` (`services/job_submission.py:660`, `routes/jobs.py:145`) | **falta** (el límite numérico no se aplica) | — |
| `jobHistoryDays` | días de retención visibles | ventana móvil | cuenta | plan | nativa SPACE | `routes/users.py:452` (filtra el listado) | existe | `tests/test_usage_endpoints.py` |

### 2.2 Número de jobs, tareas y estudios

| Límite | Unidad | Periodo | Alcance | Rol / plan | Fuente | Enforcement | Estado | Tests |
|---|---|---|---|---|---|---|---|---|
| Jobs **simultáneos** (técnico) `MAX_CONCURRENT_JOBS_PER_USER` | jobs en `queued`+`running` | instantáneo (no acumula) | cuenta | todos, independiente del plan | **local** (cuenta filas de `jobs`) | `jobs/limits.py:43` (`enforce_concurrency_limit`), `:24` (`lock_owner`, `FOR UPDATE`), `:34` (`count_in_flight`); invocado en `services/job_submission.py:662` (`POST /v1/jobs`, y cada celda de estudio), `routes/jobs.py:152` (retry) | existe | `tests/test_concurrency_limit.py`, `tests/test_usage_limits.py::test_the_concurrency_limit_frees_a_slot_...`; carrera real: `tests/concurrency/test_job_leases_pg.py` (**omitido** sin PostgreSQL) |
| Jobs simultáneos **del plan** `concurrentJobs` | jobs | instantáneo | cuenta | plan | nativa SPACE | **ninguno**: `PlanCaps` lo trae (`open.py:76` lo rellena con el tope técnico) pero ningún código lo lee; `tests/test_concurrency_limit.py::test_the_limit_does_not_depend_on_the_plan` fija ese diseño | **falta / decisión pendiente** | — |
| Jobs por periodo / `taskStarts`, `federatedTaskStarts` | tareas arrancadas | mensual (según la pricing de SPHERE) | cuenta | plan | nativa SPACE (contador) | **ninguno** y **no hay medida local**: el gateway no cuenta arranques por periodo ni informa a SPACE | **desconocido** (clase B, ver abajo) | — |
| `solverSeconds` | segundos de reloj de solver | mensual | cuenta | plan | nativa SPACE (contador) | **ninguno**; lo más cercano es el tope por job (`maxTimeoutSeconds`) | **desconocido** (clase B) | — |
| `studyRuns` | ejecuciones de estudio | mensual | cuenta | plan | nativa SPACE (contador) | **ninguno** (`routes/admin.py:574` cuenta filas `StudyRun` solo para mostrarlas) | **desconocido** (clase B) | — |
| Estudios: tamaño de un run | celdas por run | por run | cuenta | plan (`studies`) | local | el run no limita su número de celdas; cada celda es un job y entra en la concurrencia (`study_jobs.py:421` `RETRYABLE_LAUNCH_CODES`: el resto espera) | **falta** un tope de celdas por run (no se añade: sería una cantidad comercial) | — |

### 2.3 Tiempo

| Límite | Unidad | Periodo | Alcance | Tipo de tiempo | Fuente | Enforcement | Estado | Tests |
|---|---|---|---|---|---|---|---|---|
| `maxTimeoutSeconds` (presupuesto de un job) | segundos | por job | cuenta | **reloj de pared** | nativa SPACE | `access/policy.py:155` (`solve_timeout_s`: es el `timeout` que viaja al motor, `services/job_submission.py:529`, y `requested_budget_s`, `:714`); `access/policy.py:111` (`clamp_options` recorta `time_budget_ms`) | existe; **corregido**: un plan sin este límite declarado ya no da un timeout de 0 s sino `503 pricing_misconfigured` | `tests/test_usage_limits.py::test_a_plan_that_declares_no_timeout_...`, `tests/test_access_policy.py` |
| `maxIterations` | iteraciones / evaluaciones | por job | cuenta | no es tiempo | nativa SPACE | `access/policy.py:111` (recorta `iterations`, `max_evaluations` con aviso `OPTION_CLAMPED`) | existe | `tests/test_access_policy.py` |
| `ENGINE_SOLVE_TIMEOUT_S` (1800 s) | segundos | por llamada al motor | despliegue | **reloj de pared** (espera del gateway) | local | `core/settings.py:93`; `services/execution.py:790`; techo del plan en `access/policy.py:155` | existe | `tests/test_access_policy.py:180` |
| `QUEUE_TIMEOUT_S` (1800 s, mín. 60) | segundos | por job en cola | despliegue | reloj de pared | local | `core/settings.py:110`; `jobs/reconciler.py:246` | existe | `tests/test_job_reconciler.py` |
| Gracia de abandono (120 s) y lease (60 s, latido 20 s, 2 reclamaciones) | segundos / intentos | por job | despliegue | reloj de pared (reloj de la base de datos en PostgreSQL) | local | `jobs/reconciler.py:46`, `:275`; `jobs/leases.py:29-37` | existe | `tests/test_job_leases.py`, `tests/test_job_reconciler.py` |
| `BIM_SERVICE_TIMEOUT_S` (30 s), `SPACE_TIMEOUT_MS` (5000) | s / ms | por llamada | despliegue | reloj de pared | local | `core/settings.py:143`, `:233` | existe | `tests/test_settings.py` |
| Tiempo de **CPU** | — | — | — | CPU | — | **no se mide ni se limita en ningún sitio** (`grep -i cpu` en `src/`: solo un semáforo de análisis, `analysis_jobs.py:20`) | **falta** (y no se puede decir «segundos de solver» en CPU: el motor es remoto) | — |

Sobre el tiempo: todo lo que el gateway controla es **tiempo de reloj de pared** (cuánto espera a un motor, cuánto puede
estar un job en cola, cuánto dura una lease). El motor es un servicio remoto (`bim-engine/v1`); el gateway no ve su CPU, y
`time_budget_ms` es un presupuesto que el motor interpreta. Un «tiempo de ejecución» medido en CPU requeriría
telemetría del motor y no existe. **Timeouts técnicos** (los de `core/settings.py` de arriba) son salvaguardas del
despliegue, no derechos del plan: ningún plan puede concederlos por encima (`solve_timeout_s` lo hace explícito).

### 2.4 Salvaguardas técnicas que no son de plan

| Salvaguarda | Unidad | Enforcement | Estado |
|---|---|---|---|
| Limitación de login/registro/refresh | intentos por ventana (`AUTH_RATE_LIMIT_*`, 300 s) | `core/ratelimit.py`, `core/settings.py:198` | existe |
| Lecturas públicas sin cuenta | peticiones por minuto (240) | `access/public_read.py`, `core/settings.py:280` | existe |
| Retención de evidencia de motor | días (14, máx. 90) | `core/settings.py:114`, `jobs/evidence.py` | existe |

## 3. Complejidad del espacio de binding

### 3.1 Qué es y qué no es

BIM expone en `analysis` (`bim-toolchain/.../compiler.py:3596-3628`, sin tocar): `bindingSpaceBreakdown` (candidatos
elegibles por tarea de servicio), `bindingSpaceCardinality` (**string decimal**: el producto del desglose),
`bindingSpaceLog10` (float: la suma de `log10` del desglose), `serviceTasks` y `candidates`. El gateway recalcula lo
mismo para un snapshot guardado en `services/snapshots.py:50` (`ir_analysis`).

Es una **ESTIMACIÓN** del esfuerzo máximo de búsqueda: el producto sin restricciones de la elegibilidad. **No es una métrica
real**: no cuenta combinaciones evaluadas, ni tiempo, ni trabajo del motor. Dos instancias con el mismo espacio pueden
costar muy distinto. Por eso se usa como **techo de admisión** (se rechaza antes de ejecutar) y nunca como medida de lo
consumido. No hay ninguna métrica real equivalente en el gateway (el resultado de un job no guarda combinaciones
evaluadas de forma que se pueda sumar).

### 3.2 Precisión, redondeo y desbordamiento

| Asunto | Decisión | Dónde |
|---|---|---|
| Representación | La cardinalidad viaja y se compara como **string de dígitos decimales**, nunca como `float`. `log10` (float) solo se muestra y es el respaldo si no hay cardinalidad. | `domain/binding_space.py:87` (`parse_cardinality`), `:139` (`BindingSpace`) |
| Comparación con techo entero (la unidad de los planes) | **Exacta**: `10**k` está dentro del techo `k`; `10**k + 1` no. Sin logaritmos. | `domain/binding_space.py:110` (`cardinality_exceeds`) |
| Comparación con techo fraccionario | Se decide con `log10` de los 17 primeros dígitos: exacta a precisión de `float` (~1e-16). Una instancia a menos de ese margen del techo puede caer a cualquier lado. | ídem |
| Por qué no el float | La suma de `log10` no es exacta (p. ej. `log10(5)+log10(2)` puede quedar a un lado u otro de `1.0`) y aceptaría o rechazaría mal una instancia justo en el techo. | `tests/test_usage_limits.py::test_summed_logarithms_do_not_decide_a_limit_when_the_exact_size_is_known` |
| Redondeo en las respuestas | `used` y `binding_space.log10` se redondean a 6 decimales; solo se muestran, no deciden. | `domain/binding_space.py:175` (`as_report`), `:202` (`_quota`) |
| Desbordamiento | CPython **se niega** a convertir a texto un entero de más de 4300 dígitos (`str(int)`, `int(str)`). `ir_analysis` hacía `str(cardinality)` y `Compilation.binding_space_cardinality` hacía `int(texto)`: un espacio de más de 4300 dígitos (p. ej. 1440 tareas × 1000 candidatos) levantaba `ValueError`. Ahora se produce el texto con `divmod` por bloques y nunca se llama a `int(texto)` sobre la cardinalidad. | `domain/binding_space.py:69` (`decimal_digits`), `services/snapshots.py:83` y `:148-155` |
| Tamaño de la respuesta | Una cardinalidad de más de 40 dígitos no se devuelve: solo `digits` y `log10`. | `domain/binding_space.py:63`, `:175` |
| Techo gigantesco (`1e300`) | No cuesta memoria: se compara el número de dígitos antes de construir nada. | `cardinality_exceeds` |
| Espacio vacío | Una tarea sin candidatos da cardinalidad `0` y `log10 = 0.0`: nunca supera un techo (no hay nada que buscar). | `tests/test_usage_limits.py::test_a_task_without_candidates_...` |

Sin modificar el toolchain: `bim-toolchain` también hace `str(cardinality)` (`operations.py:118`, `inprocess.py:125`); su
servicio fija `sys.set_int_max_str_digits` en el worker (`bim-toolchain/docs/SERVICE.md:354`). Un espacio de más de 4300
dígitos puede seguir fallando **dentro del toolchain** en modo `inproc`. Es un riesgo fuera de alcance, anotado en
`USAGE_LIMITS.md`.

### 3.3 Qué se decide, con qué datos y qué se responde

El techo efectivo es el **menor** de: el `maxInstanceComplexityLog10` del plan (si lo declara) y `MAX_BINDING_SPACE_LOG10`
(si está puesto). Si el plan no declara un valor utilizable, la salvaguarda técnica **ocupa su lugar**; si tampoco hay
salvaguarda, se **deniega**. «Desconocido» nunca se lee como ilimitado ni como cuota disponible.

| Plan | Salvaguarda | Medida del espacio | Resultado | HTTP | `code` |
|---|---|---|---|---|---|
| techo finito `c` | — | supera `c` | rechazo | **402** | `instance_complexity_too_large` |
| techo finito `c` | — | ≤ `c` (incluida la igualdad) | sigue | — | — |
| techo finito `c` | `t` < `c` | supera `t` | rechazo | **422** | `binding_space_over_technical_limit` |
| ilimitado (`inf`/`null`) | — | cualquiera, incluso ilegible | sigue | — | — |
| ilimitado | `t` | supera `t` | rechazo | **422** | `binding_space_over_technical_limit` |
| **desconocido** (clave ausente, `NaN`, negativa, no numérica) | — | cualquiera | **rechazo** | **403** | `binding_space_limit_unknown` |
| desconocido | `t` | supera `t` | rechazo | 422 | `binding_space_over_technical_limit` |
| desconocido | `t` | ≤ `t` | sigue | — | — |
| cualquiera con techo efectivo | — | **sin medida legible** (ni cardinalidad ni log10) | **rechazo** | **422** | `binding_space_unmeasured` |

Notas: el `402` mantiene el estado que este rechazo ya tenía (el frontend lo lee como `QuotaError`); **no hay cobro ni
pago**. El rechazo por la salvaguarda técnica es `422` porque un plan mayor no lo arregla. La puerta abierta
(`SPACE_ENABLED=false`) declara `maxInstanceComplexityLog10 = inf`, así que solo la salvaguarda técnica puede limitarla.

Cuerpo (JSON seguro, acotado, sin rutas, hosts ni nombres de tarea; el frontend ya lee `quota.{limit_id,limit,used,unit}`):

```json
{
  "type": "https://openbinding.dev/problems/instance_complexity_too_large",
  "title": "instance_complexity_too_large", "status": 402, "code": "instance_complexity_too_large",
  "detail": "instance binding space exceeds the caller plan limit",
  "quota": {"limit_id": "maxInstanceComplexityLog10", "state": "exhausted", "unit": "log10 combinations",
            "source": "plan", "limit": 0.1, "used": 0.30103},
  "binding_space": {"kind": "estimate", "log10": 0.30103, "digits": 1, "cardinality": "2"}
}
```

`state` ∈ `exhausted` · `unknown` · `unmeasured`; `source` ∈ `plan` · `technical` · `none`. En `unknown` no hay `limit`.
**Forma en el cable**: en rutas BIM (`/v1/jobs`, `/v1/validate`, `/v1/instances`…) y en cualquier `422`, `quota` y
`binding_space` van al nivel superior; en rutas de plataforma con otro estado (`402`/`403`, p. ej. `…/studies/{s}/runs`)
van dentro de `detail`, como ya hacen `sponsor_quota_exceeded` y `storage_quota_exceeded` (`main.py:240-274`). El
frontend ya busca `detail.quota ?? quota` (`frontend/src/api/client.ts:592`).

El OpenAPI **no cambia**: los miembros extra de un problema no están modelados (`models/errors.py:44` `QuotaBody` ni se
toca) y no se declaran respuestas nuevas. `tools/dump_openapi.py --check` lo confirma (check 0).

### 3.4 Sin cargo y sin reserva

La comprobación se hace **antes de bloquear la fila de la cuenta, de guardar el snapshot o de insertar el job**
(`services/job_submission.py:523` está en `_plan_terms`; `_persist` empieza en `:634`). En un estudio se hace antes de
crear el `StudyRun` y las celdas (`routes/studies.py:641`). Un rechazo no deja filas, no ocupa ninguna ranura de
concurrencia, no consume la clave de idempotencia y no entrega nada a un worker. No hay cargo que revertir porque no
existe ninguna contabilidad. Tests: `test_a_job_above_the_plan_limit_is_refused_and_leaves_nothing_behind`,
`test_a_study_run_with_a_case_above_the_limit_is_refused_whole_and_writes_nothing`,
`test_retrying_a_job_holds_its_size_against_the_plan_and_a_refusal_writes_nothing` (`tests/test_usage_limits.py`).

Límites del enforcement actual:

- Un **retry** de un job anterior a que se guardara el tamaño (`jobs.instance_complexity` vacío) no se vuelve a medir: su
  instancia no se puede leer desde ahí (`routes/jobs.py:146`). Es una excepción conocida y probada.
- En un estudio, una celda cuyo snapshot no se puede leer se deja al lanzamiento de esa celda, que lo informa como
  siempre (`study_jobs.py:212`).
- Un replay de una clave de idempotencia heredada (algoritmo antiguo) se compara después de resolver
  (`services/job_submission.py:347`) y por tanto **después** de `_plan_terms`: podría recibir el rechazo de complejidad si el
  plan se encogió. Solo afecta a filas anteriores al esquema `v2:`.

## 4. Concurrencia: límite simultáneo, no saldo

`concurrentJobs` / `MAX_CONCURRENT_JOBS_PER_USER` cuenta los jobs `queued`+`running` de la cuenta **ahora**
(`jobs/limits.py:34`). Un job que termina libera su ranura sin más: no hay contador acumulado ni periodo
(`tests/test_usage_limits.py::test_the_concurrency_limit_frees_a_slot_when_a_job_ends_and_counts_nothing_cumulative`:
tres jobs seguidos por una única ranura, con tres rechazos que no crean nada). El rechazo es `429
concurrency_limit_exceeded` con `Retry-After: 15`, y las celdas de estudio lo tratan como reintentable
(`study_jobs.py:421`).

Cuerpo del `429`, ahora con el mismo vocabulario que un `402` para que el frontend lo lea (antes solo `{limit, active}`, que
`client.ts:602` descartaba por faltar `limit_id`):

```json
{"concurrency": {"limit_id": "concurrentJobs", "limit": 8, "used": 8, "active": 8, "unit": "job", "source": "technical"}}
```

(`domain/entitlements.py:48`). `active` se conserva por compatibilidad. **El límite que se aplica es el técnico**, no el del
plan; ver la fila «Jobs simultáneos del plan» de §2.2.

La exclusión de dos creaciones simultáneas depende de `FOR UPDATE` sobre la fila del usuario (`jobs/limits.py:31`). SQLite
no tiene bloqueos de fila: **la carrera real solo se prueba con PostgreSQL** (`tests/concurrency/test_job_leases_pg.py`,
`test_jobs_idempotency_pg.py`), y en este entorno esas pruebas se **omiten** (40 omitidas en el check 2, ver
`USAGE_LIMITS.md`). Con la sesión única de SQLite no se puede lanzar dos peticiones a la vez sin que SQLAlchemy lo
prohíba, así que la prueba de «simultáneo» en SQLite es secuencial.

## 5. Reintentos y deduplicación: el mismo job no se cuenta dos veces

No hay cargo, pero sí hay recursos que se tomarían dos veces (una ranura, un job): lo que impide duplicarlos, con el
código y los tests que lo prueban:

| Caso | Mecanismo | Código | Prueba |
|---|---|---|---|
| Misma `Idempotency-Key` y misma petición canónica | Se devuelve el job original (`202`, `idempotent: true`) **antes** de evaluar planes, límites o ranuras | `services/job_submission.py:439` (`_precheck`), `:171` (`_idempotent_outcome`) | `tests/test_idempotency_jobs.py::test_same_key_and_body_replays_the_same_job`; `tests/test_job_submission_service.py::test_a_replay_at_the_limit_is_not_refused` |
| Replay con el límite agotado | Se responde el replay (`202`), no un `429` | `jobs/limits.py:43` se llama después del replay (`services/job_submission.py:657-662`) | `tests/test_concurrency_limit.py::test_an_idempotent_replay_at_the_limit_returns_the_job_not_a_429` |
| Replay cuando el plan se encogió | Se responde con el job original; una clave nueva sí recibe el rechazo | `services/job_submission.py:439-442` | `tests/test_usage_limits.py::test_an_idempotent_replay_is_not_measured_again_and_takes_no_second_slot` |
| Dos peticiones con la misma clave a la vez | Bloqueo de la cuenta + restricción única `uq_jobs_owner_idempotency_key` + relectura del ganador | `services/job_submission.py:655-658`, `:674-678`, `:722-733`; `docs/IDEMPOTENCY.md` (G1) | `tests/test_job_submission_service.py::test_losing_the_insert_race_...`; PostgreSQL: `tests/concurrency/test_jobs_idempotency_pg.py` (omitido sin PG) |
| Un rechazo no quema la clave | No se inserta nada | `services/job_submission.py:523` | `tests/test_usage_limits.py::test_a_job_above_the_plan_limit_...` (misma clave aceptada tras ampliar el plan) |
| Retry de un job fallido, repetido | `find_retry_of` devuelve el reemplazo existente | `routes/jobs.py:134` | `tests/test_concurrency_limit.py::test_a_retry_at_the_limit_is_a_429_and_a_replay_of_a_retry_is_not`; `tests/test_usage_limits.py::test_retrying_a_job_holds_its_size_...` |
| Celda de estudio lanzada dos veces | Índice único `uq_jobs_study_cell_id` + clave `study-cell:<id>` | `study_jobs.py:245`, `services/job_submission.py:722` | `tests/test_study_cell_launch.py` |
| Ejecución en el motor (cola al-menos-una-vez) | **No** es exactamente-una-vez: un motor puede ver el mismo job otra vez tras perder la lease | `docs/IDEMPOTENCY.md` (G2-G4) | pruebas PG y de cancelación remota |

La última fila es una advertencia honesta: la deduplicación evita crear **dos jobs** o tomar **dos ranuras**; no evita que
un motor remoto haga el trabajo dos veces tras un fallo, y ese coste de cómputo no lo ve el gateway.

## 6. Contadores de clase B (`taskStarts`, `solverSeconds`, `studyRuns`, `concurrentJobs`)

Estado heredado (`docs/qa/SPHERE_PRIVACY.md:65-90`, `docs/qa/REMOTE_TOOLS.md:102-114`): la pricing de desarrollo
`openbinding-dev@0.1.0` conserva 33 hallazgos de clase B y ninguno de clase A (sin CU ni créditos); la concesión histórica
**no está resuelta**. Con la decisión de 2026-10-14 queda así:

- **No se retiran por defecto** ni se tocan en SPHERE/SPACE (no se escribe nada).
- **No se asimilan a CU**: son conteos y segundos de reloj sobre cosas reales, no una moneda ponderada. Si se adoptan, serán
  topes con su unidad propia.
- **El gateway hoy no consume ninguno** excepto `concurrentJobs` como dato informativo (`open.py:76`); su límite
  simultáneo real es el técnico. Que la pricing los declare no los hace efectivos.
- Para que un contador mensual funcione hace falta **medir y acumular** eventos (arranques, segundos, runs) por cuenta y
  periodo, e informarlos a SPACE o leerlos de él. Eso es contabilidad y **no se ha implementado** ni se implementará aquí
  sin una decisión sobre quién mide (ver `USAGE_LIMITS.md`, «Plan de integración»).
- Lo que sí se puede hacer sin contabilidad y está hecho: topes **por job** o **instantáneos** (espacio de binding,
  timeout, iteraciones, simultaneidad).

Decisión pendiente para el humano: si `taskStarts`/`solverSeconds`/`studyRuns` han de ser topes mensuales nativos de SPACE,
y en ese caso qué evento exacto cuenta cada uno (p. ej. «arranque de tarea» = job que pasa a `running`, no un reintento).
